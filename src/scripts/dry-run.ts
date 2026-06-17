// Phase 2 dry-run. Exercises the shop + locations runners end-to-end against
// the real Shopify + Supabase, prints results, then exits. Does NOT touch
// customers/products/orders (those run via the orchestrator only).
//
//   npm run dry-run

import { createSyncRun, finishRun, markRunning } from "../worker/progress";
import { runSingleton } from "../worker/runners/singletonRunner";
import { runPaginated } from "../worker/runners/paginatedRunner";
import { logger } from "../lib/logger";
import shop from "../resources/shop";
import locations from "../resources/locations";
import { getSupabaseAdmin, supabaseAdmin } from "../lib/supabase/admin";

const log = logger.child({ module: "dry-run" });

async function exercise<T extends { syncStrategy: string; resourceName: string }>(
  module: T,
  runner: (opts: { module: T; syncRunId: string }) => Promise<{
    recordsProcessed: number;
    recordsInserted: number;
    recordsFailed: number;
  }>,
): Promise<{ ok: boolean; runId: string; result?: unknown; err?: string }> {
  const runId = await createSyncRun({
    resourceName: module.resourceName,
    runType: "manual",
    triggeredBy: "dry-run",
  });
  log.info({ runId, resource: module.resourceName }, "Starting dry-run");
  await markRunning({ runId });
  try {
    const result = await runner({ module, syncRunId: runId });
    await finishRun({
      runId,
      status: result.recordsFailed > 0 ? "partial" : "succeeded",
    });
    return { ok: true, runId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun({ runId, status: "failed", errorMessage: msg });
    return { ok: false, runId, err: msg };
  }
}

async function verifyRow(table: string): Promise<number> {
  const dataDb = getSupabaseAdmin("shopify");
  const { count, error } = await dataDb
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`verify ${table}: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<number> {
  let failed = 0;

  log.info("=== shop ===");
  const shopRes = await exercise(shop, runSingleton);
  if (!shopRes.ok) {
    log.error({ err: shopRes.err }, "shop runner failed");
    failed += 1;
  } else {
    const count = await verifyRow("shop");
    log.info({ result: shopRes.result, rowCount: count }, "shop OK");
  }

  log.info("=== locations ===");
  const locRes = await exercise(locations, runPaginated);
  if (!locRes.ok) {
    log.error({ err: locRes.err }, "locations runner failed");
    failed += 1;
  } else {
    const count = await verifyRow("locations");
    log.info({ result: locRes.result, rowCount: count }, "locations OK");
  }

  // Print last 3 sync_run rows for visibility
  const { data: recent } = await supabaseAdmin
    .from("sync_runs")
    .select("id, resource_name, status, records_processed, records_inserted, duration_ms")
    .in("resource_name", ["shop", "locations"])
    .order("created_at", { ascending: false })
    .limit(4);
  log.info({ recent }, "Recent sync_runs rows");

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err }, "Unexpected dry-run failure");
    process.exit(1);
  });
