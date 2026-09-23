# RUNBOOK — Shopify Bridge System

Operational playbook. For project history + non-obvious gotchas, read
[`CLAUDE.md`](./CLAUDE.md). For setup + architecture, read [`README.md`](./README.md).

---

## Daily / on-demand sync health checks

### `npm run audit-data` — DB self-consistency
Runs in <30s, exit 0 = clean. Checks:
- Row count of every `shopify.<table>` matches the cached counter in `shopify_sync.resource_registry`
- Every registered resource is in a sane phase (`backfill_complete` / `not_started` / `deferred_*`)
- No orphan registry rows pointing at non-existent tables
- Per-month `orders` distribution flags any thin/empty month
- Lists `not_started` and deferred resources with reasons

If it exits 1: read the drift report at the top — every flagged resource
explains itself. Counter drifts > 0.1% are usually staleness; the script
auto-corrects them by `count(*)`-ing the table directly.

### `npm run audit-shopify-vs-db` — completeness vs. Shopify
**Long-running (~30 min on Ourkids).** Counts every Shopify resource with
its authoritative `*Count` query (or paginated fallback when Shopify caps at
10,000 with `precision: AT_LEAST`). For child tables (line items, refunds,
fulfillments, addresses, metafields, etc.), uses ratio-sampling against
parent counts.

Last clean run: 12 ✅ matches, 3 ⚠️ tolerance drifts (<0.13%), 9 🛑 flags
(all explained — live-store growth, real-vs-bulk count semantics,
ratio-sampling small-n noise on rare-event tables).

Trigger this only after major events (large backfills, recovery procedures,
quarterly checkpoints).

### Control room — `https://shopify-bridge-system.vercel.app/`
Live view of:
- Per-resource phase + counters
- Active sync runs (heartbeat, current chunk, progress)
- Recent errors from `error_log` (auto-resolves stale entries)
- Pause / resume / cancel / retry buttons

The "recent errors" panel may show **historical** Wave 2 partial errors
(e.g. `Translation.market` ACCESS_DENIED — 3 entries from 2026-05-06). DB
confirms 0 unresolved errors in the last hour. Don't worry about historical
entries unless retry-eligible.

---

## Webhook backlog (DLQ recovery)

### Quick check: how many webhooks are stuck?
```sql
SELECT status, count(*)
FROM shopify_sync.webhook_events
WHERE received_at > now() - interval '24 hours'
GROUP BY status;
```

Healthy state: nearly all `processed`, a few `received` (in-flight).
If `failed` > 5 or `dead_letter` > 0, investigate.

### Inspect failures
```sql
SELECT topic, status, retry_count, last_error, received_at
FROM shopify_sync.webhook_events
WHERE status IN ('failed', 'dead_letter')
ORDER BY received_at DESC
LIMIT 20;
```

### Manually drain the queue
The processor is fire-and-forget from the receiver and the cron. To force a
drain right now:
```bash
# Hit the catchup endpoint — it drains webhook_events first via processWebhookQueue({maxEvents:200})
curl -H "Authorization: Bearer $CATCHUP_CRON_SECRET" \
  https://shopify-bridge-system.vercel.app/api/cron/catchup-sync
```

### Replay a dead-lettered webhook
Reset its status to `received` so the next processor tick picks it up:
```sql
UPDATE shopify_sync.webhook_events
SET status = 'received', retry_count = 0, last_error = NULL
WHERE id = '<uuid>';
```
Then trigger a drain (curl above).

If the underlying issue is upstream (Shopify schema change, scope removed,
network partition), fix the root cause first or the row will dead-letter
again on retry.

### Inspect dead-letter queue
```sql
SELECT resource_name, shopify_id, source, error_message, retry_count, last_failed_at
FROM shopify_sync.dead_letter_queue
WHERE resolved = false
ORDER BY last_failed_at DESC;
```

After fixing root cause, mark resolved:
```sql
UPDATE shopify_sync.dead_letter_queue
SET resolved = true, resolved_at = now(), resolution_notes = '<what you did>'
WHERE id = '<uuid>';
```

---

## Manually trigger catchup sync

The cron runs daily at 00:00 UTC (= 03:00 Cairo winter / 02:00 Cairo
summer). To trigger it on demand:
```bash
curl -H "Authorization: Bearer $CATCHUP_CRON_SECRET" \
  https://shopify-bridge-system.vercel.app/api/cron/catchup-sync
```

Returns JSON: `{ webhookProcessor: {...}, catchup: { results: [...] } }`.

The cursor only advances if every record landed cleanly. If `syncedFailed
> 0` for a resource, the cursor stays put and the next run retries from the
same point. Check `shopify_sync.config` for the current cursor:
```sql
SELECT key, value FROM shopify_sync.config WHERE key = 'last_successful_catchup';
```

