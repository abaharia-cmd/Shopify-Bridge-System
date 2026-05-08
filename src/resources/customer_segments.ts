// Wave 2 Group C: customer_segments — definitions only.
// Per Decision 2 in Wave 2 spec, the membership table is deferred
// (recomputable from each segment's `query` string).
import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query SegmentsPage($first: Int!, $after: String) {
    segments(first: $first, after: $after) {
      edges {
        node { id name query creationDate lastEditDate }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const customer_segments: ResourceModule = {
  resourceName: "customer_segments",
  category: "customers",
  table: "customer_segments",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    return {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      name: raw.name ?? null,
      query: raw.query ?? null,
      creation_date: raw.creationDate ?? null,
      last_edit_date: raw.lastEditDate ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    } as MainRow;
  },
};

export default customer_segments;
