"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KpiCards, type Kpis } from "./KpiCards";
import { Pipeline, type PipelineState } from "./Pipeline";
import { ResourceTable, type ResourceRow } from "./ResourceTable";
import { ActiveRunPanel, type ActiveRun } from "./ActiveRunPanel";
import { ErrorLog, type ErrorRow } from "./ErrorLog";

interface State {
  timestamp: string;
  shop: { name: string | null; myshopify_domain: string | null; plan_display_name: string | null } | null;
  kpis: Kpis;
  pipeline: PipelineState;
  resources: ResourceRow[];
  activeRun: ActiveRun | null;
  recentErrors: ErrorRow[];
}

const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 30000;

export function ControlRoom() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<"start" | "pause" | "resume" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/control-room/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as State;
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll: 2s when active, 30s when idle. Re-arm whenever activeRun toggles.
  // The first fetch is delayed by one tick so the effect itself doesn't
  // synchronously dispatch a state update.
  useEffect(() => {
    const ms = state?.activeRun ? POLL_FAST_MS : POLL_SLOW_MS;
    const id = setInterval(() => {
      void fetchState();
    }, ms);
    intervalRef.current = id;
    return () => {
      clearInterval(id);
    };
  }, [state?.activeRun, fetchState]);

  // Initial fetch (separate from the polling effect so it can't cascade).
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchState();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchState]);

  const post = useCallback(
    async (path: string, body?: object) => {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      await fetchState();
    },
    [fetchState],
  );

  const handleStart = async () => {
    setBusy("start");
    try {
      await post("/api/sync/start", { triggeredBy: "control-room.button" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const handlePause = async () => {
    setBusy("pause");
    try {
      await post("/api/sync/pause");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const handleResume = async () => {
    setBusy("resume");
    try {
      await post("/api/sync/resume");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const handleCancel = async () => {
    setBusy("cancel");
    try {
      await post("/api/sync/cancel");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const handleRetry = useCallback(
    async (resourceName: string | null) => {
      if (!resourceName) return;
      try {
        await post("/api/sync/retry", { resourceName });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [post],
  );

  const isActive = !!state?.activeRun;
  const isPaused = state?.activeRun?.status === "paused";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <div className="text-sm text-zinc-500">Shopify Bridge System</div>
            <h1 className="text-lg font-semibold">
              {state?.shop?.name ?? "—"}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {state?.shop?.myshopify_domain}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {!isActive && (
              <button
                onClick={handleStart}
                disabled={busy === "start"}
                className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-sky-400 disabled:opacity-50"
              >
                {busy === "start" ? "Starting…" : "Start Initial Sync"}
              </button>
            )}
            {isActive && !isPaused && (
              <button
                onClick={handlePause}
                disabled={busy === "pause"}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
              >
                {busy === "pause" ? "Pausing…" : "Pause"}
              </button>
            )}
            {isPaused && (
              <button
                onClick={handleResume}
                disabled={busy === "resume"}
                className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-sky-400 disabled:opacity-50"
              >
                {busy === "resume" ? "Resuming…" : "Resume"}
              </button>
            )}
            {isActive && (
              <button
                onClick={handleCancel}
                disabled={busy === "cancel"}
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        {error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        {!state ? (
          <div className="text-zinc-500">Loading…</div>
        ) : (
          <>
            <KpiCards kpis={state.kpis} />
            <Pipeline state={state.pipeline} />
            {state.activeRun && <ActiveRunPanel run={state.activeRun} />}

            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
                Resources
              </h2>
              <ResourceTable rows={state.resources} onRetry={handleRetry} />
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
                Recent Errors
              </h2>
              <ErrorLog rows={state.recentErrors} onRetry={handleRetry} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
