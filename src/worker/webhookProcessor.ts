// Webhook event processor. Reads pending rows from shopify_sync.webhook_events,
// dispatches each by topic to the right incremental sync action, and updates
// the row's status (processed / failed / dead_letter) per outcome.
//
// Lifecycle of a webhook_events row:
//   received  → processing → processed         (happy path)
//                          → failed (retry≤3)  (transient: stays in queue)
//                          → dead_letter       (after 3 failures, also pushed to DLQ)
//
// Concurrency: a single in-process loop. The webhook receiver fires this off
// after each enqueue (best-effort, non-blocking); the cron job calls it as a
// safety net (in case the receiver was busy / cold-started). We do NOT use
// SELECT ... FOR UPDATE SKIP LOCKED — concurrency between Next.js worker
// instances is bounded to 1 per instance and our enqueue rate is low. The
// race risk (two processors picking the same row) is mitigated by the
// `status='received'` → `status='processing'` UPDATE returning the row count
// — only one updater wins.
//
// Refunds + fulfillments topics: there is no standalone refunds.ts /
// fulfillments.ts module (they are child extractors under orders). This
// processor extracts the parent order GID from the webhook payload and
// dispatches to orders.incremental — which re-fetches the order PLUS all its
// children (line items, transactions, fulfillments, refunds, journey, visits).
// Net effect: the new refund/fulfillment row lands as a child upsert on the
// next orders.incremental call.

import { supabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";
import { runIncremental } from "./runners/incrementalRunner";
import { resourceRegistry } from "../resources";
import { pushDeadLetter, logError } from "./errors";

const log = logger.child({ module: "worker.webhookProcessor" });

const MAX_RETRIES = 3;

// Ensure only one in-process processor runs at a time. Callers can fire and
// forget; subsequent calls during an in-flight run no-op.
let processorRunning = false;

interface WebhookEventRow {
  id: string;
  shopify_webhook_id: string | null;
  topic: string;
  resource_id: string | null;
  resource_name: string | null;
  // reason: webhook payloads are arbitrary JSON, narrowed per-topic at use site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  retry_count: number;
  hmac_valid: boolean;
}

export interface ProcessorOpts {
  // Max events to drain per call. Caller can keep calling until the queue
  // empties; we cap each invocation so a stuck / slow Shopify endpoint can't
  // monopolize a single Lambda invocation.
  maxEvents?: number;
}

export interface ProcessorResult {
  processedOk: number;
  processedFailed: number;
  deadLettered: number;
  totalDrained: number;
  durationMs: number;
}

export async function processWebhookQueue(
  opts: ProcessorOpts = {},
): Promise<ProcessorResult> {
  const t0 = Date.now();
  const result: ProcessorResult = {
    processedOk: 0,
    processedFailed: 0,
    deadLettered: 0,
    totalDrained: 0,
    durationMs: 0,
  };

  if (processorRunning) {
    log.info("processWebhookQueue: another instance already running — skipping");
    return result;
  }
  processorRunning = true;
  log.info({ maxEvents: opts.maxEvents ?? 100 }, "processWebhookQueue: starting");

  try {
    const max = opts.maxEvents ?? 100;
    while (result.totalDrained < max) {
      const next = await claimNextEvent();
      if (!next) break;
      result.totalDrained += 1;
      const outcome = await processOne(next);
      if (outcome === "ok") result.processedOk += 1;
      else if (outcome === "dead") result.deadLettered += 1;
      else result.processedFailed += 1;
    }
  } finally {
    processorRunning = false;
    result.durationMs = Date.now() - t0;
  }

  log.info(result, "processWebhookQueue done");
  return result;
}

// Atomically claim the next event ready to be worked on. Two simple queries
// (received-first, then retry-eligible failed) — earlier attempt used a single
// .or() with nested and() but PostgREST's filter parser kept tripping on the
// ISO-timestamp special chars in the failed-row sub-filter, returning empty.
// Two queries is plenty fast for our enqueue rate.
async function claimNextEvent(): Promise<WebhookEventRow | null> {
  const SELECT_COLS =
    "id, shopify_webhook_id, topic, resource_id, resource_name, payload, retry_count, hmac_valid, status";

  // 1. Newest still-untried event (LIFO). Rationale: with sustained inventory
  // churn, FIFO would starve fresh events behind days-old backlog. Each event
  // re-fetches the resource's CURRENT state from Shopify, so processing the
  // newest event for a resource is functionally equivalent to processing all
  // older events for the same resource — the mirror lands at the same place.
  // Old events that never get claimed are harmless; they'll be GC'd later.
  const { data: receivedRows, error: rxErr } = await supabaseAdmin
    .from("webhook_events")
    .select(SELECT_COLS)
    .eq("status", "received")
    .order("received_at", { ascending: false })
    .limit(1);
  if (rxErr) {
    log.error({ err: rxErr.message }, "claimNextEvent received-select failed");
    return null;
  }

  let candidate: (WebhookEventRow & { status: string }) | null =
    receivedRows && receivedRows.length
      ? (receivedRows[0] as WebhookEventRow & { status: string })
      : null;

  // 2. If nothing fresh, look for failed events past the back-off window.
  if (!candidate) {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: failedRows, error: fxErr } = await supabaseAdmin
      .from("webhook_events")
      .select(SELECT_COLS + ", last_failed_at")
      .eq("status", "failed")
      .lt("retry_count", MAX_RETRIES)
      .lt("last_failed_at", cutoff)
      .order("last_failed_at", { ascending: false })
      .limit(1);
    if (fxErr) {
      log.error({ err: fxErr.message }, "claimNextEvent failed-select failed");
      return null;
    }
    if (failedRows && failedRows.length) {
      candidate = failedRows[0] as unknown as WebhookEventRow & { status: string };
    }
  }

  if (!candidate) return null;

  // Atomic flip: only succeed if the row's status hasn't changed under us.
  const { data: claimed, error: updErr } = await supabaseAdmin
    .from("webhook_events")
    .update({ status: "processing" })
    .eq("id", candidate.id)
    .eq("status", candidate.status)
    .select(
      "id, shopify_webhook_id, topic, resource_id, resource_name, payload, retry_count, hmac_valid",
    )
    .maybeSingle();
  if (updErr) {
    log.warn({ err: updErr.message, id: candidate.id }, "claimNextEvent update failed");
    return null;
  }
  if (!claimed) return null; // someone else won the race
  return claimed as WebhookEventRow;
}

