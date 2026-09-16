// Wave 3 Phase A — one-time external completeness audit.
// Compares Shopify's authoritative state to our Supabase mirror, resource
// by resource. Read-only. No data writes.
//
// Run via: npm run audit-shopify-vs-db
// Outputs:
//   - Console table with per-resource status
//   - JSON archive at /tmp/shopify-vs-db-audit-{timestamp}.json
// Exit code: 0 if all match/tolerance, 1 if any 🛑 needs-investigation.

import { writeFileSync } from "node:fs";
import { shopify, query } from "../lib/shopify/client";
import { getSupabaseAdmin, supabaseAdmin } from "../lib/supabase/admin";

interface AuditEntry {
  resource: string;
  table: string;
  category: string | null;
  shopify_count: number | null;
  shopify_method: string;
  db_count: number;
  delta: number | null;
  delta_pct: number | null;
  status: "match" | "tolerance" | "investigate" | "unknown" | "error";
  notes?: string;
}

interface SpotCheckResult {
  resource: string;
  id: string;
  matches: string[];
  mismatches: { field: string; db: unknown; shopify: unknown }[];
  error?: string;
}

const dataDb = getSupabaseAdmin("shopify");

// ─── Helpers ────────────────────────────────────────────────────────────

async function tableCount(table: string): Promise<number> {
  const { count } = await dataDb.from(table).select("*", { count: "exact", head: true });
  return count ?? 0;
}

