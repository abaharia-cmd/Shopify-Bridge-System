// Boot-time housekeeping. Called once from instrumentation.ts.
// Marks any sync_runs whose heartbeat is stale (> 60s) as 'paused' so the
// control room shows a sane state after a server crash / restart.

import { supabaseAdmin } from "./supabase/admin";
import { logger } from "./logger";

const log = logger.child({ module: "initBoot" });
let booted = false;

export async function bootOnce(): Promise<void> {
  if (booted) return;
  booted = true;
  log.info("Boot: cleaning up stale sync runs");
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("sync_runs")
    .update({ status: "paused" })
    .eq("status", "running")
    .lt("heartbeat_at", cutoff)
    .select("id");
  if (error) {
    log.warn({ err: error.message }, "Boot stale-run cleanup failed");
    return;
  }
  if (data && (data as { id: string }[]).length > 0) {
    log.info(
      { count: (data as { id: string }[]).length },
      "Boot: paused stale runs",
    );
  }
}
