// Upsert helpers into the `shopify` (data) schema. The default supabaseAdmin
// targets `shopify_sync` for metadata; all data writes use `getSupabaseAdmin('shopify')`.

import { getSupabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";
import { withRetry } from "./retry";
import { logError } from "./errors";

const log = logger.child({ module: "worker.upsert" });
const dataDb = getSupabaseAdmin("shopify");

export interface UpsertResult {
  inserted: number;
  updated: number; // PostgREST doesn't reliably distinguish — we count attempts that returned a row.
  failed: number;
  attempted: number;
}

const BATCH_SIZE = 500;

export interface UpsertOpts {
  onConflict?: string;
  // Optional context for error_log entries when a sub-batch fails.
  syncRunId?: string;
  resourceName?: string;
}

export async function upsertBatch(
  table: string,
  rows: Record<string, unknown>[],
  opts: UpsertOpts = {},
): Promise<UpsertResult> {
  if (!rows.length) return { inserted: 0, updated: 0, failed: 0, attempted: 0 };
  const result: UpsertResult = { inserted: 0, updated: 0, failed: 0, attempted: rows.length };
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      // Wrap in withRetry — Supabase pooler occasionally blips with
      // `TypeError: fetch failed`; that should not kill a multi-hour run.
      await withRetry(
        async () => {
          const { error, count } = await dataDb
            .from(table)
            .upsert(slice, { onConflict: opts.onConflict, count: "exact" });
          if (error) throw new Error(`upsert ${table}: ${error.message}`);
          result.updated += count ?? slice.length;
        },
        { label: `upsert:${table}`, retries: 4 },
      );
    } catch (err) {
      // Per-batch isolation: a single sub-batch failure (after all retries
      // exhausted) must not terminate the whole run. Log to error_log,
      // increment failed count, continue. Caller decides what to do.
      result.failed += slice.length;
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { table, batchStart: i, batchSize: slice.length, err: msg },
        "upsertBatch sub-batch failed after retries — continuing",
      );
      await logError({
        source: "worker.upsertBatch",
        resourceName: opts.resourceName,
        syncRunId: opts.syncRunId,
        errorMessage: `upsert ${table} sub-batch (rows ${i}..${i + slice.length}): ${msg}`,
        context: { table, batchStart: i, batchSize: slice.length },
      });
    }
  }
  return result;
}

export async function deleteByParent(
  table: string,
  parentColumn: string,
  parentId: string,
): Promise<void> {
  await withRetry(
    async () => {
      const { error } = await dataDb.from(table).delete().eq(parentColumn, parentId);
      if (error) {
        log.error(
          { table, parentColumn, parentId, err: error.message },
          "deleteByParent failed",
        );
        throw new Error(`delete ${table}: ${error.message}`);
      }
    },
    { label: `delete:${table}`, retries: 3 },
  );
}