If the cursor is stuck for >24h, investigate the failures via
`shopify_sync.error_log` filtered by `source = 'worker.catchupSync'`.

---

## Adding a new resource module

1. **Probe** — check what Shopify exposes for it:
   ```bash
   npm run probe-wave-2  # or write a probe script for the new resource
   ```
   Confirm count, sample one record, decide `paginated` vs `paginated_batch`
   vs `bulk` vs `chunked_monthly` strategy (see CLAUDE.md gotchas for
   strategy-selection heuristics).

2. **Build the module** at `src/resources/<name>.ts`. Implement:
   - `transform(raw, ctx) → MainRow | null`
   - `childExtractors[]` (with shape-agnostic accessors — handle BOTH bulk
     `_children.<gidType>` AND inline `raw.<field>.edges[].node`)
   - For incremental sync: `incremental(id)` query + `softDelete(id)`
   - Composite-UNIQUE child tables: set `onConflict` explicitly

3. **Cross-module CASCADE check** — query
   `information_schema.referential_constraints` for FKs targeting any of
   this resource's child tables. If any incoming FKs are `CASCADE`, do NOT
   use `replaceByParent: true` on the corresponding extractor (see
   2026-05-07 incident #3 in CLAUDE.md). Use upsert-only with natural GIDs.

4. **Register** in `src/resources/index.ts`.

5. **Dry-run** — for chunked_monthly: `npm run dry-run-pass -- <name> 2024-08`.
   For others: `npm run sync-resource -- <name>`.

6. **Audit** — `npm run audit-data` then `npm run audit-shopify-vs-db`
   focused on the new table.

7. **Webhook coverage** (if applicable) — add the topic to the TOPICS array
   in `src/scripts/register-webhooks.ts`, add the route case to
   `src/worker/webhookProcessor.ts` `routeAndRun()`, redeploy, re-run
   `npm run register-webhooks`.

---

## Known persistent errors (do not panic)

| Pattern | Why | What to do |
|---------|-----|------------|
| `staff_users — ACCESS_DENIED on staffMembers` | Custom app missing `read_staff` scope | Ignore unless scope granted. Resource is `deferred_pending_scope`. |
| `price_rules — Field 'priceRules' doesn't exist on type 'QueryRoot'` | Shopify removed legacy priceRules in 2026-01 | Modern discount API is in `discount_codes` + `automatic_discounts`. Resource is `deferred_not_applicable`. |
| `events_audit_log — Internal Server Error on QueryRoot.events` | Shopify-side bug in 2026-01 | Wait for Shopify fix or workaround. `deferred_not_applicable`. |
| `Translation.market — ACCESS_DENIED` | Missing `read_markets` scope | `market_id` columns left null in translation tables. Translations themselves still synced. |
| `inventory_movements` — REST/CSV only | No GraphQL connection in 2026-01 | `deferred_not_applicable` — current stock state in `inventory_levels` is sufficient for our analytics. |
| `customer_segment_members` not synced | 1.4M membership tuples derivable from each segment's `query` field | We keep the 46 segment definitions only. Compute membership on demand. |
| Trailing-month `~5%` FK orphans after backfill | Live store keeps creating new records during sync | Auto-resolves on next incremental cycle. See CLAUDE.md "2026-05-04 — Trailing-month FK orphans are inevitable". |
| Tax-line tables empty for orders >= 2024-09-18 | Ourkids stopped charging tax mid-September 2024 (real shop config) | Not a sync gap. CLAUDE.md "2026-05-04 — Ourkids stopped charging tax". |
| Unresolved `error_log` from before deploy | Historical Wave 2 errors | Most are auto-resolved by `audit-data`. Manual cleanup: `UPDATE error_log SET resolved=true, resolved_at=now() WHERE created_at < '<date>' AND ...`. |

---

## Past incidents — read the postmortems

All three are detailed in [`CLAUDE.md`](./CLAUDE.md):

1. **2026-05-04 — TRUNCATE CASCADE wiped 21,331 order_refunds.** A dry-run
   cleanup `TRUNCATE shopify.order_returns ... CASCADE` propagated through
   the FK `order_refunds.return_id → order_returns.id`. Recovery: 4-hour
   `orders` re-run. **NEVER rule** added: no `TRUNCATE ... CASCADE` on
   `shopify.*` ever. For dry-run cleanup, use `DELETE WHERE` by date or
   `sync_run_id` only.

2. **2026-05-06 — Wave 2 collections corruption.** A bulk re-fetch with
   stale `products` parent caused FK violations dropping 38K
   `collection_products`. Recovery via Wave 2 staleness recovery procedure.
   Lesson: re-run parent before any cousin module that depends on it.

3. **2026-05-07 — products refresh CASCADE-wiped 444,525 inventory rows.**
   `variantsExtractor` with `replaceByParent: true` caused per-batch DELETEs
   that CASCADE-propagated through `inventory_items.variant_id → product_variants.id`,
   wiping 60,681 inventory_items + 383,844 inventory_levels. Recovery: 58-min
   `inventory_items` re-fetch. **NEVER rule** added: no `replaceByParent: true`
   on a child whose target table has cross-module CASCADE FKs incoming. Two
   schema migrations flipped the latent CASCADE FKs to RESTRICT
   (`restrict_cross_module_cascades` + `restrict_orders_cross_module_cascades`)
   so future `replaceByParent` mistakes fail loudly instead of silently.

---

## Phase 4+ future work

### Scope grants (the architect can flip these in `resource_registry`):
- `read_content` → `articles`, `blog_comments`, `blogs`, `pages`, `redirects`
- `read_metaobjects`, `read_metaobject_definitions` → custom metaobject data
- `read_companies` → B2B (only matters if Ourkids enables it)
- `read_markets` → international markets config + `Translation.market`
- `read_store_credit_account_transactions` → store credit
- `read_cash_tracking` → POS cash drawer
- `read_staff` → `order_staff_attribution`, `staff_users`
- `read_customer_payment_methods` → `customer_payment_methods`

When granted: architect updates `resource_registry.status` from
`deferred_pending_scope` → `active`, then we backfill via the existing
`sync-resource` or chunked_monthly path.

### Full incremental coverage of remaining resources
Currently incremental sync covers the 4 top-level operational resources
(orders, customers, products, collections). Other resources (discounts,
files, draft_orders, abandoned_checkouts, translations, inventory, …) rely
on the daily catchup cron + `audit-data` drift detection. Phase 4 work:
add `incremental(id)` to the next-most-active modules + register their
webhooks (e.g. `discounts/create`, `inventory_items/update`).

### Hardened webhooks (Phase 4 proper)
- Replay protection (deduplicate by signed-event-id with TTL)
- HMAC rotation procedure
- Per-topic rate limits
- Webhook-event purging (right now `webhook_events` grows forever; add a
  TTL job that moves processed rows older than 90 days to a cold-storage
  table or just `DELETE WHERE status='processed' AND received_at < now() - interval '90 days'`)

### Reconciliation cron (Phase 5)
Built on top of `incrementalRunner`:
- **Daily existence reconciliation**: SELECT IDs from Shopify that don't
  exist in our DB → enqueue incremental sync. SELECT IDs in our DB that
  don't exist in Shopify → soft-delete.
- **Weekly content reconciliation**: random-sample N records per resource,
  re-fetch via incremental, diff `_content_hash` against stored value,
  enqueue resyncs for drift > threshold.

### Auth + locked-down API (Phase 6)
The control room is currently unauthenticated. Sync controls
(`/api/sync/*`) accept any caller. Phase 6 adds bearer-token auth to all
control endpoints. Webhook receiver stays HMAC-only as it is now.

### Eventual rotation of the 3 deferred credentials
The user explicitly chose **not** to rotate the existing 3 credentials at
Phase 3C time (Shopify token, Supabase service-role key, DB password). Plan
for rotation:
1. Generate new credential in source (Shopify/Supabase)
2. Add new value to Vercel env (Production + Preview scopes) under same name
3. `vercel --prod` redeploy (picks up new value)
4. Verify `/api/health` still 200
5. Revoke old credential in source
6. (For DB password: change in Supabase, update SUPABASE_DB_PASSWORD if used)

---

## Common SQL queries

```sql
-- How many webhooks are processing right now?
SELECT count(*) FROM shopify_sync.webhook_events WHERE status = 'processing';

-- Recent failed sync runs
SELECT resource_name, run_type, status, error_message, started_at
FROM shopify_sync.sync_runs
WHERE status IN ('failed', 'partial') AND started_at > now() - interval '7 days'
ORDER BY started_at DESC LIMIT 20;

-- What incremental syncs ran today?
SELECT resource_name, status, count(*)
FROM shopify_sync.sync_runs
WHERE run_type = 'incremental' AND started_at > date_trunc('day', now())
GROUP BY resource_name, status
ORDER BY count(*) DESC;

-- Per-resource phase + last-synced
SELECT resource_name, phase, total_records_synced, last_successful_run_at
FROM shopify_sync.resource_registry
WHERE status = 'active' AND priority < 100
ORDER BY priority, resource_name;

-- Most recent webhook processed per topic
SELECT topic, max(processed_at) as last_processed
FROM shopify_sync.webhook_events
WHERE status = 'processed'
GROUP BY topic
ORDER BY last_processed DESC;
```

---

## Emergency contacts / escalation

- Architect: Claude on the web (paste any incident as context)
- Project owner: a.baharia@ourkids-eg.com
- For Shopify-side issues: Shopify Partner support
- For Supabase-side issues: Supabase Discord / support ticket via dashboard
