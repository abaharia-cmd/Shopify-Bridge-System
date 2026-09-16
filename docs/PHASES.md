# Shopify Bridge System — Phase Roadmap

Mirror an entire Shopify store (102 resource types) into Supabase.

## Phase 0 — Foundation
- [x] Repo scaffold (Next.js, TypeScript, Tailwind, App Router)
- [x] Pin Node 20, install Shopify + Supabase clients, logger, validation
- [x] `src/lib/config.ts` (zod-validated env)
- [x] `src/lib/logger.ts` (pino)
- [x] `src/lib/shopify/client.ts` (Admin GraphQL client)
- [x] `src/lib/supabase/admin.ts` (service-role client)
- [x] `GET /api/health` — proves Shopify + Supabase connectivity
- [x] `npm run verify` — CLI parity of /api/health
- [x] Vercel preview deploy

## Phase 1 — Schema (architect-owned)
- [ ] Tables in `shopify` schema for all 102 resource types
- [ ] Generated TypeScript types via `supabase gen types`

## Phase 2 — Initial backfill
- [ ] Bulk Operations API client (jsonl ingest)
- [ ] Per-resource backfill jobs writing into `shopify` tables
- [ ] Progress tracking via `shopify_sync` metadata tables

## Phase 3 — Incremental sync
- [ ] `updated_at` cursors per resource
- [ ] Scheduled cron jobs (vercel.json)

## Phase 4 — Reliability
- [ ] Retry / backoff strategy for 429s and bulk timeouts
- [ ] Dead-letter queue / failed-job inspection

## Phase 5 — Webhooks
- [ ] Register webhooks for real-time deltas
- [ ] HMAC verification, idempotent handlers

## Phase 6 — Auth & access control
- [ ] Lock down `/api/*` routes
- [ ] Dashboard auth (Supabase anon client)

## Phase 7 — Dashboard
- [ ] Sync status UI (per-resource freshness, errors, lag)

## Phase 8 — Hardening
- [ ] Observability (metrics, alerts)
- [ ] Disaster recovery / re-sync runbook
