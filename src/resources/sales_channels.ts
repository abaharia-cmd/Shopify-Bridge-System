import type { ResourceModule, MainRow, RawPayload } from "./types";

// Maps Shopify Publications → shopify.sales_channels. Pre-flight for products
// (product_publications has FK to sales_channels.id).
const QUERY = /* GraphQL */ `
  query PublicationsPage($first: Int!, $after: String) {
    publications(first: $first, after: $after) {
      edges {
        node {
          id
          name
          supportsFuturePublishing
          autoPublish
          app {
            id
          }
          catalog {
            id
          }
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

const sales_channels: ResourceModule = {
  resourceName: "sales_channels",
  category: "operational",
  table: "sales_channels",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      name: raw.name ?? null,
      app_id: raw.app?.id ?? null,
      catalog_id: raw.catalog?.id ?? null,
      supports_future_publishing: raw.supportsFuturePublishing ?? null,
      auto_publish: raw.autoPublish ?? null,
      has_collection: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default sales_channels;
