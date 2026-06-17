// Shared runner contract.
import type { ResourceModule, RunnerResult } from "../../resources/types";
import { upsertBatch, deleteByParent } from "../upsert";
import type { MainRow, RawPayload } from "../../resources/types";
import { makeTransformContext } from "../transformContext";

export interface Runner {
  strategy: ResourceModule["syncStrategy"];
  run(opts: { module: ResourceModule; syncRunId: string }): Promise<RunnerResult>;
}

export interface ApplyOpts {
  // When true, skip per-parent deletes for replaceByParent child extractors.
  // Use on first backfill (empty tables) — purely an optimization. NEVER use
  // on incremental sync, where Shopify may have removed children.
  skipReplaceDeletes?: boolean;
}

// Per-record path. Used by singleton + paginated runners. Sequential 1-by-1
// upserts so each call costs ~3-5 round-trips. Fine for low cardinality.
export async function applyOne(
  module: ResourceModule,
  raw: RawPayload,
  syncRunId: string,
  opts: ApplyOpts = {},
): Promise<{ inserted: number; failed: number; skipped: number }> {
  const ctx = makeTransformContext({ syncRunId, resourceName: module.resourceName });
  const main: MainRow | null = module.transform(raw, ctx);
  if (!main) return { inserted: 0, failed: 0, skipped: 1 };

  // Honor module.skipParentUpsert (Wave 2 modules like collection_rules use
  // this to walk a parent connection while only writing children). Without
  // this guard, applyOne would overwrite the parent's existing raw_payload
  // with the stub returned by the pass-style transform — corrupting it.
  let parentRes = { failed: 0, attempted: 0, inserted: 0, updated: 0 };
  if (!module.skipParentUpsert) {
    parentRes = await upsertBatch(
      module.table,
      [main as unknown as Record<string, unknown>],
      { onConflict: "id", syncRunId, resourceName: module.resourceName },
    );
  }

  if (module.childExtractors) {
    for (const ext of module.childExtractors) {
      const rows = ext.extract(raw, main, ctx);
      if (ext.replaceByParent && !opts.skipReplaceDeletes) {
        const fk = ext.parentFk ?? `${module.resourceName.replace(/s$/, "")}_id`;
        await deleteByParent(ext.table, fk, main.id);
      }
      if (rows.length) {
        await upsertBatch(ext.table, rows, {
          onConflict: ext.onConflict ?? "id",
          syncRunId,
          resourceName: module.resourceName,
        });
      }
    }
  }
  return parentRes.failed > 0
    ? { inserted: 0, failed: 1, skipped: 0 }
    : { inserted: 1, failed: 0, skipped: 0 };
}

