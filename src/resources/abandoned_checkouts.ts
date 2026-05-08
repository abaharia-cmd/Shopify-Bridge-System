// Wave 2 Group B: abandoned_checkouts + line items.
// 3-month rolling window enforced by Shopify (we don't filter further).
import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

const QUERY = /* GraphQL */ `
  query AbandonedCheckoutsPage($first: Int!, $after: String) {
    abandonedCheckouts(first: $first, after: $after) {
      edges {
        node {
          id name abandonedCheckoutUrl
          customer { id }
          totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalDiscountSet { shopMoney { amount currencyCode } }
          note
          taxesIncluded
          discountCodes
          customAttributes { key value }
          createdAt updatedAt completedAt
          lineItems(first: 100) {
            edges {
              node {
                id sku title variantTitle
                product { id } variant { id }
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                originalTotalPriceSet { shopMoney { amount currencyCode } }
                discountedTotalPriceSet { shopMoney { amount currencyCode } }
                customAttributes { key value }
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
  table: "abandoned_checkout_line_items",
  parentFk: "abandoned_checkout_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    const edges = raw?.lineItems?.edges ?? [];
    return edges.map((e: RawPayload) => {
      const li = e.node;
      return {
        id: li.id,
        abandoned_checkout_id: parent.id,
        product_id: li.product?.id ?? null,
        variant_id: li.variant?.id ?? null,
        sku: li.sku ?? null,
        title: li.title ?? null,
        variant_title: li.variantTitle ?? null,
        vendor: null,
        quantity: li.quantity ?? null,
        original_unit_price_amount: li.originalUnitPriceSet?.shopMoney?.amount ?? null,
        original_unit_price_currency: li.originalUnitPriceSet?.shopMoney?.currencyCode ?? null,
        original_total_amount: li.originalTotalPriceSet?.shopMoney?.amount ?? null,
        original_total_currency: li.originalTotalPriceSet?.shopMoney?.currencyCode ?? null,
        discounted_unit_price_amount: null,
        discounted_unit_price_currency: null,
        discounted_total_amount: li.discountedTotalPriceSet?.shopMoney?.amount ?? null,
        discounted_total_currency: li.discountedTotalPriceSet?.shopMoney?.currencyCode ?? null,
        taxable: null,
        requires_shipping: null,
        applied_discount: null,
        discount_allocations: null,
        weight: null,
        raw_payload: li,
        synced_at: parent.synced_at,
        _content_hash: ctx.hashContent(li),
      };
    });
  },
};

const abandoned_checkouts: ResourceModule = {
  resourceName: "abandoned_checkouts",
  category: "orders",
  table: "abandoned_checkouts",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    return {
      id: raw.id,
      legacy_resource_id: null,
      name: raw.name ?? null,
      abandoned_checkout_url: raw.abandonedCheckoutUrl ?? null,
      customer_id: raw.customer?.id ?? null,
      email: null,
      phone: null,
      currency_code: raw.totalPriceSet?.shopMoney?.currencyCode ?? null,
      presentment_currency_code: raw.totalPriceSet?.presentmentMoney?.currencyCode ?? null,
      total_price_amount: raw.totalPriceSet?.shopMoney?.amount ?? null,
      total_price_currency: raw.totalPriceSet?.shopMoney?.currencyCode ?? null,
      subtotal_price_amount: raw.subtotalPriceSet?.shopMoney?.amount ?? null,
      subtotal_price_currency: raw.subtotalPriceSet?.shopMoney?.currencyCode ?? null,
      total_tax_amount: raw.totalTaxSet?.shopMoney?.amount ?? null,
      total_tax_currency: raw.totalTaxSet?.shopMoney?.currencyCode ?? null,
      total_discounts_amount: raw.totalDiscountSet?.shopMoney?.amount ?? null,
      total_discounts_currency: raw.totalDiscountSet?.shopMoney?.currencyCode ?? null,
      total_shipping_price_amount: null,
      total_shipping_price_currency: null,
      total_duties_amount: null,
      total_duties_currency: null,
      total_line_items_price_amount: null,
      total_line_items_price_currency: null,
      total_weight: null,
      customer_locale: null,
      device_id: null,
      source_name: null,
      source: null,
      landing_page: null,
      referring_site: null,
      buyer_accepts_marketing: null,
      buyer_accepts_sms_marketing: null,
      sms_marketing_phone: null,
      shipping_address: null,
      billing_address: null,
      shipping_address_country_code: null,
      custom_attributes: raw.customAttributes ?? null,
      note: raw.note ?? null,
      taxes_included: raw.taxesIncluded ?? null,
      tax_exempt: null, // AbandonedCheckout.taxExempt removed in 2026-01
      taxes_exempt_breakdown: null,
      discount_codes: raw.discountCodes ?? null,
      applied_discount: null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      completed_at: raw.completedAt ?? null,
      closed_at: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    } as MainRow;
  },
  childExtractors: [lineItemsExtractor],
};

export default abandoned_checkouts;