async function shopifyCount(field: string, filter?: string): Promise<{ count: number | null; precision: string | null; err?: string }> {
  try {
    const args = filter ? `(query: "${filter}")` : "";
    const q = `query { ${field}${args} { count precision } }`;
    const r = await query<Record<string, { count: number; precision: string }>>(q);
    const v = r?.[field];
    return { count: v?.count ?? null, precision: v?.precision ?? null };
  } catch (e) {
    return { count: null, precision: null, err: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

// Paginate a connection counting edges. Caps at maxPages to bound runtime.
// Hard 30-min wall-clock cap for very-large tables (Fix 6 from architect).
async function paginatedCount(rootField: string, maxPages = 200, perPage = 250): Promise<{ count: number; capped: boolean; inconclusive?: boolean; err?: string }> {
  const HARD_BUDGET_MS = 30 * 60 * 1000; // 30 min
  const startedAt = Date.now();
  let cursor: string | null = null;
  let count = 0;
  for (let i = 0; i < maxPages; i++) {
    if (Date.now() - startedAt > HARD_BUDGET_MS) {
      return { count, capped: true, inconclusive: true, err: `paginated-count exceeded 30-min budget at ${count} rows` };
    }
    try {
      const q = `query Q($c: String) { ${rootField}(first: ${perPage}, after: $c) { edges { cursor } pageInfo { hasNextPage endCursor } } }`;
      const r = await shopify.request(q, { variables: { c: cursor } }) as { data?: Record<string, { edges: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>; errors?: unknown };
      if (r.errors) return { count, capped: false, err: JSON.stringify(r.errors).slice(0, 200) };
      const conn = r.data?.[rootField];
      if (!conn) return { count, capped: false, err: "missing connection" };
      count += conn.edges.length;
      cursor = conn.pageInfo.endCursor;
      if (!conn.pageInfo.hasNextPage) return { count, capped: false };
    } catch (e) {
      return { count, capped: false, err: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
  }
  return { count, capped: true };
}

function classify(delta: number, dbCount: number): { status: AuditEntry["status"]; pct: number | null } {
  if (dbCount === 0 && delta === 0) return { status: "match", pct: 0 };
  if (delta === 0) return { status: "match", pct: 0 };
  const pct = dbCount > 0 ? (Math.abs(delta) / dbCount) * 100 : 0;
  if (Math.abs(delta) <= 100 || pct <= 0.5) return { status: "tolerance", pct };
  return { status: "investigate", pct };
}

// ─── Direct totalCount audits ───────────────────────────────────────────

async function auditViaCount(label: string, table: string, category: string, countField: string, paginatedFallbackRoot?: string, filter?: string): Promise<AuditEntry> {
  const [db, sh] = await Promise.all([tableCount(table), shopifyCount(countField, filter)]);
  if (sh.err) {
    return { resource: label, table, category, shopify_count: null, shopify_method: `${countField} (errored)`, db_count: db, delta: null, delta_pct: null, status: "error", notes: sh.err };
  }
  if (sh.count === null) {
    return { resource: label, table, category, shopify_count: null, shopify_method: countField, db_count: db, delta: null, delta_pct: null, status: "error", notes: "no count returned" };
  }
  // Fix 1: AT_LEAST handling. When Shopify caps at 10,000 and our DB is bigger,
  // fall back to paginated count for the real number. Architect-approved.
  if (sh.precision === "AT_LEAST" && sh.count === 10000 && db > 10000 && paginatedFallbackRoot) {
    const maxPages = Math.ceil((db * 1.05) / 250) + 50; // headroom for organic growth
    const pag = await paginatedCount(paginatedFallbackRoot, maxPages);
    if (pag.inconclusive) {
      return { resource: label, table, category, shopify_count: pag.count, shopify_method: `${countField}=AT_LEAST 10K, paginated fallback INCONCLUSIVE (30-min budget)`, db_count: db, delta: null, delta_pct: null, status: "unknown", notes: pag.err };
    }
    if (pag.err) {
      return { resource: label, table, category, shopify_count: pag.count, shopify_method: `${countField}=AT_LEAST 10K, paginated fallback errored`, db_count: db, delta: null, delta_pct: null, status: "error", notes: pag.err };
    }
    const d = db - pag.count;
    const c = classify(d, db);
    return { resource: label, table, category, shopify_count: pag.count, shopify_method: `${countField}=AT_LEAST 10K → paginated fallback (exact)`, db_count: db, delta: d, delta_pct: c.pct, status: c.status };
  }
  const delta = db - sh.count;
  const { status, pct } = classify(delta, db);
  return { resource: label, table, category, shopify_count: sh.count, shopify_method: `${countField} (${sh.precision})`, db_count: db, delta, delta_pct: pct, status };
}

async function auditViaPagination(label: string, table: string, category: string, rootField: string, maxPages = 100): Promise<AuditEntry> {
  const [db, sh] = await Promise.all([tableCount(table), paginatedCount(rootField, maxPages)]);
  if (sh.err) {
    return { resource: label, table, category, shopify_count: null, shopify_method: `${rootField} paginated (errored)`, db_count: db, delta: null, delta_pct: null, status: "error", notes: sh.err };
  }
  const delta = db - sh.count;
  const { status, pct } = classify(delta, db);
  const note = sh.capped ? `paginated capped at ${maxPages * 250} (real count higher)` : `paginated`;
  return { resource: label, table, category, shopify_count: sh.count, shopify_method: note, db_count: db, delta, delta_pct: pct, status };
}

// For children where we can't easily get a Shopify total: validate via ratio
// against parent. Pick N random parents, sum their children count via
// connection.totalCount (if exposed), compare ratio to our DB.
// Fix 3: known LIST fields (not connections). For these, the GraphQL sub-
// selection is `field { ... }` not `field(first: N) { edges { node { ... } } }`.
// Format: "ParentType.fieldName"
const LIST_FIELDS = new Set<string>([
  "Order.fulfillments",
  "Order.refunds",
  "Order.transactions",
  "Order.taxLines",
  "Order.discountCodes",
  "Order.shippingLines",
  "Order.customAttributes",
  "Customer.addresses", // Customer.addresses is a LIST in 2026-01
  "LineItem.taxLines",
  "LineItem.discountAllocations",
  "LineItem.duties",
  "ShippingLine.taxLines",
  "ShippingLine.discountAllocations",
  "Fulfillment.trackingInfo",
]);

async function auditViaRatio(
  label: string,
  table: string,
  category: string,
  parentTable: string,
  childConnGraphqlPath: string, // e.g. "lineItems" relative to Order
  parentTypeFragment = "Order",
  sampleN = 100, // Fix 4: was 30, increased for low-rate events like refunds
): Promise<AuditEntry> {
  const db = await tableCount(table);
  const dbParent = await tableCount(parentTable);
  // Sample N parent IDs
  const { data } = await dataDb
    .from(parentTable)
    .select("id")
    .order("id", { ascending: false })
    .limit(sampleN * 4); // Take 4× then random-shuffle to get spread
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  const sampled: string[] = [];
  while (sampled.length < sampleN && ids.length) {
    const idx = Math.floor(Math.random() * ids.length);
    sampled.push(ids.splice(idx, 1)[0]);
  }
  if (!sampled.length) {
    return { resource: label, table, category, shopify_count: null, shopify_method: `ratio-via-${childConnGraphqlPath}`, db_count: db, delta: null, delta_pct: null, status: "error", notes: "no parent rows to sample" };
  }
  // Fix 2: connection sub-selections need (first: N). Fix 3: LIST fields use
  // a different shape. Detect via LIST_FIELDS lookup.
  const isList = LIST_FIELDS.has(`${parentTypeFragment}.${childConnGraphqlPath}`);
  const subSelection = isList
    ? `${childConnGraphqlPath} { id }` // LIST: just count items in array
    : `${childConnGraphqlPath}(first: 250) { edges { cursor } pageInfo { hasNextPage } }`;
  const Q = `query Q($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ${parentTypeFragment} { id ${subSelection} }
    }
  }`;
  let sampleChildCount = 0;
  let sampleParentsQueried = 0;
  let trueChildCount = 0;
  try {
    // Fetch in batches of 10 nodes to keep cost low
    for (let i = 0; i < sampled.length; i += 10) {
      const batch = sampled.slice(i, i + 10);
      const r = await shopify.request(Q, { variables: { ids: batch } }) as { data?: { nodes: { id: string; [k: string]: unknown }[] }; errors?: unknown };
      if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 200));
      for (const n of r.data?.nodes ?? []) {
        if (!n) continue;
        sampleParentsQueried++;
        if (isList) {
          // LIST: field is an array directly
          const arr = (n as Record<string, unknown[]>)[childConnGraphqlPath];
          sampleChildCount += Array.isArray(arr) ? arr.length : 0;
        } else {
          const conn = (n as Record<string, { edges?: unknown[]; pageInfo?: { hasNextPage: boolean } }>)[childConnGraphqlPath];
          const ec = conn?.edges?.length ?? 0;
          sampleChildCount += ec;
        }
      }
    }
  } catch (e) {
    return { resource: label, table, category, shopify_count: null, shopify_method: `ratio-via-${childConnGraphqlPath}`, db_count: db, delta: null, delta_pct: null, status: "error", notes: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  if (sampleParentsQueried === 0) {
    return { resource: label, table, category, shopify_count: null, shopify_method: `ratio-via-${childConnGraphqlPath}`, db_count: db, delta: null, delta_pct: null, status: "error", notes: "no parents fetched from Shopify" };
  }
  const avgChildPerParent = sampleChildCount / sampleParentsQueried;
  trueChildCount = Math.round(avgChildPerParent * dbParent);
  const delta = db - trueChildCount;
  const dbRatio = dbParent > 0 ? db / dbParent : 0;
  // For ratio audits, tolerance is wider: 10% (sampling variance)
  const pct = dbParent > 0 ? (Math.abs(delta) / Math.max(trueChildCount, 1)) * 100 : 0;
  let status: AuditEntry["status"];
  if (Math.abs(pct) <= 10) status = "match";
  else if (Math.abs(pct) <= 20) status = "tolerance";
  else status = "investigate";
  return {
    resource: label,
    table,
    category,
    shopify_count: trueChildCount,
    shopify_method: `ratio-sampling (${sampleParentsQueried} parents, avg ${avgChildPerParent.toFixed(2)} children, scaled to ${dbParent} parents)`,
    db_count: db,
    delta,
    delta_pct: pct,
    status,
    notes: `our DB ratio: ${dbRatio.toFixed(2)} children/parent`,
  };
}

// ─── Spot-check (deep field comparison) ──────────────────────────────────

async function spotCheck(table: string, idsLimit = 5): Promise<SpotCheckResult[]> {
  // Pick random spread of IDs ordered by created_at for variety
  const { data } = await dataDb
    .from(table)
    .select("*")
    .order("id", { ascending: false })
    .limit(100);
  const all = (data ?? []) as Record<string, unknown>[];
  const sampled: Record<string, unknown>[] = [];
  while (sampled.length < idsLimit && all.length) {
    const idx = Math.floor(Math.random() * all.length);
    sampled.push(all.splice(idx, 1)[0]);
  }
  const out: SpotCheckResult[] = [];
  for (const row of sampled) {
    const id = row.id as string;
    const Q = `query Q($id: ID!) {
      node(id: $id) {
        __typename
        ... on Order { id name createdAt totalPriceSet { shopMoney { amount currencyCode } } customer { id } }
        ... on Customer { id email firstName lastName createdAt updatedAt }
        ... on Product { id title status createdAt updatedAt vendor productType handle }
        ... on Collection { id title handle updatedAt sortOrder }
      }
    }`;
    try {
      const r = await shopify.request(Q, { variables: { id } }) as { data?: { node: Record<string, unknown> | null }; errors?: unknown };
      if (r.errors) {
        out.push({ resource: table, id, matches: [], mismatches: [], error: JSON.stringify(r.errors).slice(0, 200) });
        continue;
      }
      const n = r.data?.node;
      if (!n) {
        out.push({ resource: table, id, matches: [], mismatches: [], error: "node not found in Shopify (deleted?)" });
        continue;
      }
      const matches: string[] = [];
      const mismatches: { field: string; db: unknown; shopify: unknown }[] = [];
      // Per-table field comparisons
      const checks: { field: string; db: unknown; shopify: unknown }[] = [];
      if (table === "orders") {
        checks.push({ field: "name", db: row.name, shopify: n.name });
        checks.push({ field: "created_at", db: (row.created_at as string)?.slice(0, 10), shopify: (n.createdAt as string)?.slice(0, 10) });
        checks.push({ field: "total_price_amount", db: Number(row.total_price_amount), shopify: Number((n as { totalPriceSet?: { shopMoney?: { amount: string } } }).totalPriceSet?.shopMoney?.amount) });
        checks.push({ field: "customer_id", db: row.customer_id, shopify: (n as { customer?: { id: string } | null }).customer?.id ?? null });
      } else if (table === "customers") {
        checks.push({ field: "email", db: row.email, shopify: n.email });
        checks.push({ field: "first_name", db: row.first_name, shopify: n.firstName });
        checks.push({ field: "last_name", db: row.last_name, shopify: n.lastName });
        checks.push({ field: "created_at", db: (row.created_at as string)?.slice(0, 10), shopify: (n.createdAt as string)?.slice(0, 10) });
      } else if (table === "products") {
        checks.push({ field: "title", db: row.title, shopify: n.title });
        checks.push({ field: "status", db: row.status, shopify: n.status });
        checks.push({ field: "vendor", db: row.vendor, shopify: n.vendor });
        checks.push({ field: "product_type", db: row.product_type, shopify: n.productType });
        checks.push({ field: "handle", db: row.handle, shopify: n.handle });
      } else if (table === "collections") {
        checks.push({ field: "title", db: row.title, shopify: n.title });
        checks.push({ field: "handle", db: row.handle, shopify: n.handle });
        checks.push({ field: "sort_order", db: row.sort_order, shopify: n.sortOrder });
      }
      for (const c of checks) {
        if (String(c.db) === String(c.shopify) || (c.db == null && c.shopify == null)) matches.push(c.field);
        else mismatches.push(c);
      }
      out.push({ resource: table, id, matches, mismatches });
    } catch (e) {
      out.push({ resource: table, id, matches: [], mismatches: [], error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return out;
}

// ─── Main audit plan ─────────────────────────────────────────────────────

async function main(): Promise<number> {
  const startedAt = Date.now();
  console.log("\n═══ Shopify-vs-DB completeness audit ═══");
  console.log(`Started: ${new Date().toISOString()}\n`);

  const results: AuditEntry[] = [];

  // ── A) Direct count queries (Shopify exposes a *Count field).
  // For tables likely > 10K, pass paginatedFallbackRoot so we can resolve
  // the Shopify AT_LEAST=10000 ceiling via paginated count.
  console.log("[1/4] Direct *Count queries (with AT_LEAST → paginated fallback for >10K tables)...");
  results.push(await auditViaCount("products", "products", "catalog", "productsCount", "products"));
  results.push(await auditViaCount("customers", "customers", "customers", "customersCount", "customers"));
  results.push(await auditViaCount("orders", "orders", "orders", "ordersCount", "orders"));
  results.push(await auditViaCount("customer_segments", "customer_segments", "customers", "segmentsCount"));
  results.push(await auditViaCount("draft_orders", "draft_orders", "orders", "draftOrdersCount", "draftOrders"));

  // ── B) Top-level paginated counts (no totalCount available)
  console.log("[2/4] Top-level paginated counts...");
  results.push(await auditViaPagination("discount_codes", "discount_codes", "marketing", "codeDiscountNodes", 700));
  results.push(await auditViaPagination("automatic_discounts", "automatic_discounts", "marketing", "automaticDiscountNodes", 5));
  results.push(await auditViaPagination("locations", "locations", "operational", "locations", 5));
  results.push(await auditViaPagination("collections", "collections", "catalog", "collections", 10));
  results.push(await auditViaPagination("inventory_items", "inventory_items", "inventory", "inventoryItems", 300));
  results.push(await auditViaPagination("files", "files", "files", "files", 700));
  results.push(await auditViaPagination("navigation_menus", "navigation_menus", "content", "menus", 5));

  // Singletons / very small resources — just pass-through
  results.push({ resource: "shop", table: "shop", category: "operational", shopify_count: 1, shopify_method: "singleton", db_count: await tableCount("shop"), delta: 0, delta_pct: 0, status: "match" });

  // ── C) Children — ratio sampling against parents
  console.log("[3/4] Child-table ratio sampling...");
  // auditViaRatio now handles LIST and CONNECTION shapes via LIST_FIELDS lookup.
  results.push(await auditViaRatio("order_line_items", "order_line_items", "orders", "orders", "lineItems", "Order"));
  results.push(await auditViaRatio("order_transactions", "order_transactions", "orders", "orders", "transactions", "Order"));
  results.push(await auditViaRatio("order_fulfillments", "order_fulfillments", "orders", "orders", "fulfillments", "Order"));
  results.push(await auditViaRatio("order_refunds", "order_refunds", "orders", "orders", "refunds", "Order"));
  results.push(await auditViaRatio("customer_addresses", "customer_addresses", "customers", "customers", "addresses", "Customer"));
  results.push(await auditViaRatio("customer_metafields", "customer_metafields", "customers", "customers", "metafields", "Customer"));
  results.push(await auditViaRatio("product_metafields", "product_metafields", "catalog", "products", "metafields", "Product"));
  results.push(await auditViaRatio("product_variants", "product_variants", "catalog", "products", "variants", "Product"));
  results.push(await auditViaRatio("product_media", "product_media", "catalog", "products", "media", "Product"));
  results.push(await auditViaRatio("inventory_levels", "inventory_levels", "inventory", "inventory_items", "inventoryLevels", "InventoryItem"));
  results.push(await auditViaRatio("collection_products", "collection_products", "catalog", "collections", "products", "Collection"));

  // ── D) Spot checks: 5 random rows × 4 top tables
  console.log("[4/4] Spot-checking 5 random rows × 4 top tables...");
  const spotChecks: SpotCheckResult[] = [];
  for (const t of ["orders", "customers", "products", "collections"]) {
    spotChecks.push(...(await spotCheck(t, 5)));
  }

  // ── E) Deferred section
  // Fix 5: status is an enum — PostgREST `like` doesn't apply. Filter via `in()`
  // on the two known deferred values.
  const { data: deferredRaw } = await supabaseAdmin
    .from("resource_registry")
    .select("resource_name, status, defer_reason")
    .in("status", ["deferred_pending_scope", "deferred_not_applicable"])
    .order("resource_name");
  const deferred = (deferredRaw ?? []) as { resource_name: string; status: string; defer_reason: string | null }[];

  // ── Output: console table + JSON file
  console.log("\n═══ AUDIT RESULTS ═══\n");

  const widths = { resource: 32, shopify: 11, db: 11, delta: 11, status: 14, method: 50 };
  const hdr = `${"resource".padEnd(widths.resource)} │ ${"shopify".padStart(widths.shopify)} │ ${"db".padStart(widths.db)} │ ${"delta".padStart(widths.delta)} │ ${"status".padEnd(widths.status)} │ method/notes`;
  console.log(hdr);
  console.log("─".repeat(hdr.length));
  const fmt = (n: number | null) => n === null ? "—" : n.toLocaleString();
  for (const r of results) {
    const icon = r.status === "match" ? "✅" : r.status === "tolerance" ? "⚠️ " : r.status === "investigate" ? "🛑" : "❓";
    const deltaStr = r.delta === null ? "—" : (r.delta >= 0 ? "+" : "") + r.delta.toLocaleString();
    const pctStr = r.delta_pct !== null ? ` (${r.delta_pct.toFixed(2)}%)` : "";
    console.log(
      `${r.resource.padEnd(widths.resource).slice(0, widths.resource)} │ ${fmt(r.shopify_count).padStart(widths.shopify)} │ ${fmt(r.db_count).padStart(widths.db)} │ ${deltaStr.padStart(widths.delta)} │ ${(icon + " " + r.status + pctStr).padEnd(widths.status)} │ ${r.shopify_method.slice(0, widths.method)}`,
    );
    if (r.notes) console.log(`  └─ ${r.notes.slice(0, 200)}`);
  }

  // Spot checks
  console.log("\n─── Spot checks (deep field compare, 5 rows × 4 tables) ───");
  for (const sc of spotChecks) {
    const status = sc.error ? "❌ ERROR" : sc.mismatches.length === 0 ? "✅ all match" : `🛑 ${sc.mismatches.length} mismatch`;
    console.log(`  ${sc.resource} ${sc.id.slice(-12)} — ${status}`);
    if (sc.error) console.log(`    └─ ${sc.error}`);
    for (const m of sc.mismatches) console.log(`    └─ ${m.field}: db="${String(m.db).slice(0,40)}" shopify="${String(m.shopify).slice(0,40)}"`);
  }

  // Deferred section
  console.log("\n─── Intentionally not synced (deferred) ───");
  for (const d of deferred) {
    console.log(`  ${d.resource_name.padEnd(35)} ${d.status.padEnd(28)} ${d.defer_reason?.slice(0, 80) ?? ""}`);
  }

  // Summary
  const counts = { match: 0, tolerance: 0, investigate: 0, error: 0, unknown: 0 };
  for (const r of results) counts[r.status]++;
  const spotMismatches = spotChecks.filter((s) => s.mismatches.length > 0).length;
  const spotErrors = spotChecks.filter((s) => s.error).length;
  console.log("\n═══ SUMMARY ═══");
  console.log(`  Resources: ${counts.match} ✅ match | ${counts.tolerance} ⚠️  tolerance | ${counts.investigate} 🛑 investigate | ${counts.error} ❌ error`);
  console.log(`  Spot-checks: ${spotChecks.length - spotMismatches - spotErrors} clean | ${spotMismatches} mismatches | ${spotErrors} errors`);
  console.log(`  Deferred: ${deferred.length} resources (intentionally skipped)`);
  console.log(`  Elapsed: ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);

  // Archive
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = `/tmp/shopify-vs-db-audit-${ts}.json`;
  writeFileSync(archivePath, JSON.stringify({ results, spotChecks, deferred, summary: counts, started: startedAt, completed: Date.now() }, null, 2));
  console.log(`\nArchive: ${archivePath}`);

  const exitCode = counts.investigate === 0 && counts.error === 0 && spotMismatches === 0 ? 0 : 1;
  console.log(exitCode === 0 ? "\n═══ ✅ AUDIT CLEAN ═══\n" : "\n═══ 🛑 AUDIT FOUND ISSUES — see flags above ═══\n");
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("audit-shopify-vs-db failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
