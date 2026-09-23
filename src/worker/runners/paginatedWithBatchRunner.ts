// Paginated GraphQL with batched applyBatch — for resources where bulk JSONL
// can't be used (e.g. connection-inside-list children) but the volume is too
// large for per-record applyOne. Iterates a root connection, buffers N parents,
// flushes via applyBatch, paces against Shopify's calculated query cost.
//
// Phase 3 Wave 1.5 use case: orders_pass_4 fills order_fulfillment_line_items
// + order_refund_line_items by walking `orders { fulfillments { fulfillmentLineItems(first:250) } refunds { refundLineItems(first:250) } }`.
// Bulk forbids connection-in-list; regular GraphQL allows it.
//
// The module's graphqlQuery MUST contain `{{QUERY_FILTER}}` (replaced per
// month chunk) and follow this shape:
//   query Page($cursor: String) {
//     orders(first: 50, after: $cursor, query: "{{QUERY_FILTER}}", sortKey: CREATED_AT) {
//       edges { node { ... } cursor }
//       pageInfo { hasNextPage endCursor }
//     }
//   }
// The runner extracts the first connection-shaped field (orders or whatever).

import type { ResourceModule, RunnerResult, RawPayload } from "../../resources/types";
import { shopify } from "../../lib/shopify/client";
import { monthChunks, chunkQueryFilter } from "../../lib/shopify/monthChunks";
import { applyBatch } from "./runner";
import { checkpoint, heartbeat, updateProgress } from "../progress";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { logger } from "../../lib/logger";
import { withRetry } from "../retry";

const log = logger.child({ module: "paginatedWithBatchRunner" });

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_ORDERS_PER_REQUEST = 50;
const DEFAULT_TARGET_ORDERS_PER_SEC = 20; // architect: pace below latency-bound 28/s
const DEFAULT_THROTTLE_FLOOR = 1000; // back off when currentlyAvailable drops below this

export interface RunPaginatedWithBatchOpts {
  module: ResourceModule;
  syncRunId: string;
  // Restrict to a date range (e.g. dry-run on one month). When unset, walks
  // earliest-record-found to now via month chunks (needs chunkField on module).
  dateRange?: { fromISO: string; toISO: string };
  skipReplaceDeletes?: boolean;
  batchSize?: number;
  ordersPerRequest?: number;
  targetOrdersPerSec?: number;
  throttleFloor?: number;
}

