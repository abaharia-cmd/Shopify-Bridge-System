import { NextResponse } from "next/server";
import { resumeBulk } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resume ingest of a `bulk` resource from its existing JSONL URL — bypasses
// Shopify resubmission. Useful when ingest crashed mid-stream or when fixing
// worker code without paying the 5-30 min Shopify generation wait again.
//
// Body: { "resourceName": "customers" }
export async function POST(req: Request) {
  let resourceName: string | undefined;
  try {
    const body = (await req.json()) as { resourceName?: string };
    resourceName = body?.resourceName;
  } catch {
    // ignore
  }
  if (!resourceName) {
    return NextResponse.json(
      { ok: false, error: "resourceName required" },
      { status: 400 },
    );
  }
  try {
    const result = await resumeBulk({
      resourceName,
      triggeredBy: "control-room.resume-bulk",
    });
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
