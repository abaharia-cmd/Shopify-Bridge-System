// Registry of implemented resource modules. Keyed by resource_name (matches
// shopify_sync.resource_registry.resource_name).
//
// Phase 2 implements 5 resources end-to-end. The other 79 active resources
// will be added in later phases — the orchestrator skips unimplemented ones
// with a warning.

import type { ResourceModule } from "./types";
import shop from "./shop";
import locations from "./locations";
import sales_channels from "./sales_channels";
import customers from "./customers";
import products from "./products";
import orders from "./orders";
// Phase 3 — Tier 1 (operational singletons / paginated):
import staff_users from "./staff_users";
import apps_installed from "./apps_installed";
import webhooks_registered from "./webhooks_registered";
import shipping_profiles from "./shipping_profiles";
import carrier_services from "./carrier_services";
// Phase 3 — Tier 2 (catalog):
import collections from "./collections";
// Phase 3 — Tier 3 (inventory):
import inventory_items from "./inventory_items";
import inventory_transfers from "./inventory_transfers";
// Phase 3 — Tier 4 (marketing — partial):
import gift_cards from "./gift_cards";
import marketing_events from "./marketing_events";
// Phase 3 — Tier 5 (financial):
import payouts from "./payouts";
import balance_transactions from "./balance_transactions";
import disputes from "./disputes";
// Phase 3 Wave 1 — Order children passes (skipParentUpsert; orders parent
// table is already complete from Phase 2):
import orders_pass_1 from "./orders_pass_1";
import orders_pass_2 from "./orders_pass_2";
import orders_pass_3 from "./orders_pass_3";
import orders_pass_4 from "./orders_pass_4";
// Phase 3 Wave 2 — long tail:
import discount_codes from "./discount_codes";
import automatic_discounts from "./automatic_discounts";
import draft_orders from "./draft_orders";
import abandoned_checkouts from "./abandoned_checkouts";
import customer_segments from "./customer_segments";
import collection_rules from "./collection_rules";
import files from "./files";
import navigation_menus from "./navigation_menus";
import product_translations from "./product_translations";
import collection_translations from "./collection_translations";
import translations from "./translations";
// Phase 3D — FulfillmentOrder routing (per-line-item location assignment).
// Canonical source for "which warehouse is this order assigned to" — works
// for fulfilled AND unfulfilled orders (Order.fulfillments is null for the latter).
import fulfillment_orders from "./fulfillment_orders";

export const resourceRegistry: Record<string, ResourceModule> = {
  shop,
  locations,
  sales_channels,
  customers,
  products,
  orders,
  // Tier 1
  staff_users,
  apps_installed,
  webhooks_registered,
  shipping_profiles,
  carrier_services,
  // Tier 2
  collections,
  // Tier 3
  inventory_items,
  inventory_transfers,
  // Tier 4 (partial — discount_codes, automatic_discounts, price_rules, marketing_activities deferred)
  gift_cards,
  marketing_events,
  // Tier 5 (financial)
  payouts,
  balance_transactions,
  disputes,
  // Phase 3 Wave 1 — order children passes
  orders_pass_1,
  orders_pass_2,
  orders_pass_3,
  orders_pass_4,
  // Wave 2
  discount_codes,
  automatic_discounts,
  draft_orders,
  abandoned_checkouts,
  customer_segments,
  collection_rules,
  files,
  navigation_menus,
  product_translations,
  collection_translations,
  translations,
  // Phase 3D
  fulfillment_orders,
};
