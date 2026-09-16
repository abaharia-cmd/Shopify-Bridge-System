// Master orchestrator: kicks off a backfill, iterates the active resources by
// priority, runs each via the appropriate runner, tracks the master run row
// and per-resource run rows, and handles pause/resume/cancel.

import { supabaseAdmin, getSupabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";
import { logError, errorMessage, errorStack } from "./errors";
import {
  createSyncRun,
  finishRun,
  markRunning,
  startHeartbeat,
  RunPausedError,
  RunCancelledError,
  updateProgress,
} from "./progress";
import { runSingleton } from "./runners/singletonRunner";
import { runPaginated } from "./runners/paginatedRunner";
import { runBulk } from "./runners/bulkRunner";
import { runChunkedMonthly } from "./runners/chunkedMonthlyRunner";
import type { ResourceModule, RunnerResult } from "../resources/types";
import { resourceRegistry } from "../resources";

const log = logger.child({ module: "orchestrator" });

const MASTER_RESOURCE = "_master_backfill";

// In-process flag — only one backfill at a time. The Supabase row is the
// durable source of truth; this just prevents accidental double-trigger
// from the same process.
let inFlightMasterRunId: string | null = null;

export async function startBackfill(opts: {
  triggeredBy: string;
}): Promise<{ masterRunId: string }> {
  await ensureMasterResource();

  if (inFlightMasterRunId) {
    log.warn({ inFlightMasterRunId }, "Backfill already in flight (in-process)");
    return { masterRunId: inFlightMasterRunId };
  }

  // Hard guard: don't start if another orchestrator (e.g. a previous server
  // process) left a `running` row behind. Boot cleanup should normally cover
  // this, but defend in depth.
  const { data: stale } = await supabaseAdmin
    .from("sync_runs")
    .select("id, status")
    .eq("resource_name", MASTER_RESOURCE)
    .in("status", ["running", "queued"])
    .limit(1)
    .maybeSingle();
  if (stale) {
    const id = (stale as { id: string }).id;
    log.warn({ existingMasterRunId: id }, "Existing master run found; reusing");
    inFlightMasterRunId = id;
    void runBackfill(id);
    return { masterRunId: id };
  }

  const masterRunId = await createSyncRun({
    resourceName: MASTER_RESOURCE,
    runType: "backfill",
    triggeredBy: opts.triggeredBy,
  });
  inFlightMasterRunId = masterRunId;
  // Fire-and-forget: do NOT await.
  void runBackfill(masterRunId);
  return { masterRunId };
}

export async function pauseActiveRun(): Promise<void> {
  await mutateActiveRuns("paused");
}

export async function resumeActiveRun(): Promise<void> {
  // Find paused master + paused per-resource rows, mark them queued so the
  // next orchestrator pass picks them up. Then re-trigger the orchestrator.
  const { data: pausedMasters } = await supabaseAdmin
    .from("sync_runs")
    .select("id")
    .eq("resource_name", MASTER_RESOURCE)
    .eq("status", "paused")
    .order("created_at", { ascending: false })
    .limit(1);
  const masterId =
    pausedMasters && pausedMasters.length
      ? (pausedMasters[0] as { id: string }).id
      : null;
  if (!masterId) {
    log.info("resumeActiveRun: no paused master run to resume");
    return;
  }
  await supabaseAdmin
    .from("sync_runs")
    .update({ status: "queued" })
    .eq("id", masterId);
  inFlightMasterRunId = masterId;
  void runBackfill(masterId);
}

export async function cancelActiveRun(): Promise<void> {
  await mutateActiveRuns("cancelled");
  inFlightMasterRunId = null;
}

// Resume ingest of a `bulk` resource from an existing JSONL URL — bypasses
// Shopify resubmission and the 5-30+ min generation wait. Looks up the most
// recent COMPLETED bulk_operations row for the resource and pipes its URL
// through runBulk via the existingOp param. Useful when ingest crashed
// mid-stream or when iterating on the worker side without re-paying Shopify.
export async function resumeBulk(opts: {
  resourceName: string;
  triggeredBy: string;
}): Promise<{ runId: string; bulkOperationId: string }> {
  const mod = resourceRegistry[opts.resourceName];
  if (!mod) throw new Error(`Unknown resource: ${opts.resourceName}`);
  if (mod.syncStrategy !== "bulk") {
    throw new Error(
      `resumeBulk only valid for syncStrategy=bulk; ${opts.resourceName} is ${mod.syncStrategy}`,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("bulk_operations")
    .select("shopify_operation_id, jsonl_url, status")
    .eq("resource_name", opts.resourceName)
    .eq("status", "COMPLETED")
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`bulk_operations lookup: ${error.message}`);
  const row = data as
    | { shopify_operation_id: string; jsonl_url: string | null; status: string }
    | null;
  if (!row) {
    throw new Error(
      `No COMPLETED bulk_operations row for resource ${opts.resourceName} — submit a fresh run instead`,
    );
  }
  if (!row.jsonl_url) {
    throw new Error(
      `bulk_operations row for ${opts.resourceName} has no JSONL URL (was empty result)`,
    );
  }

  // Look up the most recent prior sync_run for this resource that recorded
  // a jsonl_offset. If found, resume from that byte to skip already-flushed
  // batches. Cuts re-processing time on retries from "full file" to "tail".
  const startByte = await loadJsonlOffset(opts.resourceName, row.shopify_operation_id);

  const runId = await createSyncRun({
    resourceName: opts.resourceName,
    runType: "manual",
    triggeredBy: opts.triggeredBy,
    metadata: {
      resumedFromBulkOp: row.shopify_operation_id,
      ...(startByte > 0 ? { resumedFromByte: startByte } : {}),
    },
  });

  void (async () => {
    const stop = startHeartbeat(runId);
    try {
      await markRunning({ runId });
      const skipReplaceDeletes = await isFirstBackfill(opts.resourceName);
      const result = await runBulk({
        module: mod,
        syncRunId: runId,
        existingOp: { id: row.shopify_operation_id, url: row.jsonl_url! },
        startByte,
        skipReplaceDeletes,
      });
      await finishRun({
        runId,
        status: result.recordsFailed > 0 ? "partial" : "succeeded",
      });
      await touchResourceRegistry(mod);
    } catch (err) {
      await logError({
        source: "orchestrator.resumeBulk",
        resourceName: opts.resourceName,
        syncRunId: runId,
        errorMessage: errorMessage(err),
        stackTrace: errorStack(err),
      });
      await finishRun({ runId, status: "failed", errorMessage: errorMessage(err) });
    } finally {
      stop();
    }
  })();

  return { runId, bulkOperationId: row.shopify_operation_id };
}

export async function retryChunk(opts: {
  resourceName: string;
  chunkLabel?: string;
}): Promise<{ runId: string }> {
  // Single-resource retry. Creates a fresh run for that resource, runs it,
  // and returns. Useful from the control room "Retry" button on failed rows.
  const mod = resourceRegistry[opts.resourceName];
  if (!mod) throw new Error(`Unknown resource: ${opts.resourceName}`);
  const runId = await createSyncRun({
    resourceName: opts.resourceName,
    runType: "manual",
    triggeredBy: "control-room.retry",
    metadata: opts.chunkLabel ? { chunkLabel: opts.chunkLabel } : {},
  });
  void (async () => {
    const stop = startHeartbeat(runId);
    try {
      await markRunning({ runId });
      const skipReplaceDeletes = await isFirstBackfill(opts.resourceName);
      const result = await dispatch(mod, runId, { skipReplaceDeletes });
      await finishRun({
        runId,
        status: result.recordsFailed > 0 ? "partial" : "succeeded",
      });
    } catch (err) {
      await logError({
        source: "orchestrator.retryChunk",
        resourceName: opts.resourceName,
        syncRunId: runId,
        errorMessage: errorMessage(err),
        stackTrace: errorStack(err),
      });
      await finishRun({ runId, status: "failed", errorMessage: errorMessage(err) });
    } finally {
      stop();
    }
  })();
  return { runId };
}

// ---------- internals ----------

async function mutateActiveRuns(
  newStatus: "paused" | "cancelled",
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update({ status: newStatus })
    .in("status", ["running", "queued"]);
  if (error) {
    log.error({ err: error.message }, `mutateActiveRuns(${newStatus}) failed`);
    throw new Error(error.message);
  }
}

async function runBackfill(masterRunId: string): Promise<void> {
  const stopHeartbeat = startHeartbeat(masterRunId);
  const perResourceTotals = { processed: 0, inserted: 0, failed: 0 };
  let resourcesOk = 0;
  let resourcesFailed = 0;

  try {
    await markRunning({ runId: masterRunId });

    const { data: registry, error } = await supabaseAdmin
      .from("resource_registry")
      .select("resource_name, priority")
      .eq("status", "active")
      .neq("resource_name", MASTER_RESOURCE)
      .order("priority", { ascending: true });
    if (error) throw new Error(`load registry: ${error.message}`);

    for (const row of (registry as { resource_name: string; priority: number }[]) ?? []) {
      const mod = resourceRegistry[row.resource_name];
      if (!mod) {
        log.warn(
          { resource_name: row.resource_name },
          "Active resource has no implemented module — skipping",
        );
        continue;
      }

      const childRunId = await createSyncRun({
        resourceName: mod.resourceName,
        runType: "backfill",
        triggeredBy: `master:${masterRunId}`,
      });
      const stopChildHb = startHeartbeat(childRunId);
      try {
        await markRunning({ runId: childRunId });
        const skipReplaceDeletes = await isFirstBackfill(mod.resourceName);
        const result = await dispatch(mod, childRunId, { skipReplaceDeletes });
        perResourceTotals.processed += result.recordsProcessed;
        perResourceTotals.inserted += result.recordsInserted;
        perResourceTotals.failed += result.recordsFailed;
        const status = result.recordsFailed > 0 ? "partial" : "succeeded";
        await finishRun({ runId: childRunId, status });
        await touchResourceRegistry(mod);
        resourcesOk += 1;
      } catch (err) {
        if (err instanceof RunPausedError) {
          await finishRun({ runId: childRunId, status: "paused" });
          // Cascade pause to the master run and stop processing further
          // resources. The user can resume later.
          await supabaseAdmin
            .from("sync_runs")
            .update({ status: "paused" })
            .eq("id", masterRunId);
          throw err;
        }
        if (err instanceof RunCancelledError) {
          await finishRun({ runId: childRunId, status: "cancelled" });
          throw err;
        }
        resourcesFailed += 1;
        await logError({
          source: "orchestrator.runBackfill",
          resourceName: mod.resourceName,
          syncRunId: childRunId,
          errorMessage: errorMessage(err),
          stackTrace: errorStack(err),
        });
        await finishRun({
          runId: childRunId,
          status: "failed",
          errorMessage: errorMessage(err),
        });
        // Continue with the next resource — one failure shouldn't kill the run.
      } finally {
        stopChildHb();
      }

      // Update the master row's running tallies.
      await updateProgress({
        runId: masterRunId,
        recordsProcessed: perResourceTotals.processed,
        recordsInserted: perResourceTotals.inserted,
        recordsFailed: perResourceTotals.failed,
      });
    }

    const masterStatus =
      resourcesFailed === 0 ? "succeeded" : resourcesOk > 0 ? "partial" : "failed";
    await finishRun({
      runId: masterRunId,
      status: masterStatus,
      metadata: { resourcesOk, resourcesFailed },
    });
  } catch (err) {
    if (err instanceof RunPausedError) {
      log.info({ masterRunId }, "Backfill paused");
    } else if (err instanceof RunCancelledError) {
      await finishRun({ runId: masterRunId, status: "cancelled" });
    } else {
      await logError({
        source: "orchestrator.runBackfill",
        syncRunId: masterRunId,
        errorMessage: errorMessage(err),
        stackTrace: errorStack(err),
        severity: "critical",
      });
      await finishRun({
        runId: masterRunId,
        status: "failed",
        errorMessage: errorMessage(err),
      });
    }
  } finally {
    stopHeartbeat();
    if (inFlightMasterRunId === masterRunId) inFlightMasterRunId = null;
  }
}

interface DispatchOpts {
  // True when this is the resource's first backfill — runners can skip
  // delete-by-parent for replaceByParent child extractors (empty tables, no
  // rows to delete). ~3-10x speedup on bulk resources.
  skipReplaceDeletes?: boolean;
}

async function dispatch(
  module: ResourceModule,
  syncRunId: string,
  opts: DispatchOpts = {},
): Promise<RunnerResult> {
  switch (module.syncStrategy) {
    case "singleton":
      return runSingleton({ module, syncRunId });
    case "paginated":
      return runPaginated({ module, syncRunId });
    case "bulk":
      return runBulk({
        module,
        syncRunId,
        skipReplaceDeletes: opts.skipReplaceDeletes,
      });
    case "chunked_monthly":
      return runChunkedMonthly({
        module,
        syncRunId,
        skipReplaceDeletes: opts.skipReplaceDeletes,
      });
    default:
      throw new Error(`Unknown syncStrategy: ${module.syncStrategy as string}`);
  }
}

// Resource is considered "first backfill" if its registry phase is still
// 'not_started'. Once any backfill completes (succeeded/partial), we flip
// phase to 'backfill_complete' and incremental runs use the safer slow path
// with delete-by-parent.
async function isFirstBackfill(resourceName: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("resource_registry")
    .select("phase")
    .eq("resource_name", resourceName)
    .single();
  return (data as { phase: string } | null)?.phase === "not_started";
}

async function touchResourceRegistry(module: ResourceModule): Promise<void> {
  // total_records_synced is authoritative as of NOW. Read the actual table
  // count instead of incrementing by result.recordsInserted — runner counts
  // include idempotent upsert no-ops on resume-bulk / retry, which double-
  // counted the registry (e.g. products → 61,298 ≈ 2× of 30,749, locations
  // → 14 = 2× of 7). The table is the source of truth.
  const dataDb = getSupabaseAdmin("shopify");
  const { count, error: countErr } = await dataDb
    .from(module.table)
    .select("*", { count: "exact", head: true });
  if (countErr) {
    log.warn(
      { err: countErr.message, resource: module.resourceName, table: module.table },
      "touchResourceRegistry: count failed, leaving counter untouched",
    );
    return;
  }
  const { error } = await supabaseAdmin
    .from("resource_registry")
    .update({
      total_records_synced: count ?? 0,
      last_backfill_at: new Date().toISOString(),
      phase: "backfill_complete",
    })
    .eq("resource_name", module.resourceName);
  if (error) {
    log.warn({ err: error.message, resource: module.resourceName }, "touchResourceRegistry failed");
  }
}

// Find the highest jsonl_offset across prior sync_runs that ingested the
// SAME bulk operation. Used by resumeBulk to skip already-flushed bytes via
// a Range request. Different bulk ops produce different JSONL files, so
// offsets aren't comparable across ops — we restrict to runs that touched
// the given bulkOperationId (either via the bulk_operation_id column on the
// run row, or via metadata.resumedFromBulkOp on a prior resume).
async function loadJsonlOffset(
  resourceName: string,
  bulkOperationId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("sync_runs")
    .select("metadata, bulk_operation_id")
    .eq("resource_name", resourceName)
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) {
    log.warn({ err: error.message, resourceName }, "loadJsonlOffset: query failed");
    return 0;
  }
  let best = 0;
  for (const row of (data as {
    metadata: Record<string, unknown> | null;
    bulk_operation_id: string | null;
  }[]) ?? []) {
    const m = row.metadata ?? {};
    const offset = Number(m.jsonl_offset ?? 0);
    if (offset <= 0) continue;
    const sameOp =
      row.bulk_operation_id === bulkOperationId ||
      String(m.resumedFromBulkOp ?? "") === bulkOperationId;
    if (sameOp && offset > best) best = offset;
  }
  return best;
}

// Idempotently register the meta-resource the master run row references.
// resource_registry has a strict FK from sync_runs.resource_name, so the
// orchestrator can't insert a master row until the meta-resource exists.
async function ensureMasterResource(): Promise<void> {
  const { data } = await supabaseAdmin
    .from("resource_registry")
    .select("resource_name")
    .eq("resource_name", MASTER_RESOURCE)
    .maybeSingle();
  if (data) return;
  const { error } = await supabaseAdmin.from("resource_registry").insert({
    resource_name: MASTER_RESOURCE,
    display_name: "Master Backfill (orchestrator)",
    category: "meta",
    status: "active",
    phase: "not_started",
    bulk_op_supported: false,
    priority: 0,
    notes: "Synthetic resource representing the multi-resource backfill orchestrator run.",
  });
  if (error && !error.message.includes("duplicate key")) {
    throw new Error(`ensureMasterResource: ${error.message}`);
  }
}
