# Shopify Bridge System

Mirrors the **`ourkids1.myshopify.com`** Shopify store into a Supabase
Postgres database, with verifiable completeness and live incremental sync
via webhooks. Single source of truth for all Shopify data — queryable
independently of Shopify, ready for analytics, AI agents, and internal apps.

## What it does

- **Backfill** (one-time per resource): bulk-export every record of every
  exportable resource via Shopify's GraphQL Bulk Operations API → upsert
  into `shopify.<table>` keyed on Shopify's natural GIDs.
- **Live sync** (Phase 3B+): receive `*/create | update | delete | …`
  webhooks → verify HMAC → enqueue → background processor fetches the
  single record + children via GraphQL → upserts through the same code path
  as the bulk runners.
- **Daily catchup cron** (Vercel Cron): paginates `<resource>(query: "updated_at:>=…")`
  for the 4 top-level modules, dispatches each ID through the incremental
  runner. Safety net for missed/dropped webhooks.
- **Audit + reconciliation** scripts compare Supabase row counts against
  Shopify's authoritative counts (`*Count` queries + paginated fallback)
  with ratio-sampling on child tables.

## Architecture

```
Shopify (ourkids1.myshopify.com)
   │
   │ webhooks (HMAC-signed POSTs)         GraphQL Admin API 2026-01
   ▼                                      ▲
┌─────────────────────────────────────────────────────────────┐
│ Vercel: shopify-bridge-system.vercel.app                    │
│                                                             │
│   /api/webhooks/shopify (receiver)  →  webhook_events queue │
│           ↓ fire-and-forget                                 │
│   webhookProcessor  → routes by topic → incremental(id)     │
│           ↓                                                 │
│   /api/cron/catchup-sync (daily 00:00 UTC)                  │
│           ↓                                                 │
│   incrementalRunner  →  applyOne  →  upsert into shopify.*  │
│                                                             │
│   /api/sync/{start,pause,resume,cancel,retry}               │
│   /api/control-room/state  (dashboard)                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
         Supabase Postgres (project lhhuunjxajkxzrggsxjr)
            shopify.*       (84 data tables — 1:1 mirror)
            shopify_sync.*  (12 metadata tables — runs, queue, errors)
```

## Repo layout

```
src/
  app/
    api/
      webhooks/shopify/route.ts     # POST receiver (HMAC verify + enqueue)
      cron/catchup-sync/route.ts    # Vercel Cron daily safety net
      sync/{start,pause,...}/       # Manual sync controls
      control-room/state/           # Dashboard data
      health/                       # GET liveness + connectivity check
    components/                     # Control room UI (React 19)
    page.tsx                        # / → control room
  lib/
    config.ts                       # zod-validated env loader
    logger.ts                       # pino
    shopify/
      client.ts                     # GraphQL client (Admin API 2026-01)
      bulkOperation.ts, pagination.ts, monthChunks.ts
      webhookVerify.ts              # HMAC SHA-256 + timing-safe compare
    supabase/admin.ts               # service-key client (server-only)
  resources/                        # Per-resource modules (transform + extractors)
    types.ts                        # ResourceModule contract
    {orders,customers,products,collections,...}.ts
    orders_pass_{1..4}.ts           # Wave 1/1.5 child backfill passes
    index.ts                        # Registry
  worker/
    orchestrator.ts                 # Multi-resource backfill (fire-and-forget)
    runners/
      bulkRunner.ts                 # Bulk Operations + JSONL ingest + resume
      chunkedMonthlyRunner.ts       # Month-by-month backfill with pacing
      paginatedRunner.ts            # GraphQL paginate (small connections)
      paginatedWithBatchRunner.ts   # GraphQL paginate + batch upsert
      singletonRunner.ts            # One-record resources (shop)
      incrementalRunner.ts          # Phase 3B fetch-one-by-id
      runner.ts                     # applyOne / applyBatch helpers
    upsert.ts, jsonlStreamer.ts, transformContext.ts, errors.ts, retry.ts
    progress.ts                     # sync_runs lifecycle helpers
    webhookProcessor.ts             # Phase 3B queue consumer + topic router
    catchupSync.ts                  # Phase 3B daily safety net
  scripts/                          # Operational + diagnostic scripts (tsx-run)
    verify-connections.ts           # `npm run verify`
    audit-data.ts                   # `npm run audit-data` (DB self-consistency)
    audit-shopify-vs-db.ts          # `npm run audit-shopify-vs-db` (~30 min)
    mock-webhook.ts                 # `npm run mock-webhook` (6-case test)
    register-webhooks.ts            # `npm run register-webhooks` (one-shot)
    sync-resource.ts                # `npm run sync-resource -- <name>`
    {dry-run, dry-run-pass, run-pass-full, run-pass-paginated, ...}.ts
CLAUDE.md                           # Project memory (read first in any session)
RUNBOOK.md                          # Operational playbook
vercel.json                         # framework=nextjs + daily cron
```

