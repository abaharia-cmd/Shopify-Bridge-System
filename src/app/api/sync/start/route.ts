import { NextResponse } from "next/server";
import { startBackfill } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let triggeredBy = "control-room";
  try {
    const body = (await req.json()) as { triggeredBy?: string };
    if (body?.triggeredBy) triggeredBy = body.triggeredBy;
  } catch {
    // empty body is fine
  }
  const { masterRunId } = await startBackfill({ triggeredBy });
  return NextResponse.json({ ok: true, masterRunId }, { status: 202 });
}
