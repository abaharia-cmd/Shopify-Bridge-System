# CLAUDE.md — Shopify Bridge System

> Persistent project memory. Read this at the start of EVERY session before doing anything else. Update it whenever you learn something a future session would need to know.

## Mission
Mirror every record of every exportable resource from the Shopify store `ourkids1.myshopify.com` into a Supabase database, with verifiable completeness and ongoing real-time sync. End goal: a single source of truth for all Shopify data, queryable independently of Shopify, ready for future tools to consume (analytics, AI agents, internal apps).

## Current Phase
**Phase 3C complete — system is live in production** (2026-05-09). Production URL `https://shopify-bridge-system.vercel.app` (Vercel), 18 webhook subscriptions registered with Shopify, catchup-sync cron scheduled at 00:00 UTC daily, end-to-end smoke test traced cleanly (product edit → webhook → upsert → mirror). `npm run audit-data` exit 0, audit-shopify-vs-db unchanged.

Pre-Phase-3C state (2026-05-08): **Phase 3B code-complete** — webhook receiver + HMAC verifier + queue + processor + incremental runner + `incremental(id)` & `softDelete(id)` on 4 top-level modules (orders, customers, products, collections) + daily catchup-sync cron + mock-webhook test harness. `npm run build` + `npx tsc --noEmit` + `npm run lint` clean.

Pre-Phase-3B state (2026-05-07): **Wave 3 Phase A complete** — Shopify-vs-DB completeness audit landed 12 ✅ matches, 3 ⚠️ tolerance drifts (all <0.13%), 9 🛑 flags (all explained: live-store growth, real-vs-bulk count semantics, ratio-sampling small-n noise on rare-event tables). 20/20 spot-checks clean. Architect signed off.

Pre-Phase-3-Wave-3 state (2026-05-06): **Phase 3 Wave 2 complete** — long-tail backfill of 13 resources (~333K new rows). All 22 originally-not_started active resources are now resolved (12 backfilled, 10 deferred with reason).

