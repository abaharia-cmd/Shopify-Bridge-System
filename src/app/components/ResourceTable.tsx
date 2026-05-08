import { StatusBadge, variantFromRunStatus } from "./StatusBadge";
import { ProgressBar } from "./ProgressBar";

export interface ResourceRow {
  resource_name: string;
  display_name: string;
  category: string;
  status: string;
  phase: string;
  is_deferred: boolean;
  total_records_synced: number;
  last_backfill_at: string | null;
  last_run_status: string | null;
  last_run_records_processed: number | null;
  last_run_records_failed: number | null;
  last_run_current_chunk: number | null;
  last_run_total_chunks: number | null;
  last_run_current_chunk_label: string | null;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function ResourceTable({
  rows,
  onRetry,
}: {
  rows: ResourceRow[];
  onRetry: (resourceName: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Resource</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Progress</th>
              <th className="px-4 py-2 font-medium text-right">Records</th>
              <th className="px-4 py-2 font-medium">Last Sync</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((r) => {
              const v = r.is_deferred
                ? { variant: "deferred" as const, label: "Deferred" }
                : variantFromRunStatus(r.last_run_status);
              const showProgress = r.last_run_total_chunks && r.last_run_current_chunk;
              return (
                <tr key={r.resource_name} className="hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-100">{r.display_name}</div>
                    <div className="text-xs text-zinc-500">{r.resource_name}</div>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{r.category}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge variant={v.variant} label={v.label} pulse={v.pulse} />
                  </td>
                  <td className="px-4 py-2.5">
                    {showProgress ? (
                      <div className="flex flex-col gap-1">
                        <ProgressBar
                          value={r.last_run_current_chunk ?? 0}
                          max={r.last_run_total_chunks ?? 1}
                        />
                        <span className="text-xs text-zinc-500">
                          {r.last_run_current_chunk_label
                            ? `${r.last_run_current_chunk_label} · `
                            : ""}
                          {r.last_run_current_chunk}/{r.last_run_total_chunks}
                        </span>
                      </div>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">
                    {fmt(r.total_records_synced)}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{timeAgo(r.last_backfill_at)}</td>
                  <td className="px-4 py-2.5">
                    {(r.last_run_status === "failed" || r.last_run_status === "partial") && (
                      <button
                        onClick={() => onRetry(r.resource_name)}
                        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  No resources registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
