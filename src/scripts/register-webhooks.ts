// register-webhooks.ts — one-shot script to subscribe the deployed
// /api/webhooks/shopify endpoint to all topics our processor handles.
//
// Run with:
//   WEBHOOK_DEPLOY_URL=https://your.vercel.app npm run register-webhooks
//
// What it does:
//   1. Reads existing subscriptions via webhookSubscriptions query.
//   2. For each topic in TOPICS that's not already subscribed to our URL,
//      calls webhookSubscriptionCreate. Idempotent — re-running is safe.
//   3. Outputs a summary table: topic → action (created / kept / failed).
//
// Topics: all 14 listed in the Phase 3C spec (orders.create..updated..cancelled..
// fulfilled..partially_fulfilled, customers.create..update..delete,
// products.create..update..delete, collections.create..update..delete,
// inventory_levels.update, refunds.create, fulfillments.create..update).
//
// Shopify GraphQL uses underscore-cased topic enums (ORDERS_CREATE etc), not
// the slash-format the webhook receiver gets in X-Shopify-Topic.

import { query } from "../lib/shopify/client";
import { config } from "../lib/config";

const DEPLOY_URL = process.env.WEBHOOK_DEPLOY_URL;
if (!DEPLOY_URL) {
  console.error("ERROR: set WEBHOOK_DEPLOY_URL=https://your.vercel.app first");
  process.exit(1);
}
const CALLBACK = `${DEPLOY_URL.replace(/\/$/, "")}/api/webhooks/shopify`;

// Topic IDs Shopify expects in the GraphQL mutation (WebhookSubscriptionTopic enum).
const TOPICS: { graphqlTopic: string; restTopic: string }[] = [
  { graphqlTopic: "ORDERS_CREATE", restTopic: "orders/create" },
  { graphqlTopic: "ORDERS_UPDATED", restTopic: "orders/updated" },
  { graphqlTopic: "ORDERS_CANCELLED", restTopic: "orders/cancelled" },
  { graphqlTopic: "ORDERS_FULFILLED", restTopic: "orders/fulfilled" },
  { graphqlTopic: "ORDERS_PARTIALLY_FULFILLED", restTopic: "orders/partially_fulfilled" },
  { graphqlTopic: "CUSTOMERS_CREATE", restTopic: "customers/create" },
  { graphqlTopic: "CUSTOMERS_UPDATE", restTopic: "customers/update" },
  { graphqlTopic: "CUSTOMERS_DELETE", restTopic: "customers/delete" },
  { graphqlTopic: "PRODUCTS_CREATE", restTopic: "products/create" },
  { graphqlTopic: "PRODUCTS_UPDATE", restTopic: "products/update" },
  { graphqlTopic: "PRODUCTS_DELETE", restTopic: "products/delete" },
  { graphqlTopic: "COLLECTIONS_CREATE", restTopic: "collections/create" },
  { graphqlTopic: "COLLECTIONS_UPDATE", restTopic: "collections/update" },
  { graphqlTopic: "COLLECTIONS_DELETE", restTopic: "collections/delete" },
  { graphqlTopic: "INVENTORY_LEVELS_UPDATE", restTopic: "inventory_levels/update" },
  { graphqlTopic: "REFUNDS_CREATE", restTopic: "refunds/create" },
  { graphqlTopic: "FULFILLMENTS_CREATE", restTopic: "fulfillments/create" },
  { graphqlTopic: "FULFILLMENTS_UPDATE", restTopic: "fulfillments/update" },
];

interface ExistingSub {
  id: string;
  topic: string;
  endpoint: { callbackUrl?: string };
}

interface SubsPage {
  webhookSubscriptions: {
    edges: { node: { id: string; topic: string; endpoint: { callbackUrl?: string } } }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function listExistingSubscriptions(): Promise<ExistingSub[]> {
  const subs: ExistingSub[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: SubsPage = await query<SubsPage>(
      /* GraphQL */ `
        query ExistingWebhooks($first: Int!, $after: String) {
          webhookSubscriptions(first: $first, after: $after) {
            edges {
              node {
                id
                topic
                endpoint {
                  __typename
                  ... on WebhookHttpEndpoint { callbackUrl }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { first: 100, after: cursor },
    );
    for (const e of res.webhookSubscriptions.edges) subs.push(e.node);
    if (!res.webhookSubscriptions.pageInfo.hasNextPage) break;
    cursor = res.webhookSubscriptions.pageInfo.endCursor;
    if (!cursor) break;
  }
  return subs;
}

async function createSubscription(graphqlTopic: string): Promise<string> {
  const res = await query<{
    webhookSubscriptionCreate: {
      webhookSubscription: { id: string; topic: string; endpoint: { callbackUrl?: string } } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(
    /* GraphQL */ `
      mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $url: URL!) {
        webhookSubscriptionCreate(
          topic: $topic
          webhookSubscription: { callbackUrl: $url, format: JSON }
        ) {
          webhookSubscription {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
          userErrors { field message }
        }
      }
    `,
    { topic: graphqlTopic, url: CALLBACK },
  );
  const { webhookSubscription, userErrors } = res.webhookSubscriptionCreate;
  if (userErrors && userErrors.length) {
    throw new Error(
      userErrors.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; "),
    );
  }
  if (!webhookSubscription) throw new Error("no webhookSubscription returned");
  return webhookSubscription.id;
}

(async () => {
  console.log(`\n═══ Shopify webhook registration ═══`);
  console.log(`Shop:       ${config.SHOPIFY_SHOP_DOMAIN}`);
  console.log(`Callback:   ${CALLBACK}`);
  console.log(`API ver:    ${config.SHOPIFY_API_VERSION}`);
  console.log(`Topics:     ${TOPICS.length}\n`);

  const existing = await listExistingSubscriptions();
  console.log(`Existing subscriptions: ${existing.length}`);

  type Outcome = "created" | "kept" | "failed";
  const results: { topic: string; outcome: Outcome; id: string; note: string }[] = [];

  for (const { graphqlTopic, restTopic } of TOPICS) {
    const match = existing.find(
      (s) =>
        s.topic === graphqlTopic && s.endpoint?.callbackUrl === CALLBACK,
    );
    if (match) {
      results.push({ topic: restTopic, outcome: "kept", id: match.id, note: "already subscribed" });
      continue;
    }
    try {
      const id = await createSubscription(graphqlTopic);
      results.push({ topic: restTopic, outcome: "created", id, note: "new" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ topic: restTopic, outcome: "failed", id: "—", note: msg });
    }
  }

  console.log(`\n${"topic".padEnd(34)} │ ${"outcome".padEnd(8)} │ id`);
  console.log("─".repeat(34) + "─┼─" + "─".repeat(8) + "─┼─" + "─".repeat(40));
  for (const r of results) {
    const icon = r.outcome === "created" ? "✅" : r.outcome === "kept" ? "♻️" : "🛑";
    console.log(
      `${r.topic.padEnd(34)} │ ${icon} ${r.outcome.padEnd(7)} │ ${r.id} ${r.note ? "— " + r.note : ""}`,
    );
  }

  const created = results.filter((r) => r.outcome === "created").length;
  const kept = results.filter((r) => r.outcome === "kept").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  console.log(`\nSummary: created=${created}  kept=${kept}  failed=${failed}  total=${results.length}\n`);
  if (failed > 0) process.exit(1);
})();
