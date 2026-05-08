import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";
import { query } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

// Bulk inner-query template for orders. The chunkedMonthlyRunner replaces
// `{{QUERY_FILTER}}` with each month's `created_at:>=... created_at:<...`
// expression. Per-resource-spec (Phase 2 brief): main + 6 most operational
// child tables — line_items, transactions, fulfillments, refunds,
// customer_journey_summaries, customer_visits. The remaining ~16 child
// tables (taxLines, discountAllocations, duties, refundLineItems,
// fulfillmentLineItems, fulfillmentEvents, returns, returnLineItems, risks,
// agreements, clientDetails, shippingLines, taxLines, discountApplications,
// discountCodes, metafields, staffMember, app, channel) are captured in
// orders.raw_payload and will be backfilled in a future phase via reconciler.
const QUERY = /* GraphQL */ `
  orders(query: "{{QUERY_FILTER}}") {
    edges {
      node {
        id
        legacyResourceId
        name
        confirmationNumber
        reference: customerLocale
        poNumber
        customer {
          id
        }
        email
        phone
        displayFinancialStatus
        displayFulfillmentStatus
        returnStatus
        cancelReason
        closed
        cancelledAt
        closedAt
        confirmed
        processedAt
        fullyPaid
        unpaid
        refundable
        restockable
        test
        currencyCode
        presentmentCurrencyCode
        currentSubtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalDutiesSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalAdditionalFeesSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        originalTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalReceivedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalRefundedShippingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTipReceivedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalCapturableSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        netPaymentSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalWeight
        currentTotalQuantity: currentSubtotalLineItemsQuantity
        subtotalLineItemsQuantity
        paymentGatewayNames
        discountCodes
        tags
        taxesIncluded
        taxExempt
        dutiesIncluded
        estimatedTaxes
        requiresShipping
        hasTimelineComment
        sourceName
        sourceIdentifier
        publication {
          id
        }
        app {
          id
        }
        channelInformation {
          channelId
        }
        landingPage: landingPageUrl
        referringSite: referrerUrl
        customerLocale
        registeredSourceUrl
        shippingAddress {
          address1
          address2
          city
          countryCode
          provinceCode
          zip
          phone
          firstName
          lastName
          name
        }
        billingAddress {
          address1
          address2
          city
          countryCode
          provinceCode
          zip
          phone
          firstName
          lastName
          name
        }
        note
        customAttributes {
          key
          value
        }
        createdAt
        updatedAt
        lineItems {
          edges {
            node {
              id
              product {
                id
              }
              variant {
                id
              }
              variantTitle
              title
              name
              vendor
              sku
              quantity
              currentQuantity
              refundableQuantity
              fulfillableQuantity
              nonFulfillableQuantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalDiscountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              taxable
              requiresShipping
              isGiftCard
              restockable
              sellingPlan {
                sellingPlanId
                name
              }
            }
          }
        }
        transactions {
          id
          parentTransaction {
            id
          }
          kind
          status
          test
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          fees {
            amount {
              amount
              currencyCode
            }
          }
          gateway
          formattedGateway
          paymentId
          authorizationCode
          authorizationExpiresAt
          paymentDetails {
            ... on CardPaymentDetails {
              avsResultCode
              cvvResultCode
            }
          }
          paymentIcon {
            url
          }
          receiptJson
          errorCode
          accountNumber
          createdAt
          processedAt
          settlementCurrency
          settlementCurrencyRate
          multiCapturable
          manualPaymentGateway
        }
        fulfillments {
          id
          legacyResourceId
          status
          displayStatus
          service {
            handle
            serviceName
          }
          location {
            id
          }
          trackingInfo {
            company
            number
            url
          }
          estimatedDeliveryAt
          inTransitAt
          deliveredAt
          createdAt
          updatedAt
        }
        refunds {
          id
          legacyResourceId
          note
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          return {
            id
          }
          duties {
            amountSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          createdAt
          updatedAt
        }
        customerJourneySummary {
          customerOrderIndex
          daysToConversion
          momentsCount {
            count
          }
          ready
          firstVisit {
            id
            landingPage
            landingPageHtml
            referrerUrl
            source
            sourceType
            sourceDescription
            referralCode
            referralInfoHtml
            occurredAt
            utmParameters {
              source
              medium
              campaign
              content
              term
            }
          }
          lastVisit {
            id
            landingPage
            landingPageHtml
            referrerUrl
            source
            sourceType
            sourceDescription
            referralCode
            referralInfoHtml
            occurredAt
            utmParameters {
              source
              medium
              campaign
              content
              term
            }
          }
          moments {
            edges {
              node {
                ... on CustomerVisit {
                  id
                  occurredAt
                  source
                  sourceType
                  sourceDescription
                  referralCode
                  referralInfoHtml
                  referrerUrl
                  landingPage
                  landingPageHtml
                  utmParameters {
                    source
                    medium
                    campaign
                    content
                    term
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function moneySetAmount(set: RawPayload): number | null {
  return set?.shopMoney?.amount ? Number(set.shopMoney.amount) : null;
}
function moneySetCurrency(set: RawPayload): string | null {
  return set?.shopMoney?.currencyCode ?? null;
}
function edgeNodes(connOrChildren: unknown): RawPayload[] {
  const c = connOrChildren as RawPayload | undefined;
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (c.edges) return c.edges.map((e: RawPayload) => e.node);
  return [];
}

const lineItemsExtractor: ChildExtractor = {
  table: "order_line_items",
  parentFk: "order_id",
  // upsert-only: NO replaceByParent. The DELETE-then-insert pattern would
  // CASCADE-wipe order_line_item_tax_lines, order_line_item_discount_allocations,
  // order_line_item_duties (owned by orders_pass_1 — different module). Phase 1
  // schema migration restrict_orders_cross_module_cascades flipped those FKs to
  // RESTRICT; this module fix prevents the DELETE in the first place.
  // Line items have natural Shopify GIDs → id-based upsert is idempotent.
  // "Remove line items Shopify deleted" semantics will be handled by webhook
  // events (Phase 4 incremental sync) or periodic reconciliation.
  // See CLAUDE.md NEVER rule about cross-module CASCADE.
  extract: (raw, parent, ctx) => {
    // Bulk JSONL: lineItems flatten under _children.line_item.
    // Fall back to inline edges for non-bulk paths.
    const fromBulk = pickChildren(raw, "line_item") as RawPayload[];
    const items = fromBulk.length ? fromBulk : (edgeNodes(raw.lineItems) as RawPayload[]);
    return items.map((li, idx) => {
      const legacy = ctx.parseGid(li.id).legacyId;
      return {
        id: li.id,
        order_id: parent.id,
        legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
        product_id: li.product?.id ?? null,
        variant_id: li.variant?.id ?? null,
        variant_title: li.variantTitle ?? null,
        product_title: li.title ?? null,
        vendor: li.vendor ?? null,
        sku: li.sku ?? null,
        name: li.name ?? null,
        title: li.title ?? null,
        quantity: li.quantity,
        current_quantity: li.currentQuantity ?? null,
        refundable_quantity: li.refundableQuantity ?? null,
        refunded_quantity: null,
        fulfillable_quantity: li.fulfillableQuantity ?? null,
        unfulfilled_quantity: null,
        non_fulfillable_quantity: li.nonFulfillableQuantity ?? null,
        original_unit_price_amount: moneySetAmount(li.originalUnitPriceSet),
        original_unit_price_currency: moneySetCurrency(li.originalUnitPriceSet),
        original_total_amount: moneySetAmount(li.originalTotalSet),
        original_total_currency: moneySetCurrency(li.originalTotalSet),
        discounted_unit_price_amount: moneySetAmount(li.discountedUnitPriceSet),
        discounted_unit_price_currency: moneySetCurrency(li.discountedUnitPriceSet),
        discounted_total_amount: moneySetAmount(li.discountedTotalSet),
        discounted_total_currency: moneySetCurrency(li.discountedTotalSet),
        total_discount_amount: moneySetAmount(li.totalDiscountSet),
        total_discount_currency: moneySetCurrency(li.totalDiscountSet),
        current_quantity_total_amount: null,
        current_quantity_total_currency: null,
        taxable: li.taxable ?? null,
        requires_shipping: li.requiresShipping ?? null,
        is_gift_card: li.isGiftCard ?? null,
        restockable: li.restockable ?? null,
        fulfillment_status: null,
        fulfillment_service: null,
        fulfillment_origin_location_id: null,
        variant_inventory_management: null,
        variant_inventory_policy: null,
        variant_options: li.variant?.selectedOptions ?? null,
        custom_attributes: null,
        selling_plan_id: li.sellingPlan?.sellingPlanId ?? null,
        selling_plan_name: li.sellingPlan?.name ?? null,
        product_exists: null,
        position: idx + 1,
        raw_payload: li,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(li),
      };
    });
  },
};

const transactionsExtractor: ChildExtractor = {
  table: "order_transactions",
  parentFk: "order_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    const tx: RawPayload[] = raw.transactions ?? [];
    return tx.map((t) => {
      const legacy = ctx.parseGid(t.id).legacyId;
      return {
        id: t.id,
        order_id: parent.id,
        legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
        parent_transaction_id: t.parentTransaction?.id ?? null,
        kind: t.kind ?? null,
        status: t.status ?? null,
        test: t.test ?? null,
        amount_amount: moneySetAmount(t.amountSet),
        amount_currency: moneySetCurrency(t.amountSet),
        amount_set: t.amountSet ?? null,
        fees: t.fees ?? null,
        total_unsettled_amount: null,
        total_unsettled_currency: null,
        gateway: t.gateway ?? null,
        formatted_gateway: t.formattedGateway ?? null,
        payment_id: t.paymentId ?? null,
        authorization_code: t.authorizationCode ?? null,
        authorization_expires_at: t.authorizationExpiresAt ?? null,
        payment_details: t.paymentDetails ?? null,
        payment_icon_url: t.paymentIcon?.url ?? null,
        receipt_json: t.receiptJson ?? null,
        error_code: t.errorCode ?? null,
        account_number: t.accountNumber ?? null,
        created_at: t.createdAt ?? null,
        processed_at: t.processedAt ?? null,
        settlement_currency: t.settlementCurrency ?? null,
        settlement_currency_rate: t.settlementCurrencyRate ?? null,
        multi_capturable: t.multiCapturable ?? null,
        manual_payment_gateway: t.manualPaymentGateway ?? null,
        raw_payload: t,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(t),
      };
    });
  },
};

const fulfillmentsExtractor: ChildExtractor = {
  table: "order_fulfillments",
  parentFk: "order_id",
  // upsert-only: NO replaceByParent. DELETE-then-insert would CASCADE-wipe
  // order_fulfillment_line_items + order_fulfillment_events (owned by
  // orders_pass_4 / deferred — different modules). Phase 1 schema migration
  // restrict_orders_cross_module_cascades flipped those FKs to RESTRICT.
  // Fulfillments have natural Shopify GIDs → id-based upsert is idempotent.
  // See CLAUDE.md NEVER rule about cross-module CASCADE.
  extract: (raw, parent, ctx) => {
    const fs: RawPayload[] = raw.fulfillments ?? [];
    return fs.map((f) => ({
      id: f.id,
      order_id: parent.id,
      legacy_resource_id: Number(f.legacyResourceId) || null,
      status: f.status ?? null,
      display_status: f.displayStatus ?? null,
      service: f.service?.serviceName ?? null,
      service_handle: f.service?.handle ?? null,
      service_id: null,
      fulfillment_origin_location_id: f.location?.id ?? null,
      destination: null,
      tracking_company: f.trackingInfo?.[0]?.company ?? null,
      tracking_number: f.trackingInfo?.[0]?.number ?? null,
      tracking_numbers:
        Array.isArray(f.trackingInfo) ? f.trackingInfo.map((t: RawPayload) => t.number).filter(Boolean) : null,
      tracking_url: f.trackingInfo?.[0]?.url ?? null,
      tracking_urls:
        Array.isArray(f.trackingInfo) ? f.trackingInfo.map((t: RawPayload) => t.url).filter(Boolean) : null,
      tracking_info: f.trackingInfo ?? null,
      estimated_delivery_at: f.estimatedDeliveryAt ?? null,
      in_transit_at: f.inTransitAt ?? null,
      delivered_at: f.deliveredAt ?? null,
      created_at: f.createdAt ?? null,
      updated_at: f.updatedAt ?? null,
      raw_payload: f,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(f),
    }));
  },
};

const refundsExtractor: ChildExtractor = {
  table: "order_refunds",
  parentFk: "order_id",
  // upsert-only: NO replaceByParent. DELETE-then-insert would CASCADE-wipe
  // order_refund_line_items (owned by orders_pass_4 — different module).
  // Phase 1 schema migration restrict_orders_cross_module_cascades flipped
  // that FK to RESTRICT. Refunds have natural Shopify GIDs → id-based upsert
  // is idempotent.
  // See CLAUDE.md NEVER rule about cross-module CASCADE.
  extract: (raw, parent, ctx) => {
    const rs: RawPayload[] = raw.refunds ?? [];
    return rs.map((r) => ({
      id: r.id,
      order_id: parent.id,
      legacy_resource_id: Number(r.legacyResourceId) || null,
      note: r.note ?? null,
      total_refunded_amount: moneySetAmount(r.totalRefundedSet),
      total_refunded_currency: moneySetCurrency(r.totalRefundedSet),
      total_refunded_set: r.totalRefundedSet ?? null,
      // FK to order_returns (not synced in Phase 2). Always null on first
      // backfill; raw_payload preserves the ID for later reconciliation.
      return_id: null,
      staff_member_id: null,
      restock: null,
      duties: r.duties ?? null,
      order_adjustments: r.orderAdjustments ?? null,
      refund_shipping: null,
      created_at: r.createdAt ?? null,
      updated_at: r.updatedAt ?? null,
      raw_payload: r,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(r),
    }));
  },
};

const journeyExtractor: ChildExtractor = {
  table: "customer_journey_summaries",
  parentFk: "order_id",
  replaceByParent: true,
  // PK is (order_id) — one journey per order. No `id` column.
  onConflict: "order_id",
  extract: (raw, parent, ctx) => {
    const j = raw.customerJourneySummary;
    if (!j) return [];
    const fv = j.firstVisit ?? {};
    const lv = j.lastVisit ?? {};
    const fvU = fv.utmParameters ?? {};
    const lvU = lv.utmParameters ?? {};
    return [
      {
        order_id: parent.id,
        customer_id: raw.customer?.id ?? null,
        customer_order_index: j.customerOrderIndex ?? null,
        days_to_conversion: j.daysToConversion ?? null,
        moments_count: j.momentsCount?.count ?? null,
        ready: j.ready ?? null,
        first_visit_id: fv.id ?? null,
        first_visit_landing_page: fv.landingPage ?? null,
        first_visit_landing_page_html: fv.landingPageHtml ?? null,
        first_visit_referrer_url: fv.referrerUrl ?? null,
        first_visit_source: fv.source ?? null,
        first_visit_source_type: fv.sourceType ?? null,
        first_visit_source_description: fv.sourceDescription ?? null,
        first_visit_marketing_event_id: null,
        first_visit_referral_code: fv.referralCode ?? null,
        first_visit_referral_info_html: fv.referralInfoHtml ?? null,
        first_visit_occurred_at: fv.occurredAt ?? null,
        first_visit_utm_source: fvU.source ?? null,
        first_visit_utm_medium: fvU.medium ?? null,
        first_visit_utm_campaign: fvU.campaign ?? null,
        first_visit_utm_content: fvU.content ?? null,
        first_visit_utm_term: fvU.term ?? null,
        last_visit_id: lv.id ?? null,
        last_visit_landing_page: lv.landingPage ?? null,
        last_visit_landing_page_html: lv.landingPageHtml ?? null,
        last_visit_referrer_url: lv.referrerUrl ?? null,
        last_visit_source: lv.source ?? null,
        last_visit_source_type: lv.sourceType ?? null,
        last_visit_source_description: lv.sourceDescription ?? null,
        last_visit_marketing_event_id: null,
        last_visit_referral_code: lv.referralCode ?? null,
        last_visit_referral_info_html: lv.referralInfoHtml ?? null,
        last_visit_occurred_at: lv.occurredAt ?? null,
        last_visit_utm_source: lvU.source ?? null,
        last_visit_utm_medium: lvU.medium ?? null,
        last_visit_utm_campaign: lvU.campaign ?? null,
        last_visit_utm_content: lvU.content ?? null,
        last_visit_utm_term: lvU.term ?? null,
        raw_payload: j,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(j),
      },
    ];
  },
};

const visitsExtractor: ChildExtractor = {
  table: "customer_visits",
  parentFk: "order_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    // Bulk JSONL: customerJourneySummary.moments (CustomerVisit connection)
    // flattens under _children.customer_visit.
    const fromBulk = pickChildren(raw, "customer_visit") as RawPayload[];
    const moments: RawPayload[] = fromBulk.length
      ? fromBulk
      : edgeNodes(raw.customerJourneySummary?.moments);
    return moments.map((m, idx) => {
      const utm = m.utmParameters ?? {};
      return {
        id: m.id,
        order_id: parent.id,
        customer_id: raw.customer?.id ?? null,
        position: idx + 1,
        occurred_at: m.occurredAt ?? null,
        source: m.source ?? null,
        source_type: m.sourceType ?? null,
        source_description: m.sourceDescription ?? null,
        marketing_event_id: null,
        referral_code: m.referralCode ?? null,
        referral_info_html: m.referralInfoHtml ?? null,
        referrer_url: m.referrerUrl ?? null,
        landing_page: m.landingPage ?? null,
        landing_page_html: m.landingPageHtml ?? null,
        utm_source: utm.source ?? null,
        utm_medium: utm.medium ?? null,
        utm_campaign: utm.campaign ?? null,
        utm_content: utm.content ?? null,
        utm_term: utm.term ?? null,
        raw_payload: m,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(m),
      };
    });
  },
};

const orders: ResourceModule = {
  resourceName: "orders",
  category: "orders",
  table: "orders",
  syncStrategy: "chunked_monthly",
  graphqlQuery: QUERY,
  chunkField: "created_at",
  dependsOn: ["customers", "products"],
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const sa = raw.shippingAddress ?? null;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      name: raw.name ?? null,
      order_number: null,
      confirmation_number: raw.confirmationNumber ?? null,
      reference: raw.reference ?? null,
      po_number: raw.poNumber ?? null,
      customer_id: raw.customer?.id ?? null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      contact_email: null,
      display_financial_status: raw.displayFinancialStatus ?? null,
      display_fulfillment_status: raw.displayFulfillmentStatus ?? null,
      return_status: raw.returnStatus ?? null,
      cancel_reason: raw.cancelReason ?? null,
      closed: raw.closed ?? null,
      cancelled_at: raw.cancelledAt ?? null,
      closed_at: raw.closedAt ?? null,
      confirmed: raw.confirmed ?? null,
      confirmed_at: null,
      processed_at: raw.processedAt ?? null,
      fully_paid: raw.fullyPaid ?? null,
      unpaid: raw.unpaid ?? null,
      refundable: raw.refundable ?? null,
      restockable: raw.restockable ?? null,
      test: raw.test ?? null,
      currency_code: raw.currencyCode ?? null,
      presentment_currency_code: raw.presentmentCurrencyCode ?? null,
      current_subtotal_price_amount: moneySetAmount(raw.currentSubtotalPriceSet),
      current_subtotal_price_currency: moneySetCurrency(raw.currentSubtotalPriceSet),
      current_total_price_amount: moneySetAmount(raw.currentTotalPriceSet),
      current_total_price_currency: moneySetCurrency(raw.currentTotalPriceSet),
      current_total_tax_amount: moneySetAmount(raw.currentTotalTaxSet),
      current_total_tax_currency: moneySetCurrency(raw.currentTotalTaxSet),
      current_total_discounts_amount: moneySetAmount(raw.currentTotalDiscountsSet),
      current_total_discounts_currency: moneySetCurrency(raw.currentTotalDiscountsSet),
      current_total_duties_amount: moneySetAmount(raw.currentTotalDutiesSet),
      current_total_duties_currency: moneySetCurrency(raw.currentTotalDutiesSet),
      current_total_additional_fees_amount: moneySetAmount(raw.currentTotalAdditionalFeesSet),
      current_total_additional_fees_currency: moneySetCurrency(raw.currentTotalAdditionalFeesSet),
      original_total_price_amount: moneySetAmount(raw.originalTotalPriceSet),
      original_total_price_currency: moneySetCurrency(raw.originalTotalPriceSet),
      subtotal_price_amount: moneySetAmount(raw.subtotalPriceSet),
      subtotal_price_currency: moneySetCurrency(raw.subtotalPriceSet),
      total_price_amount: moneySetAmount(raw.totalPriceSet),
      total_price_currency: moneySetCurrency(raw.totalPriceSet),
      total_outstanding_amount: moneySetAmount(raw.totalOutstandingSet),
      total_outstanding_currency: moneySetCurrency(raw.totalOutstandingSet),
      total_received_amount: moneySetAmount(raw.totalReceivedSet),
      total_received_currency: moneySetCurrency(raw.totalReceivedSet),
      total_refunded_amount: moneySetAmount(raw.totalRefundedSet),
      total_refunded_currency: moneySetCurrency(raw.totalRefundedSet),
      total_refunded_shipping_amount: moneySetAmount(raw.totalRefundedShippingSet),
      total_refunded_shipping_currency: moneySetCurrency(raw.totalRefundedShippingSet),
      total_shipping_price_amount: moneySetAmount(raw.totalShippingPriceSet),
      total_shipping_price_currency: moneySetCurrency(raw.totalShippingPriceSet),
      total_tax_amount: moneySetAmount(raw.totalTaxSet),
      total_tax_currency: moneySetCurrency(raw.totalTaxSet),
      total_tip_received_amount: moneySetAmount(raw.totalTipReceivedSet),
      total_tip_received_currency: moneySetCurrency(raw.totalTipReceivedSet),
      total_discounts_amount: moneySetAmount(raw.totalDiscountsSet),
      total_discounts_currency: moneySetCurrency(raw.totalDiscountsSet),
      total_capturable_amount: moneySetAmount(raw.totalCapturableSet),
      total_capturable_currency: moneySetCurrency(raw.totalCapturableSet),
      net_payment_amount: moneySetAmount(raw.netPaymentSet),
      net_payment_currency: moneySetCurrency(raw.netPaymentSet),
      total_weight: raw.totalWeight ?? null,
      current_total_quantity: raw.currentTotalQuantity ?? null,
      subtotal_line_items_quantity: raw.subtotalLineItemsQuantity ?? null,
      payment_gateway_names: raw.paymentGatewayNames ?? null,
      discount_codes: raw.discountCodes ?? null,
      tags: raw.tags ?? null,
      buyer_accepts_marketing: null,
      taxes_included: raw.taxesIncluded ?? null,
      tax_exempt: raw.taxExempt ?? null,
      duties_included: raw.dutiesIncluded ?? null,
      estimated_taxes: raw.estimatedTaxes ?? null,
      requires_shipping: raw.requiresShipping ?? null,
      has_timeline_comment: raw.hasTimelineComment ?? null,
      legacy_subscription_attributes: null,
      source_name: raw.sourceName ?? null,
      source_identifier: raw.sourceIdentifier ?? null,
      source_url: null,
      channel_id: raw.channelInformation?.channelId ?? null,
      publication_id: raw.publication?.id ?? null,
      app_id: raw.app?.id ?? null,
      landing_site: raw.landingPage ?? null,
      referring_site: raw.referringSite ?? null,
      locale: raw.customerLocale ?? null,
      staff_member_id: null,
      registered_at_pos: null,
      pos_location_id: null,
      risk_level: null,
      risk_recommendation: null,
      shipping_address: raw.shippingAddress ?? null,
      billing_address: raw.billingAddress ?? null,
      shipping_address_country_code: sa?.countryCode ?? null,
      shipping_address_zip: sa?.zip ?? null,
      shipping_address_city: sa?.city ?? null,
      merchant_business_entity_id: null,
      merchant_of_record_app_id: null,
      note: raw.note ?? null,
      custom_attributes: raw.customAttributes ?? null,
      note_attributes: null,
      created_at: raw.createdAt,
      updated_at: raw.updatedAt,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [
    lineItemsExtractor,
    transactionsExtractor,
    fulfillmentsExtractor,
    refundsExtractor,
    journeyExtractor,
    visitsExtractor,
  ],

  // ─── Phase 3B incremental sync ───────────────────────────────────────────
  // Mirrors the bulk QUERY for ONE order. Differences from bulk:
  //   - top-level: `order(id: $id) { ... }` instead of `orders(query:...) { edges { node { ... } } }`
  //   - lineItems is a CONNECTION → adds `first: 250`
  //   - customerJourneySummary.moments is a CONNECTION → adds `first: 250`
  //   - transactions / fulfillments / refunds are LISTs → unchanged (inline)
  // The orders parent + 6 child extractors all already handle BOTH the bulk
  // _children shape AND the inline raw.<field>[] / raw.<field>.edges shape
  // (added in Phase 3 Wave 1 and confirmed at lineItemsExtractor +
  // visitsExtractor). Maintenance: any field added to QUERY must be added
  // here too, or live updates will null-overwrite columns.
  incremental: async (id: string): Promise<RawPayload | null> => {
    const data = await query<{ order: RawPayload | null }>(
      /* GraphQL */ `
        query OrderById($id: ID!) {
          order(id: $id) {
            id
            legacyResourceId
            name
            confirmationNumber
            reference: customerLocale
            poNumber
            customer { id }
            email
            phone
            displayFinancialStatus
            displayFulfillmentStatus
            returnStatus
            cancelReason
            closed
            cancelledAt
            closedAt
            confirmed
            processedAt
            fullyPaid
            unpaid
            refundable
            restockable
            test
            currencyCode
            presentmentCurrencyCode
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            currentTotalTaxSet { shopMoney { amount currencyCode } }
            currentTotalDiscountsSet { shopMoney { amount currencyCode } }
            currentTotalDutiesSet { shopMoney { amount currencyCode } }
            currentTotalAdditionalFeesSet { shopMoney { amount currencyCode } }
            originalTotalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            totalOutstandingSet { shopMoney { amount currencyCode } }
            totalReceivedSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            totalRefundedShippingSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            totalTipReceivedSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount currencyCode } }
            totalCapturableSet { shopMoney { amount currencyCode } }
            netPaymentSet { shopMoney { amount currencyCode } }
            totalWeight
            currentTotalQuantity: currentSubtotalLineItemsQuantity
            subtotalLineItemsQuantity
            paymentGatewayNames
            discountCodes
            tags
            taxesIncluded
            taxExempt
            dutiesIncluded
            estimatedTaxes
            requiresShipping
            hasTimelineComment
            sourceName
            sourceIdentifier
            publication { id }
            app { id }
            channelInformation { channelId }
            landingPage: landingPageUrl
            referringSite: referrerUrl
            customerLocale
            registeredSourceUrl
            shippingAddress {
              address1 address2 city countryCode provinceCode zip phone
              firstName lastName name
            }
            billingAddress {
              address1 address2 city countryCode provinceCode zip phone
              firstName lastName name
            }
            note
            customAttributes { key value }
            createdAt
            updatedAt
            lineItems(first: 250) {
              edges {
                node {
                  id
                  product { id }
                  variant { id }
                  variantTitle
                  title
                  name
                  vendor
                  sku
                  quantity
                  currentQuantity
                  refundableQuantity
                  fulfillableQuantity
                  nonFulfillableQuantity
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  originalTotalSet { shopMoney { amount currencyCode } }
                  discountedUnitPriceSet { shopMoney { amount currencyCode } }
                  discountedTotalSet { shopMoney { amount currencyCode } }
                  totalDiscountSet { shopMoney { amount currencyCode } }
                  taxable
                  requiresShipping
                  isGiftCard
                  restockable
                  sellingPlan { sellingPlanId name }
                }
              }
            }
            transactions {
              id
              parentTransaction { id }
              kind
              status
              test
              amountSet { shopMoney { amount currencyCode } }
              fees { amount { amount currencyCode } }
              gateway
              formattedGateway
              paymentId
              authorizationCode
              authorizationExpiresAt
              paymentDetails {
                ... on CardPaymentDetails { avsResultCode cvvResultCode }
              }
              paymentIcon { url }
              receiptJson
              errorCode
              accountNumber
              createdAt
              processedAt
              settlementCurrency
              settlementCurrencyRate
              multiCapturable
              manualPaymentGateway
            }
            fulfillments {
              id
              legacyResourceId
              status
              displayStatus
              service { handle serviceName }
              location { id }
              trackingInfo { company number url }
              estimatedDeliveryAt
              inTransitAt
              deliveredAt
              createdAt
              updatedAt
            }
            refunds {
              id
              legacyResourceId
              note
              totalRefundedSet { shopMoney { amount currencyCode } }
              return { id }
              duties { amountSet { shopMoney { amount currencyCode } } }
              createdAt
              updatedAt
            }
            customerJourneySummary {
              customerOrderIndex
              daysToConversion
              momentsCount { count }
              ready
              firstVisit {
                id
                landingPage
                landingPageHtml
                referrerUrl
                source
                sourceType
                sourceDescription
                referralCode
                referralInfoHtml
                occurredAt
                utmParameters { source medium campaign content term }
              }
              lastVisit {
                id
                landingPage
                landingPageHtml
                referrerUrl
                source
                sourceType
                sourceDescription
                referralCode
                referralInfoHtml
                occurredAt
                utmParameters { source medium campaign content term }
              }
              moments(first: 250) {
                edges {
                  node {
                    ... on CustomerVisit {
                      id
                      occurredAt
                      source
                      sourceType
                      sourceDescription
                      referralCode
                      referralInfoHtml
                      referrerUrl
                      landingPage
                      landingPageHtml
                      utmParameters { source medium campaign content term }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { id },
    );
    return data.order ?? null;
  },

  // Soft-delete: triggered when a Shopify order_id resolves to null on
  // re-fetch (e.g. a hard delete on Shopify's side, rare but possible). The
  // mirror keeps the row + raw_payload but stamps deleted_at so dashboards
  // can filter. We do NOT cascade — children stay intact for audit history.
  softDelete: async (id: string): Promise<void> => {
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb
      .from("orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`orders.softDelete ${id}: ${error.message}`);
  },
};

export default orders;
