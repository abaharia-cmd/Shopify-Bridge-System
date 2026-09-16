// Generic CLI: sync ONE resource by name. Picks the right runner based on
// the module's syncStrategy. Used for Wave 2 / ad-hoc resource backfills.
//
// Usage: npm run sync-resource -- <resource_name>

import { runSingleton } from "../worker/runners/singletonRunner";
import { runPaginated } from "../worker/runners/paginatedRunner";
import { runBulk } from "../worker/runners/bulkRunner";
import { runChunkedMonthly } from "../worker/runners/chunkedMonthlyRunner";
import { runPaginatedWithBatch } from "../worker/runners/paginatedWithBatchRunner";
import {
  createSyncRun,
  markRunning,
  finishRun,
  startHeartbeat,
} from "../worker/progress";
import { resourceRegistry } from "../resources";
import { logger } from "../lib/logger";
import { getSupabaseAdmin, supabaseAdmin } from "../lib/supabase/admin";

const log = logger.child({ module: "sync-resource" });

async function main(): Promise<number> {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: npm run sync-resource -- <resource_name>");
    return 2;
  }
  const mod = resourceRegistry[name];
  if (!mod) {
    console.error(`Unknown resource module: ${name}`);
    return 1;
  }

  const runId = await createSyncRun({
    resourceName: name,
    runType: "backfill",
    triggeredBy: "script:sync-resource",
  });
  log.info({ runId, name, strategy: mod.syncStrategy }, "Sync starting");
  await markRunning({ runId });
  const stopHb = startHeartbeat(runId);

  // Snapshot main + child counts before
  const dataDb = getSupabaseAdmin("shopify");
  const tables = [mod.table, ...(mod.childExtractors?.map((c) => c.table) ?? [])];
  const before: Record<string, number> = {};
  for (const t of tables) {
    const { count } = await dataDb.from(t).select("*", { count: "exact", head: true });
    before[t] = count ?? 0;
  }

  // Determine if first-backfill (skip replace-deletes)
  const { data: regRow } = await supabaseAdmin
    .from("resource_registry")
    .select("phase")
    .eq("resource_name", name)
    .single();
  const skipReplaceDeletes = (regRow as { phase: string } | null)?.phase === "not_started";

  const startedAt = Date.now();
  try {
    let result;
    switch (mod.syncStrategy) {
      case "singleton":
        result = await runSingleton({ module: mod, syncRunId: runId });
        break;
      case "paginated":
        result = await runPaginated({ module: mod, syncRunId: runId });
        break;
      case "paginated_batch":
        result = await runPaginatedWithBatch({ module: mod, syncRunId: runId, skipReplaceDeletes });
        break;
      case "bulk":
        result = await runBulk({ module: mod, syncRunId: runId, skipReplaceDeletes });
        break;
      case "chunked_monthly":
        result = await runChunkedMonthly({ module: mod, syncRunId: runId, skipReplaceDeletes });
        break;
      default:
        throw new Error(`Unknown syncStrategy: ${mod.syncStrategy}`);
    }
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(2);
    const after: Record<string, number> = {};
    for (const t of tables) {
      const { count } = await dataDb.from(t).select("*", { count: "exact", head: true });
      after[t] = count ?? 0;
    }
    await finishRun({
      runId,
      status: result.recordsFailed > 0 ? "partial" : "succeeded",
    });
    console.log(`\n═══ ${name} complete ═══`);
    console.log(`  elapsed: ${elapsedMin} min`);
    console.log(`  recordsProcessed: ${result.recordsProcessed}`);
    console.log(`  recordsInserted: ${result.recordsInserted}`);
    console.log(`  recordsFailed: ${result.recordsFailed}`);
    console.log(`  table impact:`);
    for (const t of tables) {
      const d = (after[t] ?? 0) - (before[t] ?? 0);
      console.log(`    ${t.padEnd(45)} ${String(before[t]).padStart(8)} → ${String(after[t]).padStart(8)}  (+${d})`);
    }
    console.log("");
    return result.recordsFailed > 0 ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, "Sync FAILED");
    await finishRun({ runId, status: "failed", errorMessage: msg });
    return 1;
  } finally {
    stopHb();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("sync-resource failed:", e instanceof Error ? e.stack : e);
    process.exit(1);
  });