Phase roadmap (revised 2026-05-01 per architect's Phase 2 brief):
- [x] Supabase project + schemas + sync metadata tables (architect)
- [x] Phase 0: Repo scaffold, clients, health check
- [x] Phase 1: Schema migrations for all `shopify.*` data tables (84 tables, 12 metadata, 4 views, 104 FKs, 401 indexes — architect)
- [x] Phase 2: Worker engine (4 runners) + 5 resource modules + control room UI + 6 API routes
- [x] Phase 2.5: Registry truth-up, counter-bug fix, customer FK backfill, bulkRunner JSONL byte-offset resume + per-batch isolation, error_log auto-cleanup, `npm run audit-data` (2026-05-03)
- [x] Phase 3 Wave 1: 12 deferred order-child tables filled via 3 chunked-monthly passes (orders_pass_1/2/3) + grandchild groupByParent extension + dedupeByKey surrogate-key fix (2026-05-04 — 2026-05-05)
- [x] Phase 3 Wave 1.5: 2 connection-in-list children (`order_fulfillment_line_items`, `order_refund_line_items`) filled via paginated GraphQL + new `runPaginatedWithBatch` runner — 299K rows, 134.8 min, ~17 orders/sec (paced at 20/sec target, no throttle warnings) (2026-05-06)
- [x] Phase 3 Wave 2: long-tail backfill — discount_codes (149,809), files (110,937), product_translations (16,313), draft_orders + line items (10K + 30K), abandoned_checkouts + line items (4.6K + 7.9K), collection_rules (2,722), collection_translations (422), customer_segments (46), navigation_menus (6), automatic_discounts (3), translations (2). 10 deferred. Added `paginated_batch` strategy + `applyOne` skipParentUpsert fix. (2026-05-06)
- [x] Phase 3 Wave 3 (hardening): Cross-module CASCADE FKs flipped RESTRICT in 2 migrations + 4 module extractors flipped from `replaceByParent` → upsert-only (2026-05-07)
- [x] Wave 3 Phase A: Shopify-vs-DB completeness audit (`npm run audit-shopify-vs-db`) — direct counts + paginated fallback for AT_LEAST + ratio sampling for child tables + 5×4 spot checks (2026-05-07)
- [x] Phase 3B: Incremental sync infrastructure — code-complete, not deployed (2026-05-08)
- [x] Phase 3C: Deployed to Vercel, 18 webhooks registered, end-to-end smoke test passed (2026-05-09)
- [ ] Phase 4: Hardened webhooks (signed URLs, replay protection, HMAC rotation)
- [ ] Phase 5: Reconciliation cron (daily existence + weekly content) — built on top of incrementalRunner
- [ ] Phase 6: Auth + locked-down API (the control room is unauthenticated today)
- [ ] Phase 7: Verification & sign-off
- [ ] Phase 9 (deferred): Resources blocked on missing scopes (see "Deferred Scopes")

### Phase 2 deliverables (locations, shop verified end-to-end as of 2026-05-01)
- `src/resources/{shop,locations,sales_channels,customers,products,orders}.ts` — 5 prod resource modules + 1 pre-flight (sales_channels for product_publications FK)
- `src/worker/orchestrator.ts` — fire-and-forget multi-resource backfill, pause/resume/cancel/retry, master sync_run row, heartbeat
- `src/worker/runners/{singletonRunner,paginatedRunner,bulkRunner,chunkedMonthlyRunner}.ts`
- `src/worker/{progress,errors,retry,upsert,transformContext,jsonlStreamer}.ts` — primitives
- `src/lib/shopify/{bulkOperation,pagination,monthChunks}.ts` — Shopify helpers
- `src/lib/initBoot.ts` + `src/instrumentation.ts` — stale-run cleanup at server boot
- `src/app/api/sync/{start,pause,resume,cancel,retry}/route.ts` + `src/app/api/control-room/state/route.ts` — 6 API routes
- `src/app/components/{ControlRoom,KpiCards,Pipeline,ResourceTable,ActiveRunPanel,ErrorLog,StatusBadge,ProgressBar}.tsx` — 8 components
- `src/scripts/dry-run.ts` (`npm run dry-run`) — exercises shop+locations runners directly
- `_master_backfill` synthetic resource auto-registered by orchestrator (see Gotcha)
- `npm run build` clean, `npm run lint` clean, `npx tsc --noEmit` clean
- Dry-run: shop (1 row, 847ms, succeeded), locations (7 rows, 2207ms, succeeded)

### Phase 2 deferrals (planned for Phase 3)
- Orders nested-of-nested child tables: `order_line_item_tax_lines`, `order_line_item_discount_allocations`, `order_line_item_duties`, `order_refund_line_items`, `order_fulfillment_line_items`, `order_fulfillment_events`, `order_returns`, `order_return_line_items`, `order_risks`, `order_agreements`, `order_client_details`, `order_shipping_lines`, `order_tax_lines`, `order_discount_applications`, `order_discount_codes`, `order_metafields`, `order_staff_attribution`. The full payload IS captured in `orders.raw_payload`, so these can be backfilled via a JSON expansion pass in Phase 3 without re-fetching.
- `customers.default_address_id` and `customers.last_order_id` set to null on first run (FKs deferred per spec; will be filled in via reconciliation after orders sync).
- Variant-level metafields (`product_variant_metafields`): had to drop from products bulk query to stay under Shopify's 5-connection limit. Re-fetch via separate paginated/incremental sync in Phase 3.
- Several scope-restricted Order fields stripped (risk.recommendation, staffMember, merchantBusinessEntity, merchantOfRecordApp) — captured in `raw_payload` but not promoted to columns. Need additional Shopify scopes (`read_order_risks`, `read_staff`) to enable.

### Phase 2 — first backfill numbers (2026-05-02, ~7 hours total)
- shop=1 · locations=7 · sales_channels=10
- customers=118,213 + addresses=142,282 + metafields=82,347 (16.9 min, 0 failed)
- products=30,749 + variants=61,598 + media=87,667 + publications=217,363 + metafields=94,313 + options=36,158 + option_values=62,155 (200 metafields lost to one transient batch)
- orders=124,181 + line_items=290,284 + transactions=157,452 + fulfillments=150,028 + refunds=20,049 + journeys=124,181 + visits=448,377 (243 min, 281 nested rows lost + ~5-7K orders for 2025-08 chunk lost to Shopify-side fetch failure mid-poll)
- Re-run orders to fill gaps: `curl -X POST http://localhost:3000/api/sync/retry -d '{"resourceName":"orders"}'` (~30 min, idempotent, would close all ~7K gap)
- 2025-08 architect re-audit (2026-05-03): real count is 6,070 — fits seasonal trend, gap-fill never needed. The "lost" estimate from the v6 run was wrong.

### Phase 2.5 deliverables (2026-05-03)
- Registry truth-up via SQL: 27 counters corrected, `orders` + `collections` flipped to `backfill_complete`, `checkouts` marked `deferred_not_applicable`
- Counter-bug fix in [src/worker/orchestrator.ts](src/worker/orchestrator.ts) `touchResourceRegistry()` — reads real `count(*)` from the data table instead of `prior + result.recordsInserted` (the old `prior + recordsInserted` was double-counting on resume-bulk / retry, which is why `products` showed 61,298 ≈ 2× of 30,749)
- Customer deferred FK backfill via SQL: `customers.default_address_id` filled for 102,015 / 118,213; `customers.last_order_id` filled for 83,049 / 118,213 (rest legitimately have no addresses / orders)
- bulkRunner now resumable mid-stream: [src/worker/jsonlStreamer.ts](src/worker/jsonlStreamer.ts) tracks UTF-8 byte position per line, persists `metadata.jsonl_offset` to `sync_runs` after every flushed batch, fetch wrapped in `withRetry`, heartbeat every 100 lines. `resumeBulk()` reads the offset of the previous run touching the same bulk op and issues a `Range: bytes=N-` request to skip ahead — `kill -9` mid-batch followed by `resume-bulk` picks up at next-line, no re-processing
- Per-batch isolation in [src/worker/upsert.ts](src/worker/upsert.ts) `upsertBatch()` — sub-batch failures now log to `error_log` and increment `failed`, never throw out of the loop. Single PostgREST hiccup no longer kills the whole run downstream
- error_log auto-cleanup: 11 stale entries (resources with later succeeded sync_runs) marked resolved
- `npm run audit-data` ([src/scripts/audit-data.ts](src/scripts/audit-data.ts)): row count vs registry drift, phase consistency, orphan registry rows, per-month orders distribution with thin/empty flagging, not-started + deferred lists. Exit 0/1.

### Phase 3 Wave 1 deliverables (2026-05-04 — 2026-05-05) — 645,901 new rows, 12 of 18 deferred order-child tables filled
Modules: [src/resources/orders_pass_{1,2,3}.ts](src/resources/) — 3 chunked-monthly pass modules using `skipParentUpsert` flag to fill child tables without rewriting the parent `orders` table (already complete from Phase 2).
- **Pass 1** (line item children + order LISTs + scalars): order_line_item_tax_lines (114,543), order_line_item_discount_allocations (41,267), order_line_item_duties (0), order_tax_lines (44,874), order_discount_codes (12,771), order_client_details (131,156). 2 connections (orders + lineItems). 65 min.
- **Pass 2** (order-level connections): order_shipping_lines (127,114), order_discount_applications (15,557 — 85% DiscountCode / 11% Manual / 4% Automatic), order_metafields (51). 4 connections. 65 min.
- **Pass 3** (agreements + returns + return_line_items): order_agreements (155,777 — OrderAgreement 1:1 with orders), order_returns (1,132), order_return_line_items (1,659). 4 connections including grandchild (Return.returnLineItems nested under Order.returns). 73 min.
- **Tooling**: `npm run probe-order-schema` ([src/scripts/probe-order-schema.ts](src/scripts/probe-order-schema.ts)) — GraphQL introspection for connection-vs-list classification. `npm run dry-run-pass -- <name> <YYYY-MM>` ([src/scripts/dry-run-pass.ts](src/scripts/dry-run-pass.ts)) — single-month verification before full backfill. `npm run run-pass-full -- <name>` ([src/scripts/run-pass-full.ts](src/scripts/run-pass-full.ts)) — full multi-month backfill with progress telemetry; works for any chunked_monthly module.
- **Infra fixes that unlocked Wave 1** (all called out in Gotchas below):
  1. `dedupeByKey` pass-through for rows missing the conflict key (was collapsing surrogate-UUID rows to one per batch — 99% silent loss)
  2. `order_discount_codes` + `order_discount_applications` + `order_metafields` need explicit `onConflict` for their composite UNIQUE constraints (Shopify occasionally returns dups)
  3. `groupByParent` extended for nested CONNECTION-inside-CONNECTION (grandchildren) — required for Pass 3's `Return.returnLineItems`. Maintains a per-root `Map<id, ParentWithChildren>` so descendants attach to the right ancestor instead of being dropped as orphans.
  4. `chunkedMonthlyRunner` accepts `dateRange: {fromISO, toISO}` for dry-runs and partial-range re-runs.
  5. `ResourceModule.skipParentUpsert: true` skips parent table writes; `applyBatch` honors it. Lets passes fill children of an already-complete parent without rewriting 131K rows.
- **Synthetic registry rows**: each pass has a registry entry with `category='orders_pass'`. The `audit-data` script's orphan check skips this category since they intentionally have no data table of their own.
- **6 of 18 deferred** (all `deferred_not_applicable` or `deferred_pending_scope`): order_risks + order_edits (Order.risks/edits removed in 2026-01), order_staff_attribution (needs read_staff scope), order_fulfillment_line_items + order_refund_line_items (structural — Wave 1.5 REST workaround), order_fulfillment_events (architect decision: courier-side data, Ourkids uses 3PL with no reliable Shopify status updates).

### Phase 3 Wave 1.5 deliverables (2026-05-06) — 299,008 new rows, 2 of 6 deferred Wave-1 tables filled via paginated GraphQL
The two structurally-blocked tables (Fulfillment.fulfillmentLineItems / Refund.refundLineItems are CONNECTIONs nested inside Order.fulfillments / Order.refunds LISTs — bulk forbids connection-in-list, but **regular paginated GraphQL allows it**).
- **New runner**: [src/worker/runners/paginatedWithBatchRunner.ts](src/worker/runners/paginatedWithBatchRunner.ts) — iterates a root connection (orders) via paginated GraphQL with `first:50` per request, buffers 200 parents, calls `applyBatch`. Pacing-aware: targets ~20 orders/sec, sleeps to enforce; tracks `extensions.cost.throttleStatus.currentlyAvailable` per response and (a) sleeps 5s extra if it drops below 1,000, (b) throws if it ever hits 0. Monthly chunking inside the runner so progress is trackable per-month and chunk-level failures are isolated.
- **New module**: [src/resources/orders_pass_4.ts](src/resources/orders_pass_4.ts) — one module, two child extractors. `skipParentUpsert: true`. Both target tables: natural Shopify GID PKs, no extra UNIQUE — default `onConflict: id` is correct.
- **New CLI**: `npm run run-pass-paginated -- <name>` ([src/scripts/run-pass-paginated.ts](src/scripts/run-pass-paginated.ts)) — supports `--dry-run YYYY-MM` shortcut for single-month verification.
- **Tables filled**:
  - `order_fulfillment_line_items`: 266,703 rows (~2.0 per fulfillment — Ourkids' real per-package item count)
  - `order_refund_line_items`: 32,305 rows (~1.5 per refund — typical partial-refund pattern)
- **Wall time**: 134.8 min sequential for 137,551 orders processed = **~17 orders/sec sustained** (under target 20, pacing self-regulated). 0 throttle warnings, 0 backoffs, throttle budget never approached the 1,000 floor. **Paginated GraphQL was the right call** — the REST estimate was 12-18 hrs; paginated came in at 2.25 hrs, ~7× faster.
- **Records "failed"**: 2,753 — all from the 2026-05 trailing chunk (the same staleness pattern Wave 1 hit; orders Shopify created since our last orders parent sync). Auto-resolved in error_log; will fill once orders gets its next incremental.
- **0 FK orphans** across all 4 checks (FLI vs orders, FLI vs fulfillments, RLI vs orders, RLI vs refunds).
- **`order_fulfillment_events` stays `deferred_not_applicable`** per architect decision (courier-side, no analytical value via Shopify).

### Phase 3 Wave 2 deliverables (2026-05-06) — ~333K new rows across 13 resources, 10 deferred
13 modules built: `discount_codes`, `automatic_discounts`, `draft_orders` (+ line items), `abandoned_checkouts` (+ line items), `customer_segments`, `collection_rules`, `files`, `navigation_menus`, `product_translations`, `collection_translations`, `translations`. Plus `abandoned_checkout_line_items` registry seed (Phase 1 schema migration created the table but the seed missed the row).
- New runner option: `paginated_batch` strategy ([src/worker/runners/paginatedWithBatchRunner.ts](src/worker/runners/paginatedWithBatchRunner.ts)) extended for non-chunked top-level connections — used by `discount_codes`, `files`, 3 translation modules. 100× faster than `paginated`/applyOne for high-cardinality resources (proven empirically on discount_codes: 0.7 records/sec via applyOne → 70 records/sec via paginated_batch).
- New CLI: `npm run sync-resource -- <name>` ([src/scripts/sync-resource.ts](src/scripts/sync-resource.ts)) — generic single-resource invocation that picks the right runner from `module.syncStrategy`.
- Probe script: `npm run probe-wave-2` ([src/scripts/probe-wave-2.ts](src/scripts/probe-wave-2.ts)) — surveyed all 22 not_started resources to determine build-vs-defer; saved hours of speculative module-building.
- **10 deferred** (per architect approval after probe): `marketing_activities` (0 activities); `product_variant_metafields` (0/20 sample); 4 subscription tables (0 selling_plan_groups); `customer_payment_methods` (deferred_pending_scope: needs read_customer_payment_methods); `inventory_movements` (REST/CSV only, no GraphQL connection); `events_audit_log` (Shopify-side Internal Server Error on QueryRoot.events in 2026-01); `customer_segment_members` (1.4M membership tuples are derivable on demand from each segment's `query` field — kept the 46 segment definitions only).
- **Wave 2 chain incident & recovery**: First chain run had 3 schema errors (Menu.itemsCount removed, DraftOrder.useCustomerDefaultAddress removed, AbandonedCheckout.taxExempt removed), 3 access-denied errors on `Translation.market` (needs read_markets scope), and corrupted all 1,000 collections rows because `applyOne` didn't honor `skipParentUpsert` (only `applyBatch` did). Fix: applyOne now honors the flag. Recovery: re-fetched collections via existing module (raw_payload restored). Side effect: `collection_products` row count dropped from 54,847 → 16,232 during the bulk re-fetch — surfaced as Wave 2 finding for architect investigation (could be Shopify smart-collection ruleSet recompute, or a per-collection products pagination limit in the bulk query).

### Phase 3B deliverables (2026-05-08) — code-complete, not deployed
End-to-end incremental sync infrastructure for live updates via webhooks + scheduled catchup safety net. Lands the same data path used by webhook events, the catchup cron, and (later) the reconciliation cron — single source of truth for "fetch one record by id and upsert it".
- **HMAC verifier** ([src/lib/shopify/webhookVerify.ts](src/lib/shopify/webhookVerify.ts)) — `verifyWebhookHmac(rawBody, headerHmac, secret)` using `crypto.timingSafeEqual` over HMAC-SHA256(secret, exactRequestBytes). Empty secret → false (refuses to silently accept). Length-mismatched buffers → false (timingSafeEqual would throw).
- **Webhook receiver** ([src/app/api/webhooks/shopify/route.ts](src/app/api/webhooks/shopify/route.ts)) — POST endpoint. Reads raw body via `req.text()` BEFORE JSON parse, verifies HMAC, parses JSON, inserts into `shopify_sync.webhook_events` with `status='received'`. Idempotent on `UNIQUE(shopify_webhook_id)` — duplicate Shopify retries are 200 deduped. Fires `processWebhookQueue()` fire-and-forget after enqueue (non-blocking, returns 200 well within Shopify's 5s budget). Invalid HMAC → 401 with no DB write.
- **Webhook processor** ([src/worker/webhookProcessor.ts](src/worker/webhookProcessor.ts)) — `processWebhookQueue()` claims queued events via optimistic UPDATE (status='received' → 'processing' atomically; only one caller wins). Routes by topic root: orders/customers/products/collections → `incremental(id)`; refunds/fulfillments → extract parent order GID from payload (admin_graphql_api_order_id, order.admin_graphql_api_id, or order_id) → `orders.incremental(orderGid)`; */delete → `softDelete(id)`; inventory_levels/update → noted but unimplemented (Phase 3C). 3 retries with 60s back-off, then dead_letter + dead_letter_queue insert.
- **Incremental runner** ([src/worker/runners/incrementalRunner.ts](src/worker/runners/incrementalRunner.ts)) — `runIncremental({resourceName, id, triggeredBy})` looks up the module, calls `module.incremental(id)`, applies through the existing `applyOne` path. **Critical**: `skipReplaceDeletes: false` so replaceByParent extractors fire (children removed in Shopify must propagate). Wraps fetch in withRetry. Creates a `sync_runs` row with `run_type='incremental'`. Returns 1×IncrementalResult with notFound flag (→ softDelete dispatched if module defines one).
- **Module-level `incremental(id)` + `softDelete(id)` on 4 modules**: `customers`, `products`, `collections`, `orders`. Each exposes a focused single-record GraphQL query that mirrors the bulk QUERY's per-record body, with explicit `first: N` on connections (lineItems / customerJourneySummary.moments / variants / media / metafields / products / publications / etc.). LIST fields (transactions, fulfillments, refunds in orders; addresses in customers; options in products) come back inline as in bulk — no change.
- **Refunds + fulfillments topics: NO standalone module.** They are children of orders; the processor extracts parent order GID from the webhook payload and dispatches to `orders.incremental` — which re-fetches the parent + ALL children (line items, transactions, fulfillments, refunds, journey, visits) and upserts them. Net effect: the new refund/fulfillment row lands as a child upsert via the same code path the parent uses.
- **Shape-agnostic extractors** ([src/resources/products.ts](src/resources/products.ts) + [src/resources/collections.ts](src/resources/collections.ts)): added `variantsOf` / `mediaOf` / `metafieldsOf` / `productsOf` / `publicationsOf` helpers that try `_children` (bulk JSONL flatten) first, fall back to `raw.<field>.edges[].node` (regular GraphQL). Required because the same `transform` and `childExtractors` now run from BOTH `bulkRunner.applyBatch` AND `runIncremental.applyOne`.
- **Catchup-sync cron** ([src/worker/catchupSync.ts](src/worker/catchupSync.ts) + [src/app/api/cron/catchup-sync/route.ts](src/app/api/cron/catchup-sync/route.ts)) — daily safety net. Reads `shopify_sync.config.last_successful_catchup` (jsonb map: `{orders, customers, products, collections}` → ISO timestamp; defaults to 7 days ago on first run). For each resource, paginates `<resource>(query: "updated_at:>='<iso>'", sortKey: UPDATED_AT)` collecting GIDs, dispatches each through `runIncremental`. Cursor only advances if every record landed cleanly (a single failure leaves the cursor unchanged so next cron retries from the same point). Cap of 5,000 ids per resource per run. Auth: `Authorization: Bearer <CATCHUP_CRON_SECRET>` (Vercel Cron format) or `x-cron-secret` header (local). No secret configured = local-dev mode (allows). The cron also drains the webhook queue first via `processWebhookQueue({maxEvents:200})` so a missed webhook can't outlive a single cron tick. `maxDuration: 300` so Vercel doesn't 504 mid-pull.
- **Mock-webhook test harness** ([src/scripts/mock-webhook.ts](src/scripts/mock-webhook.ts), `npm run mock-webhook`) — POSTs 6 synthetic webhooks at `http://localhost:3000/api/webhooks/shopify` with HMAC computed from `SHOPIFY_WEBHOOK_SECRET`. Each case: builds a payload that references a REAL gid from Supabase (most-recent by synced_at), asserts the receiver returns 200, polls `webhook_events` until status terminates, asserts the expected outcome. Cases: orders/updated, customers/update, products/update, collections/update, refunds/create (verifies parent-order routing), invalid-HMAC (asserts 401 + no row enqueued).
- **New env vars** ([src/lib/config.ts](src/lib/config.ts)): `SHOPIFY_WEBHOOK_SECRET` (signing secret from Shopify webhook config), `CATCHUP_CRON_SECRET` (Vercel Cron auth). Both optional in dev so existing scripts keep working without them set; required at runtime by the receiver / cron endpoint, which 401 if missing.
- **Build hygiene**: `npm run build` clean, `npx tsc --noEmit` clean, `npm run lint` clean (no new errors; pre-existing warnings in files.ts and probe-wave-2.ts unchanged).
- **NOT YET DEPLOYED, NOT registered with Shopify.** Phase 3C will: (1) run mock-webhook locally to confirm 6/6 pass, (2) register the 14 webhooks in Shopify Admin (orders/{create,updated,cancelled,fulfilled,partially_fulfilled}, customers/{create,update,delete}, products/{create,update,delete}, collections/{create,update,delete}, refunds/create, fulfillments/{create,update}, inventory_levels/update), (3) deploy to Vercel with secrets, (4) configure vercel.json cron to hit `/api/cron/catchup-sync` daily at 03:00 Cairo, (5) monitor 24h.

### Phase 3C deliverables (2026-05-09) — system live in production
- **Production deploy**: `https://shopify-bridge-system.vercel.app` on Vercel project `prj_8FOeUsqheKbAtLKeTvJb2pH8YESp`. Framework forced to `nextjs` in `vercel.json` (the project was created with preset `Other`, which 404'd every route despite the build registering them — see Gotcha 2026-05-08). Stable prod alias is the webhook callback URL.
- **18 Shopify webhook subscriptions registered** via [src/scripts/register-webhooks.ts](src/scripts/register-webhooks.ts) (`npm run register-webhooks`): orders/{create,updated,cancelled,fulfilled,partially_fulfilled}, customers/{create,update,delete}, products/{create,update,delete}, collections/{create,update,delete}, inventory_levels/update, refunds/create, fulfillments/{create,update}. Idempotent — re-runs report `kept` for already-subscribed topics.
- **Vercel Cron**: `/api/cron/catchup-sync` scheduled at `0 0 * * *` (00:00 UTC = 03:00 Cairo winter / 02:00 summer). Auth via `Authorization: Bearer <CATCHUP_CRON_SECRET>`.
- **End-to-end smoke test passed**: user edited a product in Shopify admin → webhook arrived at receiver in <5s → HMAC verified → enqueued in `webhook_events` → processor fetched product+children via `module.incremental(id)` → upserted into `shopify.products` → `synced_at` updated. Trace confirmed for 3 sample products with `processing_duration_ms` 2-12s under normal load.
- **Receiver tuning**: added `export const maxDuration = 300` to [src/app/api/webhooks/shopify/route.ts](src/app/api/webhooks/shopify/route.ts) so the fire-and-forget processor has full Vercel function budget to drain bursts (default 60s killed it mid-drain when Shopify replayed yesterday's failed webhooks). `maxEvents: 100` per processor invocation matches the budget at ~2s per webhook.
- **Catchup tuning**: lowered `MAX_IDS_PER_RESOURCE` from 5,000 to 200, added `PER_RESOURCE_BUDGET_MS = 60_000` so the cron fits in Vercel's 300s function limit even with a backlog (4 resources × 60s = 240s + drain time). Cursor advances only on full-clean run that processed every fetched id.
- **HMAC bug discovered + fixed**: `SHOPIFY_WEBHOOK_SECRET` must be the custom app's **API secret key** (a.k.a. "client secret"), found at Shopify Admin → Settings → Apps and sales channels → Develop apps → (the app whose `shpat_...` token is `SHOPIFY_ADMIN_API_TOKEN`) → API credentials tab → "API key and secret key" section → "API secret key". The page even confirms: "Use your client secret to verify incoming webhooks." A random hex value (or anything else) makes every real webhook 401 because Shopify signs with this app-level secret. The mock-webhook test never caught this because both sides read the same `.env.local` value — only real Shopify webhooks expose the mismatch.
- **Vercel env scope gotcha**: `vercel env add NAME production` only sets the Production scope. Preview deployments (auto-triggered by `git push` to non-main branches) need Preview scope too — added with `vercel env add NAME preview <branch> --value <v> --yes --force`. CLI v53 requires the `<branch>` argument even when documenting an "all branches" form.

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
- Never use `TRUNCATE ... CASCADE` on any `shopify.*` table. Use `TRUNCATE` without `CASCADE` — it will error on FK dependents, which is the safe behavior. For dry-run cleanup, only `DELETE` rows by date range or by `sync_run_id`, never wipe whole tables. Always check FK dependents via `information_schema.referential_constraints` before any bulk delete. (Incident 2026-05-04: a Pass 3 dry-run wipe `TRUNCATE shopify.order_returns ... CASCADE` propagated through `order_refunds.return_id → order_returns.id` and silently deleted 21,331 refund rows from Phase 2. Recovery required a 3-hour orders re-run.)
- Never use `replaceByParent: true` on a child whose target table has cross-module CASCADE FKs incoming from tables this module doesn't manage. Use upsert-only instead — natural Shopify GIDs make id-based upsert idempotent. The "remove rows Shopify deleted" semantics will be handled by webhook events in Phase 4 incremental sync, or a periodic reconciliation pass. (Incident 2026-05-07: products refresh's `product_variants` extractor used `replaceByParent: true` → the resulting variant DELETEs CASCADE-wiped 444,525 rows in `inventory_items` + `inventory_levels` (different module). Schema migration `restrict_cross_module_cascades` flipped those FKs to RESTRICT to make this class of bug fail loudly. Module fix: `products.ts` `variantsExtractor` is now upsert-only. Audit other modules before re-running them — a list of remaining latent risks is in the 2026-05-07 postmortem.)

## Common Commands
- `npm run dev` — start Next.js locally (control room at /, opens with real Supabase data)
- `npm run verify` — health check Shopify + Supabase connectivity
- `npm run dry-run` — exercise shop + locations runners end-to-end (Phase 2 smoke test)
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run typecheck` — TS check
- `curl -X POST http://localhost:3000/api/sync/start` — trigger backfill (or use UI button)
- `curl -X POST http://localhost:3000/api/sync/pause|resume|cancel`
- `npm run mock-webhook` — Phase 3B: end-to-end test of webhook receiver+processor (requires `npm run dev` running and SHOPIFY_WEBHOOK_SECRET set)
- `npm run audit-shopify-vs-db` — Wave 3 Phase A: counts every Shopify resource against the DB (~30 min on Ourkids)

## Gotchas & Lessons Learned
> Append every time you hit a non-obvious issue. Format: `### [date] — short title` then 1–3 lines of context + fix.

### 2026-05-01 — Supabase custom schemas need explicit exposure
PostgREST only auto-exposes `public` and `graphql_public`. Any custom schema (`shopify`, `shopify_sync`) must be added to "Exposed schemas" in Dashboard → Settings → API. Without this, supabase-js returns PGRST106 even though the schema exists in the database.

### 2026-05-01 — Shopify API version pinning
Shopify supports versions for ~12 months then drops them. Today's correct stable pin is `2026-01`. Shopify silently falls back to a supported version if you pin a deprecated one — DO NOT rely on this. Always pin to a currently-supported quarterly release. Set a reminder to bump annually.

### 2026-05-01 — Shop domain ≠ token-bound shop
Shopify auth uses the access token, not the domain in the URL. Initial spec said `ourkids-stores.myshopify.com`; actual shop is `ourkids1.myshopify.com`. Always trust the domain returned by the `shop` query as the source of truth.

### 2026-05-01 — sync_runs.resource_name FK requires a synthetic master row
`shopify_sync.sync_runs.resource_name` has a strict FK to `resource_registry.resource_name`. The architect's spec called for inserting a master row with `resource_name = '_master_backfill'` — this requires a matching registry row first. The orchestrator now upserts `_master_backfill` (category='meta', priority=0) on first start via `ensureMasterResource()`. Idempotent.

### 2026-05-01 — sync_runs.duration_ms is a generated column
Phase 1 made `duration_ms` GENERATED ALWAYS (computed from `completed_at - started_at`). Writing to it errors with `column "duration_ms" can only be updated to DEFAULT`. `finishRun()` now writes only `completed_at` + `heartbeat_at` and lets Postgres compute the duration.

### 2026-05-01 — Shopify API 2026-01: removed Shop fields
The following fields no longer exist on `Shop` or `ShopFeatures` in API 2026-01: `Shop.customerEmail`, `Shop.countyTaxes`, `ShopFeatures.brandingStatus`, `ShopFeatures.storefrontPasswordProtection`, `ShopFeatures.paypalExpressInContext`. The Phase 1 schema retained columns for these — `src/resources/shop.ts` writes `null` for those columns. Re-evaluate if/when Shopify exposes equivalents.

### 2026-05-01 — `ShopFeatures.branding` is enum, schema column is boolean
`ShopFeatures.branding` returns an enum string (`SHOPIFY` | `STOREFRONT` | …) in API 2026-01, but `shopify.shop.features_branding` is a boolean column. Workaround: `features_branding` is set to NULL and the enum string is stored in `features_branding_status` (text). If a future architect change makes the column text, update `src/resources/shop.ts` accordingly.

### 2026-05-01 — Bulk Operations require unwrapped inner queries
`bulkOperationRunQuery` wraps the inner query in `{ }` automatically. Resource modules with `syncStrategy: 'bulk'` MUST set `graphqlQuery` to the inner query body (no outer braces, no `query Foo {}` wrapper, no `first:` arguments on connections — Bulk Ops forbids them). The runner submits via `submitBulkOperation()` which does the wrapping.

### 2026-05-01 — Bulk Operations: one in-flight per shop
Shopify allows only one bulk operation per shop at a time. `submitBulkOperation()` cancels any current op (if `RUNNING`/`CREATED`) before submitting a new one. If the orchestrator runs two `bulk` resources back-to-back without serializing them, this is the safety net.

### 2026-05-02 — Per-record applyOne is unusably slow on bulk
First customers backfill (~118K records) ingested at ~1-2/sec via `applyOne()` — each record made 3-5 sequential PostgREST round-trips (parent upsert + delete-then-upsert per child extractor). Projected total: 18 hours.

**Fix**: `applyBatch(module, parents[], …)` in [src/worker/runners/runner.ts](src/worker/runners/runner.ts:60). Buffers 200 parents from the JSONL stream, transforms them, then issues exactly one upsert per table (parents in one call, all children of each table in one call across the whole batch). Delete-by-parent uses a single `DELETE … WHERE parent_id IN (…)` chunked at 500 IDs. ~35-100x speedup measured (1-2/sec → 70-100/sec).

`bulkRunner` and `chunkedMonthlyRunner` both use applyBatch with default batch size 200. `singletonRunner` and `paginatedRunner` keep applyOne (low cardinality, not worth the buffering complexity).

### 2026-05-02 — Skip delete-by-parent on first backfill
`replaceByParent` extractors (e.g. customer_addresses, location_metafields) issue a delete-then-upsert per parent so removed children don't linger. On a first backfill the destination table is empty — the delete is pure waste.

`isFirstBackfill(resourceName)` in the orchestrator checks `resource_registry.phase === 'not_started'` and threads `skipReplaceDeletes: true` through dispatch → bulkRunner → applyBatch. After the first run, `phase` flips to `backfill_complete` and subsequent runs use the safe slow path.

Never set `skipReplaceDeletes` for incremental sync — Shopify can drop children (e.g. customer removes an address) and the delete is the only thing keeping us in sync.

### 2026-05-02 — Resume bulk ingest from existing JSONL URL
Shopify Bulk Operation result URLs are valid for 7 days. If our worker crashes mid-stream or we ship a code fix and want to re-ingest the same data, we don't need to make Shopify regenerate the JSONL (5-30 min wait).

**`POST /api/sync/resume-bulk` body `{resourceName}`** → looks up the most recent COMPLETED `bulk_operations` row for that resource and pipes its `jsonl_url` straight into `runBulk` via `existingOp`. Bypasses `submitBulkOperation` and `pollUntilDone`. See [src/app/api/sync/resume-bulk/route.ts](src/app/api/sync/resume-bulk/route.ts) and `resumeBulk()` in [src/worker/orchestrator.ts](src/worker/orchestrator.ts).

If the URL has expired, `streamJsonl` will fail with a 403 — fall back to a fresh `submitBulkOperation` via the normal Start flow.

### 2026-05-02 — Shopify API 2026-01: more removed/renamed fields
Found while running customers/products/orders bulk queries:
- `MailingAddress.countryName` removed — column `customer_addresses.country_name` left null
- `Product.optionsCount` removed (we compute from `options` array length)
- `ProductVariant.metafieldsCount` removed — column `product_variants.metafields_count` left null
- `Order.contactEmail` removed — column null
- `Order.sourceUrl` removed — column null
- `LineItem.productExists` removed — column null
- `CardPaymentDetails.creditCardCompany` and `.creditCardNumber` removed — captured in raw_payload only
- `CustomerJourneySummary.momentsCount` is now `Count` type (object with `count` subfield), not scalar
- `Publication.hasCollection` requires an `id: ID!` argument — removed from query

All errors caught by GraphQL validation before any data was upserted; the affected columns now hold null values that can be backfilled later if a Phase 1.1 schema change adds equivalents.

### 2026-05-02 — `query()` errors must include `graphQLErrors`
The Shopify SDK puts the readable problems under `errors.graphQLErrors[]`, not `errors.message`. The original `query()` only surfaced the generic `"GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details."` — useless for debugging field issues. [src/lib/shopify/client.ts](src/lib/shopify/client.ts:23) now joins `graphQLErrors[].message` into the thrown error. Always do this for any Shopify SDK that returns `errors`.

### 2026-05-02 — zsh: `status` is read-only
Bash polling scripts on macOS run in zsh by default. zsh has a built-in read-only `status` variable (current exit code). Assigning to it (`status=$(curl ...)`) errors out with `(eval): read-only variable: status`. Use `st=` or any other name. Bit me twice in monitor scripts — second time was preventable.

### 2026-05-02 — Bulk Operations: 5-connection-per-query limit
Shopify Bulk Operations rejects queries with more than 5 GraphQL connections. The original products query had 7 (root + variants + variants.metafields + variants.presentmentPrices + media + metafields + resourcePublicationsV2). Dropped the two variant connections (metafields, presentmentPrices) — both are now Phase 3 reconciliation work. Error message: `bulkOperationRunQuery userErrors: Bulk queries cannot contain more than 5 connections.`

### 2026-05-02 — Bulk Operations: no connection-inside-list
Shopify also rejects connections nested inside list fields. Orders has `refunds [Refund!]!` (list), and inside Refund I had `orderAdjustments { edges { node }}` (connection). Removed — `refunds.raw_payload` still captures the data structure for later. Error: `Queries that contain a connection field within a list field are not currently supported.`

### 2026-05-02 — Bulk JSONL flattens connections; resource extractors must use `_children`
Bulk Ops emits each connection node as its own JSONL line with `__parentId`. `groupByParent` re-stitches them under `parent._children[<gidTypeKey>]` (e.g. `_children.product_variant`, `_children.media_image`). Resource extractors that look at `raw.variants.edges.node[]` (the inline shape) get nothing. Use `pickChildren(parent, ...gidTypeKeys)` from `src/worker/jsonlStreamer.ts`. For child types with no `id` field (e.g. `ResourcePublicationV2`), use `pickChildrenWhere(parent, predicate)` — those land under `_children.unknown`.

### 2026-05-02 — `applyOne` (per-record) is unusably slow on big bulk; `applyBatch` is required
First customers backfill via per-record `applyOne()` projected at ~18 hours for 118K customers (3-5 PostgREST round-trips per record). After refactoring to `applyBatch()` (transform N parents at once, one upsert per table), customers landed in **16.9 min** — 64x speedup. `bulkRunner` and `chunkedMonthlyRunner` MUST use applyBatch; `singletonRunner` and `paginatedRunner` keep applyOne (low cardinality, not worth the buffering complexity).

### 2026-05-02 — Resume bulk ingest from existing JSONL URL (saves 30+ min Shopify wait)
If the worker crashes mid-stream or you ship a code fix, you can re-ingest the same data without re-paying Shopify's bulk-op generation time. Shopify URLs are valid 7 days. `POST /api/sync/resume-bulk {resourceName}` looks up the most recent COMPLETED `bulk_operations` row for that resource and feeds its `jsonl_url` into `runBulk` via the new `existingOp` param. See `resumeBulk()` in [src/worker/orchestrator.ts](src/worker/orchestrator.ts).

### 2026-05-02 — ChildExtractor needs `onConflict` for composite-PK tables
Most child tables use `id` as PK. Two exceptions found:
- `product_publications` PK is `(product_id, publication_id)` — set `onConflict: "product_id,publication_id"`
- `customer_journey_summaries` PK is `(order_id)` — set `onConflict: "order_id"`
Default `applyBatch` uses `onConflict: "id"`; without override, PostgREST errors with `column "id" does not exist`.

### 2026-05-02 — Dedupe within batch by conflict key
Bulk Ops can emit the same child once per parent it's associated with (e.g. a shared `MediaImage` attached to two products → 2 JSONL lines, same id, different `__parentId`). When `applyBatch` gathers children across 200 parents, the same id appears twice → PostgREST rejects: `ON CONFLICT DO UPDATE command cannot affect row a second time`. Fix: `dedupeByKey(rows, conflictKey)` in `applyBatch` keeps last-write-wins per key.

### 2026-05-02 — Postgres `statement_timeout` caps batch size for big-payload tables
Supabase has a 60s statement_timeout. Orders' `raw_payload` is ~50KB per row → 500 rows = ~25MB upsert with ON CONFLICT touching multiple indexes → routinely exceeds the timeout. **Lower batch size to 200** for any resource with heavy raw_payload. The error `canceling statement due to statement timeout` is **not transient** — retry won't help, query will time out the same way each attempt. `BATCH_SIZE = 200` is now the safe default in `bulkRunner` and `chunkedMonthlyRunner`.

### 2026-05-02 — Wrap `upsertBatch` in retry; survive Supabase pooler blips
Long-running runs (orders took 4 hours) eventually hit a transient `TypeError: fetch failed` from the Supabase pooler. Without retry, this killed an entire run mid-flight (orders v4 died at chunk 72 of 101). `upsertBatch` and `deleteByParent` are now wrapped in `withRetry` (4 attempts, exponential backoff). Heartbeat itself doesn't crash on failure (already best-effort). Orders v6 ran 4h with zero deaths.

### 2026-05-02 — Per-chunk try/catch in chunkedMonthlyRunner
Orders v3 had a Shopify ACCESS_DENIED on the 2022-01 chunk (one specific order's data needed a scope we don't have) — the throw killed the entire orders run. Fix: wrap each chunk in try/catch in chunkedMonthlyRunner. Chunk-level errors log + skip; the run continues. RunPaused/RunCancelled errors still propagate (correct). Orders v6 hit a Shopify-side `fetch failed` on 2025-08 — 5-7K orders for that month skipped, run continued through the remaining 9 chunks. Re-run via `/api/sync/retry orders` (idempotent) closes the gap.

### 2026-05-02 — Skip `deleteByParent` on first backfill
`replaceByParent` extractors (e.g. customer_addresses) issue a delete-then-upsert per parent so removed children don't linger. On a first backfill with empty tables, the delete is pure waste. `isFirstBackfill(resourceName)` checks `resource_registry.phase === 'not_started'` and threads `skipReplaceDeletes: true` through dispatch → bulkRunner → applyBatch. After first run, phase flips to `backfill_complete` and incremental syncs use the safe slow path. Never set on incremental (Shopify can drop children).

### 2026-05-02 — API 2026-01: more removed/renamed fields
Surfaced during the actual backfill (above what we caught earlier with shop/locations):
- `MailingAddress.countryName` removed → customer_addresses.country_name=null
- `Product.optionsCount` removed → compute from options array length
- `ProductVariant.metafieldsCount` removed → null
- `Order.contactEmail`, `Order.sourceUrl` removed → null
- `LineItem.productExists` removed → null
- `CardPaymentDetails.creditCardCompany`, `.creditCardNumber` removed → captured in raw_payload
- `CustomerJourneySummary.momentsCount` is now `Count` type (object with `count` subfield), not scalar
- `Publication.hasCollection` requires `id: ID!` argument → removed from query
All caught by GraphQL validation before any data was upserted; columns hold null values that can be backfilled later if a Phase 1.1 schema change exposes equivalents.

### 2026-05-02 — `query()` errors must surface `graphQLErrors`
The Shopify SDK puts the readable problems under `errors.graphQLErrors[]`, not `errors.message`. The original `query()` only surfaced the generic `"GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details."` — useless for debugging field issues. [src/lib/shopify/client.ts](src/lib/shopify/client.ts:23) now joins `graphQLErrors[].message` into the thrown error.

### 2026-05-03 — `total_records_synced` was double-counting via `prior + recordsInserted`
`touchResourceRegistry()` used to read the prior counter and add `result.recordsInserted` from the runner. Idempotent re-runs (resume-bulk after a network drop, retry, etc.) re-process already-landed rows; PostgREST's upsert returns those rows in `count`, so `result.recordsInserted` includes them. Adding to prior produced 61,298 for products (real: 30,749) and 14 for locations (real: 7). Fix: the table itself is the source of truth — `touchResourceRegistry()` now does `count(*)` on `module.table` and writes that. Immune to re-runs. The counter is for display; treat the data table as authoritative.

### 2026-05-03 — bulkRunner JSONL byte-offset resume; long bulk ingests now survive `kill -9`
[src/worker/jsonlStreamer.ts](src/worker/jsonlStreamer.ts) now tracks UTF-8 byte position per yielded line; `groupByParent` yields `{parent, byteEnd}` where `byteEnd` is the end-of-last-line for that parent's block. After every flushed batch, [src/worker/runners/bulkRunner.ts](src/worker/runners/bulkRunner.ts) writes `metadata.jsonl_offset` to `sync_runs`. `resumeBulk()` looks up the highest offset across prior runs that touched the SAME `bulk_operation_id` (different bulk ops produce different JSONL files — offsets aren't comparable across ops) and passes it to `streamJsonl({startByte})`, which issues a `Range: bytes=N-` request. Shopify's GCS-served URLs honor Range and return 206 Partial Content. Falls back to discarding bytes manually if the server returns 200. Heartbeat fires every 100 lines so stale-run detection works during long ingests.

### 2026-05-03 — `upsertBatch` per-batch isolation: never throw out of the loop
A single PostgREST sub-batch failure used to bubble up through `applyBatch` and kill the entire bulk run via the streaming loop. [src/worker/upsert.ts](src/worker/upsert.ts) now wraps each 500-row chunk in try/catch — failures (after `withRetry` exhausts) are logged to `error_log` with the table + batch range, increment `failed`, and the loop continues. Caller reads `r.failed` to know how much was lost. Net: a transient pooler hiccup mid-run loses 500 rows max, not the entire downstream stream.

### 2026-05-03 — PostgREST returns count=null status=204 for missing tables (vs count=0 status=200 for empty existing)
`dataDb.from('nonexistent_table').select('*', {count:'exact', head:true})` returns `{count: null, error: null, status: 204}` — silently, no error. An empty existing table returns `{count: 0, error: null, status: 200}`. So testing for "table exists" via `error` is wrong. Test `count === null`. Used by `audit-data` to detect orphan registry rows ([src/scripts/audit-data.ts](src/scripts/audit-data.ts) `tableCount()`).

### 2026-05-03 — Inline LIST fields in bulk JSONL stay attached to the parent (NOT flattened as __parentId children)
Bulk Operations only flatten CONNECTION fields into separate JSONL lines. Inline LIST fields stay on the parent's JSON line as a JSON array. Example for `Order.taxLines` (LIST [TaxLine]):
```jsonl
{"id":"gid://shopify/Order/...", "taxLines":[{"title":"GST","rate":0.14, ...}], "discountCodes":[]}
```
Resource extractors for LIST fields MUST read directly from the parent's `raw.<field>` array — calling `pickChildren(raw, "tax_line")` returns nothing because there ARE no `_children.tax_line` entries. Same for `Order.discountCodes`, `Order.fulfillments`, `Order.refunds`, `LineItem.taxLines`, `LineItem.discountAllocations`, `LineItem.duties`, `ShippingLine.taxLines`, etc.

For LineItem-level inline LISTs: lineItems IS a connection on Order, so each LineItem becomes its own JSONL line under `_children.line_item`. The LineItem's own LIST fields then stay inline on that lineItem object: read via `pickChildren(raw, "line_item")` then iterate each `li.taxLines`, `li.discountAllocations`, `li.duties`.

### 2026-05-03 — `dedupeByKey` collapsed surrogate-key rows when conflict-key column was undefined
[src/worker/runners/runner.ts](src/worker/runners/runner.ts) `dedupeByKey()` used `String(r[col])` to build the dedupe key. For tables whose PK is `uuid DEFAULT gen_random_uuid()` (e.g. `order_tax_lines`, `order_discount_codes`, `order_line_item_tax_lines`, `order_line_item_discount_allocations`), extractors leave `id` unset so Postgres assigns a fresh UUID on INSERT. `String(undefined)` evaluates to `"undefined"`, so EVERY row in a 200-parent batch collapsed to one row per batch. Phase 3 Wave 1 Pass 1 dry-run on August 2024 (2,988 orders) landed exactly **15 rows in each affected table** instead of ~3K — masking ~99% silent data loss. Math: 2,988 / 200 ≈ 15 batches × 1 surviving row each. Fix: `dedupeByKey` now passes through any row where one or more conflict-key columns are missing/null, since such rows can't collide with each other (Postgres assigns fresh surrogates on INSERT). The architect caught this during Pass 1 dry-run review by cross-checking against `orders.total_tax_amount > 0` (every order). Lesson: when a single low number repeats across multiple unrelated tables, the issue is almost always in the shared writer pipeline, not the per-resource extractor.

### 2026-05-03 — Shopify bulk `query` filter is shop-timezone-aware, not UTC
The bulk filter `created_at:>=2024-08-01T00:00:00Z created_at:<2024-09-01T00:00:00Z` returns orders Shopify counts as "August in shop local time", not UTC. For Egypt (UTC+2/+3), this returned 2,988 orders for "Aug 2024" while a UTC-anchored DB count showed 2,863 (the boundary orders 2024-07-31T21:16:08Z to 2024-09-01T20:50:00Z were the difference). The values look like UTC ISO strings but Shopify converts to shop time before matching. Practical implication: counts derived from `audit-data`'s per-month UTC GROUP BY will systematically differ from Shopify's reported counts by a percent or two for stores in non-UTC timezones. Not data loss — just a boundary interpretation difference. Don't try to "fix" the difference; document and trust both numbers as correct under their own definitions.

### 2026-05-03 — `customers.default_address_id` / `last_order_id` filled via SQL reconciliation
Phase 1 marked these FKs `DEFERRABLE INITIALLY DEFERRED` with the plan to fill them post-orders-sync. The fill happened in Phase 2.5 via straight SQL: `default_address_id` = most-recent `is_default=true` address per customer, fall back to most-recent by sync time; `last_order_id` = latest order by `created_at`. 102,015 customers got an address; 83,049 got a last_order. The remaining 16,198 / 35,164 NULLs are legitimate (customers with no addresses / no orders — Shopify allows this, e.g. SMS-only signups). Re-run after every fresh orders backfill if they're still NULL — pure SQL, no Shopify hit needed.

### 2026-05-04 — Ourkids stopped charging tax in mid-September 2024 (real shop config event, not data loss)
Discovered during Phase 3 Wave 1 Pass 1: 100% of orders before 2024-09-18 have populated `Order.taxLines` and `LineItem.taxLines`; 0% after. Verified directly against Shopify: orders before the cutoff have `taxesIncluded: true, totalTax: 31.81 EGP, taxLines: [GST 14%]`; orders after have `taxesIncluded: false, totalTax: 0, taxLines: []`. The store legitimately stopped collecting tax (likely tax-exemption reclassification or registration change). Empty arrays in our `order_tax_lines` and `order_line_item_tax_lines` for Sep 2024 onward are CORRECT, not a sync gap. Final Wave 1 counts will look ~50% below naive projections that assume universal tax — that's expected. Don't "fix" by re-fetching.

### 2026-05-04 — Ourkids issues most refunds without the formal Shopify Return workflow (23% return-vs-refund ratio)
Pass 3 dry-run on 2024-08: 65 orders had a Shopify `Return` row (formal return workflow); 283 orders had a `Refund` row (just a refund posted). 23% return rate is much lower than the architect's projected 70-90% (typical industry default). This is a real business workflow finding — Ourkids predominantly issues direct refunds (goodwill, comp, partial price adjust) without creating a Shopify Return record. Practical implication: don't expect `order_returns` row counts to track refund counts. Building "return rate" KPIs needs to use the `order_refunds` table primarily, with `order_returns` representing only the formal-process subset.

### 2026-05-04 — Shopify Admin API 2026-01: more removed Order/Return fields (continuation of the field-removal pattern)
Surfaced during Phase 3 Wave 1:
- `Order.risks` → REMOVED. `order_risks` table cannot be backfilled — marked deferred_not_applicable.
- `Order.edits` → REMOVED. `order_edits` table cannot be backfilled — marked deferred_not_applicable. (Note: OrderEditAgreement still exists as a SalesAgreement subtype — captured in `order_agreements`.)
- `Return.legacyResourceId` → REMOVED. The `order_returns.legacy_resource_id` column is set to NULL; raw_payload preserves the GID.
- `Order.staffMember` is OBJECT (single, not list as some old docs imply) but ACCESS_DENIED without `read_staff` scope. `order_staff_attribution` stays deferred_pending_scope.

### 2026-05-04 — Bulk JSONL nested-CONNECTION-inside-CONNECTION needs a multi-level groupByParent
Bulk Operations CAN nest connections (`Order.returns` connection containing `Return.returnLineItems` connection — flattens to JSONL with each ReturnLineItem's `__parentId` pointing at its Return, NOT at the Order). The original `groupByParent` only handled one level: a child whose `__parentId` ≠ `current.id` (the Order) was logged as orphan and skipped. This silently dropped 100% of ReturnLineItems on Pass 3's first dry-run.

Fix in [src/worker/jsonlStreamer.ts](src/worker/jsonlStreamer.ts): `groupByParent` now maintains a per-root `Map<id, ParentWithChildren>` tracking every ancestor in the in-flight tree. New children look up their parent in the map (could be the top-level Order OR any previously-attached child acting as a grandparent), attach there, and themselves get added to the map so they can also have grandchildren. Resource extractors that need to walk grandchildren now do `for (const r of pickChildren(raw, "return")) for (const rli of pickChildren(r, "return_line_item", "unverified_return_line_item")) {…}`. Existing single-level extractors are unaffected (each child also has an empty `_children` field but they don't read it).

### 2026-05-04 — Trailing-month FK orphans are inevitable when Shopify creates new data during/between syncs ("2026-05 staleness pattern")
Every Wave 1 pass + the orders recovery run hit FK orphans on the 2026-05 chunk: hundreds-to-thousands of children for orders Shopify created in the days BETWEEN our parent backfill and the current pass. Pass 1: 723. Pass 2: 756. Pass 3: 832. Orders recovery: 8,630 (one level higher — the new orders' `customer_id` referenced customers we hadn't synced).

This is a fundamental property of bulk-then-children sync against a live store, not a bug. Patterns:
1. After every parent backfill (orders, customers), assume the trailing month has ~5% orphans waiting for the next incremental.
2. Children passes for the trailing month should accept these as "FK orphans expected" and auto-resolve in `error_log`.
3. The fix is operational, not architectural: schedule incremental syncs (customers → orders → all dependent passes) on a daily cadence (Phase 5 work).

### 2026-05-05 — Composite UNIQUE constraints need explicit `onConflict`
Every child extractor whose target table has a UNIQUE constraint beyond the primary key MUST set `onConflict` to that composite. Otherwise upserts that should be idempotent will throw on collision during incremental sync — the row's surrogate `id` PK won't fire (PG generates a fresh UUID or the GID is fresh), but the natural-key UNIQUE constraint will, and PostgREST returns the whole 500-row sub-batch as failed. Reference: `orders_pass_2.ts` order_metafields extractor uses `onConflict: "order_id,namespace,key"`. Routes the upsert to the correct constraint so colliding rows UPDATE in place.

Wave 1 closeout pass (2026-05-05) added explicit `onConflict` to 5 extractors that were running on luck: `product_metafields` (`product_id,namespace,key`), `customer_metafields` (`customer_id,namespace,key`), `inventory_levels` (`inventory_item_id,location_id`), `shop_metafields` (`namespace,key`), `location_metafields` (`location_id,namespace,key`). Two more tables (`customer_email_consent_history`, `customer_sms_consent_history`) have the same constraint shape but no extractor yet — when Wave 2 builds them, set `onConflict: "customer_id,consent_updated_at,state"`.

Verification protocol going forward: any new child extractor for a `shopify.*` table, query `information_schema.table_constraints` for non-PK UNIQUEs first. If any exist, set the extractor's `onConflict` to those exact columns in declaration order.

### 2026-05-07 — Postmortem: products refresh CASCADE-wiped 444,525 inventory rows (incident #3)
A staleness-recovery refresh of `products` ran the standard `replaceByParent: true` flow on `product_variants` (DELETE-then-INSERT per 200-product batch). Phase 1 schema had two CASCADE FKs pointing AT `product_variants`:
```sql
inventory_items.variant_id → product_variants.id           ON DELETE CASCADE
product_variant_metafields.variant_id → product_variants.id ON DELETE CASCADE
```
The variant DELETEs CASCADE-deleted **60,681 inventory_items** and **383,844 inventory_levels** (which had its own CASCADE from inventory_items) — totaling **444,525 rows lost** across modules the products refresh wasn't supposed to touch.

Detected via `npm run audit-data` showing -60K/-383K drifts on those tables. The registry counters had stale values from Phase 3 (61,303 / 388,104), masking the loss until audit-data cross-checked actual row counts.

**Resolution (2026-05-07):**
1. **Schema migration `restrict_cross_module_cascades`** (architect, direct via Supabase MCP): flipped `inventory_items.variant_id` and `product_variant_metafields.variant_id` CASCADE FKs to RESTRICT. Future products refreshes that DELETE variants will FAIL LOUDLY instead of silently wiping inventory.
2. **Module fix** in [src/resources/products.ts](src/resources/products.ts) `variantsExtractor`: removed `replaceByParent: true`, now upsert-only. Variants have natural Shopify GIDs → id-based upsert is idempotent.
3. **Recovery**: `inventory_items` re-fetched via fresh bulk (58 min) — 622 → 62,260 items, 4,260 → 389,340 levels. 0 FK orphans. Net delta from Phase 3 baseline (~+957 items, +1,236 levels) reflects 4 days of organic store changes.
4. **NEW NEVER rule** added (above): "Never use `replaceByParent: true` on a child whose target table has cross-module CASCADE FKs."
5. **Schema migration `restrict_orders_cross_module_cascades`** (architect, 2026-05-07): closes the 3 latent orders.ts risks at the schema level. Flipped to RESTRICT:
   - `order_line_item_tax_lines.line_item_id`, `order_line_item_discount_allocations.line_item_id`, `order_line_item_duties.line_item_id` → `order_line_items.id` (cousin: `orders_pass_1`)
   - `order_fulfillment_line_items.fulfillment_id`, `order_fulfillment_events.fulfillment_id` → `order_fulfillments.id` (cousin: `orders_pass_4` + deferred)
   - `order_refund_line_items.refund_id` → `order_refunds.id` (cousin: `orders_pass_4`)
6. **Module fixes** in [src/resources/orders.ts](src/resources/orders.ts) (2026-05-07): the 3 corresponding extractors (`lineItemsExtractor`, `fulfillmentsExtractor`, `refundsExtractor`) flipped from `replaceByParent: true` to upsert-only. All three target tables have natural Shopify GID PKs.

**Cross-module CASCADE risk loop is now closed at both schema and module level for products + orders.** No remaining latent CASCADE risks across the active module set.

**This is the third CASCADE-deletion incident in this project**:
1. 2026-05-04 — `TRUNCATE order_returns CASCADE` → 21,331 `order_refunds` rows wiped (Wave 1 Pass 3 dry-run cleanup; led to NEVER rule about TRUNCATE CASCADE)
2. 2026-05-06 — Wave 2 collections corruption → bulk re-fetch with stale `products` parent caused FK violations dropping 38K `collection_products` (Wave 2 chain incident; led to today's staleness recovery)
3. 2026-05-07 — products refresh's `replaceByParent` → 444K rows wiped (this incident)

**Cross-incident lesson**: Phase 1 CASCADE FKs from cousin tables outside the parent module's domain are a design oversight. The bridge architecture treats each Shopify resource as an independently-owned domain, but Phase 1's ON DELETE CASCADE chains let one module's normal write flow silently destroy data owned by another. Schema migration `restrict_cross_module_cascades` is the start of paying down this debt; full audit + flip should happen before Phase 4 incremental sync introduces more frequent refreshes.

### 2026-05-07 — Phase 1 schema omitted btree indexes on FK-bearing customers columns; staleness recovery hit Postgres timeouts
Phase 1 schema created FK constraints `customers.default_address_id → customer_addresses.id` and `customers.last_order_id → orders.id` (both `DEFERRABLE INITIALLY DEFERRED`) but did NOT add btree indexes on those columns. Phase 2.5's reconciliation didn't trip the gap because it ran one bulk UPDATE rather than many small DELETEs. The omission surfaced on 2026-05-07 during the Wave 2 staleness recovery: `replaceByParent` on `customer_addresses` issues `DELETE FROM customer_addresses WHERE customer_id IN (200 ids)` per batch. Postgres must verify FK integrity by checking whether any `customers.default_address_id` references the deleted addresses. Without an index, that's a seq scan of 118K customer rows per delete check → 60s `statement_timeout`. **100% failure rate on the customers re-sync** before being killed.

Fix: indexes added 2026-05-07 via `add_missing_customers_fk_indexes` migration:
```sql
CREATE INDEX idx_customers_default_address_id ON shopify.customers (default_address_id) WHERE default_address_id IS NOT NULL;
CREATE INDEX idx_customers_last_order_id ON shopify.customers (last_order_id) WHERE last_order_id IS NOT NULL;
```
Both are partial indexes (`WHERE NOT NULL`) since 14% of customers legitimately have no address and 30% have no orders.

Lesson for Phase 4 incremental sync design: **every FK column on a high-row-count parent table needs an index, not just the FK constraint.** Audit all `shopify.*` tables with FK constraints against `pg_indexes` before incremental cycles start. Foreign-key constraint enforcement reads through the parent's index; without one, every modification of the referenced child becomes O(parent rowcount).

### 2026-05-06 — `applyOne` didn't honor `module.skipParentUpsert` (corrupted 1,000 collections rows)
Wave 2's `collection_rules` module set `skipParentUpsert: true` (it walks collections to extract rules without rewriting parent collections data). But `applyOne` in [src/worker/runners/runner.ts](src/worker/runners/runner.ts) ALWAYS upserted the parent — only `applyBatch` checked the flag. Result: 1,000 collections rows had their `raw_payload` overwritten with `{}` (the stub the pass-style transform returns for skipParentUpsert modules). Fix: applyOne now wraps the parent upsert in `if (!module.skipParentUpsert) { … }`. Recovery: full re-fetch of collections via the existing bulk module restored raw_payload.

Lesson: any flag that affects shared write paths must be checked in every code path (applyOne, applyBatch, etc.). The runners are TWO sets of writes; both need parity.

### 2026-05-06 — Shopify Admin API 2026-01: more removed/renamed fields surfaced during Wave 2
Continuation of the field-removal pattern. New ones found:
- `Menu.itemsCount` removed → compute count from `Menu.items.length`
- `DraftOrder.useCustomerDefaultAddress` removed → column `draft_orders.use_customer_default_address` left null
- `DraftOrderLineItem.sellingPlan` removed → column `selling_plan_name` left null (id was already null per Phase 1)
- `AbandonedCheckout.taxExempt` removed → column `abandoned_checkouts.tax_exempt` left null
- `Translation.marketId` renamed to `Translation.market { id }` — but `market` requires `read_markets` scope. Ourkids token doesn't have it. Translation rows still synced; `market_id` column left null (read_markets is in the deferred-scopes list).
- `Order.events` (and `QueryRoot.events`) returns Internal Server Error in 2026-01 even on minimal queries. Per-parent `Order.events` works at type level but offers no scalable backfill path. Whole `events_audit_log` is deferred until Shopify fixes.

### 2026-05-06 — `paginated_batch` strategy: 100× speedup over `paginated`/applyOne for high-cardinality resources
`paginated`/applyOne does 1 PostgREST round-trip per record (~100ms each). For 150K discount_codes, that's 4+ hours. The new `paginated_batch` strategy reuses [src/worker/runners/paginatedWithBatchRunner.ts](src/worker/runners/paginatedWithBatchRunner.ts) (originally built for Wave 1.5 chunked-monthly-via-GraphQL) — buffers 200 parents, uses `applyBatch` for one upsert per table per batch. Empirically 70 records/sec (100×). When choosing a strategy for a new resource: if expected cardinality > 1K rows, use `paginated_batch`; for <1K, `paginated` is simpler.

The runner was extended in Wave 2 with non-chunked mode: when `module.chunkField` is undefined, treats the whole walk as a single chunk (no `{{QUERY_FILTER}}` substitution). Used by Wave 2 modules without a date-range filter.

### 2026-05-04 — Postmortem: `TRUNCATE ... CASCADE` silently deleted 21,331 `order_refunds` rows
After Pass 3 dry-run completed, I ran `TRUNCATE shopify.order_returns ... CASCADE` to wipe dry-run rows before the full backfill. CASCADE propagated through the FK `order_refunds.return_id → order_returns.id` and deleted ALL 21,331 refund rows from Phase 2. `npm run audit-data` caught it within ~30 sec of Pass 3 finishing (drift = -21,331 on order_refunds). Recovery: full re-run of `orders` resource (4 hrs, idempotent UPDATE on natural-id children, fresh INSERT into the empty refunds). Final state: order_refunds back at 21,365 (slightly higher because the re-run also captured a few new May 2026 orders).

Codified as a hard NEVER rule (see "NEVER" section) — `TRUNCATE ... CASCADE` is now off-limits on `shopify.*` tables. Always check `information_schema.referential_constraints` before any bulk delete; for dry-run cleanup, prefer `DELETE WHERE` by date or `sync_run_id`.

### 2026-05-08 — Webhook receiver MUST read `req.text()` BEFORE any JSON parse
Shopify computes `X-Shopify-Hmac-Sha256` over the EXACT bytes it sent. Calling `req.json()` first re-serializes through V8's JSON parser, which can change byte layout (key ordering, number representation, whitespace) and the HMAC will silently fail. The receiver in [src/app/api/webhooks/shopify/route.ts](src/app/api/webhooks/shopify/route.ts) reads `await req.text()` and verifies HMAC against that buffer; only then does it `JSON.parse(rawBody)`. Same rule applies to any future webhook receiver in this codebase.

### 2026-05-08 — `applyOne` is the right path for incremental — but skipReplaceDeletes MUST be false
The bulk runners' first-backfill optimization sets `skipReplaceDeletes: true` to avoid pre-delete on empty tables. `runIncremental` deliberately threads `skipReplaceDeletes: false` to `applyOne` so `replaceByParent` extractors fire — children removed in Shopify (e.g. customer dropped an address; product variant deleted) MUST propagate to the mirror. The opposite would silently leave orphans. Hard-coded false at the call site, not configurable; if someone "optimizes" this in the future they'll re-introduce orphan rows.

### 2026-05-08 — Extractors must handle BOTH _children (bulk) and inline edges (incremental) shapes
Bulk JSONL flattens connections under `parent._children.<gidType>` (built by `groupByParent`). Regular GraphQL returns connections inline at `parent.<field>.edges[].node`. Phase 3B made the same `transform`+`childExtractors` runnable from BOTH paths (bulkRunner.applyBatch from the JSONL stream, incrementalRunner.applyOne from `module.incremental(id)`'s GraphQL response). [src/resources/products.ts](src/resources/products.ts) and [src/resources/collections.ts](src/resources/collections.ts) added `<field>Of(raw)` shape-agnostic helpers (variantsOf, mediaOf, metafieldsOf, productsOf, publicationsOf) that try `_children` first, fall back to inline edges. Orders' line-item extractor + visits extractor already had this pattern (set up during Wave 1 dry-run debugging). When adding any new top-level resource module that needs incremental sync, follow the same pattern — never read `_children` directly from an extractor without an inline fallback.

### 2026-05-08 — Module-level incremental() queries must include EVERY field the bulk QUERY does
The transform applies field-level `?? null` for missing fields, so a smaller incremental query will null-overwrite columns the bulk run populated. Maintenance burden: any field added to a module's bulk `QUERY` must also be added to that module's `incremental(id)` query body, or live updates silently degrade DB completeness. Comment at the top of each `incremental` block flags this. (Considered but rejected: auto-deriving the incremental query from the bulk one — string manipulation on GraphQL is fragile, and bulk has constraints — no `first:`, no connection-in-list — that don't apply to incremental, so they're not equivalent.)

### 2026-05-08 — Refunds + fulfillments topics route to orders.incremental, NOT to a separate module
The architect's spec said "incremental(id) on 6 modules" but refunds/fulfillments aren't standalone resource modules — they're child extractors under orders. The webhook processor extracts the parent order GID from the payload (admin_graphql_api_order_id, order.admin_graphql_api_id, or order_id reconstructed to a GID) and dispatches to `orders.incremental(orderGid)`. Net effect: re-fetching the parent order also re-upserts ALL its children (line items, transactions, fulfillments, refunds, journey, visits) via the same code path that webhooks for orders/* topics use. Single source of truth. If Shopify ever adds a `refunds(id:)` query that returns the refund without its parent, this could change — but for 2026-01 the parent-fetch is the canonical path.

### 2026-05-08 — Catchup-sync cursor advances ONLY on full-clean run
Each catchup invocation queries Shopify for IDs `updated_at:>=<lastCursor>`, syncs each, and only writes the new cursor (`now()`) if every record landed cleanly. A single failure leaves the cursor unchanged so the next cron retries from the same point. Cost: re-fetching the cleanly-synced records on the next tick (idempotent upserts make this safe). Benefit: zero-loss recovery from transient failures without per-record tracking. The cap (5,000 ids per resource per run) bounds blast radius if the cursor gets stuck — Phase 5 reconciliation will surface persistent stuck records.

### 2026-05-08 — Webhook processor uses optimistic UPDATE, not SELECT...FOR UPDATE
Concurrency between Next.js worker instances on Vercel is bounded to 1 per instance; multi-instance scenarios are rare in our workload. The processor claims a row by SELECT...FILTER (oldest received-or-retry-eligible failed), then UPDATEs status='received'→'processing' WITH the original status as a precondition. Whichever caller gets row count = 1 wins; the other gets null and moves on. Avoids needing a transaction-scoped row lock. Will revisit if we see contention in production (Phase 3C/4).

### 2026-05-09 — `SHOPIFY_WEBHOOK_SECRET` is the app's API secret key, NOT a random hex
Webhooks created via `webhookSubscriptionCreate` are signed with the **API secret key** of the custom Shopify app whose access token (`shpat_...`) is in `SHOPIFY_ADMIN_API_TOKEN`. Found at: Shopify Admin → Settings → Apps and sales channels → Develop apps → (the app) → API credentials tab → "API key and secret key" section → "API secret key". The page itself confirms: "Use your client secret to verify incoming webhooks." Mock-webhook tests will pass regardless because both sides read the same `.env.local` value — only **real** Shopify webhooks expose a wrong secret (every delivery 401s with `webhook HMAC verification failed` in Vercel logs).

### 2026-05-09 — `claimNextEvent` PostgREST `.or()` filter parser breaks on ISO timestamp special chars
Original query used `.or('status.eq.received,and(status.eq.failed,retry_count.lt.3,last_failed_at.lt.<isoString>)')`. The ISO timestamp's `:` and `.` chars make the OR filter return zero rows even when matching events exist. Rewrote `claimNextEvent` in [src/worker/webhookProcessor.ts](src/worker/webhookProcessor.ts) to do TWO simple `.eq().lt()` queries (received-first, then retry-eligible failed). Two queries are negligible cost; the parser cooperation is worth a lot.

### 2026-05-09 — Vercel Project default framework=`Other` 404s every Next.js route
Vercel projects created via the dashboard default to Framework Preset "Other" — which means Vercel ignores the `.next/` build output and tries to serve a static site. Build succeeds, the build log proudly lists every `/api/*` route, but every runtime request returns 404 (including `/`). Fix: add `"framework": "nextjs"` to `vercel.json` and redeploy. Also explicitly set `"buildCommand": "next build"` and `"installCommand": "npm install"` for clarity. The `vercel.json` framework setting overrides the dashboard preset.

### 2026-05-09 — Vercel env scope is per-target (production / preview-branch); preview deploys NEED their own
`vercel env add NAME production --value V --yes --force` only sets the Production scope. GitHub-triggered auto-deploys for non-`main` branches are Previews — they get an isolated env scope and DON'T see Production values. Symptom: build fails with `Invalid environment configuration: SHOPIFY_SHOP_DOMAIN: expected string, received undefined`. Fix: also `vercel env add NAME preview <branch> --value V --yes --force`. CLI v53 *requires* the `<branch>` argument even though its own help text suggests omitting it adds to "all Preview branches".

### 2026-05-09 — Vercel CLI v53 `vercel env add` requires `--value` and `--yes` flags for non-interactive
Older CLI versions accepted piped stdin input. v53 errors with `action_required: git_branch_required` and prints next-step suggestions instead of consuming stdin. Use `--value` + `--yes` + `--force` for unattended scripts.

### 2026-05-09 — Receiver `maxDuration` default 60s kills the fire-and-forget processor mid-drain
The receiver returns 200 to Shopify in <5s, then `void processWebhookQueue()` runs in the background. Vercel keeps the function alive for `maxDuration` after the response — default 60s. At ~2s per webhook × 50 maxEvents that's 100s, so the function gets killed mid-drain when Shopify replays a backlog. Fix: `export const maxDuration = 300` in the receiver route + `maxEvents: 100` in the processor call. With Pro-tier 300s budget, one invocation drains ~150 webhooks.

### 2026-05-09 — Shopify silently un-subscribed 3 of 18 webhooks overnight
Between Phase 3C registration (10 May 10:18 UTC) and the next morning (~12:00 UTC), 3 of the 18 subscriptions were missing from `webhookSubscriptions(first:50)` query results: `orders/updated`, `products/update`, `inventory_levels/update`. Cause unconfirmed — likely Shopify's auto-disable circuit-breaker on subscriptions whose endpoints returned consistent 5xx (our deploy was failing 401-with-no-row at the time, but Shopify counts 4xx differently from 5xx). `register-webhooks.ts` is idempotent (it diffs against existing subscriptions and only creates missing ones), so re-running it restored the 3. Operationally: `npm run register-webhooks` is safe to schedule weekly as a "self-heal" sanity check.

### 2026-05-09 — Shopify retries every failed webhook over ~48h with exponential backoff
After fixing the HMAC secret, the queue suddenly grew by 600+ entries — Shopify was replaying every webhook from the prior 24h that had returned 401. This is built-in retry behavior (per Shopify docs: 19 retries over 48h with exponential backoff). The drain-in-place worked but slowly (~30s burst → 600 events → ~10 min total drain). No data lost; just a thundering-herd pattern that the receiver's `maxDuration: 300` accommodates.

## Architectural Decisions
> Record significant decisions here so future sessions don't re-litigate them. Format: `### [date] — decision` then rationale.

### 2026-05-01 — Node.js + TypeScript over Python
Rationale: future tools will be added on top (similar to Odoo Bridge), Next.js dashboard runs in same repo, Vercel cron is native Node, Shopify SDK is TS-first. Single language reduces friction.

### 2026-05-01 — Mirror Shopify schema 1:1 with `raw_payload` column
Rationale: easier debugging, easier reconciliation, never lose new fields. Build analytical views on top in a separate schema later — don't pre-normalize.

### 2026-05-01 — Two schemas: `shopify` (data) and `shopify_sync` (metadata)
Rationale: clean separation between mirrored business data and operational state. Dashboard reads metadata; future apps read data.

### 2026-05-01 — In-process orchestrator (no separate worker process)
Sync runs as a fire-and-forget async task launched from the `POST /api/sync/start` route. State lives in Supabase (`sync_runs`, `bulk_operations`, `error_log`). UI polls `/api/control-room/state` every 2s when active, 30s when idle — no Realtime, no SWR, no Web Workers. Crash recovery via boot-time stale-run cleanup (heartbeat > 60s ⇒ status=paused) in `instrumentation.ts`. Resume re-queues the master row.

### 2026-05-01 — Master run uses synthetic `_master_backfill` resource
The orchestrator tracks the umbrella backfill via a single `sync_runs` row keyed by `resource_name='_master_backfill'`. Required because the FK forces every sync_run to point at a registered resource. Per-resource child runs reference the master via `triggered_by='master:<uuid>'` for traceability.

### 2026-05-01 — Pause = cooperative checkpoint
Pause/cancel works by flipping `sync_runs.status` to 'paused'/'cancelled'; runners poll `checkpoint(runId)` between safe boundaries (after each page, after each chunk, every 500 JSONL lines) and throw `RunPausedError` / `RunCancelledError` to unwind. Resume creates no new state — flips status back to queued and re-invokes the orchestrator from where it stopped (next-resource granularity for backfills, next-chunk for chunked_monthly).

### 2026-05-01 — Bulk JSONL streamed, never buffered
`src/worker/jsonlStreamer.ts` reads the JSONL response chunk-by-chunk via fetch streams; `groupByParent` re-stitches children to parents on the fly. Memory cap is one parent + its children at a time, regardless of file size (orders chunks alone may produce 100s of MB). Don't switch to `await res.text()` — it'll OOM on real data.

### 2026-05-01 — Orders deferred-of-nested model
Phase 2 implements the `orders` runner against the main table + 6 most operational child tables (line_items, transactions, fulfillments, refunds, customer_journey_summaries, customer_visits). The other ~17 nested-of-nested tables are NOT extracted in Phase 2 — but the full Shopify payload IS captured in `orders.raw_payload`. Phase 3 will add a JSON-expansion pass to populate the deferred children without re-fetching from Shopify.

## Update Protocol — IMPORTANT

You MUST update this file when:
1. **You hit a gotcha** — Shopify quirk, library bug, environment issue, anything non-obvious. Add to "Gotchas".
2. **You make or learn of a decision** — architectural choice, tradeoff resolved, convention established. Add to "Architectural Decisions".
3. **A phase advances** — update the "Current Phase" line and the roadmap checkboxes.
4. **Conventions change** — keep "Repo Conventions" and "NEVER" lists current.
5. **Environment facts change** — API version bumped, scope granted, schema added, etc.

When updating, include the date and keep entries terse (1–3 lines). This file is for FUTURE YOU. If it's not useful at a glance, it's failing.

At the start of every session, the FIRST thing you do is read this file end-to-end. Acknowledge in your first reply that you've read it.
