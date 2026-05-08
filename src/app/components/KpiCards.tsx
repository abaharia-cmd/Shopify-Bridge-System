export interface Kpis {
  lastSyncAt: string | null;
  totalRecordsSynced: number;
  modelsOk: number;
  modelsFailed: number;
  errors24h: number;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function KpiCards({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card label="Last Sync" value={formatRelative(kpis.lastSyncAt)} />
      <Card label="Records Synced" value={fmt(kpis.totalRecordsSynced)} />
      <Card label="Models OK" value={fmt(kpis.modelsOk)} />
      <Card
        label="Errors (24h)"
        value={fmt(kpis.errors24h)}
        accent={kpis.errors24h > 0 ? "rose" : "emerald"}
      />
    </div>
  );
}

function Card({
  label,
  value,
  accent = "default",
}: {
  label: string;
  value: string;
  accent?: "default" | "rose" | "emerald";
}) {
  const accentClass =
    accent === "rose"
      ? "text-rose-400"
      : accent === "emerald"
        ? "text-emerald-400"
        : "text-zinc-50";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accentClass}`}>{value}</div>
    </div>
  );
}
