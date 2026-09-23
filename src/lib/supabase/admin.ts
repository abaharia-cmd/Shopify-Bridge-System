// SERVER-ONLY. Holds the Supabase service-role key — never import into a client component.
// (The SUPABASE_SECRET_KEY is not prefixed with NEXT_PUBLIC_, so Next.js will refuse to
// bundle this module into client code anyway. Phase 6 may add the `server-only` package
// for a build-time guarantee.)
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

export type SchemaName = "shopify_sync" | "shopify";

// Until Phase 1 generates real types via `supabase gen types`, the client is
// loosely typed. Phase 1 will replace this with a generated Database type and
// proper per-schema generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

const baseOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

const cached = new Map<SchemaName, AnyClient>();

// Default client targets `shopify_sync` (metadata reads/writes most of the
// foundation/sync code touches). For Phase 2+ writes into the `shopify` data
// schema, call `getSupabaseAdmin('shopify')`.
export function getSupabaseAdmin(schema: SchemaName = "shopify_sync"): AnyClient {
  const existing = cached.get(schema);
  if (existing) return existing;
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    ...baseOptions,
    db: { schema },
  } as never) as AnyClient;
  cached.set(schema, client);
  return client;
}

export const supabaseAdmin = getSupabaseAdmin("shopify_sync");
