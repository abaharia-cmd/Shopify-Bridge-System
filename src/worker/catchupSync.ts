// Catchup sync. Safety net for missed webhooks (Shopify drops, app downtime,
// HMAC mismatch storms). Runs once per day from Vercel Cron.
//
// For each top-level resource (orders, customers, products, collections):
//   1. Read last_successful_catchup.<resource> from shopify_sync.config
//      (falls back to 7 days ago on first run).
//   2. Query Shopify for IDs touched since that timestamp via the
//      `updated_at:>=<iso>` search filter on the resource's connection.
//   3. For each ID, dispatch to that module's `incremental(id)` (which is
//      the same code path webhooks use — single source of truth).
//   4. On success, write last_successful_catchup.<resource> = now() back
//      to config. On failure of any individual record, log + continue;
//      the next catchup will retry it.
//
// The catchup is INTENTIONALLY id-by-id (same shape as webhooks) rather than
// a separate bulk path. Pros: same idempotency/onConflict guarantees as
// webhooks, no parallel maintenance burden. Cons: ~100ms per record (Shopify
// throttle ceiling). For a daily catchup of ~hundreds of records this is fine.
// If the gap is large (e.g. multi-day outage), the orchestrator's regular
// chunked_monthly backfill is the right tool — not this.

import { query } from "../lib/shopify/client";
import { supabaseAdmin } from "../lib/supabase/admin";
import { runIncremental } from "./runners/incrementalRunner";
import { logger } from "../lib/logger";
import { logError } from "./errors";

const log = logger.child({ module: "worker.catchupSync" });

const CATCHUP_CONFIG_KEY = "last_successful_catchup";
const DEFAULT_LOOKBACK_DAYS = 7;
// Per-resource cap. Sized to fit Vercel's 300s function budget across 4
// resources (~70s each). At ~2s per incremental sync (parent + children),
// 200 records ≈ 400s worst case for one resource — but in practice incremental
// is ~1.5s including network, so 200 fits comfortably. If the backlog is
// larger, multiple cron ticks (or manual `curl` invocations) drain it.
const MAX_IDS_PER_RESOURCE = 200;
// Per-resource wall-clock budget. Stops dispatching new incrementals once
// elapsed; the cursor still advances if everything dispatched succeeded.
// Matches the cron's deployment-level maxDuration:300 minus a 30s buffer.
const PER_RESOURCE_BUDGET_MS = 60_000;

// Resources we run catchup for. Matches the webhook topics list — same set
// of "live operational" resources. Catalog (variants, options, media) ride
// with their parent product/collection.
const CATCHUP_RESOURCES = [
  "orders",
  "customers",
  "products",
  "collections",
] as const;
type CatchupResource = (typeof CATCHUP_RESOURCES)[number];

// Per-resource Shopify query field name (the connection on QueryRoot).
const CONNECTION_FIELD: Record<CatchupResource, string> = {
  orders: "orders",
  customers: "customers",
  products: "products",
  collections: "collections",
};

export interface CatchupResult {
  resource: CatchupResource;
  since: string; // ISO timestamp the catchup queried from
  idsFound: number;
  syncedOk: number;
  syncedFailed: number;
  notFound: number;
  errorMessage?: string;
}

export interface CatchupSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  results: CatchupResult[];
  ok: boolean;
}

export async function runCatchupSync(): Promise<CatchupSummary> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  log.info("catchup-sync starting");

  const results: CatchupResult[] = [];
  for (const resource of CATCHUP_RESOURCES) {
    try {
      results.push(await catchupOne(resource));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ resource, err: msg }, "catchup for resource failed");
      results.push({
        resource,
        since: "",
        idsFound: 0,
        syncedOk: 0,
        syncedFailed: 0,
        notFound: 0,
        errorMessage: msg,
      });
      await logError({
        source: "worker.catchupSync",
        resourceName: resource,
        errorMessage: msg,
      });
    }
  }

  const summary: CatchupSummary = {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    results,
    ok: results.every((r) => !r.errorMessage),
  };
  log.info(summary, "catchup-sync done");
  return summary;
}

