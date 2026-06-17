import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

// `deliveryProfiles` returns shipping profiles. Each profile has zones via
// profileLocationGroups[].locationGroupZones — those become shipping_zones.
// Single Shopify query populates both tables.
const QUERY = /* GraphQL */ `
  query DeliveryProfilesPage($first: Int!, $after: String) {
    deliveryProfiles(first: $first, after: $after) {
      edges {
        node {
          id
          name
          default
          legacyMode
          activeMethodDefinitionsCount
          originLocationCount
          productVariantsCountV2 {
            count
          }
          unassignedLocations {
            id
            name
          }
          profileLocationGroups {
            locationGroup {
              id
              locations(first: 250) {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
            locationGroupZones(first: 250) {
              edges {
                node {
                  zone {
                    id
                    name
                    countries {
                      code {
                        countryCode
                        restOfWorld
                      }
                      name
                      provinces {
                        code
                        name
                      }
                    }
                  }
                }
              }
            }
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

const zonesExtractor: ChildExtractor = {
  table: "shipping_zones",
  parentFk: "profile_id",
  replaceByParent: true,
  extract: (raw: RawPayload, parent, ctx) => {
    const rows: Record<string, unknown>[] = [];
    for (const grp of raw.profileLocationGroups ?? []) {
      const zoneEdges = grp.locationGroupZones?.edges ?? [];
      for (const e of zoneEdges) {
        const z = e.node?.zone;
        if (!z?.id) continue;
        const legacy = ctx.parseGid(z.id).legacyId;
        rows.push({
          id: z.id,
          profile_id: parent.id,
          legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
          name: z.name ?? null,
          countries: z.countries ?? null,
          raw_payload: z,
          synced_at: ctx.now,
          _content_hash: ctx.hashContent(z),
        });
      }
    }
    return rows;
  },
};

const shipping_profiles: ResourceModule = {
  resourceName: "shipping_profiles",
  category: "operational",
  table: "shipping_profiles",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const variantsCount = raw.productVariantsCountV2?.count ?? null;
    const zoneCount = (raw.profileLocationGroups ?? []).reduce(
      (n: number, g: RawPayload) => n + (g.locationGroupZones?.edges?.length ?? 0),
      0,
    );
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      name: raw.name ?? null,
      default_profile: raw.default ?? null,
      product_count: variantsCount,
      active_method_definitions_count: raw.activeMethodDefinitionsCount ?? null,
      origin_location_count: raw.originLocationCount ?? null,
      zone_count: zoneCount,
      unassigned_locations: raw.unassignedLocations ?? null,
      selling_plan_groups_count: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [zonesExtractor],
};

export default shipping_profiles;