// Batch path. Used by bulkRunner / chunkedMonthlyRunner. Transforms all parents
// at once, then issues exactly:
//   1 upsert for the parent table
//   1 upsert per child table (rows aggregated across all parents)
//   (+ batch delete-by-parent-IDs if replaceByParent and !skipReplaceDeletes)
// For ~120k parents with 2 child extractors that's ~3 round-trips per 200-batch
// = ~3000 round-trips total instead of ~600k. ~200x speedup.
export async function applyBatch(
  module: ResourceModule,
  raws: RawPayload[],
  syncRunId: string,
  opts: ApplyOpts = {},
): Promise<{ inserted: number; failed: number; skipped: number }> {
  if (!raws.length) return { inserted: 0, failed: 0, skipped: 0 };
  const ctx = makeTransformContext({ syncRunId, resourceName: module.resourceName });

  const mainRows: MainRow[] = [];
  // Map: child table → array of rows (preserves insertion order).
  const childBuckets = new Map<string, Record<string, unknown>[]>();
  // Map: child extractor index → list of parent IDs that contributed (for
  // batched delete-by-parent on replace mode).
  const parentIdsByExtractor: string[][] = (module.childExtractors ?? []).map(
    () => [],
  );
  let skipped = 0;

  for (const raw of raws) {
    const main = module.transform(raw, ctx);
    if (!main) {
      skipped += 1;
      continue;
    }
    mainRows.push(main);
    if (module.childExtractors) {
      module.childExtractors.forEach((ext, i) => {
        const rows = ext.extract(raw, main, ctx);
        if (rows.length) {
          const arr = childBuckets.get(ext.table) ?? [];
          arr.push(...rows);
          childBuckets.set(ext.table, arr);
        }
        if (ext.replaceByParent) {
          parentIdsByExtractor[i].push(main.id);
        }
      });
    }
  }

  let totalFailed = 0;

  // Parents first, so child FKs resolve. Skip in child-only mode (Phase 3 Wave
  // 1 "pass" modules — orders is already complete, no need to re-upsert).
  if (mainRows.length && !module.skipParentUpsert) {
    const r = await upsertBatch(
      module.table,
      mainRows as unknown as Record<string, unknown>[],
      { onConflict: "id", syncRunId, resourceName: module.resourceName },
    );
    totalFailed += r.failed;
  }

  if (module.childExtractors) {
    for (let i = 0; i < module.childExtractors.length; i++) {
      const ext = module.childExtractors[i];
      const fk = ext.parentFk ?? `${module.resourceName.replace(/s$/, "")}_id`;
      const ids = parentIdsByExtractor[i];

      if (ext.replaceByParent && !opts.skipReplaceDeletes && ids.length) {
        await deleteByParentBatch(ext.table, fk, ids);
      }

      const rows = childBuckets.get(ext.table) ?? [];
      if (rows.length) {
        const onConflict = ext.onConflict ?? "id";
        // Dedupe within the batch by the conflict key. Shopify Bulk Ops can
        // emit the same child once per parent it's associated with (e.g. a
        // shared MediaImage attached to multiple products), and PostgREST
        // rejects an INSERT…ON CONFLICT that affects the same row twice.
        const deduped = dedupeByKey(rows, onConflict);
        const r = await upsertBatch(ext.table, deduped, {
          onConflict,
          syncRunId,
          resourceName: module.resourceName,
        });
        totalFailed += r.failed;
      }
    }
  }

  return {
    inserted: mainRows.length - Math.min(totalFailed, mainRows.length),
    failed: totalFailed,
    skipped,
  };
}

function dedupeByKey(
  rows: Record<string, unknown>[],
  conflictKey: string,
): Record<string, unknown>[] {
  const cols = conflictKey.split(",").map((c) => c.trim());
  const seen = new Map<string, Record<string, unknown>>();
  const passThrough: Record<string, unknown>[] = [];
  for (const r of rows) {
    // If ANY conflict-key column is missing/null, this row can't collide
    // with another row by the conflict key — Postgres will assign a fresh
    // surrogate (e.g. gen_random_uuid()) on INSERT. Pass it through as-is.
    // Without this guard, every row with id=undefined String()'s to
    // "undefined" and collapses to a single row per batch — the cause of
    // the Phase 3 Wave 1 Pass 1 dry-run silent data loss (15 rows for what
    // should have been ~3K).
    const missingKey = cols.some((c) => r[c] === undefined || r[c] === null);
    if (missingKey) {
      passThrough.push(r);
      continue;
    }
    const k = cols.map((c) => String(r[c])).join("|");
    seen.set(k, r); // last write wins
  }
  return [...passThrough, ...Array.from(seen.values())];
}

// Delete child rows for many parents in one IN-clause request (chunked at 500
// to stay under URL length limits). Fast on PG with the parent_id index.
async function deleteByParentBatch(
  table: string,
  parentColumn: string,
  parentIds: string[],
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < parentIds.length; i += CHUNK) {
    const slice = parentIds.slice(i, i + CHUNK);
    // Use the in-helper from upsert module via a fresh PostgREST request.
    // Keep this inline rather than adding a new exported helper.
    const { getSupabaseAdmin } = await import("../../lib/supabase/admin");
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb.from(table).delete().in(parentColumn, slice);
    if (error) {
      throw new Error(
        `deleteByParentBatch ${table}.${parentColumn} (${slice.length} ids): ${error.message}`,
      );
    }
  }
}

// Re-export the single-row deleteByParent for runners that still want it.
export { deleteByParent };
