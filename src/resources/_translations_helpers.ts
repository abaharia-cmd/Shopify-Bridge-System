// Shared helpers for the 3 translation modules. Maps a translatableResource
// node + its translations into per-row records.
import type { RawPayload } from "./types";

export interface TranslationRow {
  resource_id: string;
  locale: string;
  field_key: string;
  field_value: string | null;
  outdated: boolean | null;
  market_id: string | null;
  raw_payload: unknown;
  synced_at: Date;
  _content_hash: string;
}

export function extractTranslations(
  parentRaw: RawPayload,
  hashContent: (o: unknown) => string,
  now: Date,
): TranslationRow[] {
  const out: TranslationRow[] = [];
  const translations: RawPayload[] = parentRaw?.translations ?? [];
  for (const t of translations) {
    out.push({
      resource_id: parentRaw.resourceId,
      locale: t.locale,
      field_key: t.key,
      field_value: t.value ?? null,
      outdated: t.outdated ?? null,
      market_id: null, // Translation.market requires read_markets scope (Ourkids token doesn't have it)
      raw_payload: t,
      synced_at: now,
      _content_hash: hashContent(t),
    });
  }
  return out;
}
