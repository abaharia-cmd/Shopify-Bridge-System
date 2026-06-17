// Probe: does fulfillmentOrders work at QueryRoot? Get count.
import { query } from "../lib/shopify/client";

(async () => {
  try {
    const r = await query<{
      fulfillmentOrders: {
        edges: { node: { id: string; status: string; requestStatus: string; assignedLocation: { name: string } | null } }[];
        pageInfo: { hasNextPage: boolean };
      };
    }>(
      /* GraphQL */ `
        query {
          fulfillmentOrders(first: 5) {
            edges { node { id status requestStatus assignedLocation { name } } }
            pageInfo { hasNextPage }
          }
        }
      `,
    );
    console.log("✅ fulfillmentOrders exists on QueryRoot");
    console.log("First 3 nodes:");
    console.log(JSON.stringify(r.fulfillmentOrders.edges.slice(0, 3), null, 2));
  } catch (e) {
    console.log("❌ QueryRoot.fulfillmentOrders fails:", String(e).slice(0, 300));
  }

  try {
    const r = await query<{ fulfillmentOrdersCount: { count: number; precision: string } }>(
      /* GraphQL */ `query { fulfillmentOrdersCount { count precision } }`,
    );
    console.log("✅ fulfillmentOrdersCount:", r.fulfillmentOrdersCount);
  } catch (e) {
    console.log("ℹ️  no fulfillmentOrdersCount:", String(e).slice(0, 200));
  }
})();
