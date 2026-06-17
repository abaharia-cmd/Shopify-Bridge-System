import type { ResourceModule, RunnerResult } from "../../resources/types";
import { paginate, type PageInfo } from "../../lib/shopify/pagination";
import { withRetry } from "../retry";
import { applyOne } from "./runner";
import { checkpoint, updateProgress } from "../progress";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "paginatedRunner" });

interface ConnectionShape<T> {
  edges: { node: T; cursor: string }[];
  pageInfo: PageInfo;
}

// The module's graphqlQuery MUST be of the form:
//   query Foo($first: Int!, $after: String) {
//     foos(first: $first, after: $after) {
//       edges { node { ... } cursor }
//       pageInfo { hasNextPage endCursor }
//     }
//   }
// The runner extracts the first connection field it finds.

export async function runPaginated(opts: {
  module: ResourceModule;
  syncRunId: string;
}): Promise<RunnerResult> {
  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let lastCursor: string | undefined;

  // Recursively find the first connection-shaped field. Handles top-level
  // (e.g. `{ orders: {edges, pageInfo} }`) and one-level nested
  // (e.g. `{ shopifyPaymentsAccount: { payouts: {edges, pageInfo} } }`).
  const findConnection = (obj: unknown, depth = 0): ConnectionShape<unknown> | null => {
    if (depth > 3 || typeof obj !== "object" || obj === null) return null;
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k] as ConnectionShape<unknown> | undefined;
      if (v && Array.isArray(v.edges) && v.pageInfo) return v;
      const nested = findConnection(o[k], depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  const extract = (data: unknown): { nodes: unknown[]; pageInfo: PageInfo } => {
    const conn = findConnection(data);
    if (!conn) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    return { nodes: conn.edges.map((e) => e.node), pageInfo: conn.pageInfo };
  };

  for await (const page of paginate<unknown>({
    document: opts.module.graphqlQuery,
    extract,
  })) {
    await checkpoint(opts.syncRunId);
    for (const node of page.nodes) {
      try {
        const r = await withRetry(
          () => applyOne(opts.module, node, opts.syncRunId),
          { label: `paginated.applyOne:${opts.module.resourceName}` },
        );
        inserted += r.inserted;
        failed += r.failed;
        processed += 1;
      } catch (err) {
        failed += 1;
        log.error(
          { err: err instanceof Error ? err.message : err, resource: opts.module.resourceName },
          "applyOne failed in paginated runner",
        );
      }
    }
    if (page.cursor) lastCursor = page.cursor;
    await updateProgress({
      runId: opts.syncRunId,
      recordsProcessed: processed,
      recordsInserted: inserted,
      recordsFailed: failed,
      cursorEnd: lastCursor,
    });
  }

  return {
    recordsProcessed: processed,
    recordsInserted: inserted,
    recordsUpdated: 0,
    recordsFailed: failed,
    cursorEnd: lastCursor,
  };
}
