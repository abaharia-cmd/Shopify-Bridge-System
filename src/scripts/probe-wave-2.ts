// Wave 2 probe: for every not_started active resource, run a small GraphQL
// query to determine whether Ourkids has data worth fetching. Output a
// recommendation (build / defer_not_applicable) per resource.
//
// Run via: npm run probe-wave-2

import { query, shopify } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

interface ProbeResult {
  resource: string;
  category: string;
  approach: string;
  sample: number | string;
  has_data: boolean;
  recommendation: string;
  notes?: string;
}

async function tryQuery<T>(
  q: string,
  vars: Record<string, unknown> = {},
): Promise<{ data?: T; err?: string; cost?: unknown }> {
  try {
    const r = (await shopify.request(q, { variables: vars })) as {
      data?: T;
      errors?: unknown;
      extensions?: { cost?: unknown };
    };
    if (r.errors) {
      return {
        err: JSON.stringify(r.errors).slice(0, 300),
        cost: r.extensions?.cost,
      };
    }
    return { data: r.data, cost: r.extensions?.cost };
  } catch (e) {
    return { err: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}

async function main(): Promise<number> {
  const results: ProbeResult[] = [];
  const dataDb = getSupabaseAdmin("shopify");

  // ─── Shop config (multi-currency / multi-language) ───────────────────
  const shopProbe = await tryQuery<{
    shop: { currencyCode: string; enabledPresentmentCurrencies: string[] };
    shopLocales: { locale: string; primary: boolean; published: boolean }[];
  }>(`query { shop { currencyCode enabledPresentmentCurrencies } shopLocales { locale primary published } }`);
  const presentmentCount = shopProbe.data?.shop?.enabledPresentmentCurrencies?.length ?? 0;
  const localeCount = (shopProbe.data?.shopLocales ?? []).length;
  const publishedNonPrimaryLocales = (shopProbe.data?.shopLocales ?? []).filter(
    (l) => l.published && !l.primary,
  ).length;
  console.log(`Shop config:`);
  console.log(`  currency: ${shopProbe.data?.shop?.currencyCode}`);
  console.log(`  presentment currencies: ${presentmentCount} (${shopProbe.data?.shop?.enabledPresentmentCurrencies?.join(", ") ?? ""})`);
  console.log(`  locales: ${localeCount}, non-primary published: ${publishedNonPrimaryLocales}`);
  console.log("");

  // ─── Group A: modern discount API + marketing_activities ─────────────
  for (const [name, q] of [
    ["discount_codes", `query { codeDiscountNodes(first: 5) { edges { node { id codeDiscount { __typename } } } pageInfo { hasNextPage } } }`],
    ["automatic_discounts", `query { automaticDiscountNodes(first: 5) { edges { node { id automaticDiscount { __typename } } } pageInfo { hasNextPage } } }`],
    ["marketing_activities", `query { marketingActivities(first: 5) { edges { node { id title status } } pageInfo { hasNextPage } } }`],
  ] as const) {
    const r = await tryQuery<Record<string, { edges: unknown[]; pageInfo: { hasNextPage: boolean } }>>(q);
    const conn = r.data ? Object.values(r.data)[0] : undefined;
    const edges = conn?.edges ?? [];
    const more = conn?.pageInfo?.hasNextPage ?? false;
    if (r.err) {
      results.push({ resource: name, category: "marketing", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: r.err });
    } else {
      results.push({
        resource: name,
        category: "marketing",
        approach: "first:5",
        sample: `${edges.length}+${more ? "more" : "0"}`,
        has_data: edges.length > 0,
        recommendation: edges.length > 0 ? "build" : "defer_not_applicable",
      });
    }
  }

  // ─── Group B: drafts + abandoned ──────────────────────────────────────
  for (const [name, q] of [
    ["draft_orders", `query { draftOrders(first: 5) { edges { node { id name } } pageInfo { hasNextPage } } }`],
    ["abandoned_checkouts", `query { abandonedCheckouts(first: 5) { edges { node { id name } } pageInfo { hasNextPage } } }`],
  ] as const) {
    const r = await tryQuery<Record<string, { edges: unknown[]; pageInfo: { hasNextPage: boolean } }>>(q);
    const conn = r.data ? Object.values(r.data)[0] : undefined;
    const edges = conn?.edges ?? [];
    const more = conn?.pageInfo?.hasNextPage ?? false;
    if (r.err) {
      results.push({ resource: name, category: "orders", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: r.err });
    } else {
      results.push({
        resource: name,
        category: "orders",
        approach: "first:5",
        sample: `${edges.length}+${more ? "more" : "0"}`,
        has_data: edges.length > 0,
        recommendation: edges.length > 0 ? "build" : "defer_not_applicable",
      });
    }
  }
  // draft_order_line_items follows draft_orders' fate
  const draftStatus = results.find((r) => r.resource === "draft_orders");
  results.push({
    resource: "draft_order_line_items",
    category: "orders",
    approach: "follows draft_orders",
    sample: draftStatus?.sample ?? "?",
    has_data: draftStatus?.has_data ?? false,
    recommendation: draftStatus?.recommendation ?? "investigate",
  });

  // ─── Group C: variant metafields (DB-driven sample of 20 variants) ───
  const { data: vars } = await dataDb
    .from("product_variants")
    .select("id")
    .order("id", { ascending: false })
    .limit(20);
  const variantIds = (vars ?? []).map((v: { id: string }) => v.id);
  let variantsWithMeta = 0;
  let totalMetaInSample = 0;
  if (variantIds.length) {
    const Q = `query Probe($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant { id metafields(first: 50) { edges { node { id namespace key } } } }
      }
    }`;
    const r = await tryQuery<{ nodes: { id: string; metafields?: { edges: unknown[] } }[] }>(Q, { ids: variantIds });
    if (r.err) {
      results.push({ resource: "product_variant_metafields", category: "catalog", approach: "20-variant sample", sample: "ERROR", has_data: false, recommendation: "investigate", notes: r.err });
    } else {
      for (const n of r.data?.nodes ?? []) {
        const c = n?.metafields?.edges?.length ?? 0;
        if (c > 0) variantsWithMeta++;
        totalMetaInSample += c;
      }
      const rate = variantIds.length ? variantsWithMeta / variantIds.length : 0;
      const projected = Math.round(rate * 61598 * (totalMetaInSample / Math.max(variantsWithMeta, 1)));
      results.push({
        resource: "product_variant_metafields",
        category: "catalog",
        approach: "20-variant sample",
        sample: `${variantsWithMeta}/20 have meta, ~${projected} total proj.`,
        has_data: variantsWithMeta > 0,
        recommendation: variantsWithMeta > 0 ? "build" : "defer_not_applicable",
      });
    }
  }

  // ─── Group D: catalog tail (collection rules + translations) ─────────
  // Collection rules: present only on smart collections (ruleSet field non-null)
  const colR = await tryQuery<{ collections: { edges: { node: { id: string; ruleSet: { rules: unknown[] } | null } }[] } }>(
    `query { collections(first: 50) { edges { node { id ruleSet { rules { column relation condition } } } } } }`,
  );
  if (colR.err) {
    results.push({ resource: "collection_rules", category: "catalog", approach: "50-collection sample", sample: "ERROR", has_data: false, recommendation: "investigate", notes: colR.err });
  } else {
    const withRules = (colR.data?.collections?.edges ?? []).filter((e) => (e.node.ruleSet?.rules?.length ?? 0) > 0);
    const totalRules = withRules.reduce((s, e) => s + (e.node.ruleSet?.rules?.length ?? 0), 0);
    results.push({
      resource: "collection_rules",
      category: "catalog",
      approach: "50-collection sample",
      sample: `${withRules.length}/50 smart, ${totalRules} rules in sample`,
      has_data: withRules.length > 0,
      recommendation: withRules.length > 0 ? "build" : "defer_not_applicable",
    });
  }

  // Translations: depend on multi-language (publishedNonPrimaryLocales > 0)
  for (const t of ["product_translations", "collection_translations", "translations"] as const) {
    results.push({
      resource: t,
      category: t === "translations" ? "translations" : "catalog",
      approach: "shop locale check",
      sample: `${publishedNonPrimaryLocales} non-primary locales`,
      has_data: publishedNonPrimaryLocales > 0,
      recommendation: publishedNonPrimaryLocales > 0 ? "build" : "defer_not_applicable",
    });
  }

  // ─── Group E: misc ───────────────────────────────────────────────────
  // navigation_menus
  const menuR = await tryQuery<{ menus: { edges: unknown[]; pageInfo: { hasNextPage: boolean } } }>(
    `query { menus(first: 5) { edges { node { id title } } pageInfo { hasNextPage } } }`,
  );
  if (menuR.err) {
    results.push({ resource: "navigation_menus", category: "content", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: menuR.err });
  } else {
    const edges = menuR.data?.menus?.edges ?? [];
    const more = menuR.data?.menus?.pageInfo?.hasNextPage ?? false;
    results.push({
      resource: "navigation_menus",
      category: "content",
      approach: "first:5",
      sample: `${edges.length}+${more ? "more" : "0"}`,
      has_data: edges.length > 0,
      recommendation: edges.length > 0 ? "build" : "defer_not_applicable",
    });
  }

  // files
  const fileR = await tryQuery<{ files: { edges: unknown[]; pageInfo: { hasNextPage: boolean } } }>(
    `query { files(first: 5) { edges { node { id alt } } pageInfo { hasNextPage } } }`,
  );
  if (fileR.err) {
    results.push({ resource: "files", category: "files", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: fileR.err });
  } else {
    const edges = fileR.data?.files?.edges ?? [];
    const more = fileR.data?.files?.pageInfo?.hasNextPage ?? false;
    results.push({
      resource: "files",
      category: "files",
      approach: "first:5",
      sample: `${edges.length}+${more ? "more" : "0"}`,
      has_data: edges.length > 0,
      recommendation: edges.length > 0 ? "build" : "defer_not_applicable",
    });
  }

  // events_audit_log — Order has events; a top-level events query may not exist.
  // Probe via Shop's events connection.
  const evR = await tryQuery<{ events: { edges: { node: { id: string; createdAt: string } }[]; pageInfo: { hasNextPage: boolean } } }>(
    `query { events(first: 5) { edges { node { id createdAt } } pageInfo { hasNextPage } } }`,
  );
  if (evR.err) {
    results.push({ resource: "events_audit_log", category: "operational", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: evR.err });
  } else {
    const edges = evR.data?.events?.edges ?? [];
    const more = evR.data?.events?.pageInfo?.hasNextPage ?? false;
    const oldest = edges.length ? edges[edges.length - 1].node.createdAt : "—";
    results.push({
      resource: "events_audit_log",
      category: "operational",
      approach: "first:5 (sample only — could be 100K+)",
      sample: `${edges.length}+${more ? "more" : "0"}, oldest in sample: ${oldest}`,
      has_data: edges.length > 0,
      recommendation: edges.length > 0 ? "PROBE_DEEPER" : "defer_not_applicable",
    });
  }

  // customer_segments
  const segR = await tryQuery<{ segments: { edges: unknown[]; pageInfo: { hasNextPage: boolean } } }>(
    `query { segments(first: 5) { edges { node { id name } } pageInfo { hasNextPage } } }`,
  );
  if (segR.err) {
    results.push({ resource: "customer_segments", category: "customers", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: segR.err });
  } else {
    const edges = segR.data?.segments?.edges ?? [];
    const more = segR.data?.segments?.pageInfo?.hasNextPage ?? false;
    results.push({
      resource: "customer_segments",
      category: "customers",
      approach: "first:5",
      sample: `${edges.length}+${more ? "more" : "0"}`,
      has_data: edges.length > 0,
      recommendation: edges.length > 0 ? "build" : "defer_not_applicable",
    });
  }
  // customer_segment_members follows segments
  const segStatus = results.find((r) => r.resource === "customer_segments");
  results.push({
    resource: "customer_segment_members",
    category: "customers",
    approach: "follows customer_segments",
    sample: segStatus?.sample ?? "?",
    has_data: segStatus?.has_data ?? false,
    recommendation: segStatus?.recommendation ?? "investigate",
  });

  // customer_payment_methods — query against ONE customer to see if any saved methods exist
  const { data: cust } = await dataDb.from("customers").select("id").limit(10);
  const sampleCustIds = (cust ?? []).map((c: { id: string }) => c.id);
  let custWithPM = 0;
  if (sampleCustIds.length) {
    const Q = `query Probe($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id paymentMethods(first: 5) { edges { node { id } } } } } }`;
    const r = await tryQuery<{ nodes: { id: string; paymentMethods?: { edges: unknown[] } }[] }>(Q, { ids: sampleCustIds });
    if (r.err) {
      results.push({ resource: "customer_payment_methods", category: "customers", approach: "10-customer sample", sample: "ERROR", has_data: false, recommendation: "investigate", notes: r.err });
    } else {
      for (const n of r.data?.nodes ?? []) {
        if ((n?.paymentMethods?.edges?.length ?? 0) > 0) custWithPM++;
      }
      results.push({
        resource: "customer_payment_methods",
        category: "customers",
        approach: "10-customer sample",
        sample: `${custWithPM}/10 have saved methods`,
        has_data: custWithPM > 0,
        recommendation: custWithPM > 0 ? "build" : "defer_not_applicable",
      });
    }
  }

  // inventory_movements (via inventoryItem.scheduledChanges or adjustmentHistory)
  // Most stores have huge history. Probe one item.
  const { data: ii } = await dataDb.from("inventory_items").select("id").limit(1);
  const sampleIiId = (ii ?? [])[0]?.id;
  if (sampleIiId) {
    const Q = `query Probe($id: ID!) { node(id: $id) { ... on InventoryItem { id inventoryHistoryUrl } } }`;
    const r = await tryQuery<{ node: { id: string; inventoryHistoryUrl?: string | null } }>(Q, { id: sampleIiId });
    if (r.err) {
      results.push({ resource: "inventory_movements", category: "inventory", approach: "single-item probe", sample: "ERROR", has_data: false, recommendation: "investigate", notes: r.err });
    } else {
      // inventoryHistoryUrl returns a CSV URL for the legacy admin UI; not a clean GraphQL type
      results.push({
        resource: "inventory_movements",
        category: "inventory",
        approach: "single-item probe",
        sample: `historyUrl: ${r.data?.node?.inventoryHistoryUrl ? "present" : "absent"}`,
        has_data: false,
        recommendation: "PROBE_DEEPER",
        notes: "Shopify exposes inventory history primarily via CSV URL or REST; no clean GraphQL connection. Likely deferred.",
      });
    }
  }

  // subscriptions (4 tables) — probe selling plan groups
  const spgR = await tryQuery<{ sellingPlanGroups: { edges: unknown[]; pageInfo: { hasNextPage: boolean } } }>(
    `query { sellingPlanGroups(first: 5) { edges { node { id name } } pageInfo { hasNextPage } } }`,
  );
  if (spgR.err) {
    results.push({ resource: "selling_plan_groups", category: "subscriptions", approach: "first:5", sample: "ERROR", has_data: false, recommendation: "investigate", notes: spgR.err });
  } else {
    const edges = spgR.data?.sellingPlanGroups?.edges ?? [];
    const has = edges.length > 0;
    for (const t of ["selling_plan_groups", "selling_plans", "subscription_contracts", "subscription_billing_attempts"] as const) {
      results.push({
        resource: t,
        category: "subscriptions",
        approach: "selling plan groups probe",
        sample: `${edges.length} SPG`,
        has_data: has,
        recommendation: has ? "build" : "defer_not_applicable",
      });
    }
  }

  // ─── Output table ────────────────────────────────────────────────────
  console.log("\n═══ Wave 2 probe results ═══\n");
  const widths = {
    resource: 32,
    category: 14,
    approach: 36,
    sample: 38,
    rec: 22,
  };
  console.log(
    `${"resource".padEnd(widths.resource)} │ ${"category".padEnd(widths.category)} │ ${"approach".padEnd(widths.approach)} │ ${"sample".padEnd(widths.sample)} │ ${"recommendation".padEnd(widths.rec)}`,
  );
  console.log("─".repeat(widths.resource + widths.category + widths.approach + widths.sample + widths.rec + 12));
  // Sort: build first, then PROBE_DEEPER, then defer
  const order = (r: string) => r === "build" ? 1 : r === "PROBE_DEEPER" ? 2 : r === "investigate" ? 3 : 4;
  results.sort((a, b) => order(a.recommendation) - order(b.recommendation) || a.resource.localeCompare(b.resource));
  for (const r of results) {
    console.log(
      `${r.resource.padEnd(widths.resource).slice(0, widths.resource)} │ ${(r.category ?? "").padEnd(widths.category).slice(0, widths.category)} │ ${r.approach.padEnd(widths.approach).slice(0, widths.approach)} │ ${String(r.sample).padEnd(widths.sample).slice(0, widths.sample)} │ ${r.recommendation.padEnd(widths.rec)}`,
    );
    if (r.notes) console.log(`  └─ ${r.notes.slice(0, 200)}`);
  }
  console.log("");
  const buildCount = results.filter((r) => r.recommendation === "build").length;
  const deferCount = results.filter((r) => r.recommendation === "defer_not_applicable").length;
  const investigateCount = results.filter((r) => r.recommendation === "investigate" || r.recommendation === "PROBE_DEEPER").length;
  console.log(`Summary: ${buildCount} build, ${deferCount} defer_not_applicable, ${investigateCount} need deeper probe`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("probe-wave-2 failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
