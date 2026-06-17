import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

const QUERY = /* GraphQL */ `
  query LocationsPage($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          isActive
          shipsInventory
          hasActiveInventory
          hasUnfulfilledOrders
          fulfillsOnlineOrders
          isPrimary
          isFulfillmentService
          fulfillmentService {
            id
            handle
          }
          address {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            zip
            phone
            latitude
            longitude
            formatted
          }
          localPickupSettingsV2 {
            instructions
            pickupTime
          }
          activatable
          deactivatable
          deletable
          createdAt
          updatedAt
          deactivatedAt
          metafields(first: 250) {
            edges {
              node {
                id
                legacyResourceId
                namespace
                key
                value
                type
                description
                createdAt
                updatedAt
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

const metafieldsExtractor: ChildExtractor = {
  table: "location_metafields",
  parentFk: "location_id",
  replaceByParent: true,
  // Composite UNIQUE on (location_id, namespace, key) — Shopify can re-emit
  // the same metafield with a different GID after edits, so route the upsert
  // to the natural-key constraint, not just the surrogate `id` PK.
  onConflict: "location_id,namespace,key",
  extract: (raw: RawPayload, parent, ctx) => {
    const edges = raw?.metafields?.edges ?? [];
    return edges.map((e: { node: RawPayload }) => {
      const m = e.node;
      const legacy = ctx.parseGid(m.id).legacyId;
      return {
        id: m.id,
        location_id: parent.id,
        legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
        namespace: m.namespace,
        key: m.key,
        value: m.value ?? null,
        type: m.type ?? null,
        description: m.description ?? null,
        created_at: m.createdAt ?? null,
        updated_at: m.updatedAt ?? null,
        raw_payload: m,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(m),
      };
    });
  },
};

const locations: ResourceModule = {
  resourceName: "locations",
  category: "operational",
  table: "locations",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const a = raw.address ?? {};
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      name: raw.name,
      is_active: raw.isActive ?? null,
      ships_inventory: raw.shipsInventory ?? null,
      has_active_inventory: raw.hasActiveInventory ?? null,
      has_unfulfilled_orders: raw.hasUnfulfilledOrders ?? null,
      fulfills_online_orders: raw.fulfillsOnlineOrders ?? null,
      is_primary: raw.isPrimary ?? null,
      is_fulfillment_service: raw.isFulfillmentService ?? null,
      fulfillment_service_id: raw.fulfillmentService?.id ?? null,
      fulfillment_service_handle: raw.fulfillmentService?.handle ?? null,
      address_line1: a.address1 ?? null,
      address_line2: a.address2 ?? null,
      city: a.city ?? null,
      province: a.province ?? null,
      province_code: a.provinceCode ?? null,
      country: a.country ?? null,
      country_code: a.countryCode ?? null,
      zip: a.zip ?? null,
      phone: a.phone ?? null,
      latitude: a.latitude ?? null,
      longitude: a.longitude ?? null,
      formatted_address: a.formatted ?? null,
      local_pickup_settings: raw.localPickupSettingsV2 ?? null,
      activatable: raw.activatable ?? null,
      deactivatable: raw.deactivatable ?? null,
      deletable: raw.deletable ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      deactivated_at: raw.deactivatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [metafieldsExtractor],
};

export default locations;
