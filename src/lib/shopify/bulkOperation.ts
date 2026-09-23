// Bulk Operations API helpers. Submit a query, poll status, return JSONL URL.
// JSONL streaming itself lives in src/worker/jsonlStreamer.ts.

import { query } from "./client";
import { logger } from "../logger";

const log = logger.child({ module: "shopify.bulkOperation" });

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELED"
  | "CANCELING"
  | "FAILED"
  | "EXPIRED";

export interface BulkOperationNode {
  id: string;
  status: BulkOperationStatus;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  objectCount: string | null; // GraphQL UnsignedInt64 → string
  rootObjectCount: string | null;
  fileSize: string | null;
  url: string | null;
  partialDataUrl: string | null;
  query: string;
}

const RUN_MUTATION = /* GraphQL */ `
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CURRENT_QUERY = /* GraphQL */ `
  query CurrentBulkOperation {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      rootObjectCount
      fileSize
      url
      partialDataUrl
      query
    }
  }
`;

const CANCEL_MUTATION = /* GraphQL */ `
  mutation BulkOperationCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function submitBulkOperation(innerQuery: string): Promise<string> {
  // Cancel any in-flight bulk op first — Shopify allows only one per shop.
  const current = await getCurrentBulkOperation();
  if (
    current &&
    (current.status === "RUNNING" || current.status === "CREATED")
  ) {
    log.warn(
      { id: current.id, status: current.status },
      "Cancelling stale bulk operation before submitting new one",
    );
    await cancelBulkOperation(current.id);
    // Brief wait for the cancellation to register.
    await new Promise((r) => setTimeout(r, 1500));
  }

  const wrapped = `{ ${innerQuery.trim()} }`;
  const data = await query<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string; createdAt: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(RUN_MUTATION, { query: wrapped });

  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.length) {
    throw new Error(
      `bulkOperationRunQuery userErrors: ${JSON.stringify(userErrors)}`,
    );
  }
  if (!bulkOperation) {
    throw new Error("bulkOperationRunQuery returned no bulkOperation");
  }
  log.info({ id: bulkOperation.id }, "Bulk operation submitted");
  return bulkOperation.id;
}

export async function getCurrentBulkOperation(): Promise<BulkOperationNode | null> {
  const data = await query<{ currentBulkOperation: BulkOperationNode | null }>(
    CURRENT_QUERY,
  );
  return data.currentBulkOperation;
}

export async function cancelBulkOperation(id: string): Promise<void> {
  await query(CANCEL_MUTATION, { id });
}

export interface PollOpts {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (op: BulkOperationNode) => void | Promise<void>;
  // Throws to abort the poll loop (e.g. when run is paused/cancelled).
  checkpoint?: () => Promise<void>;
}

export async function pollUntilDone(
  expectedId: string,
  opts: PollOpts = {},
): Promise<BulkOperationNode> {
  const intervalMs = opts.intervalMs ?? 10000;
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000; // 1h default
  const start = Date.now();

  while (true) {
    if (opts.checkpoint) await opts.checkpoint();
    const op = await getCurrentBulkOperation();
    if (!op || op.id !== expectedId) {
      // Either no current op (got replaced) or a different one took over.
      throw new Error(
        `Bulk op ${expectedId} no longer current (current=${op?.id ?? "null"})`,
      );
    }
    if (opts.onTick) await opts.onTick(op);

    if (op.status === "COMPLETED") return op;
    if (
      op.status === "FAILED" ||
      op.status === "CANCELED" ||
      op.status === "EXPIRED"
    ) {
      throw new Error(
        `Bulk op ${expectedId} ended in status ${op.status} (errorCode=${op.errorCode ?? "null"})`,
      );
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Bulk op ${expectedId} timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
