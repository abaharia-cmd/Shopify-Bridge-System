import { NextResponse } from "next/server";
import { cancelActiveRun } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await cancelActiveRun();
  return NextResponse.json({ ok: true });
}
