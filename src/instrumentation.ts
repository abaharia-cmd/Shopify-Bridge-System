// Next.js instrumentation hook (App Router).
// Runs once per process at server startup.
//
// Note: Phase 2 spec called for `next.config.ts` instrumentation; the
// supported Next.js mechanism is this file. Same effect.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootOnce } = await import("./lib/initBoot");
    await bootOnce();
  }
}
