// Fulfillment Orders sync.
//
// FulfillmentOrder is Shopify's "routing decision" object — it answers
// "which location is assigned to fulfill which line items of this order?"
// It exists from `order_routing_complete` onward, regardless of whether the
// line items have actually shipped. This is THE canonical source for
// location-of-unfulfilled-orders. The legacy `Fulfillment` record only
// exists AFTER an actual shipment, which is why `order.fulfillments[].location`
// is null for unfulfilled orders.
//
// Strategy: paginated_batch on QueryRoot.fulfillmentOrders. ~1-3 records per
// order. Has natural Shopify GIDs → id-based upsert is idempotent.
//
// Child extractor: fulfillment_order_line_items — the many-to-many between
// FulfillmentOrder and LineItem with per-line-item quantities. Upsert-only
// (NOT replaceByParent): natural GIDs + cross-module RESTRICT FKs make
// id-based upsert safe and idempotent (per CLAUDE.md NEVER rule about
// cross-module CASCADE).

import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { query } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

// `created_at:>=2021-12-01` floor matches our orders backfill coverage
// (earliest order 2021-12-28). Without it, Shopify returns FOs for pre-2021
// orders that aren't in our shopify.orders table → FK violations on insert.
const QUERY = /* GraphQL */ `
  query FulfillmentOrdersPage($cursor: String) {
    fulfillmentOrders(first: 100, after: $cursor, query: "created_at:>=2021-12-01") {
      edges {
        node {
          id
          status
          requestStatus
          order { id }
          assignedLocation {
            name
            location { id }
          }
          destination {
            address1
            address2
            city
            company
            countryCode
            province
            zip
            phone
            firstName
            lastName
            email
          }
          fulfillAt
          fulfillBy
          deliveryMethod { methodType }
          channelId
          supportedActions { action }
          createdAt
          updatedAt
          lineItems(first: 100) {
            edges {
              node {
                id
                totalQuantity
                remainingQuantity
                lineItem { id }
              }
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const lineItemsExtractor: ChildExtractor = {
  table: "fulfillment_order_line_items",
  parentFk: "fulfillment_order_id",
  // upsert-only: NO replaceByParent. Cross-module RESTRICT FKs make delete-
  // then-insert risky; natural GIDs make idempotent id-based upsert safe.
  // (See CLAUDE.md NEVER rule on cross-module CASCADE.)
  extract: (raw: RawPayload, parent, ctx) => {
    const edges: RawPayload[] = raw.lineItems?.edges ?? [];
    return edges.map((e: RawPayload) => {
      const li = e.node ?? e;
      return {
        id: li.id,
        fulfillment_order_id: parent.id,
        line_item_id: li.lineItem?.id ?? null,
        total_quantity: li.totalQuantity ?? null,
        remaining_quantity: li.remainingQuantity ?? null,
        raw_payload: li,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(li),
      };
    });
  },
};

const fulfillment_orders: ResourceModule = {
  resourceName: "fulfillment_orders",
  category: "orders",
  table: "fulfillment_orders",
  syncStrategy: "paginated_batch",
  graphqlQuery: QUERY,
  dependsOn: ["orders"], // FK to orders.id
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    if (!raw.order?.id) return null; // FK requires non-null order_id
    const legacy = ctx.parseGid(raw.id).legacyId;
    const dest = raw.destination ?? null;
    const loc = raw.assignedLocation;
    const supportedActions = (raw.supportedActions ?? []).map((a: RawPayload) => a.action).filter(Boolean);
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      order_id: raw.order.id,
      status: raw.status ?? null,
      request_status: raw.requestStatus ?? null,
      assigned_location_id: loc?.location?.id ?? null,
      assigned_location_name: loc?.name ?? null,
      destination_address1: dest?.address1 ?? null,
      destination_address2: dest?.address2 ?? null,
      destination_city: dest?.city ?? null,
      destination_company: dest?.company ?? null,
      destination_country: null,
      destination_country_code: dest?.countryCode ?? null,
      destination_province: dest?.province ?? null,
      destination_province_code: null,
      destination_zip: dest?.zip ?? null,
      destination_phone: dest?.phone ?? null,
      destination_first_name: dest?.firstName ?? null,
      destination_last_name: dest?.lastName ?? null,
      destination_email: dest?.email ?? null,
      fulfill_at: raw.fulfillAt ?? null,
      fulfill_by: raw.fulfillBy ?? null,
      delivery_method_type: raw.deliveryMethod?.methodType ?? null,
      channel_id: raw.channelId ?? null,
      supported_actions: supportedActions.length ? supportedActions : null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [lineItemsExtractor],

  // ─── Phase 3B incremental sync ───────────────────────────────────────────
  // Single-record fetch for webhooks (fulfillment_orders/*). Returns the same
  // shape the bulk QUERY returns for one node, so the existing transform +
  // childExtractor work unchanged.
  incremental: async (id: string): Promise<RawPayload | null> => {
    const data = await query<{ fulfillmentOrder: RawPayload | null }>(
      /* GraphQL */ `
        query FulfillmentOrderById($id: ID!) {
          fulfillmentOrder(id: $id) {
            id
            status
            requestStatus
            order { id }
            assignedLocation {
              name
              location { id }
            }
            destination {
              address1 address2 city company countryCode province zip
              phone firstName lastName email
            }
            fulfillAt
            fulfillBy
            deliveryMethod { methodType }
            channelId
            supportedActions { action }
            createdAt
            updatedAt
            lineItems(first: 100) {
              edges {
                node {
                  id
                  totalQuantity
                  remainingQuantity
                  lineItem { id }
                }
              }
            }
          }
        }
      `,
      { id },
    );
    return data.fulfillmentOrder ?? null;
  },

  softDelete: async (id: string): Promise<void> => {
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb
      .from("fulfillment_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`fulfillment_orders.softDelete ${id}: ${error.message}`);
  },
};

export default fulfillment_orders;
