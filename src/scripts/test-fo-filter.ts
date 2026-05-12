// Test which filters Shopify accepts on fulfillmentOrders.
import { query } from "../lib/shopify/client";

(async () => {
  // Try created_at filter
  try {
    const r = await query<{ fulfillmentOrders: { edges: { node: { id: string; createdAt: string } }[] } }>(
      `{ fulfillmentOrders(first: 3, query: "created_at:>=2021-12-01") { edges { node { id createdAt } } } }`,
    );
    console.log("✅ created_at filter accepted. First 3:");
    for (const e of r.fulfillmentOrders.edges) console.log(`  ${e.node.id} created=${e.node.createdAt}`);
  } catch (e) {
    console.log("❌ created_at filter:", String(e).slice(0, 200));
  }

  // Try updated_at filter
  try {
    const r = await query<{ fulfillmentOrders: { edges: { node: { id: string; updatedAt: string } }[] } }>(
      `{ fulfillmentOrders(first: 3, query: "updated_at:>=2026-05-01") { edges { node { id updatedAt } } } }`,
    );
    console.log("\n✅ updated_at filter accepted. First 3:");
    for (const e of r.fulfillmentOrders.edges) console.log(`  ${e.node.id} updated=${e.node.updatedAt}`);
  } catch (e) {
    console.log("❌ updated_at filter:", String(e).slice(0, 200));
  }

  // Sort by createdAt
  try {
    const r = await query<{ fulfillmentOrders: { edges: { node: { id: string; createdAt: string } }[] } }>(
      `{ fulfillmentOrders(first: 3, sortKey: CREATED_AT, reverse: true) { edges { node { id createdAt } } } }`,
    );
    console.log("\n✅ sortKey CREATED_AT accepted. Newest 3:");
    for (const e of r.fulfillmentOrders.edges) console.log(`  ${e.node.id} created=${e.node.createdAt}`);
  } catch (e) {
    console.log("❌ sortKey CREATED_AT:", String(e).slice(0, 200));
  }
})();