type Outcome = "ok" | "fail" | "dead";

async function processOne(ev: WebhookEventRow): Promise<Outcome> {
  const t0 = Date.now();
  log.debug({ topic: ev.topic, id: ev.id, resourceId: ev.resource_id }, "processing webhook");

  try {
    await routeAndRun(ev);
    await markProcessed(ev.id, Date.now() - t0);
    return "ok";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const newRetryCount = ev.retry_count + 1;

    if (newRetryCount >= MAX_RETRIES) {
      await markDeadLetter(ev, errMsg);
      await pushDeadLetter({
        resourceName: ev.resource_name ?? ev.topic.split("/")[0] ?? "unknown",
        shopifyId: ev.resource_id,
        source: `webhook:${ev.topic}`,
        rawPayload: ev.payload,
        errorMessage: errMsg,
      });
      log.error(
        { topic: ev.topic, id: ev.id, resourceId: ev.resource_id, retryCount: newRetryCount, err: errMsg },
        "webhook moved to dead_letter",
      );
      return "dead";
    }

    await markFailed(ev.id, newRetryCount, errMsg, Date.now() - t0);
    log.warn(
      { topic: ev.topic, id: ev.id, retryCount: newRetryCount, err: errMsg },
      "webhook processing failed — will retry",
    );
    return "fail";
  }
}

