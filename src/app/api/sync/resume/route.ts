import { NextResponse } from "next/server";
import { resumeActiveRun } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await resumeActiveRun();
  return NextResponse.json({ ok: true });
}
