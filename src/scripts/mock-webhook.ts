// mock-webhook.ts — local end-to-end test of the webhook receiver + processor.
//
// Run with:    npm run mock-webhook
//
// What it does:
//   1. Starts a single Shopify SDK client (already in scope), looks up real
//      ids from Supabase for the most-recently-synced rows of orders/customers/
//      products/collections so the incremental fetch hits live data.
//   2. For each test case, builds a synthetic Shopify webhook body, computes
//      the correct HMAC, POSTs it to http://localhost:3000/api/webhooks/shopify,
//      and asserts the receiver returned 200.
//   3. Polls shopify_sync.webhook_events for that webhook_id until it transitions
//      to status='processed' (or 'failed' / 'dead_letter') and reports the outcome.
//
// Test cases (per Phase 3B spec):
//   1. orders/updated      with a known order GID  → expect upserted, no row count drift
//   2. customers/update    with a known customer GID
//   3. products/update     with a known product GID
//   4. collections/update  with a known collection GID
//   5. refunds/create      with a payload that includes admin_graphql_api_order_id
//                          → expect orders.incremental dispatched
//   6. invalid HMAC        → expect 401, NOT enqueued
//
// Pre-req: `npm run dev` running in another terminal, SHOPIFY_WEBHOOK_SECRET
// set in .env.local.

import { createHmac, randomUUID } from "node:crypto";
import { config } from "../lib/config";
import { getSupabaseAdmin } from "../lib/supabase/admin";

const RECEIVER_URL =
  process.env.MOCK_WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/shopify";
const SHOP_DOMAIN = config.SHOPIFY_SHOP_DOMAIN;
const API_VERSION = config.SHOPIFY_API_VERSION;
const SECRET = config.SHOPIFY_WEBHOOK_SECRET;

const metaDb = getSupabaseAdmin("shopify_sync");
const dataDb = getSupabaseAdmin("shopify");

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!SECRET) {
  fail("SHOPIFY_WEBHOOK_SECRET is not set in .env.local — set any random string and try again.");
}

interface Case {
  name: string;
  topic: string;
  // reason: webhook bodies are arbitrary JSON shaped per topic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => Promise<any>;
  // What the row's status should be after processing.
  expectStatus: "processed" | "failed" | "dead_letter";
  // True for invalid-HMAC case: the receiver should NOT enqueue.
  expectReceiverStatus?: number;
  // Custom body builder that returns the raw body string AND deliberately
  // wrong HMAC — bypasses the standard sign-and-send.
  rawSendOverride?: () => Promise<{
    body: string;
    headerHmac: string;
    webhookId: string;
  }>;
}

async function pickRecentId(table: string): Promise<string> {
  const { data, error } = await dataDb
    .from(table)
    .select("id")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) fail(`pickRecentId(${table}): ${error?.message ?? "empty"}`);
  return (data as { id: string }).id;
}

const cases: Case[] = [
  {
    name: "1. orders/updated",
    topic: "orders/updated",
    build: async () => {
      const gid = await pickRecentId("orders");
      // GraphQL GIDs and REST `id` are reciprocal — extract numeric.
      const numeric = gid.split("/").pop()!;
      return {
        id: Number(numeric),
        admin_graphql_api_id: gid,
        updated_at: new Date().toISOString(),
        _mock_source: "mock-webhook.ts",
      };
    },
    expectStatus: "processed",
  },
  {
    name: "2. customers/update",
    topic: "customers/update",
    build: async () => {
      const gid = await pickRecentId("customers");
      return {
        id: Number(gid.split("/").pop()),
        admin_graphql_api_id: gid,
        updated_at: new Date().toISOString(),
        _mock_source: "mock-webhook.ts",
      };
    },
    expectStatus: "processed",
  },
  {
    name: "3. products/update",
    topic: "products/update",
    build: async () => {
      const gid = await pickRecentId("products");
      return {
        id: Number(gid.split("/").pop()),
        admin_graphql_api_id: gid,
        updated_at: new Date().toISOString(),
        _mock_source: "mock-webhook.ts",
      };
    },
    expectStatus: "processed",
  },
  {
    name: "4. collections/update",
    topic: "collections/update",
    build: async () => {
      const gid = await pickRecentId("collections");
      return {
        id: Number(gid.split("/").pop()),
        admin_graphql_api_id: gid,
        updated_at: new Date().toISOString(),
        _mock_source: "mock-webhook.ts",
      };
    },
    expectStatus: "processed",
  },
  {
    name: "5. refunds/create (routes to orders.incremental)",
    topic: "refunds/create",
    build: async () => {
      // Pick a recent refund and its parent order.
      const { data, error } = await dataDb
        .from("order_refunds")
        .select("id, order_id")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) fail(`refunds case: no order_refunds rows: ${error?.message ?? "empty"}`);
      const refundGid = (data as { id: string }).id;
      const orderGid = (data as { order_id: string }).order_id;
      return {
        id: Number(refundGid.split("/").pop()),
        admin_graphql_api_id: refundGid,
        admin_graphql_api_order_id: orderGid,
        order_id: Number(orderGid.split("/").pop()),
        note: "mock refund webhook",
        _mock_source: "mock-webhook.ts",
      };
    },
    expectStatus: "processed",
  },
  {
    name: "6. invalid HMAC (must NOT enqueue)",
    topic: "orders/updated",
    build: async () => ({}),
    expectStatus: "processed", // unused
    expectReceiverStatus: 401,
    rawSendOverride: async () => {
      const body = JSON.stringify({ id: 999, _mock_source: "invalid-hmac" });
      // Wrong HMAC — sign with garbage instead of the real secret.
      const headerHmac = createHmac("sha256", "WRONG_SECRET").update(body).digest("base64");
      const webhookId = `mock_${randomUUID()}`;
      return { body, headerHmac, webhookId };
    },
  },
];

