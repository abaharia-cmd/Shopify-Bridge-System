type Variant = "done" | "syncing" | "waiting" | "failed" | "paused" | "deferred" | "partial";

const STYLES: Record<Variant, string> = {
  done: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30",
  syncing: "bg-sky-500/10 text-sky-400 ring-sky-500/30",
  waiting: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",
  failed: "bg-rose-500/10 text-rose-400 ring-rose-500/30",
  paused: "bg-amber-500/10 text-amber-400 ring-amber-500/30",
  deferred: "bg-indigo-500/10 text-indigo-400 ring-indigo-500/30",
  partial: "bg-orange-500/10 text-orange-400 ring-orange-500/30",
};

export function StatusBadge({
  variant,
  label,
  pulse = false,
}: {
  variant: Variant;
  label: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[variant]}`}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      )}
      {label}
    </span>
  );
}

export function variantFromRunStatus(
  status: string | null | undefined,
): { variant: Variant; label: string; pulse?: boolean } {
  switch (status) {
    case "succeeded":
      return { variant: "done", label: "Done" };
    case "running":
      return { variant: "syncing", label: "Syncing", pulse: true };
    case "queued":
      return { variant: "waiting", label: "Queued" };
    case "paused":
      return { variant: "paused", label: "Paused" };
    case "failed":
      return { variant: "failed", label: "Failed" };
    case "cancelled":
      return { variant: "failed", label: "Cancelled" };
    case "partial":
      return { variant: "partial", label: "Partial" };
    default:
      return { variant: "waiting", label: status ?? "Idle" };
  }
}
