// Run a Phase 3 Wave 1 pass module across its FULL date range. One bulk op
// per month chunk, sequential (Shopify allows one bulk op per shop). Logs
// per-chunk progress so the operator can tail.
//
// Usage: npm run run-pass-full -- orders_pass_1
// Optional: --from YYYY-MM --to YYYY-MM to restrict the range.

import { runChunkedMonthly } from "../worker/runners/chunkedMonthlyRunner";
import {
  createSyncRun,
  markRunning,
  finishRun,
  startHeartbeat,
} from "../worker/progress";
import { resourceRegistry } from "../resources";
import { logger } from "../lib/logger";
import { getSupabaseAdmin } from "../lib/supabase/admin";

const log = logger.child({ module: "run-pass-full" });

interface CliArgs {
  passName: string;
  fromYM?: string;
  toYM?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npm run run-pass-full -- <passName> [--from YYYY-MM] [--to YYYY-MM]");
    process.exit(2);
  }
  const out: CliArgs = { passName: args[0] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) out.fromYM = args[++i];
    else if (args[i] === "--to" && args[i + 1]) out.toYM = args[++i];
  }
  return out;
}

async function main(): Promise<number> {
  const { passName, fromYM, toYM } = parseArgs();
  const mod = resourceRegistry[passName];
  if (!mod) {
    console.error(`Unknown resource module: ${passName}`);
    return 1;
  }
  if (mod.syncStrategy !== "chunked_monthly") {
    console.error(`${passName} is ${mod.syncStrategy}, not chunked_monthly`);
    return 1;
  }

  const dateRange = (fromYM || toYM)
    ? {
        fromISO: `${fromYM ?? "2018-01"}-01T00:00:00Z`,
        toISO: `${toYM ?? new Date().toISOString().slice(0, 7)}-15T00:00:00Z`,
      }
    : undefined;

  const runId = await createSyncRun({
    resourceName: passName,
    runType: "backfill",
    triggeredBy: "script:run-pass-full",
    metadata: { fromYM, toYM, dateRange },
  });
  log.info({ runId, passName, dateRange }, "Pass full backfill STARTING");
  await markRunning({ runId });
  const stopHb = startHeartbeat(runId);

  const beforeCounts = await snapshotChildCounts(mod);
  log.info({ beforeCounts }, "Child table counts BEFORE");

  const startedAt = Date.now();
  try {
    const result = await runChunkedMonthly({
      module: mod,
      syncRunId: runId,
      skipReplaceDeletes: true, // child tables are empty for first backfill
      dateRange,
    });
    const afterCounts = await snapshotChildCounts(mod);
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    log.info(
      { result, elapsedMin, afterCounts },
      "Pass full backfill DONE",
    );

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
    log.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, "Pass FAILED");
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
    console.error("run-pass-full failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
