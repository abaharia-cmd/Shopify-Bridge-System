// Phase 3 Wave 1 — Pass 2: order-level CONNECTIONS.
// Runs as `chunked_monthly` over the same date range as Phase 2 orders, with
// `skipParentUpsert: true` — the parent `orders` table is already complete.
//
// Tables filled (3):
//   - order_shipping_lines        (Order.shippingLines, CONNECTION)
//   - order_discount_applications (Order.discountApplications, CONNECTION)
//   - order_metafields            (Order.metafields, CONNECTION)
//
// Connection budget: orders + shippingLines + discountApplications + metafields
//   = 4 / 5. One slot of headroom.
//
// DiscountApplication is an INTERFACE with 4 implementations
// (DiscountCodeApplication, ManualDiscountApplication, AutomaticDiscountApplication,
// ScriptDiscountApplication). Inline fragments below cover all four; the
// transform stores __typename in `application_type` so analytics can filter
// later. Unknown subtypes still get a row (no fragment-specific fields, but
// __typename + interface fields preserved).
//
// PricingValue is a UNION of MoneyV2 and PricingPercentageValue — also handled
// via inline fragments, with value_type capturing the discriminator.

import type { ResourceModule, MainRow, RawPayload } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";

const QUERY = /* GraphQL */ `
  orders(query: "{{QUERY_FILTER}}") {
    edges {
      node {
        id
        shippingLines {
          edges {
            node {
              id
              title
              code
              source
              carrierIdentifier
              deliveryCategory
              phone
              custom
              isRemoved
              shippingRateHandle
              originalPriceSet { shopMoney { amount currencyCode } }
              discountedPriceSet { shopMoney { amount currencyCode } }
              currentDiscountedPriceSet { shopMoney { amount currencyCode } }
              taxLines {
                title
                rate
                ratePercentage
                priceSet { shopMoney { amount currencyCode } }
              }
              discountAllocations {
                allocatedAmountSet { shopMoney { amount currencyCode } }
                discountApplication { index }
              }
            }
          }
        }
        discountApplications {
          edges {
            node {
              __typename
              allocationMethod
              index
              targetSelection
              targetType
              value {
                __typename
                ... on MoneyV2 { amount currencyCode }
                ... on PricingPercentageValue { percentage }
              }
              ... on DiscountCodeApplication { code }
              ... on ManualDiscountApplication { title description }
              ... on AutomaticDiscountApplication { title }
              ... on ScriptDiscountApplication { title }
            }
          }
        }
        metafields {
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
    }
  }
`;

