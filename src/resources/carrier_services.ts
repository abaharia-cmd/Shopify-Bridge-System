import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query CarrierServicesPage($first: Int!, $after: String) {
    carrierServices(first: $first, after: $after) {
      edges {
        node {
          id
          name
          active
          callbackUrl
          formattedName
          supportsServiceDiscovery
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

const carrier_services: ResourceModule = {
  resourceName: "carrier_services",
  category: "operational",
  table: "carrier_services",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: (() => {
        const m = /\/(\d+)(?:\?|$)/.exec(raw.id ?? "");
        return m ? Number(m[1]) : null;
      })(),
      name: raw.name ?? raw.formattedName ?? null,
      active: raw.active ?? null,
      callback_url: raw.callbackUrl ?? null,
      format: null,
      service_discovery: raw.supportsServiceDiscovery ?? null,
      supports_service_discovery: raw.supportsServiceDiscovery ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default carrier_services;
