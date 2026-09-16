export function ProgressBar({
  value,
  max,
  className = "",
  animated = false,
}: {
  value: number;
  max: number;
  className?: string;
  animated?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-zinc-800 ${className}`}>
      <div
        className={`h-full rounded-full bg-sky-500 transition-all duration-500 ${animated ? "animate-pulse" : ""}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
