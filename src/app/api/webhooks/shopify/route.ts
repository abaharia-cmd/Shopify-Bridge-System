// Shopify webhook receiver. Mounted at POST /api/webhooks/shopify.
//
// Per Shopify's webhook contract (and Phase 3B spec):
//   1. Read the EXACT raw request body (utf-8) before any JSON parsing.
//   2. Verify the X-Shopify-Hmac-Sha256 header against HMAC_SHA256(secret, body).
//      - If invalid: return 401 immediately (no DB write). Shopify will retry,
//        but a persistent secret mismatch means the app is misconfigured.
//   3. Insert the event into shopify_sync.webhook_events (status='received')
//      with hmac_valid=true and the parsed payload — this is the durable queue.
//   4. Return 200 quickly (<5s budget per Shopify; topic dispatch happens async
//      in the next request cycle / cron tick / explicit /api/sync/process call).
//
// Idempotency: shopify_sync.webhook_events has UNIQUE(shopify_webhook_id).
//   Shopify retries deliver the SAME X-Shopify-Webhook-Id, so a 23505 conflict
//   on insert is the success-path for a duplicate; we still 200 it.

import { NextResponse } from "next/server";
import { verifyWebhookHmac } from "@/lib/shopify/webhookVerify";
import { config } from "@/lib/config";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { processWebhookQueue } from "@/worker/webhookProcessor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel keeps the function alive for up to maxDuration after the response is
// returned. We respond to Shopify in <5s, but the fire-and-forget processor
// invocation needs time to drain a backlog (~2s per webhook × 50 events).
// Cap at 300s = Vercel Pro limit. (Default 60s would kill processWebhookQueue
// mid-drain when a burst of webhooks arrives.)
export const maxDuration = 300;

const log = logger.child({ module: "api.webhooks.shopify" });
const metaDb = getSupabaseAdmin("shopify_sync");

// Lifted from a Shopify topic like "orders/updated" → ("orders", "updated").
function parseTopic(topic: string): { resourceName: string; action: string } {
  const slash = topic.indexOf("/");
  if (slash < 0) return { resourceName: topic, action: "" };
  return {
    resourceName: topic.substring(0, slash),
    action: topic.substring(slash + 1),
  };
}

// Best-effort resource-id extraction from a Shopify webhook payload.
// Different topics shape the payload differently; we try the obvious spots.
// reason: webhook payloads are arbitrary JSON; per-topic typing is in the processor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractResourceId(payload: any, topic: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  // 1. admin_graphql_api_id is the explicit GID (preferred).
  if (typeof payload.admin_graphql_api_id === "string") {
    return payload.admin_graphql_api_id;
  }
  // 2. Numeric `id` → reconstruct the GID using the topic root.
  if (payload.id != null) {
    const root = topic.split("/")[0];
    const TYPE_MAP: Record<string, string> = {
      orders: "Order",
      customers: "Customer",
      products: "Product",
      collections: "Collection",
      refunds: "Refund",
      fulfillments: "Fulfillment",
      inventory_levels: "InventoryLevel",
    };
    const t = TYPE_MAP[root];
    if (t) return `gid://shopify/${t}/${payload.id}`;
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const t0 = Date.now();
  const headerHmac = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? "";
  const apiVersion = req.headers.get("x-shopify-api-version") ?? "";
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";
  const triggeredAtHeader = req.headers.get("x-shopify-triggered-at");

  // Step 1: capture raw bytes BEFORE any JSON parsing — otherwise the HMAC
  // wouldn't match (Node's JSON.parse re-serialization changes the byte layout).
  const rawBody = await req.text();

  // Step 2: HMAC verify. Failures are early returns — no DB write.
  const hmacValid = verifyWebhookHmac(
    rawBody,
    headerHmac,
    config.SHOPIFY_WEBHOOK_SECRET,
  );
  if (!hmacValid) {
    log.warn(
      { topic, shopDomain, webhookId, hasSecret: Boolean(config.SHOPIFY_WEBHOOK_SECRET) },
      "webhook HMAC verification failed",
    );
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  // Parse payload (best-effort). We persist whatever we can; the processor
  // will decide what to do with it.
  // reason: Shopify payloads are arbitrary; full typing lives in the processor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any = null;
  try {
    payload = rawBody.length ? JSON.parse(rawBody) : null;
  } catch (err) {
    log.error({ err: String(err), topic, webhookId }, "webhook payload not valid JSON");
    // Even though Shopify sent it, we can't process — record and 200 to stop retries.
    payload = { _parseError: String(err), _raw: rawBody.slice(0, 1024) };
  }

  const { resourceName } = parseTopic(topic);
  const resourceId = extractResourceId(payload, topic);

  // Step 3: enqueue. UNIQUE(shopify_webhook_id) makes this idempotent.
  const { error } = await metaDb.from("webhook_events").insert({
    shopify_webhook_id: webhookId || null,
    topic,
    shop_domain: shopDomain,
    api_version: apiVersion,
    triggered_at: triggeredAtHeader ?? new Date().toISOString(),
    received_at: new Date().toISOString(),
    status: "received",
    resource_id: resourceId,
    resource_name: resourceName,
    hmac_valid: true,
    payload,
    retry_count: 0,
  });

  if (error) {
    // 23505 unique violation = duplicate delivery from Shopify retry logic.
    // That's the success-path for at-least-once delivery; just 200 it.
    if (error.code === "23505") {
      log.info(
        { webhookId, topic, elapsedMs: Date.now() - t0 },
        "webhook already enqueued (duplicate delivery)",
      );
      return NextResponse.json({ ok: true, deduped: true });
    }
    log.error(
      { err: error.message, code: error.code, topic, webhookId },
      "webhook enqueue failed",
    );
    // 500 → Shopify will retry. We want it to.
    return NextResponse.json({ error: "enqueue failed" }, { status: 500 });
  }

  log.info(
    { topic, resourceId, webhookId, elapsedMs: Date.now() - t0 },
    "webhook enqueued",
  );

  // Fire-and-forget: kick the processor so the queue drains promptly without
  // waiting for the cron tick. The processor is a no-op if another in-process
  // run is already in flight, so this is safe to spam from the receiver.
  // We do NOT await — the response must return within Shopify's 5s budget.
  // maxEvents:100 + maxDuration:300 lets one invocation drain ~100 webhooks
  // (~2s each) before Vercel terminates the function.
  void processWebhookQueue({ maxEvents: 100 }).catch((err) => {
    log.error({ err: String(err) }, "background processWebhookQueue failed");
  });

  return NextResponse.json({ ok: true });
}
