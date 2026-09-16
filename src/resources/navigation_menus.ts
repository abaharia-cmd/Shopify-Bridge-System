// Wave 2 Group E: navigation_menus.
import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query MenusPage($first: Int!, $after: String) {
    menus(first: $first, after: $after) {
      edges {
        node {
          id title handle isDefault
          items { id title type url resourceId items { id title type url resourceId } }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const navigation_menus: ResourceModule = {
  resourceName: "navigation_menus",
  category: "content",
  table: "navigation_menus",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    return {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      title: raw.title ?? null,
      handle: raw.handle ?? null,
      is_default: raw.isDefault ?? null,
      items: raw.items ?? null,
      items_count: Array.isArray(raw.items) ? raw.items.length : null,
      created_at: null, // Menu type has no createdAt in 2026-01
      updated_at: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    } as MainRow;
  },
};

export default navigation_menus;
