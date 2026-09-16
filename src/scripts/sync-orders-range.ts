// One-off: sync orders for an explicit date range, bypassing the
// chunked-monthly orchestrator. Used to fill gaps when one or two month
// chunks fail and we want to retry just those, possibly at smaller granularity
// (e.g. half-month) to dodge Shopify timeouts on big months.
//
// Usage:
//   npm run sync-orders-range -- 2025-08-01 2025-08-16
//   npm run sync-orders-range -- 2025-08-16 2025-09-01
// Or hardcode the RANGES below and just run.

import { submitBulkOperation, pollUntilDone } from "../lib/shopify/bulkOperation";
import { streamJsonl, groupByParent } from "../worker/jsonlStreamer";
import { applyBatch } from "../worker/runners/runner";
import {
  createSyncRun,
  markRunning,
  finishRun,
  updateProgress,
} from "../worker/progress";
import { logger } from "../lib/logger";
import orders from "../resources/orders";

const log = logger.child({ module: "sync-orders-range" });
const BATCH_SIZE = 100; // smaller than 200 — extra safety on big chunks

interface Range {
  label: string;
  startISO: string;
  endISO: string; // exclusive
}

// Default: split 2025-08 into halves. Override via CLI args (start, end ISO).
const DEFAULT_RANGES: Range[] = [
  { label: "2025-08a", startISO: "2025-08-01T00:00:00Z", endISO: "2025-08-16T00:00:00Z" },
  { label: "2025-08b", startISO: "2025-08-16T00:00:00Z", endISO: "2025-09-01T00:00:00Z" },
];

function parseArgs(): Range[] {
  const args = process.argv.slice(2);
  if (args.length === 2) {
    const [s, e] = args;
    return [{ label: `${s}__${e}`, startISO: `${s}T00:00:00Z`, endISO: `${e}T00:00:00Z` }];
  }
  return DEFAULT_RANGES;
}

async function syncRange(range: Range): Promise<void> {
  const runId = await createSyncRun({
    resourceName: "orders",
    runType: "manual",
    triggeredBy: `script:fill-${range.label}`,
    metadata: { range },
  });
  log.info({ runId, range }, "Range sync starting");
  await markRunning({ runId });

  try {
    const filter = `created_at:>=${range.startISO} created_at:<${range.endISO}`;
    const innerQuery = orders.graphqlQuery.replace(/\{\{QUERY_FILTER\}\}/g, filter);

    const opId = await submitBulkOperation(innerQuery);
    log.info({ opId, range: range.label }, "Bulk op submitted");
    await updateProgress({ runId, bulkOperationId: opId });

    const finalOp = await pollUntilDone(opId, {
      intervalMs: 10000,
      timeoutMs: 90 * 60 * 1000, // 90 min ceiling per range
    });

    if (!finalOp.url) {
      log.info({ range: range.label }, "No data for this range");
      await finishRun({ runId, status: "succeeded" });
      return;
    }
    log.info(
      { range: range.label, objects: finalOp.objectCount, roots: finalOp.rootObjectCount },
      "Bulk op COMPLETED, streaming JSONL",
    );

    let processed = 0;
    let inserted = 0;
    let failed = 0;
    // reason: ParentWithChildren is loosely typed in the streamer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer: any[] = [];

    const flush = async () => {
      if (!buffer.length) return;
      try {
        const r = await applyBatch(orders, buffer, runId, {
          skipReplaceDeletes: true, // these orders aren't yet in DB
        });
        inserted += r.inserted;
        failed += r.failed;
      } catch (err) {
        failed += buffer.length;
        log.error(
          {
            err: err instanceof Error ? err.message : err,
            batchSize: buffer.length,
            range: range.label,
          },
          "applyBatch failed",
        );
      }
      processed += buffer.length;
      buffer.length = 0;
      await updateProgress({
        runId,
        recordsProcessed: processed,
        recordsInserted: inserted,
        recordsFailed: failed,
      });
      log.info(
        { range: range.label, processed, inserted, failed },
        "batch flushed",
      );
    };

    for await (const parent of groupByParent(streamJsonl(finalOp.url))) {
      buffer.push(parent);
      if (buffer.length >= BATCH_SIZE) await flush();
    }
    await flush();

    await finishRun({
      runId,
      status: failed > 0 ? "partial" : "succeeded",
    });
    log.info(
      { range: range.label, processed, inserted, failed },
      "Range sync DONE",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun({ runId, status: "failed", errorMessage: msg });
    log.error({ range: range.label, err: msg }, "Range sync FAILED");
    throw err;
  }
}

async function main(): Promise<number> {
  const ranges = parseArgs();
  log.info({ count: ranges.length, ranges }, "Sync ranges");

  let failures = 0;
  for (const range of ranges) {
    try {
      await syncRange(range);
    } catch {
      failures += 1;
      // Continue to the next range — one failure shouldn't stop the rest.
    }
  }
  log.info({ totalRanges: ranges.length, failures }, "All ranges complete");
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err }, "Unexpected sync-orders-range failure");
    process.exit(1);
  });
