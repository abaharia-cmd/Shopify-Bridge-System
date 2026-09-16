// One-off CLI: dry-run a Phase 3 Wave 1 pass module on a single month.
// Used to validate each pass before the multi-hour full backfill.
//
// Usage: npm run dry-run-pass -- orders_pass_1 2024-08

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

const log = logger.child({ module: "dry-run-pass" });

interface CliArgs {
  passName: string;
  yearMonth: string; // 'YYYY-MM'
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npm run dry-run-pass -- <passName> <YYYY-MM>");
    console.error("Example: npm run dry-run-pass -- orders_pass_1 2024-08");
    process.exit(2);
  }
  const [passName, yearMonth] = args;
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    console.error(`Invalid YYYY-MM: ${yearMonth}`);
    process.exit(2);
  }
  return { passName, yearMonth };
}

async function main(): Promise<number> {
  const { passName, yearMonth } = parseArgs();
  const mod = resourceRegistry[passName];
  if (!mod) {
    console.error(`Unknown resource module: ${passName}`);
    return 1;
  }
  if (mod.syncStrategy !== "chunked_monthly") {
    console.error(`${passName} is ${mod.syncStrategy}, not chunked_monthly`);
    return 1;
  }

  // Single-month range: monthChunks() iterates UP TO and INCLUDING the toISO
  // month. Pass mid-month so it stays at exactly one chunk.
  const fromISO = `${yearMonth}-01T00:00:00Z`;
  const toISO = `${yearMonth}-15T00:00:00Z`;

  const runId = await createSyncRun({
    resourceName: passName,
    runType: "manual",
    triggeredBy: `script:dry-run-pass`,
    metadata: { dryRun: true, yearMonth, fromISO, toISO },
  });
  log.info({ runId, passName, yearMonth }, "Dry-run starting");
  await markRunning({ runId });
  const stopHb = startHeartbeat(runId);

  const beforeCounts = await snapshotChildCounts(mod);
  log.info({ beforeCounts }, "Child table counts BEFORE dry-run");

  try {
    const result = await runChunkedMonthly({
      module: mod,
      syncRunId: runId,
      skipReplaceDeletes: true, // pass 1's child tables are empty for this month
      dateRange: { fromISO, toISO },
    });
    log.info({ result }, "runChunkedMonthly returned");
    await finishRun({
      runId,
      status: result.recordsFailed > 0 ? "partial" : "succeeded",
    });

    const afterCounts = await snapshotChildCounts(mod);
    console.log("\n═══ child table impact ═══");
    for (const [t, before] of Object.entries(beforeCounts)) {
      const after = afterCounts[t] ?? 0;
      const delta = after - before;
      console.log(`  ${t.padEnd(45)} ${String(before).padStart(8)} → ${String(after).padStart(8)}  (Δ ${delta >= 0 ? "+" : ""}${delta})`);
    }
    console.log("");

    return result.recordsFailed > 0 ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, "Dry-run FAILED");
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
    console.error("dry-run-pass failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
