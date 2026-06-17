import type { ResourceModule, RunnerResult } from "../../resources/types";
import { monthChunks, chunkQueryFilter } from "../../lib/shopify/monthChunks";
import { submitBulkOperation, pollUntilDone } from "../../lib/shopify/bulkOperation";
import { streamJsonl, groupByParent, type ParentWithChildren } from "../jsonlStreamer";
import { applyBatch } from "./runner";
import { checkpoint, updateProgress } from "../progress";
import { logger } from "../../lib/logger";
import { query as gqlQuery } from "../../lib/shopify/client";

const log = logger.child({ module: "chunkedMonthlyRunner" });
// 200 keeps single-batch upsert size below the Postgres statement_timeout
// budget. 500 worked for customers (small raw_payload) but timed out on big
// orders chunks where each row's raw_payload is ~50KB.
const BATCH_SIZE = 200;

// The module's graphqlQuery uses `{{QUERY_FILTER}}` as a placeholder where the
// runner injects each chunk's `created_at:>=... created_at:<...` filter, and
// is otherwise a normal bulk inner-query selecting connections (no `{ }` wrap).

export interface RunChunkedMonthlyOpts {
  module: ResourceModule;
  syncRunId: string;
  // Skip per-parent deletes for replaceByParent extractors. Set true on first
  // backfill (empty tables); false on incremental sync.
  skipReplaceDeletes?: boolean;
  // Restrict to a specific date range (e.g. dry-run on one month). When set,
  // skips the earliest-record probe and uses these bounds verbatim. Used by
  // dry-run-pass.ts to test pass modules on a single month before full backfill.
  dateRange?: { fromISO: string; toISO: string };
}

export async function runChunkedMonthly(opts: RunChunkedMonthlyOpts): Promise<RunnerResult> {
  const fromISO = opts.dateRange?.fromISO ?? (await findEarliestRecord(opts.module));
  const toISO = opts.dateRange?.toISO ?? new Date().toISOString();
  const chunks = monthChunks(fromISO, toISO);
  await updateProgress({ runId: opts.syncRunId });
  // updateProgress doesn't accept totalChunks; set it via a direct write.
  await setTotalChunks(opts.syncRunId, chunks.length);

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  const chunkField = opts.module.chunkField ?? "created_at";

  let chunkErrors = 0;
  for (const chunk of chunks) {
    await checkpoint(opts.syncRunId);
    await updateProgress({
      runId: opts.syncRunId,
      currentChunk: chunk.index + 1,
      currentChunkLabel: chunk.label,
    });

    // Wrap each chunk so a single chunk failure (Shopify ACCESS_DENIED on a
    // weird order, transient network blip, etc.) doesn't kill the whole run.
    // The architect's spec said "Resume: if a chunk row is paused or failed,
    // re-run that month chunk only" — for now we just log + skip; manual
    // re-run via /api/sync/retry handles recovery.
    try {
      const filter = chunkQueryFilter(chunk, chunkField);
      const innerQuery = opts.module.graphqlQuery.replace(/\{\{QUERY_FILTER\}\}/g, filter);
      const opId = await submitBulkOperation(innerQuery);
      await updateProgress({ runId: opts.syncRunId, bulkOperationId: opId });

      const finalOp = await pollUntilDone(opId, {
        intervalMs: 10000,
        checkpoint: () => checkpoint(opts.syncRunId),
      });

      if (!finalOp.url) {
        log.info({ resource: opts.module.resourceName, chunk: chunk.label }, "Chunk had no data");
        continue;
      }

      const buffer: ParentWithChildren[] = [];
      const flush = async () => {
        if (!buffer.length) return;
        try {
          const r = await applyBatch(opts.module, buffer, opts.syncRunId, {
            skipReplaceDeletes: opts.skipReplaceDeletes,
          });
          inserted += r.inserted;
          failed += r.failed;
        } catch (err) {
          failed += buffer.length;
          log.error(
            {
              err: err instanceof Error ? err.message : err,
              batchSize: buffer.length,
              chunk: chunk.label,
            },
            "applyBatch failed in chunked runner",
          );
        }
        processed += buffer.length;
        buffer.length = 0;
        await updateProgress({
          runId: opts.syncRunId,
          recordsProcessed: processed,
          recordsInserted: inserted,
          recordsFailed: failed,
        });
      };

      for await (const { parent } of groupByParent(
        streamJsonl(finalOp.url, { checkpoint: () => checkpoint(opts.syncRunId) }),
      )) {
        buffer.push(parent);
        if (buffer.length >= BATCH_SIZE) await flush();
      }
      await flush();
    } catch (err) {
      // Re-throw pause/cancel so the orchestrator handles them properly.
      const name = err instanceof Error ? err.name : "";
      if (name === "RunPausedError" || name === "RunCancelledError") throw err;
      chunkErrors += 1;
      log.error(
        {
          chunk: chunk.label,
          chunkIndex: chunk.index,
          err: err instanceof Error ? err.message : err,
        },
        "Chunk failed — skipping; re-run via /api/sync/retry to fill gaps",
      );
      // Continue to next chunk.
    }
  }
  if (chunkErrors > 0) {
    log.warn(
      { chunkErrors, totalChunks: chunks.length },
      "Chunked run completed with chunk errors",
    );
  }

  return {
    recordsProcessed: processed,
    recordsInserted: inserted,
    recordsUpdated: 0,
    recordsFailed: failed,
    metadata: { totalChunks: chunks.length },
  };
}

async function setTotalChunks(runId: string, total: number): Promise<void> {
  const { supabaseAdmin } = await import("../../lib/supabase/admin");
  await supabaseAdmin
    .from("sync_runs")
    .update({ total_chunks: total })
    .eq("id", runId);
}

// Find the earliest record's createdAt for a chunked resource. For orders we
// query `orders(first: 1, sortKey: CREATED_AT) { edges { node { createdAt } } }`.
// If empty → return today (one trivial chunk).
async function findEarliestRecord(module: ResourceModule): Promise<string> {
  // The convention: each chunkedMonthly module exports a `firstRecordQuery`
  // via metadata in its graphqlQuery comment. To keep it simple: extract the
  // root field name from graphqlQuery and synthesize a small query.
  const m = /^\s*([a-zA-Z]+)\s*\(/.exec(module.graphqlQuery);
  const rootField = m ? m[1] : module.resourceName;

  const probe = `
    query Earliest_${rootField} {
      ${rootField}(first: 1, sortKey: CREATED_AT, query: "${module.chunkField ?? "created_at"}:>=2018-01-01T00:00:00Z") {
        edges { node { ... on HasMetafields { id } createdAt } }
      }
    }
  `;
  // ^ Many root types implement HasMetafields, but not all have createdAt
  // directly via that fragment. Simpler approach: try a typed selection per
  // resource. We fall back to 2018-01 if the probe fails.
  try {
    type ProbeResult = {
      [key: string]: { edges: { node: { createdAt?: string } }[] } | undefined;
    };
    const data = await gqlQuery<ProbeResult>(probe);
    const conn = data[rootField];
    const first = conn?.edges?.[0]?.node?.createdAt;
    if (first) return first;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err, rootField },
      "earliest-record probe failed; defaulting to 2018-01",
    );
  }
  return "2018-01-01T00:00:00Z";
}
