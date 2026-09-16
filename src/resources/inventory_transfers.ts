import type { ResourceModule, MainRow, RawPayload } from "./types";

// Inventory Transfers — paginated (no bulk op support per registry).
// Note: GraphQL field is `inventoryTransfers`. If the store has none,
// this returns 0 rows and succeeds quickly.
const QUERY = /* GraphQL */ `
  query InventoryTransfersPage($first: Int!, $after: String) {
    inventoryTransfers(first: $first, after: $after) {
      edges {
        node {
          id
          status
          note
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const inventory_transfers: ResourceModule = {
  resourceName: "inventory_transfers",
  category: "inventory",
  table: "inventory_transfers",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const m = /\/(\d+)(?:\?|$)/.exec(raw.id ?? "");
    const legacy = m ? Number(m[1]) : null;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: legacy,
      origin_location_id: null,
      destination_location_id: null,
      status: raw.status ?? null,
      reference: null,
      note: raw.note ?? null,
      total_quantity: null,
      expected_arrival_date: null,
      arrived_at: null,
      created_at: null,
      updated_at: null,
      line_items: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default inventory_transfers;
