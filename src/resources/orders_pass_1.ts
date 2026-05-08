// Phase 3 Wave 1 — Pass 1: line-item children + order-level inline LIST
// children + scalars. Runs as `chunked_monthly` over the same date range as
// the original orders backfill, but with `skipParentUpsert: true` — the
// parent `orders` table is already complete; we only fill child tables.
//
// Tables filled by this pass (6):
//   - order_line_item_tax_lines           (LineItem.taxLines, inline LIST)
//   - order_line_item_discount_allocations (LineItem.discountAllocations, inline LIST)
//   - order_line_item_duties              (LineItem.duties, inline LIST)
//   - order_tax_lines                     (Order.taxLines, inline LIST)
//   - order_discount_codes                (Order.discountCodes, inline LIST<String>)
//   - order_client_details                (Order.clientIp + clientUserAgent, scalars)
//
// Connection budget: orders + lineItems = 2 / 5. Plenty of headroom.
//
// The 5 surrogate-key tables (uuid PK) use replaceByParent so re-runs replace
// children atomically without UUID duplication. order_client_details uses
// upsert by order_id (PK).

import type { ResourceModule, MainRow, RawPayload } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";

const QUERY = /* GraphQL */ `
  orders(query: "{{QUERY_FILTER}}") {
    edges {
      node {
        id
        clientIp
        customerJourneySummary { ready }
        taxLines {
          title
          rate
          ratePercentage
          channelLiable
          source
          priceSet { shopMoney { amount currencyCode } }
        }
        discountCodes
        lineItems {
          edges {
            node {
              id
              taxLines {
                title
                rate
                ratePercentage
                channelLiable
                source
                priceSet { shopMoney { amount currencyCode } }
              }
              discountAllocations {
                allocatedAmountSet { shopMoney { amount currencyCode } }
                discountApplication { index }
              }
              duties {
                id
                harmonizedSystemCode
                countryCodeOfOrigin
                price { shopMoney { amount currencyCode } }
              }
            }
          }
        }
      }
    }
  }
`;

// Note: in 2026-01 there's no Order.clientUserAgent field — only clientIp
// remains. The other browser fields (height/width, accept-language, session
// hash, user agent) are not exposed via GraphQL. Columns stay null; raw_payload
// captures whatever Shopify returned.

