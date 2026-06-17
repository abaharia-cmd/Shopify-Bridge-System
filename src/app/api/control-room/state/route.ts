import { NextResponse } from "next/server";
import { supabaseAdmin, getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceOverviewRow {
  resource_name: string;
  display_name: string;
  category: string;
  status: string;
  phase: string;
  priority: number;
  is_deferred: boolean;
  total_records_synced: number;
  last_backfill_at: string | null;
  last_run_status: string | null;
  last_run_started_at: string | null;
  last_run_completed_at: string | null;
  last_run_records_processed: number | null;
  last_run_records_failed: number | null;
  last_run_current_chunk: number | null;
  last_run_total_chunks: number | null;
  last_run_current_chunk_label: string | null;
  last_run_error_message: string | null;
}

interface ActiveRunRow {
  id: string;
  resource_name: string;
  run_type: string;
  status: string;
  started_at: string;
  heartbeat_at: string | null;
  elapsed_seconds: number;
  seconds_since_heartbeat: number;
  records_processed: number;
  records_inserted: number;
  records_updated: number;
  records_failed: number;
  current_chunk: number | null;
  total_chunks: number | null;
  current_chunk_label: string | null;
  bulk_operation_id: string | null;
}

interface RecentErrorRow {
  id: string;
  occurred_at: string;
  severity: string;
  source: string;
  resource_name: string | null;
  error_code: string | null;
  error_message: string;
  resolved: boolean;
}

interface ShopRow {
  name: string | null;
  myshopify_domain: string | null;
  plan_display_name: string | null;
}

export async function GET() {
  const ts = new Date().toISOString();

  // Run all reads in parallel.
  const [overviewRes, activeRunRes, errorsRes, shopRes, errors24hRes] =
    await Promise.all([
      supabaseAdmin
        .from("v_resource_overview")
        .select(
          "resource_name, display_name, category, status, phase, priority, is_deferred, total_records_synced, last_backfill_at, last_run_status, last_run_started_at, last_run_completed_at, last_run_records_processed, last_run_records_failed, last_run_current_chunk, last_run_total_chunks, last_run_current_chunk_label, last_run_error_message",
        )
        .order("priority", { ascending: true }),
      supabaseAdmin
        .from("v_active_run")
        .select("*")
        .neq("resource_name", "_master_backfill")
        .order("started_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("v_recent_errors")
        .select("id, occurred_at, severity, source, resource_name, error_code, error_message, resolved")
        .order("occurred_at", { ascending: false })
        .limit(20),
      getSupabaseAdmin("shopify")
        .from("shop")
        .select("name, myshopify_domain, plan_display_name")
        .limit(1),
      supabaseAdmin
        .from("error_log")
        .select("*", { count: "exact", head: true })
        .gte("occurred_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    ]);

  const resources = (overviewRes.data ?? []) as unknown as ResourceOverviewRow[];
  const activeRun = ((activeRunRes.data ?? []) as unknown as ActiveRunRow[])[0] ?? null;
  const recentErrors = (errorsRes.data ?? []) as unknown as RecentErrorRow[];
  const shopRow = ((shopRes.data ?? []) as unknown as ShopRow[])[0] ?? null;
  const errors24h = errors24hRes.count ?? 0;

  const totalRecordsSynced = resources.reduce(
    (sum, r) => sum + (Number(r.total_records_synced) || 0),
    0,
  );
  const modelsOk = resources.filter((r) => r.last_run_status === "succeeded").length;
  const modelsFailed = resources.filter(
    (r) => r.last_run_status === "failed" || r.last_run_status === "partial",
  ).length;
  const lastSyncAt = resources
    .map((r) => r.last_backfill_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1) ?? null;

  // Pipeline status — Phase 2 keeps this minimal: any unresolved error in the
  // last 5 minutes degrades the relevant stage.
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recentErrSources = new Set(
    recentErrors
      .filter((e) => new Date(e.occurred_at).getTime() >= fiveMinAgo && !e.resolved)
      .map((e) => e.source),
  );
  const pipeline = {
    shopifyApi:
      [...recentErrSources].some((s) => s.startsWith("shopify") || s.includes("bulk"))
        ? "degraded"
        : "ok",
    transform: [...recentErrSources].some((s) => s.includes("transform") || s.includes("applyOne"))
      ? "degraded"
      : "ok",
    supabase: [...recentErrSources].some((s) => s.includes("supabase") || s.includes("upsert"))
      ? "degraded"
      : "ok",
  };

  return NextResponse.json({
    timestamp: ts,
    shop: shopRow,
    kpis: {
      lastSyncAt,
      totalRecordsSynced,
      modelsOk,
      modelsFailed,
      errors24h,
    },
    pipeline,
    resources,
    activeRun,
    recentErrors,
  });
}
