// Compute year-month boundaries used by chunkedMonthlyRunner.
// A chunk represents a half-open interval [start, end) — Shopify's `query`
// arg uses inclusive lower / exclusive upper to avoid month-boundary dupes.

export interface MonthChunk {
  label: string; // 'YYYY-MM'
  startISO: string; // 'YYYY-MM-01T00:00:00Z'
  endISO: string; // first day of the following month, same time
  index: number; // 0-based, oldest first
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function monthChunks(earliestISO: string, nowISO: string): MonthChunk[] {
  const start = new Date(earliestISO);
  const now = new Date(nowISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(now.getTime())) {
    throw new Error(`monthChunks: invalid dates ${earliestISO} / ${nowISO}`);
  }
  const chunks: MonthChunk[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-indexed
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  let i = 0;
  while (y < endY || (y === endY && m <= endM)) {
    const ny = m === 11 ? y + 1 : y;
    const nm = m === 11 ? 0 : m + 1;
    chunks.push({
      label: `${y}-${pad(m + 1)}`,
      startISO: `${y}-${pad(m + 1)}-01T00:00:00Z`,
      endISO: `${ny}-${pad(nm + 1)}-01T00:00:00Z`,
      index: i++,
    });
    y = ny;
    m = nm;
  }
  return chunks;
}

// Build a Shopify `query` filter for the chunk's created_at range.
// Format: `created_at:>=2024-08-01T00:00:00Z created_at:<2024-09-01T00:00:00Z`
export function chunkQueryFilter(chunk: MonthChunk, field = "created_at"): string {
  return `${field}:>=${chunk.startISO} ${field}:<${chunk.endISO}`;
}
