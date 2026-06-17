import { NextResponse } from "next/server";
import { retryChunk } from "@/worker/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as { resourceName?: string; chunkLabel?: string };
  if (!body?.resourceName) {
    return NextResponse.json(
      { ok: false, error: "resourceName required" },
      { status: 400 },
    );
  }
  const result = await retryChunk({
    resourceName: body.resourceName,
    chunkLabel: body.chunkLabel,
  });
  return NextResponse.json({ ok: true, ...result }, { status: 202 });
}
