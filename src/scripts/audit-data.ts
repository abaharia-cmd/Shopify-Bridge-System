// Standalone CLI: prints a consistency report of the shopify mirror.
// Run with `npm run audit-data` (uses Node's native --env-file=.env.local).
// Exit code 0 = all consistent, 1 = drift detected.
//
// Sections:
//  1. Counts: real shopify.* row count vs registry total_records_synced (drift)
//  2. Phase flags: backfill_complete resources must have last_backfill_at
//  3. Orphan registry rows: registry resource_name with no matching shopify.* table
//  4. Per-month orders distribution (look for missing/suspiciously thin months)
//  5. Deferred / empty active resources still to fetch
//
// All checks use the Supabase service-role client only — no raw psql, no
// new deps. Per-month orders is one HEAD request per month (~72 requests,
// ~5s); everything else is one request per row.

import { getSupabaseAdmin, supabaseAdmin } from "../lib/supabase/admin";

interface RegistryRow {
  resource_name: string;
  category: string | null;
  status: string;
  phase: string;
  total_records_synced: number | null;
  last_backfill_at: string | null;
  defer_reason: string | null;
}

interface CountRow {
  resource: string;
  category: string;
  status: string;
  phase: string;
  registryCount: number;
  realCount: number | null; // null = no table
  drift: number | null;
}

const dataDb = getSupabaseAdmin("shopify");

async function tableCount(table: string): Promise<number | null> {
  const { count, error } = await dataDb
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    if (/does not exist|not found/i.test(error.message)) return null;
    throw new Error(`count(${table}): ${error.message}`);
  }
  // PostgREST quirk: a missing table returns { count: null, error: null,
  // status: 204 } (silently), while an empty existing table returns
  // { count: 0, status: 200 }. So `count === null` here = missing table.
  if (count === null) return null;
  return count;
}

async function loadRegistry(): Promise<RegistryRow[]> {
  const { data, error } = await supabaseAdmin
    .from("resource_registry")
    .select(
      "resource_name, category, status, phase, total_records_synced, last_backfill_at, defer_reason",
    )
    .neq("resource_name", "_master_backfill")
    .order("resource_name");
  if (error) throw new Error(`load registry: ${error.message}`);
  return (data as RegistryRow[]) ?? [];
}

function fmt(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s.slice(0, width);
  const space = " ".repeat(width - s.length);
  return align === "left" ? s + space : space + s;
}

function printTable(headers: string[], rows: string[][], aligns: ("left" | "right")[] = []): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const hdr = headers.map((h, i) => pad(h, widths[i], aligns[i] ?? "left")).join(" │ ");
  console.log(hdr);
  console.log(sep);
  for (const r of rows) {
    console.log(r.map((c, i) => pad(c ?? "", widths[i], aligns[i] ?? "left")).join(" │ "));
  }
}

async function checkCounts(registry: RegistryRow[]): Promise<{ rows: CountRow[]; drift: number }> {
  const rows: CountRow[] = [];
  let drift = 0;
  for (const r of registry) {
    const real = await tableCount(r.resource_name);
    const reg = r.total_records_synced ?? 0;
    const d = real === null ? null : real - reg;
    if (d !== null && d !== 0) drift += 1;
    rows.push({
      resource: r.resource_name,
      category: r.category ?? "",
      status: r.status,
      phase: r.phase,
      registryCount: reg,
      realCount: real,
      drift: d,
    });
  }
  return { rows, drift };
}

function checkPhaseConsistency(registry: RegistryRow[]): string[] {
  const broken: string[] = [];
  for (const r of registry) {
    if (r.phase === "backfill_complete" && !r.last_backfill_at) {
      broken.push(`${r.resource_name}: phase=backfill_complete but last_backfill_at IS NULL`);
    }
  }
  return broken;
}

async function checkOrphanRegistry(registry: RegistryRow[]): Promise<string[]> {
  // Only flag NON-DEFERRED orphans. Deferred-scope resources (~18) don't have
  // tables in Phase 1 — they're created when the scope is granted. Those are
  // expected. The actionable signal is an active resource with no table.
  // Also skip "pass" categories (e.g. orders_pass) — these are synthetic
  // umbrella rows for Phase 3 multi-table backfill passes and intentionally
  // don't have their own data table; they fill several existing tables.
  const orphans: string[] = [];
  for (const r of registry) {
    if (r.status !== "active") continue;
    if ((r.category ?? "").endsWith("_pass")) continue;
    const real = await tableCount(r.resource_name);
    if (real === null) {
      orphans.push(`${r.resource_name} (status=${r.status}, phase=${r.phase})`);
    }
  }
  return orphans;
}

async function ordersByMonth(): Promise<{ month: string; count: number }[]> {
  // Probe min(created_at) so we know how far back to iterate.
  const { data: minRow } = await dataDb
    .from("orders")
    .select("created_at")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const earliest = (minRow as { created_at: string } | null)?.created_at;
  if (!earliest) return [];

  const months: { month: string; count: number }[] = [];
  const start = new Date(earliest);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  let cursor = start;
  while (cursor <= today) {
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lo = cursor.toISOString();
    const hi = next.toISOString();
    const { count, error } = await dataDb
      .from("orders")
      .select("*", { count: "exact", head: true })
      .gte("created_at", lo)
      .lt("created_at", hi);
    if (error) throw new Error(`orders by month ${lo}: ${error.message}`);
    months.push({
      month: lo.slice(0, 7),
      count: count ?? 0,
    });
    cursor = next;
  }
  return months;
}

