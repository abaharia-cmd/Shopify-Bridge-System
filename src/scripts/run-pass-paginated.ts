// Run a Phase 3 Wave 1.5+ pass module that uses runPaginatedWithBatch
// (paginated GraphQL with buffered applyBatch — for resources where bulk
// JSONL can't be used).
//
// Usage:
//   npm run run-pass-paginated -- orders_pass_4
//   npm run run-pass-paginated -- orders_pass_4 --from 2024-08 --to 2024-08
//   npm run run-pass-paginated -- orders_pass_4 --dry-run 2024-08

import { runPaginatedWithBatch } from "../worker/runners/paginatedWithBatchRunner";
import {
  createSyncRun,
  markRunning,
  finishRun,
  startHeartbeat,
} from "../worker/progress";
import { resourceRegistry } from "../resources";
import { logger } from "../lib/logger";
import { getSupabaseAdmin } from "../lib/supabase/admin";

const log = logger.child({ module: "run-pass-paginated" });

interface CliArgs {
  passName: string;
  fromYM?: string;
  toYM?: string;
  dryRunYM?: string; // shortcut: --dry-run YYYY-MM sets from=YYYY-MM, to=YYYY-MM
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npm run run-pass-paginated -- <passName> [--from YYYY-MM] [--to YYYY-MM] | [--dry-run YYYY-MM]");
    process.exit(2);
  }
  const out: CliArgs = { passName: args[0] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) out.fromYM = args[++i];
    else if (args[i] === "--to" && args[i + 1]) out.toYM = args[++i];
    else if (args[i] === "--dry-run" && args[i + 1]) out.dryRunYM = args[++i];
  }
  return out;
}

async function main(): Promise<number> {
  const { passName, fromYM, toYM, dryRunYM } = parseArgs();
  const mod = resourceRegistry[passName];
  if (!mod) {
    console.error(`Unknown resource module: ${passName}`);
    return 1;
  }

  // Date range. dry-run shorthand pins to a single month, padded to mid-month
  // so monthChunks() produces exactly one chunk.
  let dateRange: { fromISO: string; toISO: string } | undefined;
  if (dryRunYM) {
    dateRange = {
      fromISO: `${dryRunYM}-01T00:00:00Z`,
      toISO: `${dryRunYM}-15T00:00:00Z`,
    };
  } else if (fromYM || toYM) {
    dateRange = {
      fromISO: `${fromYM ?? "2018-01"}-01T00:00:00Z`,
      toISO: `${toYM ?? new Date().toISOString().slice(0, 7)}-15T00:00:00Z`,
    };
  }

  const runId = await createSyncRun({
    resourceName: passName,
    runType: dryRunYM ? "manual" : "backfill",
    triggeredBy: dryRunYM ? "script:dry-run-paginated" : "script:run-pass-paginated",
    metadata: { dryRunYM, fromYM, toYM, dateRange },
  });
  log.info({ runId, passName, dateRange, dryRunYM }, dryRunYM ? "Paginated DRY-RUN starting" : "Paginated full backfill STARTING");
  await markRunning({ runId });
  const stopHb = startHeartbeat(runId);

  const beforeCounts = await snapshotChildCounts(mod);
  log.info({ beforeCounts }, "Child table counts BEFORE");

  const startedAt = Date.now();
  try {
    const result = await runPaginatedWithBatch({
      module: mod,
      syncRunId: runId,
      dateRange,
      skipReplaceDeletes: true, // safe: pass-4 target tables are empty
    });
    const afterCounts = await snapshotChildCounts(mod);
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    log.info({ result, elapsedMin, afterCounts }, "Paginated run DONE");

    console.log("\n═══ Pass complete ═══");
    console.log(`  elapsed: ${elapsedMin} min`);
    console.log(`  recordsProcessed (orders): ${result.recordsProcessed}`);
    console.log(`  recordsInserted (children): ${result.recordsInserted}`);
    console.log(`  recordsFailed: ${result.recordsFailed}`);
    console.log("\n  child table impact:");
    for (const [t, before] of Object.entries(beforeCounts)) {
      const after = afterCounts[t] ?? 0;
      const delta = after - before;
      console.log(
        `    ${t.padEnd(45)} ${String(before).padStart(8)} → ${String(after).padStart(8)}  (+${delta})`,
      );
    }
    console.log("");

    await finishRun({
      runId,
      status: result.recordsFailed > 0 ? "partial" : "succeeded",
    });
    return result.recordsFailed > 0 ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, "Paginated run FAILED");
    await finishRun({ runId, status: "failed", errorMessage: msg });
    return 1;
  } finally {
    stopHb();
  }
}

async function snapshotChildCounts(mod: { childExtractors?: { table: string }[] }): Promise<Record<string, number>> {
  const dataDb = getSupabaseAdmin("shopify");
  const out: Record<string, number> = {};
  for (const ext of mod.childExtractors ?? []) {
    const { count } = await dataDb.from(ext.table).select("*", { count: "exact", head: true });
    out[ext.table] = count ?? 0;
  }
  return out;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("run-pass-paginated failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
