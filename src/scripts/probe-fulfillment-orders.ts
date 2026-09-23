// Throwaway probe: confirm how Shopify exposes per-line-item location assignment
// for BOTH fulfilled and unfulfilled orders. Hypothesis: FulfillmentOrder.assignedLocation.
//
// Usage: npx tsx --env-file=.env.local src/scripts/probe-fulfillment-orders.ts 135381
import { query } from "../lib/shopify/client";

const orderNumber = process.argv[2] ?? "135381";

(async () => {
  console.log(`Probing order #${orderNumber}…`);
  const data = await query<{
    orders: {
      edges: {
        node: {
          id: string;
          name: string;
          displayFulfillmentStatus: string;
          lineItems: {
            edges: { node: { id: string; title: string; variantTitle: string | null; quantity: number } }[];
          };
          fulfillments: {
            id: string;
            status: string;
            location: { id: string; name: string } | null;
            fulfillmentLineItems: {
              edges: { node: { id: string; lineItem: { id: string; title: string }; quantity: number } }[];
            };
          }[];
          fulfillmentOrders: {
            edges: {
              node: {
                id: string;
                status: string;
                requestStatus: string;
                assignedLocation: { location: { id: string; name: string } | null; name: string } | null;
                destination: { city: string | null; address1: string | null } | null;
                lineItems: {
                  edges: {
                    node: {
                      id: string;
                      remainingQuantity: number;
                      totalQuantity: number;
                      lineItem: { id: string; title: string; variantTitle: string | null };
                    };
                  }[];
                };
              };
            }[];
          };
        };
      }[];
    };
  }>(
    /* GraphQL */ `
      query ProbeOrder($q: String!) {
        orders(query: $q, first: 1) {
          edges {
            node {
              id
              name
              displayFulfillmentStatus
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    variantTitle
                    quantity
                  }
                }
              }
              fulfillments(first: 20) {
                id
                status
                location { id name }
                fulfillmentLineItems(first: 50) {
                  edges {
                    node { id quantity lineItem { id title } }
                  }
                }
              }
              fulfillmentOrders(first: 20) {
                edges {
                  node {
                    id
                    status
                    requestStatus
                    assignedLocation {
                      name
                      location { id name }
                    }
                    destination { city address1 }
                    lineItems(first: 50) {
                      edges {
                        node {
                          id
                          remainingQuantity
                          totalQuantity
                          lineItem { id title variantTitle }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { q: `name:#${orderNumber}` },
  );

  const order = data.orders.edges[0]?.node;
  if (!order) {
    console.error("order not found");
    process.exit(1);
  }
  console.log(`\nOrder: ${order.name} (${order.id})`);
  console.log(`displayFulfillmentStatus: ${order.displayFulfillmentStatus}`);
  console.log(`Total line items: ${order.lineItems.edges.length}`);

  console.log(`\n=== fulfillmentOrders (canonical per-line-item assignment) ===`);
  for (const fo of order.fulfillmentOrders.edges) {
    const n = fo.node;
    const loc = n.assignedLocation?.location;
    console.log(`\n  FulfillmentOrder: ${n.id}`);
    console.log(`    status=${n.status}  requestStatus=${n.requestStatus}`);
    console.log(`    assignedLocation: name=${n.assignedLocation?.name ?? "—"}  id=${loc?.id ?? "—"}`);
    console.log(`    line items (${n.lineItems.edges.length}):`);
    for (const li of n.lineItems.edges) {
      console.log(`      - ${li.node.lineItem.title} | variant=${li.node.lineItem.variantTitle ?? "—"} | remaining=${li.node.remainingQuantity}/${li.node.totalQuantity}`);
    }
  }

  console.log(`\n=== fulfillments (actual shipments, populated only after fulfillment) ===`);
  for (const f of order.fulfillments) {
    console.log(`  Fulfillment ${f.id}  status=${f.status}  location=${f.location?.name ?? "—"} (${f.location?.id ?? "—"})`);
    for (const fli of f.fulfillmentLineItems.edges) {
      console.log(`    - ${fli.node.lineItem.title} qty=${fli.node.quantity}`);
    }
  }
})();