const ordersPass2: ResourceModule = {
  resourceName: "orders_pass_2",
  category: "orders_pass",
  table: "orders",
  syncStrategy: "chunked_monthly",
  chunkField: "created_at",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    return {
      id: raw.id,
      raw_payload: {},
      synced_at: ctx.now,
      _content_hash: "",
    } as MainRow;
  },
  childExtractors: [
    {
      // ShippingLine has a Shopify GID, so PK 'id' is natural — no surrogate.
      table: "order_shipping_lines",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        return pickChildren(raw, "shipping_line").map((sl) => ({
          id: sl.id,
          order_id: parent.id,
          legacy_resource_id: legacyOf(ctx, sl.id),
          title: sl.title ?? null,
          code: sl.code ?? null,
          source: sl.source ?? null,
          carrier_identifier: sl.carrierIdentifier ?? null,
          delivery_category: sl.deliveryCategory ?? null,
          phone: sl.phone ?? null,
          original_price_amount: sl.originalPriceSet?.shopMoney?.amount ?? null,
          original_price_currency: sl.originalPriceSet?.shopMoney?.currencyCode ?? null,
          discounted_price_amount: sl.discountedPriceSet?.shopMoney?.amount ?? null,
          discounted_price_currency: sl.discountedPriceSet?.shopMoney?.currencyCode ?? null,
          current_discounted_price_amount: sl.currentDiscountedPriceSet?.shopMoney?.amount ?? null,
          current_discounted_price_currency: sl.currentDiscountedPriceSet?.shopMoney?.currencyCode ?? null,
          requested_fulfillment_service_id: null, // not exposed in 2026-01 schema
          discount_allocations: sl.discountAllocations ?? null,
          tax_lines: sl.taxLines ?? null,
          custom: sl.custom ?? null,
          raw_payload: sl,
          synced_at: parent.synced_at,
          _content_hash: ctx.hashContent(sl),
        }));
      },
    },
    {
      // DiscountApplication has NO `id` in the JSONL output (interface with
      // surrogate uuid PK on our side). PG has a UNIQUE constraint on
      // (order_id, application_index) — Shopify CAN return multiple DAs with
      // the same index for one order (e.g. when one discount targets multiple
      // products, sometimes emitted as multiple edges with shared index, or
      // when JSONL flattening produces apparent duplicates). Routing onConflict
      // to that constraint makes the upsert UPDATE-on-collision instead of
      // failing the whole sub-batch. dedupeByKey will collapse same-key rows
      // within a batch (last-write-wins) since both cols are populated.
      table: "order_discount_applications",
      replaceByParent: true,
      parentFk: "order_id",
      onConflict: "order_id,application_index",
      extract: (raw, parent) => {
        // DiscountApplication is INTERFACE — JSONL emits each as a separate
        // line with __parentId. groupByParent uses gidTypeKey from `id`, but
        // these have no id field, so they land under _children.unknown.
        // Filter by the discriminator `allocationMethod` / `targetSelection`.
        const apps = pickDiscountApplications(raw);
        return apps.map((da) => {
          const v = da.value ?? {};
          const isMoney = v.__typename === "MoneyV2";
          const isPct = v.__typename === "PricingPercentageValue";
          return {
            order_id: parent.id,
            application_index: da.index,
            application_type: da.__typename ?? null,
            target_selection: da.targetSelection ?? null,
            target_type: da.targetType ?? null,
            allocation_method: da.allocationMethod ?? null,
            value_type: v.__typename ?? null,
            value_amount: isMoney ? v.amount ?? null : null,
            value_currency: isMoney ? v.currencyCode ?? null : null,
            value_percentage: isPct ? v.percentage ?? null : null,
            code: da.code ?? null,
            title: da.title ?? null,
            description: da.description ?? null,
            raw_payload: da,
            synced_at: parent.synced_at,
          };
        });
      },
    },
    {
      // Order.metafields has Shopify GID — natural PK 'id'. ALSO has UNIQUE
      // constraint on (order_id, namespace, key) — route onConflict there for
      // safety in case the same metafield is reassigned a new GID across runs.
      table: "order_metafields",
      replaceByParent: true,
      parentFk: "order_id",
      onConflict: "order_id,namespace,key",
      extract: (raw, parent, ctx) => {
        return pickChildren(raw, "metafield").map((m) => ({
          id: m.id,
          order_id: parent.id,
          legacy_resource_id: m.legacyResourceId ? Number(m.legacyResourceId) : null,
          namespace: m.namespace,
          key: m.key,
          value: m.value ?? null,
          type: m.type ?? null,
          description: m.description ?? null,
          created_at: m.createdAt ?? null,
          updated_at: m.updatedAt ?? null,
          raw_payload: m,
          synced_at: parent.synced_at,
          deleted_at: null,
          _content_hash: ctx.hashContent(m),
        }));
      },
    },
  ],
};

function legacyOf(ctx: { parseGid: (gid: string) => { legacyId: string } }, gid: string): number | null {
  if (!gid) return null;
  const { legacyId } = ctx.parseGid(gid);
  const n = Number(legacyId);
  return Number.isFinite(n) ? n : null;
}

// DiscountApplications have no `id` field in JSONL output, so groupByParent
// puts them under `_children.unknown`. Filter by the discriminator fields a
// DiscountApplication reliably has (`allocationMethod` is required on the
// interface).
function pickDiscountApplications(raw: RawPayload): RawPayload[] {
  const c = raw?._children as Record<string, RawPayload[]> | undefined;
  if (!c) return [];
  const out: RawPayload[] = [];
  for (const arr of Object.values(c)) {
    for (const item of arr) {
      // Heuristic: DA always has allocationMethod + index + targetSelection.
      if (
        typeof item.allocationMethod === "string" &&
        typeof item.index === "number" &&
        typeof item.targetSelection === "string"
      ) {
        out.push(item);
      }
    }
  }
  return out;
}

export default ordersPass2;
