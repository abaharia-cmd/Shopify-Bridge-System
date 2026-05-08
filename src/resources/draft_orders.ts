// Wave 2 Group B: draft_orders + line items.
import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

const QUERY = /* GraphQL */ `
  query DraftOrdersPage($first: Int!, $after: String) {
    draftOrders(first: $first, after: $after) {
      edges {
        node {
          id legacyResourceId name status
          customer { id }
          email phone
          order { id }
          currencyCode presentmentCurrencyCode
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalDiscountsSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          totalQuantityOfLineItems
          totalWeight
          acceptableStatusForCompletion: status
          customAttributes { key value }
          note: note2
          tags
          shippingAddress { address1 address2 city province country zip }
          billingAddress { address1 address2 city province country zip }
          shippingLine { title price }
          appliedDiscount { description value valueType title amountSet { shopMoney { amount currencyCode } } }
          discountCodes
          ready taxesIncluded taxExempt hasTimelineComment visibleToCustomer
          reserveInventoryUntil invoiceSentAt invoiceUrl
          createdAt updatedAt completedAt
          lineItems(first: 100) {
            edges {
              node {
                id name title variantTitle vendor sku
                product { id } variant { id }
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                originalTotalSet { shopMoney { amount currencyCode } }
                discountedUnitPriceSet { shopMoney { amount currencyCode } }
                discountedTotalSet { shopMoney { amount currencyCode } }
                totalDiscountSet { shopMoney { amount currencyCode } }
                taxable requiresShipping isGiftCard custom
                appliedDiscount { description value valueType title }
                customAttributes { key value }
                taxLines { title rate ratePercentage priceSet { shopMoney { amount currencyCode } } }
                weight { value unit }
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
  table: "draft_order_line_items",
  parentFk: "draft_order_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    const edges = raw?.lineItems?.edges ?? [];
    return edges.map((e: RawPayload) => {
      const li = e.node;
      return {
        id: li.id,
        draft_order_id: parent.id,
        product_id: li.product?.id ?? null,
        variant_id: li.variant?.id ?? null,
        sku: li.sku ?? null,
        title: li.title ?? null,
        variant_title: li.variantTitle ?? null,
        vendor: li.vendor ?? null,
        name: li.name ?? null,
        quantity: li.quantity ?? null,
        original_unit_price_amount: li.originalUnitPriceSet?.shopMoney?.amount ?? null,
        original_unit_price_currency: li.originalUnitPriceSet?.shopMoney?.currencyCode ?? null,
        original_total_amount: li.originalTotalSet?.shopMoney?.amount ?? null,
        original_total_currency: li.originalTotalSet?.shopMoney?.currencyCode ?? null,
        discounted_unit_price_amount: li.discountedUnitPriceSet?.shopMoney?.amount ?? null,
        discounted_unit_price_currency: li.discountedUnitPriceSet?.shopMoney?.currencyCode ?? null,
        discounted_total_amount: li.discountedTotalSet?.shopMoney?.amount ?? null,
        discounted_total_currency: li.discountedTotalSet?.shopMoney?.currencyCode ?? null,
        total_discount_amount: li.totalDiscountSet?.shopMoney?.amount ?? null,
        total_discount_currency: li.totalDiscountSet?.shopMoney?.currencyCode ?? null,
        taxable: li.taxable ?? null,
        requires_shipping: li.requiresShipping ?? null,
        is_gift_card: li.isGiftCard ?? null,
        custom: li.custom ?? null,
        applied_discount: li.appliedDiscount ?? null,
        custom_attributes: li.customAttributes ?? null,
        tax_lines: li.taxLines ?? null,
        weight: li.weight?.value ?? null,
        selling_plan_id: null,
        selling_plan_name: null, // DraftOrderLineItem.sellingPlan removed in 2026-01
        raw_payload: li,
        synced_at: parent.synced_at,
        _content_hash: ctx.hashContent(li),
      };
    });
  },
};

const draft_orders: ResourceModule = {
  resourceName: "draft_orders",
  category: "orders",
  table: "draft_orders",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    return {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      name: raw.name ?? null,
      status: raw.status ?? null,
      customer_id: raw.customer?.id ?? null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      order_id: raw.order?.id ?? null,
      currency_code: raw.currencyCode ?? null,
      presentment_currency_code: raw.presentmentCurrencyCode ?? null,
      total_price_amount: raw.totalPriceSet?.shopMoney?.amount ?? null,
      total_price_currency: raw.totalPriceSet?.shopMoney?.currencyCode ?? null,
      subtotal_price_amount: raw.subtotalPriceSet?.shopMoney?.amount ?? null,
      subtotal_price_currency: raw.subtotalPriceSet?.shopMoney?.currencyCode ?? null,
      total_tax_amount: raw.totalTaxSet?.shopMoney?.amount ?? null,
      total_tax_currency: raw.totalTaxSet?.shopMoney?.currencyCode ?? null,
      total_discounts_amount: raw.totalDiscountsSet?.shopMoney?.amount ?? null,
      total_discounts_currency: raw.totalDiscountsSet?.shopMoney?.currencyCode ?? null,
      total_shipping_price_amount: raw.totalShippingPriceSet?.shopMoney?.amount ?? null,
      total_shipping_price_currency: raw.totalShippingPriceSet?.shopMoney?.currencyCode ?? null,
      total_quantity_of_line_items: raw.totalQuantityOfLineItems ?? null,
      total_weight: raw.totalWeight ?? null,
      acceptable_payment_methods: null,
      payment_terms: null,
      custom_attributes: raw.customAttributes ?? null,
      note: null,
      note2: raw.note ?? null,
      tags: raw.tags ?? null,
      shipping_address: raw.shippingAddress ?? null,
      billing_address: raw.billingAddress ?? null,
      shipping_line: raw.shippingLine ?? null,
      applied_discount: raw.appliedDiscount ?? null,
      discount_codes: raw.discountCodes ?? null,
      ready: raw.ready ?? null,
      taxes_included: raw.taxesIncluded ?? null,
      taxes_exempt: raw.taxExempt ?? null,
      use_customer_default_address: null, // removed in 2026-01
      has_timeline_comment: raw.hasTimelineComment ?? null,
      visible_to_customer: raw.visibleToCustomer ?? null,
      reserve_inventory_until: raw.reserveInventoryUntil ?? null,
      invoice_sent_at: raw.invoiceSentAt ?? null,
      invoice_url: raw.invoiceUrl ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      completed_at: raw.completedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    } as MainRow;
  },
  childExtractors: [lineItemsExtractor],
};

export default draft_orders;
