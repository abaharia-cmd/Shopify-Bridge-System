export interface ErrorRow {
  id: string;
  occurred_at: string;
  severity: string;
  source: string;
  resource_name: string | null;
  error_code: string | null;
  error_message: string;
  resolved: boolean;
}

const SEV_COLOR: Record<string, string> = {
  info: "text-zinc-400",
  warning: "text-amber-400",
  error: "text-rose-400",
  critical: "text-rose-500 font-semibold",
};

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ErrorLog({
  rows,
  onRetry,
}: {
  rows: ErrorRow[];
  onRetry: (resourceName: string | null) => void;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-6 text-center text-sm text-zinc-500">
        No errors in the last 7 days.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">Time</th>
            <th className="px-4 py-2 font-medium">Severity</th>
            <th className="px-4 py-2 font-medium">Resource</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Message</th>
            <th className="px-4 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-zinc-900/40">
              <td className="px-4 py-2 text-xs text-zinc-500 whitespace-nowrap">
                {shortTime(r.occurred_at)}
              </td>
              <td className={`px-4 py-2 text-xs uppercase ${SEV_COLOR[r.severity] ?? "text-zinc-300"}`}>
                {r.severity}
              </td>
              <td className="px-4 py-2 text-zinc-300">{r.resource_name ?? "—"}</td>
              <td className="px-4 py-2 text-xs text-zinc-500 whitespace-nowrap">{r.source}</td>
              <td className="px-4 py-2 max-w-xl truncate text-zinc-200" title={r.error_message}>
                {r.error_message}
              </td>
              <td className="px-4 py-2">
                {r.resource_name && !r.resolved && (
                  <button
                    onClick={() => onRetry(r.resource_name)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
                  >
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
