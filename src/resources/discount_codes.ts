// Wave 2 Group A: discount_codes via the modern codeDiscountNodes API
// (replaced legacy priceRules in 2026-01).
//
// codeDiscount is a UNION (DiscountCodeBasic, DiscountCodeBxgy,
// DiscountCodeFreeShipping, DiscountCodeApp). Inline fragments cover all
// four; __typename is stored in raw_payload + discount_type column.
//
// Run via the orchestrator (`syncStrategy: paginated`).

import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query DiscountCodesPage($cursor: String) {
    codeDiscountNodes(first: 250, after: $cursor) {
      edges {
        node {
          id
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title summary status startsAt endsAt createdAt updatedAt
              usageLimit appliesOncePerCustomer
              asyncUsageCount
              customerSelection {
                __typename
                ... on DiscountCustomerSegments { segments { id } }
                ... on DiscountCustomers { customers { id } }
              }
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
              recurringCycleLimit
              combinesWith { productDiscounts orderDiscounts shippingDiscounts }
              codes(first: 250) { edges { node { code } } }
              codesCount { count }
            }
            ... on DiscountCodeBxgy {
              title summary status startsAt endsAt createdAt updatedAt
              usageLimit asyncUsageCount usesPerOrderLimit
              codes(first: 250) { edges { node { code } } }
              codesCount { count }
            }
            ... on DiscountCodeFreeShipping {
              title summary status startsAt endsAt createdAt updatedAt
              usageLimit asyncUsageCount appliesOncePerCustomer
              codes(first: 250) { edges { node { code } } }
              codesCount { count }
            }
            ... on DiscountCodeApp {
              title status startsAt endsAt createdAt updatedAt asyncUsageCount
              codes(first: 250) { edges { node { code } } }
              codesCount { count }
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

const discount_codes: ResourceModule = {
  resourceName: "discount_codes",
  category: "marketing",
  table: "discount_codes",
  syncStrategy: "paginated_batch",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const d = raw.codeDiscount ?? {};
    const v = pickValue(d);
    const mr = pickMinReq(d);
    const codes = (d.codes?.edges ?? []).map((e: RawPayload) => e.node?.code).filter(Boolean);
    const segIds = (d.customerSelection?.segments ?? []).map((s: RawPayload) => s.id);
    const custIds = (d.customerSelection?.customers ?? []).map((c: RawPayload) => c.id);
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      discount_class: null, // Shopify doesn't expose a top-level discount_class on codeDiscount union
      discount_type: d.__typename ?? null,
      status: d.status ?? null,
      title: d.title ?? null,
      summary: d.summary ?? null,
      short_summary: null,
      codes,
      codes_count: d.codesCount?.count ?? codes.length,
      usage_limit: d.usageLimit ?? null,
      applies_once_per_customer: d.appliesOncePerCustomer ?? null,
      uses_per_order_limit: d.usesPerOrderLimit ?? null,
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
      customer_selection_type: d.customerSelection?.__typename ?? null,
      customer_segment_ids: segIds.length ? segIds : null,
      customer_ids: custIds.length ? custIds : null,
      applies_on_subscription: d.appliesOnSubscription ?? null,
      applies_on_one_time_purchase: d.appliesOnOneTimePurchase ?? null,
      combines_with_product_discounts: d.combinesWith?.productDiscounts ?? null,
      combines_with_order_discounts: d.combinesWith?.orderDiscounts ?? null,
      combines_with_shipping_discounts: d.combinesWith?.shippingDiscounts ?? null,
      recurring_cycle_limit: d.recurringCycleLimit ?? null,
      target_type: null,
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

export default discount_codes;