## Local development

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env.local
# Edit .env.local with real values for SHOPIFY_ADMIN_API_TOKEN, SUPABASE_*, etc.
# SHOPIFY_WEBHOOK_SECRET + CATCHUP_CRON_SECRET only needed for incremental work.

# 3. Verify connectivity
npm run verify
#   ✓ Shopify OK (Ourkids, Advanced plan)
#   ✓ Supabase OK (108 resources)

# 4. Open the control room
npm run dev
# → http://localhost:3000

# 5. Optional: end-to-end webhook test
npm run mock-webhook    # requires npm run dev running
```

## Operational dashboards

| What | Where |
|------|-------|
| Production app | https://shopify-bridge-system.vercel.app |
| Health check | https://shopify-bridge-system.vercel.app/api/health |
| Control room | https://shopify-bridge-system.vercel.app/ |
| Supabase project | https://supabase.com/dashboard/project/lhhuunjxajkxzrggsxjr |
| Vercel project | https://vercel.com/abaharia-cmds-projects/shopify-bridge-system |
| Vercel cron logs | Vercel dashboard → Project → Logs → filter `/api/cron/` |
| Shopify admin | https://admin.shopify.com/store/ourkids1 |
| Webhook subscriptions | Shopify admin → Settings → Notifications → Webhooks |
| GitHub repo | https://github.com/abaharia-cmd/Shopify-Bridge-System |

## Env vars

See `.env.example`. All env access goes through `src/lib/config.ts` (zod-validated).

| Var | Required | Where |
|-----|----------|-------|
| `SHOPIFY_SHOP_DOMAIN` | always | `ourkids1.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | always | Shopify custom-app token (`shpat_...`) |
| `SHOPIFY_API_VERSION` | always | `2026-01` (bump annually per Shopify cadence) |
| `SUPABASE_URL` | always | `https://lhhuunjxajkxzrggsxjr.supabase.co` |
| `SUPABASE_SECRET_KEY` | always | Service-role key (server-only) |
| `SHOPIFY_WEBHOOK_SECRET` | for live sync | Signing secret from Shopify webhook config |
| `CATCHUP_CRON_SECRET` | for live sync | Bearer secret for `/api/cron/catchup-sync` |
| `LOG_LEVEL` | optional | default `info` |

## Tech stack

- Node.js ≥20, TypeScript strict
- Next.js 16 App Router, React 19
- Supabase JS v2, `@shopify/admin-api-client` (official)
- pino (logging), zod (validation), p-retry (retries)
- Vercel (hosting + cron + env vars)

## Project memory

**Read [`CLAUDE.md`](./CLAUDE.md) at the start of every session.** It tracks the current
phase, every gotcha hit during the build, and the architectural decisions —
this is what makes the project context survive across sessions. Do not skip
it; it has 40+ non-obvious lessons that are not derivable from the code.

## Operations

See [`RUNBOOK.md`](./RUNBOOK.md) for the operational playbook (sync health
checks, webhook backlog recovery, manual catchup, adding a new resource,
known persistent errors, postmortems).