// Route a webhook to the right action based on its topic.
async function routeAndRun(ev: WebhookEventRow): Promise<void> {
  const slash = ev.topic.indexOf("/");
  const root = slash > 0 ? ev.topic.substring(0, slash) : ev.topic;
  const action = slash > 0 ? ev.topic.substring(slash + 1) : "";

  // Resolve the resource GID. For top-level resources we use ev.resource_id
  // (already extracted by the receiver). For child topics (refunds,
  // fulfillments) we extract the parent order GID from the payload.
  switch (root) {
    case "orders": {
      // create | updated | cancelled | fulfilled | partially_fulfilled
      if (!ev.resource_id) throw new Error("orders webhook: no resource_id");
      if (action === "delete") {
        await softDeleteIfPossible("orders", ev.resource_id);
        return;
      }
      const r = await runIncremental({
        resourceName: "orders",
        id: ev.resource_id,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "customers": {
      if (!ev.resource_id) throw new Error("customers webhook: no resource_id");
      if (action === "delete") {
        await softDeleteIfPossible("customers", ev.resource_id);
        return;
      }
      const r = await runIncremental({
        resourceName: "customers",
        id: ev.resource_id,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "products": {
      if (!ev.resource_id) throw new Error("products webhook: no resource_id");
      if (action === "delete") {
        await softDeleteIfPossible("products", ev.resource_id);
        return;
      }
      const r = await runIncremental({
        resourceName: "products",
        id: ev.resource_id,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "collections": {
      if (!ev.resource_id) throw new Error("collections webhook: no resource_id");
      if (action === "delete") {
        await softDeleteIfPossible("collections", ev.resource_id);
        return;
      }
      const r = await runIncremental({
        resourceName: "collections",
        id: ev.resource_id,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "refunds": {
      // refunds/create payload includes an order_id (numeric, REST-style) or
      // admin_graphql_api_id-style nested order field. Either way, route to
      // orders.incremental(orderGid) to refresh the parent + all children.
      const orderGid = extractOrderGidFromChildPayload(ev.payload);
      if (!orderGid) throw new Error("refunds webhook: cannot resolve parent order GID");
      const r = await runIncremental({
        resourceName: "orders",
        id: orderGid,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}:viaRefund(${ev.resource_id ?? "?"})`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "fulfillments": {
      // fulfillments/create + fulfillments/update — same pattern as refunds.
      const orderGid = extractOrderGidFromChildPayload(ev.payload);
      if (!orderGid) throw new Error("fulfillments webhook: cannot resolve parent order GID");
      const r = await runIncremental({
        resourceName: "orders",
        id: orderGid,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}:viaFulfillment(${ev.resource_id ?? "?"})`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    case "inventory_levels": {
      // inventory_levels/update payload has inventory_item_id + location_id.
      // Route to inventory_items.incremental once that module gets one (Phase
      // 3C). For now, log + park as a no-op success so the queue doesn't fill
      // with retries. The Phase 5 catchup will eventually pick them up.
      log.info(
        { id: ev.id, payload: ev.payload },
        "inventory_levels webhook noted — incremental sync handler not yet implemented",
      );
      return;
    }
    case "fulfillment_orders": {
      // All fulfillment_orders/* topics: order_routing_complete, moved, split,
      // merged, cancelled, placed_on_hold, hold_released, etc. The payload's
      // top-level id IS the FulfillmentOrder id; the receiver already extracted
      // it as ev.resource_id. Re-fetch the FO and upsert via incremental.
      if (!ev.resource_id) throw new Error("fulfillment_orders webhook: no resource_id");
      const r = await runIncremental({
        resourceName: "fulfillment_orders",
        id: ev.resource_id,
        triggeredBy: `webhook:${ev.topic}:${ev.shopify_webhook_id ?? ev.id}`,
      });
      if (r.errorMessage) throw new Error(r.errorMessage);
      return;
    }
    default: {
      throw new Error(`unrouted webhook topic: ${ev.topic}`);
    }
  }
}

// Pull a parent order GID out of a refunds/fulfillments webhook payload.
// Tries (in order): payload.admin_graphql_api_order_id, payload.order_id (REST
// numeric → reconstruct GID), payload.order.admin_graphql_api_id.
// reason: webhook payloads are arbitrary JSON across topics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractOrderGidFromChildPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.admin_graphql_api_order_id === "string") {
    return payload.admin_graphql_api_order_id;
  }
  if (payload.order?.admin_graphql_api_id) {
    return String(payload.order.admin_graphql_api_id);
  }
  if (payload.order_id != null) {
    return `gid://shopify/Order/${payload.order_id}`;
  }
  return null;
}

async function softDeleteIfPossible(
  resourceName: string,
  id: string,
): Promise<void> {
  const mod = resourceRegistry[resourceName];
  if (!mod?.softDelete) {
    log.warn({ resourceName, id }, "delete topic but no softDelete handler — ignoring");
    return;
  }
  await mod.softDelete(id, "webhook");
}

async function markProcessed(id: string, durationMs: number): Promise<void> {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      processing_duration_ms: durationMs,
    })
    .eq("id", id);
  if (error) log.error({ err: error.message, id }, "markProcessed failed");
}

async function markFailed(
  id: string,
  retryCount: number,
  errorMessage: string,
  durationMs: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "failed",
      retry_count: retryCount,
      last_error: errorMessage,
      last_failed_at: new Date().toISOString(),
      processing_duration_ms: durationMs,
    })
    .eq("id", id);
  if (error) log.error({ err: error.message, id }, "markFailed failed");
}

async function markDeadLetter(
  ev: WebhookEventRow,
  errorMessage: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "dead_letter",
      retry_count: ev.retry_count + 1,
      last_error: errorMessage,
      last_failed_at: new Date().toISOString(),
    })
    .eq("id", ev.id);
  if (error) {
    log.error({ err: error.message, id: ev.id }, "markDeadLetter failed");
    await logError({
      source: "worker.webhookProcessor.markDeadLetter",
      errorMessage: error.message,
      context: { eventId: ev.id, topic: ev.topic },
    });
  }
}
