// Phase 3B incremental runner.
//
// Used by:
//   - the webhook processor (one resource per `*/create|update|fulfilled|...` event)
//   - the catchup-sync cron (one resource per row returned by the catchup query)
//
// Shape: fetch ONE record (and its children) from Shopify by GID, run it
// through the module's existing transform + childExtractors via applyOne.
// applyOne already honors the same idempotency/onConflict/upsert pipeline as
// the bulk runners, so:
//   - duplicate webhooks are safe (upsert by id)
//   - cross-module CASCADE FKs are not at risk (extractors are upsert-only
//     post-Phase-3-Wave-3-hardening; replaceByParent only fires for same-row
//     children, which is what we want for an updated parent)
//
// Failures are isolated per-call. The caller (webhook processor / cron)
// decides whether to retry.

import type { ResourceModule, RunnerResult } from "../../resources/types";
import { resourceRegistry } from "../../resources";
import { applyOne } from "./runner";
import { createSyncRun, finishRun, markRunning } from "../progress";
import { logger } from "../../lib/logger";
import { logError } from "../errors";
import { withRetry } from "../retry";

const log = logger.child({ module: "worker.runners.incrementalRunner" });

export interface IncrementalOpts {
  resourceName: string;
  id: string;
  triggeredBy: string; // e.g. "webhook:orders/updated:wh_abc123" or "cron:catchup-sync"
  // If true, do NOT create a sync_runs row. Use when the caller is already
  // wrapping a multi-resource batch in its own run (catchup cron does this).
  // Errors are still surfaced in the return value either way.
  skipRunRow?: boolean;
}

export interface IncrementalResult extends RunnerResult {
  // True if the Shopify fetch returned null (resource deleted/missing).
  // The runner attempted softDelete if the module defines one.
  notFound: boolean;
  syncRunId: string | null;
  errorMessage?: string;
}

export async function runIncremental(
  opts: IncrementalOpts,
): Promise<IncrementalResult> {
  const t0 = Date.now();
  const mod: ResourceModule | undefined = resourceRegistry[opts.resourceName];
  if (!mod) {
    const msg = `unknown resource '${opts.resourceName}'`;
    log.error({ resourceName: opts.resourceName, id: opts.id }, msg);
    return emptyResult(false, null, msg);
  }
  if (!mod.incremental) {
    const msg = `resource '${opts.resourceName}' does not implement incremental(id)`;
    log.error({ resourceName: opts.resourceName, id: opts.id }, msg);
    return emptyResult(false, null, msg);
  }

  let syncRunId: string | null = null;
  if (!opts.skipRunRow) {
    try {
      syncRunId = await createSyncRun({
        resourceName: opts.resourceName,
        runType: "incremental",
        triggeredBy: opts.triggeredBy,
        metadata: { id: opts.id },
      });
      await markRunning({ runId: syncRunId });
    } catch (err) {
      // sync_runs metadata is best-effort here; if we can't even open the
      // row, log+continue with a synthetic id so the actual data write still
      // attempts (we'd rather have data than a perfect audit trail).
      log.error(
        { err: String(err), resourceName: opts.resourceName, id: opts.id },
        "createSyncRun failed for incremental — proceeding without run row",
      );
    }
  }

  try {
    // withRetry handles transient Shopify SDK errors (network blip, 5xx,
    // throttle exhaustion). Persistent failures bubble up.
    const raw = await withRetry(
      async () => mod.incremental!(opts.id),
      { label: `incremental:${opts.resourceName}`, retries: 3 },
    );

    // Resource gone from Shopify — soft-delete if the module knows how.
    if (raw == null) {
      if (mod.softDelete) {
        await mod.softDelete(opts.id, syncRunId ?? "incremental");
      }
      log.info(
        {
          resourceName: opts.resourceName,
          id: opts.id,
          elapsedMs: Date.now() - t0,
          softDeleted: Boolean(mod.softDelete),
        },
        "incremental: resource not found in Shopify",
      );
      if (syncRunId) {
        await finishRun({
          runId: syncRunId,
          status: "succeeded",
          metadata: { notFound: true, softDeleted: Boolean(mod.softDelete) },
        });
      }
      return {
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsFailed: 0,
        notFound: true,
        syncRunId,
      };
    }

    // Run through the regular per-record path. NOTE: skipReplaceDeletes is
    // FALSE — incremental sync MUST honor replaceByParent semantics so
    // children removed in Shopify (e.g. customer dropped an address) propagate
    // to the mirror. This is the safe slow path; on first backfill we skip it
    // for perf, but on incremental we always pay the cost.
    const r = await applyOne(mod, raw, syncRunId ?? "incremental", {
      skipReplaceDeletes: false,
    });

    if (syncRunId) {
      await finishRun({
        runId: syncRunId,
        status: r.failed > 0 ? "partial" : "succeeded",
        metadata: { id: opts.id, ...r },
      });
    }

    log.info(
      {
        resourceName: opts.resourceName,
        id: opts.id,
        elapsedMs: Date.now() - t0,
        ...r,
      },
      "incremental sync ok",
    );
    return {
      recordsProcessed: 1,
      recordsInserted: r.inserted,
      recordsUpdated: r.inserted - r.failed,
      recordsFailed: r.failed,
      notFound: false,
      syncRunId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, resourceName: opts.resourceName, id: opts.id },
      "incremental sync failed",
    );
    await logError({
      source: "worker.incrementalRunner",
      resourceName: opts.resourceName,
      syncRunId: syncRunId ?? undefined,
      errorMessage: msg,
      context: { id: opts.id, triggeredBy: opts.triggeredBy },
    });
    if (syncRunId) {
      await finishRun({ runId: syncRunId, status: "failed", errorMessage: msg });
    }
    return emptyResult(false, syncRunId, msg);
  }
}

function emptyResult(
  notFound: boolean,
  syncRunId: string | null,
  errorMessage?: string,
): IncrementalResult {
  return {
    recordsProcessed: 0,
    recordsInserted: 0,
    recordsUpdated: 0,
    recordsFailed: errorMessage ? 1 : 0,
    notFound,
    syncRunId,
    errorMessage,
  };
}
