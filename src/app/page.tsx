export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-24 font-sans dark:bg-black">
      <div className="flex max-w-xl flex-col gap-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Shopify Bridge System
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Phase 0 — Foundation OK
        </p>
      </div>
      <a
        href="/api/health"
        className="rounded-full border border-zinc-300 px-5 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
      >
        Check /api/health →
      </a>
    </main>
  );
}
