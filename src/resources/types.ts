// Resource module contract — every resource (shop, products, orders, etc.)
// implements this. The orchestrator + runners read from here only; resources
// know nothing about how the runner executes them.

export type SyncStrategy =
  | "singleton"
  | "paginated"
  | "paginated_batch"
  | "bulk"
  | "chunked_monthly";

// reason: payloads come from Shopify GraphQL with arbitrary nested shapes;
// strict typing per resource lives in the resource module's transform.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawPayload = any;

export interface MainRow {
  id: string; // Shopify GID
  raw_payload: unknown;
  synced_at: Date;
  _content_hash: string;
  [key: string]: unknown;
}

export interface ChildExtractor {
  table: string; // e.g. 'customer_addresses'
  // Returns the rows to upsert into the child table for this parent. Each row
  // MUST include the FK back to the parent and a stable primary key.
  extract: (
    parentRaw: RawPayload,
    parentRow: MainRow,
    ctx: TransformContext,
  ) => Record<string, unknown>[];
  // If true, the child table is a per-parent replacement — runner will delete
  // existing children with `WHERE <parentFk> = parent.id` before inserting.
  // Use for things like customer_addresses where the full set is re-sent.
  replaceByParent?: boolean;
  parentFk?: string; // column name of FK back to parent (default: '<resource_singular>_id')
  // Comma-separated columns for ON CONFLICT. Defaults to "id" — override
  // for child tables with composite PKs (e.g. product_publications uses
  // "product_id,publication_id").
  onConflict?: string;
}

export interface TransformContext {
  syncRunId: string;
  resourceName: string;
  hashContent: (obj: unknown) => string;
  parseGid: (gid: string) => { type: string; legacyId: string };
  now: Date;
}

export interface ResourceModule {
  resourceName: string; // matches shopify_sync.resource_registry.resource_name
  category: string; // 'foundation' | 'customers' | 'catalog' | 'orders' | ...
  table: string; // e.g. 'shop' (schema is always 'shopify')
  syncStrategy: SyncStrategy;
  // GraphQL document body. For bulk strategies this is the inner query passed
  // to bulkOperationRunQuery; for singleton/paginated it is a normal query.
  graphqlQuery: string;
  // For chunked_monthly only — the field used to slice. The runner builds the
  // `query` arg per chunk via monthChunks().
  chunkField?: string;
  transform: (raw: RawPayload, ctx: TransformContext) => MainRow | null;
  childExtractors?: ChildExtractor[];
  // Optional pre-flight: array of resource_names that must succeed before
  // this resource runs (in addition to priority order). E.g. products
  // depends on sales_channels for product_publications FKs.
  dependsOn?: string[];
  // Child-only mode: skip the parent upsert but still run all child extractors.
  // Used by Phase 3 Wave 1 "pass" modules that backfill order children for the
  // already-complete `orders` table without re-writing 131K parent rows.
  // The transform is still called so the runner has the parent.id for child FKs.
  skipParentUpsert?: boolean;

  // ─── Phase 3B: incremental sync (webhook + cron) ─────────────────────────
  //
  // Fetch-one-by-id. Returns the same RawPayload shape that `transform` and
  // `childExtractors` expect — extractors already accept BOTH the bulk JSONL
  // (`_children.<type>`) shape AND the regular GraphQL (`raw.<field>` /
  // `raw.<field>.edges[].node`) shape, so the runner can just call
  // `applyOne(module, raw, syncRunId)` with whatever this returns.
  //
  // Returns null if the resource was deleted or no longer exists in Shopify
  // (the runner will then call `softDelete` if defined, or just log+skip).
  incremental?: (id: string) => Promise<RawPayload | null>;

  // Soft-delete handler invoked by:
  //  - the `*/delete` webhook topics (customers/delete, products/delete, ...)
  //  - the incremental runner when `incremental(id)` returns null
  // Implementation should mark the row deleted (set `deleted_at` if present,
  // or whatever the table's convention is) — never hard-delete from the
  // mirror, since cross-module CASCADE FKs make that catastrophic.
  softDelete?: (id: string, syncRunId: string) => Promise<void>;
}

export interface RunnerContext {
  module: ResourceModule;
  syncRunId: string;
  // Throws if the run was paused/cancelled — runners poll this between chunks
  // / pages so a pause request takes effect at the next safe boundary.
  checkpoint: () => Promise<void>;
}

export interface RunnerResult {
  recordsProcessed: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsFailed: number;
  bulkOperationId?: string;
  cursorEnd?: string;
  metadata?: Record<string, unknown>;
}
