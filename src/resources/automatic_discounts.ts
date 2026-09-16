// Wave 2 Group A: automatic_discounts via the modern automaticDiscountNodes
// API (replaced legacy priceRules in 2026-01).
//
// automaticDiscount is a UNION (DiscountAutomaticBasic, DiscountAutomaticBxgy,
// DiscountAutomaticFreeShipping, DiscountAutomaticApp). __typename → discount_type.

import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query AutoDiscountsPage($first: Int!, $after: String) {
    automaticDiscountNodes(first: $first, after: $after) {
      edges {
        node {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title summary status startsAt endsAt createdAt updatedAt asyncUsageCount
              recurringCycleLimit
              combinesWith { productDiscounts orderDiscounts shippingDiscounts }
              customerGets {
                value {
                  __typename
                  ... on DiscountAmount { amount { amount currencyCode } }
                  ... on DiscountPercentage { percentage }
                }
              }
              minimumRequirement {
                __typename
                ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
              }
            }
            ... on DiscountAutomaticBxgy {
              title summary status startsAt endsAt createdAt updatedAt asyncUsageCount
              usesPerOrderLimit
            }
            ... on DiscountAutomaticFreeShipping {
              title summary status startsAt endsAt createdAt updatedAt asyncUsageCount
              combinesWith { productDiscounts orderDiscounts shippingDiscounts }
            }
            ... on DiscountAutomaticApp {
              title status startsAt endsAt createdAt updatedAt asyncUsageCount
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function pickValue(d: RawPayload): { type: string | null; pct: number | null; amt: number | null; cur: string | null } {
  const v = d?.customerGets?.value;
  if (!v) return { type: null, pct: null, amt: null, cur: null };
  if (v.__typename === "DiscountPercentage") return { type: "PERCENTAGE", pct: Number(v.percentage) * 100, amt: null, cur: null };
  if (v.__typename === "DiscountAmount") return { type: "FIXED_AMOUNT", pct: null, amt: v.amount?.amount ?? null, cur: v.amount?.currencyCode ?? null };
  return { type: v.__typename ?? null, pct: null, amt: null, cur: null };
}

function pickMinReq(d: RawPayload): { type: string | null; value: number | null; cur: string | null } {
  const m = d?.minimumRequirement;
  if (!m) return { type: null, value: null, cur: null };
  if (m.__typename === "DiscountMinimumQuantity") return { type: "QUANTITY", value: m.greaterThanOrEqualToQuantity ?? null, cur: null };
  if (m.__typename === "DiscountMinimumSubtotal") return { type: "SUBTOTAL", value: m.greaterThanOrEqualToSubtotal?.amount ?? null, cur: m.greaterThanOrEqualToSubtotal?.currencyCode ?? null };
  return { type: m.__typename ?? null, value: null, cur: null };
}

const automatic_discounts: ResourceModule = {
  resourceName: "automatic_discounts",
  category: "marketing",
  table: "automatic_discounts",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const d = raw.automaticDiscount ?? {};
    const v = pickValue(d);
    const mr = pickMinReq(d);
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      discount_class: null,
      discount_type: d.__typename ?? null,
      status: d.status ?? null,
      title: d.title ?? null,
      summary: d.summary ?? null,
      short_summary: null,
      async_usage_count: d.asyncUsageCount ?? null,
      total_sales_amount: null,
      total_sales_currency: null,
      value_type: v.type,
      value_percentage: v.pct,
      value_amount: v.amt,
      value_currency: v.cur,
      minimum_requirement_type: mr.type,
      minimum_requirement_value: mr.value,
      minimum_requirement_currency: mr.cur,
      combines_with_product_discounts: d.combinesWith?.productDiscounts ?? null,
      combines_with_order_discounts: d.combinesWith?.orderDiscounts ?? null,
      combines_with_shipping_discounts: d.combinesWith?.shippingDiscounts ?? null,
      target_type: null,
      applies_on_subscription: d.appliesOnSubscription ?? null,
      applies_on_one_time_purchase: d.appliesOnOneTimePurchase ?? null,
      recurring_cycle_limit: d.recurringCycleLimit ?? null,
      starts_at: d.startsAt ?? null,
      ends_at: d.endsAt ?? null,
      created_at: d.createdAt ?? null,
      updated_at: d.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default automatic_discounts;
