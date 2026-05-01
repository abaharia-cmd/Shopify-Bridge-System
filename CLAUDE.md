# CLAUDE.md — Shopify Bridge System

> Persistent project memory. Read this at the start of EVERY session before doing anything else. Update it whenever you learn something a future session would need to know.

## Mission
Mirror every record of every exportable resource from the Shopify store `ourkids1.myshopify.com` into a Supabase database, with verifiable completeness and ongoing real-time sync. End goal: a single source of truth for all Shopify data, queryable independently of Shopify, ready for future tools to consume (analytics, AI agents, internal apps).

## Current Phase
**Phase 0 — Foundation** (in progress)

Phase roadmap:
- [x] Supabase project + schemas + sync metadata tables (done by architect)
- [ ] Phase 0: Repo scaffold, clients, health check ← YOU ARE HERE
- [ ] Phase 1: Schema migrations for all `shopify.*` data tables
- [ ] Phase 2: Backfill core (orders, customers, journey)
- [ ] Phase 3: Backfill catalog (products, collections, inventory)
- [ ] Phase 4: Backfill remaining resources
- [ ] Phase 5: Webhook receiver
- [ ] Phase 6: Reconciliation jobs + Vercel cron
- [ ] Phase 7: Control room dashboard UI
- [ ] Phase 8: Verification & sign-off
- [ ] Phase 9 (deferred): Backfill resources blocked on missing scopes

## Roles
- **Architect** = Claude on the web (chat). Owns architecture, schema design, decisions. Source of truth for "what" and "why".
- **You (Claude Code)** = executor. Owns code, file edits, terminal, debugging. Source of truth for "how it actually works in this codebase".
- **User** = the bridge. Pastes architect's specs into Claude Code; pastes Claude Code's results back to architect.

If a spec from the architect seems wrong or incomplete, STOP and surface the concern via the user. Do not improvise architecture.

## Tech Stack
- Node.js 20, TypeScript strict mode
- Next.js 16 App Router (also hosts the dashboard later)
- Supabase JS client v2
- @shopify/admin-api-client (official)
- pino (logging), zod (validation), p-retry (retries)
- Vercel (hosting, cron, env vars)
- GitHub (source)

## Key Environment Facts (DO NOT GUESS)
- Supabase project ID: `lhhuunjxajkxzrggsxjr`
- Supabase region: eu-west-2 (London)
- Supabase schemas: `shopify` (data, populated in Phase 1+) and `shopify_sync` (metadata, already populated). Both exposed in PostgREST.
- Shop domain: `ourkids1.myshopify.com` (token-bound; canonical)
- Shop display name: "Ourkids"
- Shopify plan: Advanced
- Shopify API version pinned: `2026-01`
- 102 resources in `shopify_sync.resource_registry`: 84 active, 18 deferred (blocked on missing scopes — see "Deferred Scopes" below)

## Deferred Scopes (resources we can't sync yet)
The custom app currently lacks:
- `read_content` → blogs, articles, blog_comments, pages, redirects
- `read_metaobjects`, `read_metaobject_definitions` → all custom metaobject data
- `read_companies` → B2B (only matters if used)
- `read_markets` → international markets config (only matters if used)
- `read_store_credit_account_transactions` → store credit (only matters if used)
- `read_cash_tracking` → POS cash drawer (only matters if used)

When a scope is granted, the architect will flip its `status` in `shopify_sync.resource_registry` from `deferred_pending_scope` to `active`, and Phase 9 backfills it. Do not attempt to sync deferred resources.

## Repo Conventions
- Branch per phase: `phase-N-name`. PR into `main`.
- Commit prefix: `[phase-N] short message`.
- One file per Shopify resource type in `src/lib/sync/resources/`.
- All Shopify data tables include a `raw_payload jsonb NOT NULL` column — never drop a field Shopify sent us.
- All `shopify_sync.*` writes go through helpers in `src/lib/supabase/admin.ts` — never raw SQL scattered across files.
- Logging via `pino` only. No `console.log` in production code paths.
- All env access goes through `src/lib/config.ts`. Never read `process.env` directly elsewhere.
- TypeScript: no `any` without a `// reason: ...` comment.

## NEVER (hard rules)
- Never commit `.env*` files (except `.env.example`).
- Never hardcode secrets.
- Never write to Shopify (no mutations). This is a read-only mirror.
- Never delete rows in `shopify.*` tables without a recorded reason in `shopify_sync.audit_log`.
- Never skip HMAC verification on incoming webhooks.
- Never run a backfill or reconciliation against production without the architect's confirmation in the spec.
- Never bump the Shopify API version without architect approval.

## Common Commands
- `npm run dev` — start Next.js locally
- `npm run verify` — run connection verification CLI script
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run typecheck` — TS check

## Gotchas & Lessons Learned
> Append every time you hit a non-obvious issue. Format: `### [date] — short title` then 1–3 lines of context + fix.

### 2026-05-01 — Supabase custom schemas need explicit exposure
PostgREST only auto-exposes `public` and `graphql_public`. Any custom schema (`shopify`, `shopify_sync`) must be added to "Exposed schemas" in Dashboard → Settings → API. Without this, supabase-js returns PGRST106 even though the schema exists in the database.

### 2026-05-01 — Shopify API version pinning
Shopify supports versions for ~12 months then drops them. Today's correct stable pin is `2026-01`. Shopify silently falls back to a supported version if you pin a deprecated one — DO NOT rely on this. Always pin to a currently-supported quarterly release. Set a reminder to bump annually.

### 2026-05-01 — Shop domain ≠ token-bound shop
Shopify auth uses the access token, not the domain in the URL. Initial spec said `ourkids-stores.myshopify.com`; actual shop is `ourkids1.myshopify.com`. Always trust the domain returned by the `shop` query as the source of truth.

## Architectural Decisions
> Record significant decisions here so future sessions don't re-litigate them. Format: `### [date] — decision` then rationale.

### 2026-05-01 — Node.js + TypeScript over Python
Rationale: future tools will be added on top (similar to Odoo Bridge), Next.js dashboard runs in same repo, Vercel cron is native Node, Shopify SDK is TS-first. Single language reduces friction.

### 2026-05-01 — Mirror Shopify schema 1:1 with `raw_payload` column
Rationale: easier debugging, easier reconciliation, never lose new fields. Build analytical views on top in a separate schema later — don't pre-normalize.

### 2026-05-01 — Two schemas: `shopify` (data) and `shopify_sync` (metadata)
Rationale: clean separation between mirrored business data and operational state. Dashboard reads metadata; future apps read data.

## Update Protocol — IMPORTANT

You MUST update this file when:
1. **You hit a gotcha** — Shopify quirk, library bug, environment issue, anything non-obvious. Add to "Gotchas".
2. **You make or learn of a decision** — architectural choice, tradeoff resolved, convention established. Add to "Architectural Decisions".
3. **A phase advances** — update the "Current Phase" line and the roadmap checkboxes.
4. **Conventions change** — keep "Repo Conventions" and "NEVER" lists current.
5. **Environment facts change** — API version bumped, scope granted, schema added, etc.

When updating, include the date and keep entries terse (1–3 lines). This file is for FUTURE YOU. If it's not useful at a glance, it's failing.

At the start of every session, the FIRST thing you do is read this file end-to-end. Acknowledge in your first reply that you've read it.
