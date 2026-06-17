// Count fulfillmentOrders by paginating with various filters to see what's
// returned vs what we expected.
import { query } from "../lib/shopify/client";

async function paginateCount(filter: string | null, label: string): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  let pages = 0;
  type Page = { fulfillmentOrders: { edges: { node: { id: string } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  while (pages < 100) {
    const q = filter
      ? `query Q($c: String) { fulfillmentOrders(first: 100, after: $c, query: "${filter}") { edges { node { id } } pageInfo { hasNextPage endCursor } } }`
      : `query Q($c: String) { fulfillmentOrders(first: 100, after: $c) { edges { node { id } } pageInfo { hasNextPage endCursor } } }`;
    const r: Page = await query<Page>(q, { c: cursor });
    count += r.fulfillmentOrders.edges.length;
    pages += 1;
    if (!r.fulfillmentOrders.pageInfo.hasNextPage) break;
    cursor = r.fulfillmentOrders.pageInfo.endCursor;
    if (!cursor) break;
  }
  console.log(`  ${label}: ${count} records across ${pages} pages`);
  return count;
}

(async () => {
  console.log("Probing fulfillmentOrders pagination behavior...");
  // No filter - what's the unfiltered total via pagination?
  await paginateCount(null, "no filter");
  // With our current filter
  await paginateCount("created_at:>=2021-12-01", "created_at:>=2021-12-01");
  // Just fresh ones
  await paginateCount("created_at:>=2026-01-01", "created_at:>=2026-01-01");
})();
