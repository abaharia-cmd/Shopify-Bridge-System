// Phase 3 Wave 1 — Pass 3: agreements + returns + return_line_items.
// Runs as `chunked_monthly` over the same date range as Phase 2 orders, with
// `skipParentUpsert: true` — the parent `orders` table is already complete.
//
// Tables filled (3):
//   - order_agreements         (Order.agreements, CONNECTION; SalesAgreement INTERFACE)
//   - order_returns            (Order.returns, CONNECTION)
//   - order_return_line_items  (Return.returnLineItems, CONNECTION inside CONNECTION;
//                                ReturnLineItemType INTERFACE)
//
// Connection budget: orders + agreements + returns + returnLineItems = 4 / 5.
//
// SalesAgreement is INTERFACE with 4 implementations (OrderAgreement,
// OrderEditAgreement, RefundAgreement, ReturnAgreement). All share interface
// fields (id, happenedAt, reason, app); we store __typename in raw_payload
// since the schema has no agreement_type column.
//
// ReturnLineItemType is INTERFACE with 2 implementations (ReturnLineItem,
// UnverifiedReturnLineItem). Both share id + quantity fields. Concrete-only
// fields: ReturnLineItem.fulfillmentLineItem, .totalWeight; UnverifiedRLI.unitPrice.

import type { ResourceModule, MainRow, RawPayload } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";

const QUERY = /* GraphQL */ `
  orders(query: "{{QUERY_FILTER}}") {
    edges {
      node {
        id
        agreements {
          edges {
            node {
              __typename
              id
              happenedAt
              reason
              app { id }
            }
          }
        }
        returns {
          edges {
            node {
              id
              name
              status
              totalQuantity
              decline { reason note }
              requestApprovedAt
              closedAt
              createdAt
              returnLineItems {
                edges {
                  node {
                    __typename
                    id
                    quantity
                    refundableQuantity
                    refundedQuantity
                    customerNote
                    returnReasonNote
                    returnReasonDefinition { id name }
                    ... on ReturnLineItem {
                      fulfillmentLineItem { id lineItem { id } }
                      totalWeight { value unit }
                    }
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

const ordersPass3: ResourceModule = {
  resourceName: "orders_pass_3",
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
      // Order.agreements is a CONNECTION → flattened. SalesAgreement is an
      // INTERFACE; ALL 4 implementations (OrderAgreement, OrderEditAgreement,
      // RefundAgreement, ReturnAgreement) share the same GID prefix
      // `gid://shopify/SalesAgreement/...`, so gidTypeKey is `sales_agreement`
      // for all of them. The concrete __typename is in the JSON payload itself
      // and gets preserved in raw_payload for downstream filtering.
      table: "order_agreements",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        return pickChildren(raw, "sales_agreement").map((a) => ({
          id: a.id,
          order_id: parent.id,
          reason: a.reason ?? null,
          happened_at: a.happenedAt ?? null,
          app_id: a.app?.id ?? null,
          raw_payload: a, // includes __typename for downstream analytics
          synced_at: parent.synced_at,
          _content_hash: ctx.hashContent(a),
        }));
      },
    },
    {
      // Order.returns is a CONNECTION → flattened under _children.return.
      table: "order_returns",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        return pickChildren(raw, "return").map((r) => ({
          id: r.id,
          order_id: parent.id,
          legacy_resource_id: null, // Return.legacyResourceId removed in 2026-01
          name: r.name ?? null,
          status: r.status ?? null,
          return_shipping_fees: null, // not requested in this query (would need its own sub-selection)
          total_quantity: r.totalQuantity ?? null,
          decline: r.decline ?? null,
          request_approved_at: r.requestApprovedAt ?? null,
          closed_at: r.closedAt ?? null,
          created_at: r.createdAt ?? null,
          updated_at: null, // Return type has no updatedAt in 2026-01
          raw_payload: r,
          synced_at: parent.synced_at,
          deleted_at: null,
          _content_hash: ctx.hashContent(r),
        }));
      },
    },
    {
      // Return.returnLineItems is a CONNECTION nested inside the Order.returns
      // CONNECTION. In bulk JSONL each ReturnLineItem is its own line with
      // __parentId pointing at its RETURN (not the Order). groupByParent now
      // builds a multi-level tree, so each Return node has its OWN _children
      // map populated with return_line_item / unverified_return_line_item
      // entries. Walk through each Return to gather them.
      table: "order_return_line_items",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        const out: Record<string, unknown>[] = [];
        for (const r of pickChildren(raw, "return")) {
          const rlis = pickChildren(
            r,
            "return_line_item",
            "unverified_return_line_item",
          );
          for (const rli of rlis) {
            out.push({
              id: rli.id,
              return_id: r.id,
              order_id: parent.id,
              // FK target order_fulfillment_line_items is empty (deferred — Bulk
              // can't fetch FulfillmentLineItem children of fulfillments-list).
              // Storing the id would FK-orphan; keep it in raw_payload only.
              fulfillment_line_item_id: null,
              line_item_id: rli.fulfillmentLineItem?.lineItem?.id ?? null,
              quantity: rli.quantity ?? null,
              refundable_quantity: rli.refundableQuantity ?? null,
              refunded_quantity: rli.refundedQuantity ?? null,
              return_reason: rli.returnReasonDefinition?.name ?? null,
              return_reason_note: rli.returnReasonNote ?? null,
              customer_note: rli.customerNote ?? null,
              total_weight: rli.totalWeight?.value ?? null,
              with_code: null, // ReturnLineItem.withCodeDiscountedTotalPriceSet is money; column is text → raw_payload only
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

export default ordersPass3;