function flagSuspiciousMonths(
  months: { month: string; count: number }[],
): { month: string; count: number; flag: string }[] {
  if (months.length < 3) return months.map((m) => ({ ...m, flag: "" }));
  // The current (in-progress) month is partial — never flag it as thin.
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  // Median-based flag: if a month's count is < 25% of the trailing-12-month
  // median (excluding zero-count months), flag it. Crude but catches the
  // 2025-08 class of incident.
  const out: { month: string; count: number; flag: string }[] = [];
  for (let i = 0; i < months.length; i++) {
    const lookback = months.slice(Math.max(0, i - 12), i).filter((m) => m.count > 0);
    if (lookback.length < 3 || months[i].month === currentMonth) {
      out.push({ ...months[i], flag: months[i].month === currentMonth ? "(in progress)" : "" });
      continue;
    }
    const sorted = lookback.map((m) => m.count).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let flag = "";
    if (months[i].count === 0 && i < months.length - 1) flag = "EMPTY (mid-history)";
    else if (months[i].count > 0 && months[i].count < median * 0.25) flag = "thin (<25% median)";
    out.push({ ...months[i], flag });
  }
  return out;
}

async function main(): Promise<number> {
  console.log("\n═══ shopify mirror data audit ═══\n");
  const registry = await loadRegistry();
  console.log(`Registry: ${registry.length} resources (excluding _master_backfill)\n`);

  // 1. Counts + drift
  console.log("─── 1. Row count vs registry counter ───");
  const { rows: countRows, drift } = await checkCounts(registry);
  // Show only rows where real > 0 OR registry > 0 (skip the never-touched).
  const interesting = countRows.filter((r) => r.realCount !== 0 || r.registryCount !== 0);
  printTable(
    ["resource", "category", "phase", "registry", "real", "drift"],
    interesting.map((r) => [
      r.resource,
      r.category,
      r.phase,
      fmt(r.registryCount),
      r.realCount === null ? "(no table)" : fmt(r.realCount),
      r.drift === null ? "—" : r.drift === 0 ? "✓" : (r.drift > 0 ? "+" : "") + fmt(r.drift),
    ]),
    ["left", "left", "left", "right", "right", "right"],
  );
  console.log(
    `\n→ drift summary: ${drift === 0 ? "all counts match ✓" : `${drift} resources have drift`}\n`,
  );

  // 2. Phase consistency
  console.log("─── 2. Phase consistency ───");
  const phaseBroken = checkPhaseConsistency(registry);
  if (phaseBroken.length === 0) {
    console.log("All backfill_complete rows have last_backfill_at ✓\n");
  } else {
    for (const m of phaseBroken) console.log(`✗ ${m}`);
    console.log("");
  }

  // 3. Orphan registry rows
  console.log("─── 3. Orphan registry rows (registry entry, no shopify.* table) ───");
  const orphans = await checkOrphanRegistry(registry);
  if (orphans.length === 0) {
    console.log("None ✓\n");
  } else {
    for (const o of orphans) console.log(`• ${o}`);
    console.log("");
  }

  // 4. Per-month orders distribution
  console.log("─── 4. Orders per month (looking for empty / thin months) ───");
  const months = await ordersByMonth();
  const flagged = flagSuspiciousMonths(months);
  printTable(
    ["month", "orders", "flag"],
    flagged.map((m) => [m.month, fmt(m.count), m.flag]),
    ["left", "right", "left"],
  );
  const suspicious = flagged.filter(
    (m) => m.flag !== "" && m.flag !== "(in progress)",
  ).length;
  console.log(
    `\n→ ${suspicious === 0 ? "no suspicious months ✓" : `${suspicious} month(s) flagged — investigate`}\n`,
  );

  // 5. Active not-started (still to fetch in Phase 3)
  console.log("─── 5. Active resources still to backfill ───");
  const todo = registry.filter(
    (r) => r.status === "active" && r.phase === "not_started",
  );
  if (todo.length === 0) {
    console.log("All active resources have run at least once ✓\n");
  } else {
    printTable(
      ["resource", "category"],
      todo.map((r) => [r.resource_name, r.category ?? ""]),
    );
    console.log(`\n→ ${todo.length} active resources not yet backfilled\n`);
  }

  // 6. Deferred summary
  console.log("─── 6. Deferred resources ───");
  const deferred = registry.filter((r) => r.status.startsWith("deferred"));
  printTable(
    ["resource", "status", "reason"],
    deferred.map((r) => [r.resource_name, r.status, r.defer_reason ?? ""]),
  );
  console.log("");

  const exitCode = drift === 0 && phaseBroken.length === 0 && orphans.length === 0 && suspicious === 0
    ? 0
    : 1;
  console.log(
    exitCode === 0 ? "═══ all consistent ═══\n" : "═══ DRIFT DETECTED — see flags above ═══\n",
  );
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("audit-data failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
