import { NextResponse } from "next/server";
import { pauseActiveRun } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await pauseActiveRun();
  return NextResponse.json({ ok: true });
}
