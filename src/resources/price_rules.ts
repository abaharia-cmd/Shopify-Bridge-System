import type { ResourceModule, MainRow, RawPayload } from "./types";

// Legacy `priceRules` still exists in 2026-01 alongside the modern discount
// API. Stores rarely use it directly, but the data is still queryable.
const QUERY = /* GraphQL */ `
  query PriceRulesPage($first: Int!, $after: String) {
    priceRules(first: $first, after: $after) {
      edges {
        node {
          id
          legacyResourceId
          title
          status
          valueV2 {
            __typename
            ... on PricingPercentageValue {
              percentage
            }
            ... on MoneyV2 {
              amount
              currencyCode
            }
          }
          customerSelection {
            __typename
          }
          target
          allocationMethod
          allocationLimit
          oncePerCustomer
          usageLimit
          startsAt
          endsAt
          createdAt
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

const price_rules: ResourceModule = {
  resourceName: "price_rules",
  category: "marketing",
  table: "price_rules",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const v = raw.valueV2 ?? {};
    const isPct = v.__typename === "PricingPercentageValue";
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: raw.legacyResourceId ? Number(raw.legacyResourceId) : null,
      title: raw.title ?? null,
      value_type: isPct ? "percentage" : v.__typename === "MoneyV2" ? "fixed_amount" : null,
      value: isPct ? v.percentage : v.amount ?? null,
      customer_selection: raw.customerSelection?.__typename ?? null,
      target_type: raw.target ?? null,
      target_selection: null,
      allocation_method: raw.allocationMethod ?? null,
      allocation_limit: raw.allocationLimit ?? null,
      once_per_customer: raw.oncePerCustomer ?? null,
      usage_limit: raw.usageLimit ?? null,
      prerequisite_subtotal_range: null,
      prerequisite_quantity_range: null,
      prerequisite_shipping_price_range: null,
      prerequisite_to_entitlement_quantity_ratio: null,
      prerequisite_to_entitlement_purchase: null,
      prerequisite_product_ids: null,
      prerequisite_variant_ids: null,
      prerequisite_collection_ids: null,
      prerequisite_customer_ids: null,
      prerequisite_segment_ids: null,
      entitled_product_ids: null,
      entitled_variant_ids: null,
      entitled_collection_ids: null,
      entitled_country_ids: null,
      starts_at: raw.startsAt ?? null,
      ends_at: raw.endsAt ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default price_rules;
