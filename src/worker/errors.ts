// Error logging + dead-letter queue writes. All sync error paths funnel
// through here so the control room sees a single source of truth.

import { supabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";

const log = logger.child({ module: "worker.errors" });

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface LogErrorOpts {
  source: string; // e.g. 'orchestrator', 'bulkRunner', 'paginatedRunner.locations'
  severity?: ErrorSeverity;
  resourceName?: string;
  syncRunId?: string;
  errorCode?: string;
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
}

export async function logError(opts: LogErrorOpts): Promise<void> {
  const row = {
    source: opts.source,
    severity: opts.severity ?? "error",
    resource_name: opts.resourceName ?? null,
    sync_run_id: opts.syncRunId ?? null,
    error_code: opts.errorCode ?? null,
    error_message: opts.errorMessage,
    stack_trace: opts.stackTrace ?? null,
    context: opts.context ?? {},
  };
  const { error } = await supabaseAdmin.from("error_log").insert(row);
  if (error) {
    log.error(
      { dbError: error.message, original: opts.errorMessage },
      "Failed to write to error_log",
    );
  }
}

export interface DeadLetterOpts {
  resourceName: string;
  shopifyId?: string | null;
  source: string;
  rawPayload?: unknown;
  errorMessage: string;
}

// Idempotent dead-letter write — increments retry_count if the same
// (resource_name, shopify_id, source) row already exists, else inserts.
export async function pushDeadLetter(opts: DeadLetterOpts): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from("dead_letter_queue")
    .select("id, retry_count")
    .eq("resource_name", opts.resourceName)
    .eq("source", opts.source)
    .eq("shopify_id", opts.shopifyId ?? "")
    .eq("resolved", false)
    .maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from("dead_letter_queue")
      .update({
        retry_count: (existing.retry_count as number) + 1,
        last_failed_at: new Date().toISOString(),
        error_message: opts.errorMessage,
        raw_payload: opts.rawPayload ?? null,
      })
      .eq("id", existing.id);
    if (error) log.error({ err: error.message }, "DLQ update failed");
    return;
  }

  const { error } = await supabaseAdmin.from("dead_letter_queue").insert({
    resource_name: opts.resourceName,
    shopify_id: opts.shopifyId ?? null,
    source: opts.source,
    raw_payload: opts.rawPayload ?? null,
    error_message: opts.errorMessage,
  });
  if (error) log.error({ err: error.message }, "DLQ insert failed");
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

export function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