interface PageResponse {
  data?: Record<string, { edges: { node: RawPayload; cursor: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
  errors?: unknown;
}

export async function runPaginatedWithBatch(opts: RunPaginatedWithBatchOpts): Promise<RunnerResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const ordersPerRequest = opts.ordersPerRequest ?? DEFAULT_ORDERS_PER_REQUEST;
  const targetOrdersPerSec = opts.targetOrdersPerSec ?? DEFAULT_TARGET_ORDERS_PER_SEC;
  const throttleFloor = opts.throttleFloor ?? DEFAULT_THROTTLE_FLOOR;
  // Minimum wall-clock time per request to hit the target rate, e.g.
  // 50 orders / 20 orders-per-sec = 2.5 sec per request.
  const minMsPerRequest = (ordersPerRequest / targetOrdersPerSec) * 1000;

  // Build month chunks IF the module has a chunkField. Without one, the query
  // doesn't have a {{QUERY_FILTER}} placeholder and we run as one big walk
  // (used by Wave 2 translations, files, etc. — top-level connections with
  // no date filter).
  type Chunk = { label: string; index: number; startISO?: string; endISO?: string };
  let chunks: Chunk[];
  if (opts.module.chunkField) {
    const fromISO = opts.dateRange?.fromISO ?? "2018-01-01T00:00:00Z";
    const toISO = opts.dateRange?.toISO ?? new Date().toISOString();
    chunks = monthChunks(fromISO, toISO);
  } else {
    chunks = [{ label: "all", index: 0 }];
  }
  await setTotalChunks(opts.syncRunId, chunks.length);

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let chunkErrors = 0;

  for (const chunk of chunks) {
    await checkpoint(opts.syncRunId);
    await updateProgress({
      runId: opts.syncRunId,
      currentChunk: chunk.index + 1,
      currentChunkLabel: chunk.label,
    });

    try {
      const innerQuery = opts.module.chunkField
        ? opts.module.graphqlQuery.replace(
            /\{\{QUERY_FILTER\}\}/g,
            chunkQueryFilter(chunk as { startISO: string; endISO: string; label: string; index: number }, opts.module.chunkField),
          )
        : opts.module.graphqlQuery;

      const buffer: RawPayload[] = [];
      const flush = async () => {
        if (!buffer.length) return;
        try {
          const r = await applyBatch(opts.module, buffer, opts.syncRunId, {
            skipReplaceDeletes: opts.skipReplaceDeletes,
          });
          inserted += r.inserted;
          failed += r.failed;
        } catch (err) {
          failed += buffer.length;
          log.error(
            {
              err: err instanceof Error ? err.message : err,
              batchSize: buffer.length,
              chunk: chunk.label,
            },
            "applyBatch failed in paginated-with-batch runner",
          );
        }
        processed += buffer.length;
        buffer.length = 0;
        await updateProgress({
          runId: opts.syncRunId,
          recordsProcessed: processed,
          recordsInserted: inserted,
          recordsFailed: failed,
        });
      };

      let cursor: string | null = null;
      while (true) {
        await checkpoint(opts.syncRunId);
        const reqStart = Date.now();
        const variables: Record<string, unknown> = { cursor };
        const res = await withRetry(
          async () => (await shopify.request(innerQuery, { variables })) as PageResponse,
          { label: `paginatedWithBatch:${opts.module.resourceName}`, retries: 3 },
        );
        if (res.errors) {
          throw new Error(
            `GraphQL errors: ${JSON.stringify(res.errors).slice(0, 500)}`,
          );
        }

        // Throttle awareness — track Shopify's calculated cost. Back off if we
        // get close to the budget floor; surface (throw) if we hit zero.
        const cost = res.extensions?.cost;
        if (cost) {
          const { currentlyAvailable, maximumAvailable } = cost.throttleStatus;
          if (currentlyAvailable === 0) {
            throw new Error(
              `Shopify rate-limit exhausted: throttleStatus.currentlyAvailable=0 (max=${maximumAvailable})`,
            );
          }
          if (currentlyAvailable < throttleFloor) {
            log.warn(
              { currentlyAvailable, maximumAvailable, chunk: chunk.label },
              "Throttle budget low — sleeping 5s extra to recover",
            );
            await sleep(5000);
          }
        }

        // Find the first connection-shaped field (orders, products, etc.)
        const conn = findConnection(res.data);
        if (!conn) {
          log.warn({ chunk: chunk.label }, "No connection found in response");
          break;
        }
        for (const edge of conn.edges) {
          buffer.push(edge.node);
          if (buffer.length >= batchSize) await flush();
        }
        cursor = conn.pageInfo.endCursor;
        await heartbeat(opts.syncRunId);

        // Pacing: enforce target rate. The whole request budget is
        // `minMsPerRequest`; if we finished faster, sleep for the difference.
        const elapsed = Date.now() - reqStart;
        if (elapsed < minMsPerRequest) await sleep(minMsPerRequest - elapsed);

        if (!conn.pageInfo.hasNextPage) break;
      }
      await flush();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "RunPausedError" || name === "RunCancelledError") throw err;
      chunkErrors += 1;
      log.error(
        {
          chunk: chunk.label,
          err: err instanceof Error ? err.message : err,
        },
        "Chunk failed — skipping; re-run via /api/sync/retry to fill gaps",
      );
    }
  }
  if (chunkErrors > 0) {
    log.warn({ chunkErrors, totalChunks: chunks.length }, "Run completed with chunk errors");
  }

  return {
    recordsProcessed: processed,
    recordsInserted: inserted,
    recordsUpdated: 0,
    recordsFailed: failed,
    metadata: { totalChunks: chunks.length, chunkErrors },
  };
}

function findConnection(
  data: PageResponse["data"],
):
  | { edges: { node: RawPayload; cursor: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | null {
  if (!data) return null;
  for (const v of Object.values(data)) {
    if (v && Array.isArray(v.edges) && v.pageInfo) return v;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function setTotalChunks(runId: string, total: number): Promise<void> {
  await supabaseAdmin
    .from("sync_runs")
    .update({ total_chunks: total })
    .eq("id", runId);
}