async function catchupOne(resource: CatchupResource): Promise<CatchupResult> {
  const since = await getLastCatchup(resource);
  log.info({ resource, since }, "catchupOne: fetching ids");

  const ids = await fetchIdsUpdatedSince(resource, since, MAX_IDS_PER_RESOURCE);
  const t0 = Date.now();
  let syncedOk = 0;
  let syncedFailed = 0;
  let notFound = 0;
  let processed = 0;
  let budgetExceeded = false;

  for (const id of ids) {
    if (Date.now() - t0 > PER_RESOURCE_BUDGET_MS) {
      budgetExceeded = true;
      log.warn(
        { resource, processed, remaining: ids.length - processed, elapsedMs: Date.now() - t0 },
        "catchupOne: per-resource budget exceeded, stopping",
      );
      break;
    }
    const r = await runIncremental({
      resourceName: resource,
      id,
      triggeredBy: "cron:catchup-sync",
    });
    processed += 1;
    if (r.notFound) notFound += 1;
    if (r.errorMessage) syncedFailed += 1;
    else syncedOk += 1;
  }

  // Only advance the cursor if every record landed cleanly AND we processed
  // every id we fetched. Budget-cut runs must NOT advance — the unprocessed
  // tail is still pending and the next tick needs to see it.
  if (syncedFailed === 0 && !budgetExceeded && processed === ids.length) {
    await setLastCatchup(resource, new Date());
  } else {
    log.warn(
      { resource, syncedOk, syncedFailed, notFound },
      "catchup had failures — not advancing cursor",
    );
  }

  return {
    resource,
    since,
    idsFound: ids.length,
    syncedOk,
    syncedFailed,
    notFound,
  };
}

async function getLastCatchup(resource: CatchupResource): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("config")
    .select("value")
    .eq("key", CATCHUP_CONFIG_KEY)
    .maybeSingle();
  if (error) {
    log.warn({ err: error.message }, "getLastCatchup: config read failed — using default lookback");
  }
  // reason: jsonb value shape is per-key; here we expect { resource: iso }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = ((data as any)?.value ?? {}) as Record<string, string>;
  if (typeof v[resource] === "string") return v[resource];
  // First run: look back 7 days.
  return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
}

async function setLastCatchup(
  resource: CatchupResource,
  at: Date,
): Promise<void> {
  // Read-modify-write the jsonb. Concurrent writes are unlikely (cron is single
  // execution per Vercel Cron schedule), so a simple R-M-W is fine.
  const { data, error: selErr } = await supabaseAdmin
    .from("config")
    .select("value, description")
    .eq("key", CATCHUP_CONFIG_KEY)
    .maybeSingle();
  if (selErr) {
    log.error({ err: selErr.message }, "setLastCatchup: config read failed");
  }
  // reason: jsonb shape is per-key map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const current = ((data as any)?.value ?? {}) as Record<string, string>;
  current[resource] = at.toISOString();
  const { error: upErr } = await supabaseAdmin
    .from("config")
    .upsert(
      {
        key: CATCHUP_CONFIG_KEY,
        value: current,
        description:
          // reason: jsonb description column is text; default if missing.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((data as any)?.description ??
            "Per-resource last successful catchup-sync ISO timestamp (jsonb map)") as string,
        updated_at: new Date().toISOString(),
        updated_by: "cron:catchup-sync",
      },
      { onConflict: "key" },
    );
  if (upErr) {
    log.error({ err: upErr.message }, "setLastCatchup: config write failed");
    throw new Error(`setLastCatchup ${resource}: ${upErr.message}`);
  }
}

// Paginate Shopify's `<resource>(query: "updated_at:>=<iso>")` connection
// to collect IDs touched since the cursor. Returns at most `cap` ids.
async function fetchIdsUpdatedSince(
  resource: CatchupResource,
  sinceIso: string,
  cap: number,
): Promise<string[]> {
  const fieldName = CONNECTION_FIELD[resource];
  const ids: string[] = [];
  let cursor: string | null = null;
  // Use Shopify's filter syntax — `updated_at:>=<iso>`. Quoting keeps colons
  // inside the timestamp from being parsed as filter syntax.
  const filter = `updated_at:>='${sinceIso}'`;

  while (ids.length < cap) {
    const remaining = cap - ids.length;
    const pageSize = Math.min(250, remaining);
    const data: {
      [k: string]: {
        edges: { node: { id: string } }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await query(
      /* GraphQL */ `
        query CatchupIds($q: String!, $first: Int!, $after: String) {
          ${fieldName}(query: $q, first: $first, after: $after, sortKey: UPDATED_AT) {
            edges {
              node { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { q: filter, first: pageSize, after: cursor },
    );
    const conn = data[fieldName];
    if (!conn) break;
    for (const e of conn.edges) ids.push(e.node.id);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (!cursor) break;
  }

  return ids;
}