async function postWebhook(
  topic: string,
  body: string,
  headerHmac: string,
  webhookId: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(RECEIVER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP_DOMAIN,
      "x-shopify-api-version": API_VERSION,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-hmac-sha256": headerHmac,
      "x-shopify-triggered-at": new Date().toISOString(),
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function pollForFinal(
  webhookId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; last_error: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await metaDb
      .from("webhook_events")
      .select("status, last_error")
      .eq("shopify_webhook_id", webhookId)
      .maybeSingle();
    if (data) {
      const s = (data as { status: string }).status;
      if (s === "processed" || s === "failed" || s === "dead_letter") {
        return data as { status: string; last_error: string | null };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function runCase(c: Case): Promise<boolean> {
  console.log(`\n▶ ${c.name}`);
  const webhookId = `mock_${randomUUID()}`;

  let body: string;
  let headerHmac: string;
  let usedWebhookId: string;

  if (c.rawSendOverride) {
    const o = await c.rawSendOverride();
    body = o.body;
    headerHmac = o.headerHmac;
    usedWebhookId = o.webhookId;
  } else {
    const payload = await c.build();
    body = JSON.stringify(payload);
    headerHmac = createHmac("sha256", SECRET!).update(body).digest("base64");
    usedWebhookId = webhookId;
  }

  const res = await postWebhook(c.topic, body, headerHmac, usedWebhookId);
  console.log(`  receiver → ${res.status} ${res.text.slice(0, 200)}`);

  if (c.expectReceiverStatus !== undefined) {
    if (res.status !== c.expectReceiverStatus) {
      console.error(
        `  ❌ expected receiver status ${c.expectReceiverStatus}, got ${res.status}`,
      );
      return false;
    }
    // For the 401 case, also assert no row was enqueued.
    const { data } = await metaDb
      .from("webhook_events")
      .select("id")
      .eq("shopify_webhook_id", usedWebhookId)
      .maybeSingle();
    if (data) {
      console.error(`  ❌ webhook_events row was created despite 401`);
      return false;
    }
    console.log(`  ✅ HMAC rejected, no row enqueued`);
    return true;
  }

  if (res.status !== 200) {
    console.error(`  ❌ unexpected receiver status ${res.status}`);
    return false;
  }

  const final = await pollForFinal(usedWebhookId);
  if (!final) {
    console.error(`  ❌ timed out waiting for processor; check receiver/processor logs`);
    return false;
  }
  console.log(`  processor → status=${final.status} last_error=${final.last_error ?? "—"}`);
  if (final.status !== c.expectStatus) {
    console.error(`  ❌ expected status=${c.expectStatus}, got ${final.status}`);
    return false;
  }
  console.log(`  ✅ ok`);
  return true;
}

(async () => {
  console.log(`\n═══ mock-webhook test harness ═══`);
  console.log(`Receiver: ${RECEIVER_URL}`);
  console.log(`Shop:     ${SHOP_DOMAIN}`);
  console.log(`Cases:    ${cases.length}\n`);

  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    if (await runCase(c)) passed += 1;
    else failed += 1;
  }

  console.log(`\n═══ Summary ═══`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
