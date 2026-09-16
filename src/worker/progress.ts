// sync_runs lifecycle helpers + heartbeat. Every state change in a run goes
// through here so the control room can show consistent data.

import { supabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";

const log = logger.child({ module: "worker.progress" });

export type SyncRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "partial";

export type SyncRunType =
  | "backfill"
  | "incremental"
  | "webhook"
  | "reconciliation"
  | "deep_reconciliation"
  | "manual";

export interface CreateRunOpts {
  resourceName: string;
  runType: SyncRunType;
  triggeredBy: string;
  metadata?: Record<string, unknown>;
}

export async function createSyncRun(opts: CreateRunOpts): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("sync_runs")
    .insert({
      resource_name: opts.resourceName,
      run_type: opts.runType,
      status: "queued",
      triggered_by: opts.triggeredBy,
      metadata: opts.metadata ?? {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`createSyncRun: ${error.message}`);
  return (data as { id: string }).id;
}

export interface MarkRunningOpts {
  runId: string;
  totalChunks?: number;
}

export async function markRunning(opts: MarkRunningOpts): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: "running",
    started_at: now,
    heartbeat_at: now,
  };
  if (opts.totalChunks !== undefined) patch.total_chunks = opts.totalChunks;
  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update(patch)
    .eq("id", opts.runId);
  if (error) throw new Error(`markRunning: ${error.message}`);
}

export async function heartbeat(runId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) log.warn({ err: error.message, runId }, "heartbeat failed");
}

export interface UpdateProgressOpts {
  runId: string;
  recordsProcessed?: number;
  recordsInserted?: number;
  recordsUpdated?: number;
  recordsFailed?: number;
  currentChunk?: number;
  currentChunkLabel?: string;
  bulkOperationId?: string;
  cursorEnd?: string;
}

export async function updateProgress(opts: UpdateProgressOpts): Promise<void> {
  const patch: Record<string, unknown> = {
    heartbeat_at: new Date().toISOString(),
  };
  if (opts.recordsProcessed !== undefined) patch.records_processed = opts.recordsProcessed;
  if (opts.recordsInserted !== undefined) patch.records_inserted = opts.recordsInserted;
  if (opts.recordsUpdated !== undefined) patch.records_updated = opts.recordsUpdated;
  if (opts.recordsFailed !== undefined) patch.records_failed = opts.recordsFailed;
  if (opts.currentChunk !== undefined) patch.current_chunk = opts.currentChunk;
  if (opts.currentChunkLabel !== undefined) patch.current_chunk_label = opts.currentChunkLabel;
  if (opts.bulkOperationId !== undefined) patch.bulk_operation_id = opts.bulkOperationId;
  if (opts.cursorEnd !== undefined) patch.cursor_end = opts.cursorEnd;
  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update(patch)
    .eq("id", opts.runId);
  if (error) log.warn({ err: error.message, runId: opts.runId }, "updateProgress failed");
}

export interface FinishRunOpts {
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "partial" | "paused";
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export async function finishRun(opts: FinishRunOpts): Promise<void> {
  // duration_ms is a generated column in Phase 1 — Postgres computes it from
  // (completed_at - started_at). We only set completed_at + heartbeat_at.
  const completed = new Date();
  const patch: Record<string, unknown> = {
    status: opts.status,
    completed_at: completed.toISOString(),
    heartbeat_at: completed.toISOString(),
  };
  if (opts.errorMessage !== undefined) patch.error_message = opts.errorMessage;
  if (opts.metadata !== undefined) patch.metadata = opts.metadata;

  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update(patch)
    .eq("id", opts.runId);
  if (error) log.error({ err: error.message, runId: opts.runId }, "finishRun failed");
}

// Heartbeat loop — returns a stop function. Call from a background runner
// to keep the row's heartbeat_at fresh while long-running work happens.
export function startHeartbeat(runId: string, intervalMs = 5000): () => void {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      await heartbeat(runId);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}

// Read the current status of a run — used by checkpoint() to detect
// pause/cancel requests issued while a runner is mid-flight.
export async function getRunStatus(runId: string): Promise<SyncRunStatus> {
  const { data, error } = await supabaseAdmin
    .from("sync_runs")
    .select("status")
    .eq("id", runId)
    .single();
  if (error) throw new Error(`getRunStatus: ${error.message}`);
  return (data as { status: SyncRunStatus }).status;
}

export class RunPausedError extends Error {
  constructor(public readonly runId: string) {
    super(`run ${runId} paused`);
    this.name = "RunPausedError";
  }
}

export class RunCancelledError extends Error {
  constructor(public readonly runId: string) {
    super(`run ${runId} cancelled`);
    this.name = "RunCancelledError";
  }
}

// Throws if the run was paused/cancelled. Runners call this between safe
// boundaries (after each page, after each chunk, every N JSONL lines).
export async function checkpoint(runId: string): Promise<void> {
  const status = await getRunStatus(runId);
  if (status === "paused") throw new RunPausedError(runId);
  if (status === "cancelled") throw new RunCancelledError(runId);
}
