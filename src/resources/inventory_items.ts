import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";

// Bulk inner-query: inventoryItems + their inventoryLevels (per-location).
// Single bulk op populates both shopify.inventory_items and shopify.inventory_levels.
const QUERY = /* GraphQL */ `
  inventoryItems {
    edges {
      node {
        id
        legacyResourceId
        sku
        tracked
        requiresShipping
        unitCost {
          amount
          currencyCode
        }
        countryCodeOfOrigin
        provinceCodeOfOrigin
        harmonizedSystemCode
        countryHarmonizedSystemCodes(first: 250) {
          edges {
            node {
              countryCode
              harmonizedSystemCode
            }
          }
        }
        measurement {
          weight {
            value
            unit
          }
        }
        inventoryHistoryUrl
        duplicateSkuCount
        locationsCount {
          count
        }
        variant {
          id
        }
        createdAt
        updatedAt
        inventoryLevels {
          edges {
            node {
              id
              location {
                id
              }
              quantities(names: ["available","committed","incoming","on_hand","reserved","damaged","safety_stock","quality_control"]) {
                name
                quantity
              }
              canDeactivate
              deactivationAlert
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
`;

const levelsExtractor: ChildExtractor = {
  table: "inventory_levels",
  parentFk: "inventory_item_id",
  replaceByParent: true,
  // Composite UNIQUE on (inventory_item_id, location_id) — one level row per
  // (item, location) pair. Shopify re-emits the same level with the same
  // location ID across syncs; route to the natural-key constraint to make
  // upserts idempotent on collision.
  onConflict: "inventory_item_id,location_id",
  extract: (raw, parent, ctx) => {
    const levels = pickChildren(raw, "inventory_level");
    return levels.map((l) => {
      // Map quantities array to per-name columns.
      const q: Record<string, number> = {};
      for (const item of l.quantities ?? []) {
        if (item?.name) q[item.name] = item.quantity;
      }
      return {
        id: l.id,
        inventory_item_id: parent.id,
        location_id: l.location?.id ?? null,
        quantity_available: q["available"] ?? null,
        quantity_committed: q["committed"] ?? null,
        quantity_incoming: q["incoming"] ?? null,
        quantity_on_hand: q["on_hand"] ?? null,
        quantity_reserved: q["reserved"] ?? null,
        quantity_damaged: q["damaged"] ?? null,
        quantity_safety_stock: q["safety_stock"] ?? null,
        quantity_quality_control: q["quality_control"] ?? null,
        quantities: l.quantities ?? null,
        can_deactivate: l.canDeactivate ?? null,
        deactivation_alert: l.deactivationAlert ?? null,
        created_at: l.createdAt ?? null,
        updated_at: l.updatedAt ?? null,
        raw_payload: l,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(l),
      };
    });
  },
};

const inventory_items: ResourceModule = {
  resourceName: "inventory_items",
  category: "inventory",
  table: "inventory_items",
  syncStrategy: "bulk",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    // countryHarmonizedSystemCodes connection flattens — try _children first.
    const chsc = pickChildren(raw, "country_harmonized_system_code");
    const row: MainRow = {
      id: raw.id,
      variant_id: raw.variant?.id ?? null,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      sku: raw.sku ?? null,
      tracked: raw.tracked ?? null,
      requires_shipping: raw.requiresShipping ?? null,
      unit_cost_amount: raw.unitCost?.amount ?? null,
      unit_cost_currency: raw.unitCost?.currencyCode ?? null,
      country_code_of_origin: raw.countryCodeOfOrigin ?? null,
      province_code_of_origin: raw.provinceCodeOfOrigin ?? null,
      harmonized_system_code: raw.harmonizedSystemCode ?? null,
      country_harmonized_system_codes: chsc.length ? chsc : (raw.countryHarmonizedSystemCodes ?? null),
      measurement_weight_value: raw.measurement?.weight?.value ?? null,
      measurement_weight_unit: raw.measurement?.weight?.unit ?? null,
      inventory_history_url: raw.inventoryHistoryUrl ?? null,
      duplicate_sku_count: raw.duplicateSkuCount ?? null,
      locations_count: raw.locationsCount?.count ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [levelsExtractor],
};

export default inventory_items;
