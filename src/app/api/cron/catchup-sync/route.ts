// Vercel Cron endpoint — invoked daily (3 AM Cairo per Phase 5 plan).
// Runs the safety-net catchup sync for the 4 top-level resources.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to the URL
// configured in vercel.json. We accept either that OR an `x-cron-secret`
// header for local testing. A 401 if neither is present and matches.

import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runCatchupSync } from "@/worker/catchupSync";
import { processWebhookQueue } from "@/worker/webhookProcessor";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Per Vercel docs: cron-triggered routes get up to 300s on Pro / 800s on
// Enterprise. The default is 60s, which is too short for catchup of a few
// thousand records at ~100ms each.
export const maxDuration = 300;

const log = logger.child({ module: "api.cron.catchup-sync" });

function isAuthorized(req: Request): boolean {
  // Accept either CATCHUP_CRON_SECRET (our app's own var, used by manual cURL
  // invocations) OR CRON_SECRET (Vercel's system-managed var that it signs
  // cron requests with). Vercel auto-injects CRON_SECRET into the env and
  // uses it as Authorization: Bearer; we must read that exact value.
  const ours = config.CATCHUP_CRON_SECRET;
  const vercel = process.env.CRON_SECRET;
  if (!ours && !vercel) {
    // No secret configured = local dev mode — allow.
    return true;
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (ours && authHeader === `Bearer ${ours}`) return true;
  if (vercel && authHeader === `Bearer ${vercel}`) return true;
  if (ours && req.headers.get("x-cron-secret") === ours) return true;
  return false;
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    log.warn("catchup-sync: unauthorized request");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Drain any pending webhook events first — if the receiver was offline
  // briefly, this is the only thing standing between us and a stale catchup.
  const webhookResult = await processWebhookQueue({ maxEvents: 200 });

  // Then run the actual catchup pull from Shopify.
  const summary = await runCatchupSync();

  const status = summary.ok ? 200 : 207; // 207 Multi-Status for partial success
  return NextResponse.json({ webhookProcessor: webhookResult, catchup: summary }, { status });
}

// Allow POST too — useful for local manual invocation: curl -X POST ...
export const POST = GET;
