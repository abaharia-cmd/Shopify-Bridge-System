import { ProgressBar } from "./ProgressBar";

export interface ActiveRun {
  id: string;
  resource_name: string;
  run_type: string;
  status: string;
  started_at: string;
  elapsed_seconds: number;
  records_processed: number;
  records_inserted: number;
  records_failed: number;
  current_chunk: number | null;
  total_chunks: number | null;
  current_chunk_label: string | null;
  bulk_operation_id: string | null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function ActiveRunPanel({ run }: { run: ActiveRun | null }) {
  if (!run) return null;

  const chunkLabel = run.current_chunk_label
    ? ` · ${run.current_chunk_label}`
    : "";
  const chunkProgress = run.total_chunks
    ? `Chunk ${run.current_chunk ?? 0} / ${run.total_chunks}`
    : "Streaming…";
  const eta =
    run.total_chunks && run.current_chunk && run.current_chunk > 0
      ? formatDuration(
          Math.round(
            (run.elapsed_seconds * (run.total_chunks - run.current_chunk)) /
              run.current_chunk,
          ),
        )
      : null;

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-sky-400">Active Run</div>
          <h2 className="mt-1 text-xl font-semibold text-zinc-50">
            {run.resource_name}
            <span className="ml-2 text-sm font-normal text-zinc-400">{chunkLabel}</span>
          </h2>
        </div>
        <div className="text-right text-sm text-zinc-400">
          <div>Elapsed: {formatDuration(run.elapsed_seconds)}</div>
          {eta && <div>ETA: ~{eta}</div>}
        </div>
      </div>

      {run.total_chunks && (
        <div className="mt-4">
          <ProgressBar
            value={run.current_chunk ?? 0}
            max={run.total_chunks}
            animated
          />
          <div className="mt-1 text-xs text-zinc-500">{chunkProgress}</div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
        <Cell label="Processed" value={run.records_processed.toLocaleString()} />
        <Cell label="Upserted" value={run.records_inserted.toLocaleString()} />
        <Cell
          label="Failed"
          value={run.records_failed.toLocaleString()}
          accent={run.records_failed > 0 ? "rose" : undefined}
        />
      </div>

      {run.bulk_operation_id && (
        <div className="mt-3 text-xs text-zinc-500">
          Bulk Op: <span className="font-mono">{run.bulk_operation_id}</span>
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "rose";
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          accent === "rose" ? "text-rose-400" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
