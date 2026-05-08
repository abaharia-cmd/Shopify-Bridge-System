import type { ResourceModule, RunnerResult } from "../../resources/types";
import {
  submitBulkOperation,
  pollUntilDone,
  type BulkOperationNode,
} from "../../lib/shopify/bulkOperation";
import {
  streamJsonl,
  groupByParent,
  type ParentWithChildren,
} from "../jsonlStreamer";
import { applyBatch } from "./runner";
import { checkpoint, heartbeat, updateProgress } from "../progress";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "bulkRunner" });

// Default JSONL parents per upsert batch. Tuned to fit under Postgres
// statement_timeout (60s default in Supabase) — 500 worked for customers
// (small payloads) but orders' raw_payload is ~50KB so 200 is the safe cap.
const DEFAULT_BATCH_SIZE = 200;

export interface RunBulkOpts {
  module: ResourceModule;
  syncRunId: string;
  // Optional: skip submission + polling and ingest from an existing JSONL URL.
  // Used by the resume-bulk API route when a previous run already has a
  // COMPLETED bulk_operations row with a still-valid URL (Shopify URLs are
  // valid 7 days). Saves the 30+ min Shopify wait.
  existingOp?: { id: string; url: string };
  // Resume the JSONL stream at this byte offset (set by orchestrator.resumeBulk
  // from the previous run's metadata.jsonl_offset). The streamer issues a
  // Range request to skip forward.
  startByte?: number;
  // Skip per-parent deletes for replaceByParent extractors. Set true on first
  // backfill (empty tables); false on incremental sync.
  skipReplaceDeletes?: boolean;
  batchSize?: number;
}

// The module's graphqlQuery is the inner query (without the wrapping `{ }`).
// Children come back interleaved via __parentId — groupByParent stitches them
// back to their parent before the resource's transform sees the record. The
// resource's transform receives a "rich parent" object with `_children` map.

export async function runBulk(opts: RunBulkOpts): Promise<RunnerResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let opId: string;
  let url: string | null;

  if (opts.existingOp) {
    opId = opts.existingOp.id;
    url = opts.existingOp.url;
    log.info(
      { opId, resource: opts.module.resourceName, startByte: opts.startByte ?? 0 },
      "Resuming bulk ingest from existing JSONL URL",
    );
    await updateProgress({ runId: opts.syncRunId, bulkOperationId: opId });
  } else {
    opId = await submitBulkOperation(opts.module.graphqlQuery);
    await updateProgress({ runId: opts.syncRunId, bulkOperationId: opId });
    await recordBulkOp(opts.syncRunId, opts.module.resourceName, opId, opts.module.graphqlQuery);

    const finalOp = await pollUntilDone(opId, {
      intervalMs: 10000,
      onTick: async (op) => {
        await updateBulkOpStatus(opId, op);
        await checkpoint(opts.syncRunId);
      },
      checkpoint: () => checkpoint(opts.syncRunId),
    });
    url = finalOp.url;
  }

  if (!url) {
    log.info({ resource: opts.module.resourceName }, "Bulk op produced no data");
    return {
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsFailed: 0,
      bulkOperationId: opId,
    };
  }

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  // Tuples of (parent, byteEnd) so the flush can persist the byte offset
  // of the LAST successfully-flushed line. On crash + resume-bulk, the new
  // run picks up at this offset via Range request.
  const buffer: { parent: ParentWithChildren; byteEnd: number }[] = [];

  const flush = async () => {
    if (!buffer.length) return;
    const lastByteEnd = buffer[buffer.length - 1].byteEnd;
    const parents = buffer.map((b) => b.parent);
    try {
      const r = await applyBatch(opts.module, parents, opts.syncRunId, {
        skipReplaceDeletes: opts.skipReplaceDeletes,
      });
      inserted += r.inserted;
      failed += r.failed;
    } catch (err) {
      // applyBatch shouldn't throw now that upsertBatch is per-batch isolated,
      // but defend in depth — a transform-level bug shouldn't kill the run.
      failed += parents.length;
      log.error(
        {
          err: err instanceof Error ? err.message : err,
          batchSize: parents.length,
          resource: opts.module.resourceName,
        },
        "applyBatch failed in bulk runner",
      );
    }
    processed += parents.length;
    buffer.length = 0;
    await updateProgress({
      runId: opts.syncRunId,
      recordsProcessed: processed,
      recordsInserted: inserted,
      recordsFailed: failed,
    });
    // Persist resume checkpoint (byte offset). On resume-bulk, the next run
    // reads this and skips ahead. Best-effort — failure here only loses the
    // resume optimization, not data.
    await persistJsonlOffset(opts.syncRunId, lastByteEnd);
  };

  for await (const { parent, byteEnd } of groupByParent(
    streamJsonl(url, {
      startByte: opts.startByte,
      checkpoint: () => checkpoint(opts.syncRunId),
      heartbeat: () => heartbeat(opts.syncRunId),
    }),
  )) {
    buffer.push({ parent, byteEnd });
    if (buffer.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  await markBulkOpParsed(opId, processed, inserted, failed);

  return {
    recordsProcessed: processed,
    recordsInserted: inserted,
    recordsUpdated: 0,
    recordsFailed: failed,
    bulkOperationId: opId,
  };
}

async function persistJsonlOffset(syncRunId: string, byteEnd: number): Promise<void> {
  // Read-modify-write to avoid clobbering other metadata keys. Best-effort.
  const { data, error: readErr } = await supabaseAdmin
    .from("sync_runs")
    .select("metadata")
    .eq("id", syncRunId)
    .single();
  if (readErr) {
    log.warn({ err: readErr.message, syncRunId }, "persistJsonlOffset: read failed");
    return;
  }
  const meta = ((data as { metadata: Record<string, unknown> } | null)?.metadata ?? {}) as Record<
    string,
    unknown
  >;
  meta.jsonl_offset = byteEnd;
  const { error } = await supabaseAdmin
    .from("sync_runs")
    .update({ metadata: meta })
    .eq("id", syncRunId);
  if (error) {
    log.warn({ err: error.message, syncRunId }, "persistJsonlOffset: write failed");
  }
}

async function recordBulkOp(
  syncRunId: string,
  resourceName: string,
  shopifyOpId: string,
  graphqlQuery: string,
): Promise<void> {
  const { error } = await supabaseAdmin.from("bulk_operations").insert({
    shopify_operation_id: shopifyOpId,
    resource_name: resourceName,
    sync_run_id: syncRunId,
    graphql_query: graphqlQuery,
    status: "CREATED",
  });
  if (error) log.warn({ err: error.message }, "bulk_operations insert failed");
}

async function updateBulkOpStatus(
  shopifyOpId: string,
  op: BulkOperationNode,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: op.status,
    object_count: op.objectCount ? Number(op.objectCount) : null,
    root_object_count: op.rootObjectCount ? Number(op.rootObjectCount) : null,
    jsonl_size_bytes: op.fileSize ? Number(op.fileSize) : null,
    jsonl_url: op.url,
    error_code: op.errorCode,
  };
  if (op.completedAt) patch.completed_at = op.completedAt;
  await supabaseAdmin
    .from("bulk_operations")
    .update(patch)
    .eq("shopify_operation_id", shopifyOpId);
}

async function markBulkOpParsed(
  shopifyOpId: string,
  parsed: number,
  upserted: number,
  failed: number,
): Promise<void> {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("bulk_operations")
    .update({
      records_parsed: parsed,
      records_upserted: upserted,
      records_failed: failed,
      parsing_completed_at: now,
    })
    .eq("shopify_operation_id", shopifyOpId);
}