const ordersPass1: ResourceModule = {
  resourceName: "orders_pass_1",
  category: "orders_pass",
  table: "orders",
  syncStrategy: "chunked_monthly",
  chunkField: "created_at",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  // Stub transform — returns the parent's id only so child extractors can FK.
  // No row is written to `orders` because skipParentUpsert is true.
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
    // ─────── Order-level inline LISTS ───────
    {
      table: "order_tax_lines",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent) => {
        const lines = Array.isArray(raw.taxLines) ? raw.taxLines : [];
        return lines.map((tl: RawPayload) => ({
          order_id: parent.id,
          title: tl.title ?? null,
          rate: tl.rate ?? null,
          rate_percentage: tl.ratePercentage ?? null,
          price_amount: tl.priceSet?.shopMoney?.amount ?? null,
          price_currency: tl.priceSet?.shopMoney?.currencyCode ?? null,
          channel_liable: tl.channelLiable ?? null,
          source: tl.source ?? null,
          raw_payload: tl,
          synced_at: parent.synced_at,
        }));
      },
    },
    {
      table: "order_discount_codes",
      replaceByParent: true,
      parentFk: "order_id",
      // Unique constraint on (order_id, code) — Shopify occasionally returns
      // the same code twice in Order.discountCodes (e.g. ["X", "X"]). Without
      // setting onConflict here, the PG default is the `id` PK, which is uuid
      // auto-gen and never collides — so the (order_id, code) constraint
      // throws and the whole 500-row PostgREST batch is rejected. Routing
      // onConflict to the named constraint makes the upsert idempotent and
      // dedupeByKey can collapse the dups within the batch.
      onConflict: "order_id,code",
      extract: (raw, parent) => {
        const raw_codes: string[] = Array.isArray(raw.discountCodes) ? raw.discountCodes : [];
        const codes = Array.from(new Set(raw_codes));
        return codes.map((code: string) => ({
          order_id: parent.id,
          code,
          amount_amount: null,
          amount_currency: null,
          type: null,
          raw_payload: { code },
          synced_at: parent.synced_at,
        }));
      },
    },
    {
      table: "order_client_details",
      replaceByParent: false, // PK is order_id — natural upsert
      parentFk: "order_id",
      onConflict: "order_id",
      extract: (raw, parent, ctx) => {
        // Only emit if at least one client field is present — most B2C orders
        // won't have any clientIp on older records.
        const ip = raw.clientIp ?? null;
        if (!ip) return [];
        return [{
          order_id: parent.id,
          browser_ip: ip,
          accept_language: null,
          user_agent: null,
          session_hash: null,
          browser_height: null,
          browser_width: null,
          raw_payload: { clientIp: ip },
          synced_at: parent.synced_at,
          _content_hash: ctx.hashContent({ clientIp: ip }),
        }];
      },
    },
    // ─────── Per-line-item children (inline LISTs on LineItem) ───────
    // Bulk JSONL always flattens the lineItems CONNECTION — each LineItem is
    // a separate JSONL line with __parentId. groupByParent attaches them at
    // _children.line_item. The LineItem's own LIST fields (taxLines,
    // discountAllocations, duties) stay INLINE on each lineItem object.
    {
      table: "order_line_item_tax_lines",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent) => {
        const out: Record<string, unknown>[] = [];
        for (const li of pickChildren(raw, "line_item")) {
          const tls = Array.isArray(li.taxLines) ? li.taxLines : [];
          for (const tl of tls) {
            out.push({
              line_item_id: li.id,
              order_id: parent.id,
              title: tl.title ?? null,
              rate: tl.rate ?? null,
              rate_percentage: tl.ratePercentage ?? null,
              price_amount: tl.priceSet?.shopMoney?.amount ?? null,
              price_currency: tl.priceSet?.shopMoney?.currencyCode ?? null,
              channel_liable: tl.channelLiable ?? null,
              source: tl.source ?? null,
              raw_payload: tl,
              synced_at: parent.synced_at,
            });
          }
        }
        return out;
      },
    },
    {
      table: "order_line_item_discount_allocations",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent) => {
        const out: Record<string, unknown>[] = [];
        for (const li of pickChildren(raw, "line_item")) {
          const das = Array.isArray(li.discountAllocations) ? li.discountAllocations : [];
          for (const da of das) {
            out.push({
              line_item_id: li.id,
              order_id: parent.id,
              allocated_amount: da.allocatedAmountSet?.shopMoney?.amount ?? null,
              allocated_currency: da.allocatedAmountSet?.shopMoney?.currencyCode ?? null,
              discount_application_index: da.discountApplication?.index ?? null,
              raw_payload: da,
              synced_at: parent.synced_at,
            });
          }
        }
        return out;
      },
    },
    {
      table: "order_line_item_duties",
      replaceByParent: true,
      parentFk: "order_id",
      extract: (raw, parent, ctx) => {
        const out: Record<string, unknown>[] = [];
        for (const li of pickChildren(raw, "line_item")) {
          const ds = Array.isArray(li.duties) ? li.duties : [];
          for (const d of ds) {
            out.push({
              id: d.id,
              line_item_id: li.id,
              order_id: parent.id,
              harmonized_system_code: d.harmonizedSystemCode ?? null,
              country_code_of_origin: d.countryCodeOfOrigin ?? null,
              price_amount: d.price?.shopMoney?.amount ?? null,
              price_currency: d.price?.shopMoney?.currencyCode ?? null,
              tax_lines: null, // Duty.taxLines requires a sub-selection we didn't request
              raw_payload: d,
              synced_at: parent.synced_at,
              _content_hash: ctx.hashContent(d),
            });
          }
        }
        return out;
      },
    },
  ],
};

export default ordersPass1;
