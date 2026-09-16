// Phase 3 Wave 1.5 — Pass 4: fulfillment + refund line items via paginated
// GraphQL (NOT bulk — bulk forbids connection-inside-list).
//
// Tables filled (2):
//   - order_fulfillment_line_items  (Fulfillment.fulfillmentLineItems CONNECTION inside Order.fulfillments LIST)
//   - order_refund_line_items       (Refund.refundLineItems CONNECTION inside Order.refunds LIST)
//
// Both target tables have natural Shopify GID PKs and no extra UNIQUE
// constraints — default `onConflict: id` is correct (verified via
// information_schema before building).
//
// Run via: npm run run-pass-paginated -- orders_pass_4

import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query OrdersPass4Page($cursor: String) {
    orders(
      first: 50
      after: $cursor
      query: "{{QUERY_FILTER}}"
      sortKey: CREATED_AT
    ) {
      edges {
        node {
          id
          fulfillments(first: 50) {
            id
            fulfillmentLineItems(first: 250) {
              edges {
                node {
                  id
                  quantity
                  lineItem { id }
                  originalTotalSet { shopMoney { amount currencyCode } }
                  discountedTotalSet { shopMoney { amount currencyCode } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          refunds(first: 50) {
            id
            refundLineItems(first: 250) {
              edges {
                node {
                  id
                  quantity
                  restockType
                  lineItem { id }
                  location { id }
                  priceSet { shopMoney { amount currencyCode } }
                  subtotalSet { shopMoney { amount currencyCode } }
                  totalTaxSet { shopMoney { amount currencyCode } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ordersPass4: ResourceModule = {
  resourceName: "orders_pass_4",
  category: "orders_pass",
  table: "orders",
  // Note: this module's strategy field is informational; it's run by
  // runPaginatedWithBatch directly via `npm run run-pass-paginated`,
  // not via the orchestrator's dispatch (which wouldn't know this runner).
  syncStrategy: "paginated",
  chunkField: "created_at",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  // Stub transform — returns the parent's id only so child extractors can FK.
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
      // Order.fulfillments is a LIST inline on the Order JSON. Each
      // Fulfillment has fulfillmentLineItems CONNECTION (handled inline by
      // first:250). If any fulfillment has > 250 line items we'd need a
      // follow-up paginated fetch — Ourkids' biggest fulfillment is well
      // under that, so single-page is fine in practice.
      table: "order_fulfillment_line_items",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        const out: Record<string, unknown>[] = [];
        const fulfillments: RawPayload[] = Array.isArray(raw.fulfillments) ? raw.fulfillments : [];
        for (const f of fulfillments) {
          const edges: RawPayload[] = f.fulfillmentLineItems?.edges ?? [];
          for (const e of edges) {
            const fli = e.node;
            if (!fli?.id) continue;
            out.push({
              id: fli.id,
              fulfillment_id: f.id,
              order_id: parent.id,
              line_item_id: fli.lineItem?.id ?? null,
              quantity: fli.quantity ?? null,
              original_total_amount: fli.originalTotalSet?.shopMoney?.amount ?? null,
              original_total_currency: fli.originalTotalSet?.shopMoney?.currencyCode ?? null,
              discounted_total_amount: fli.discountedTotalSet?.shopMoney?.amount ?? null,
              discounted_total_currency: fli.discountedTotalSet?.shopMoney?.currencyCode ?? null,
              raw_payload: fli,
              synced_at: parent.synced_at,
              _content_hash: ctx.hashContent(fli),
            });
          }
        }
        return out;
      },
    },
    {
      // Order.refunds is a LIST inline. Each Refund has refundLineItems
      // CONNECTION (first:250 inline).
      table: "order_refund_line_items",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        const out: Record<string, unknown>[] = [];
        const refunds: RawPayload[] = Array.isArray(raw.refunds) ? raw.refunds : [];
        for (const r of refunds) {
          const edges: RawPayload[] = r.refundLineItems?.edges ?? [];
          for (const e of edges) {
            const rli = e.node;
            if (!rli?.id) continue;
            out.push({
              id: rli.id,
              refund_id: r.id,
              order_id: parent.id,
              line_item_id: rli.lineItem?.id ?? null,
              quantity: rli.quantity ?? null,
              restock_type: rli.restockType ?? null,
              location_id: rli.location?.id ?? null,
              subtotal_amount: rli.subtotalSet?.shopMoney?.amount ?? null,
              subtotal_currency: rli.subtotalSet?.shopMoney?.currencyCode ?? null,
              total_tax_amount: rli.totalTaxSet?.shopMoney?.amount ?? null,
              total_tax_currency: rli.totalTaxSet?.shopMoney?.currencyCode ?? null,
              price_amount: rli.priceSet?.shopMoney?.amount ?? null,
              price_currency: rli.priceSet?.shopMoney?.currencyCode ?? null,
              raw_payload: rli,
              synced_at: parent.synced_at,
              _content_hash: ctx.hashContent(rli),
            });
          }
        }
        return out;
      },
    },
  ],
};

export default ordersPass4;
