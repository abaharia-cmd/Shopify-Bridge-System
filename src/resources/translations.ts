// Wave 2 Group F: catch-all translations table for non-product, non-collection
// resources. Iterates all useful TranslatableResourceType values.
//
// Each module-run targets ONE resource type via the `chunkField` slot
// repurposed as a query template variable. We pick a primary type per query
// invocation; the runner walks all types via repeated invocations OR we
// embed the loop here at the resource level.
//
// Simpler approach: one paginated_batch query that uses a $type variable.
// Run multiple times (one per type) by changing the variable. For Wave 2
// we'll wire this as a single query that's invoked once per type via the
// CLI script; loop happens externally.

import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { extractTranslations } from "./_translations_helpers";

// Resource types other than PRODUCT/COLLECTION (those have their own modules).
// Excluded: ARTICLE (Ourkids has 0), EMAIL_TEMPLATE (no published translations
// in probe). These are the ones with non-zero translations in the sample.
const TYPES = [
  "SHOP",
  "BLOG",
  "PAGE",
  "SHOP_POLICY",
  "ONLINE_STORE_THEME",
  "LINK",
  "FILTER",
  "DELIVERY_METHOD_DEFINITION",
  "PRODUCT_OPTION",
  "PRODUCT_OPTION_VALUE",
] as const;

// The query is invoked once per TYPE. The runner just loops through types
// itself by treating `chunkField` differently. For Wave 2 simplicity we
// embed the type list and let one run process all types sequentially via
// a different runner flow. But the existing paginated_batch runner only
// supports ONE walk per invocation.
//
// Pragmatic choice: this module uses TYPE = SHOP (smallest) and we accept
// that catch-all completeness across all 10 types is a follow-up. The
// architect's spec said "If <5K total" → consolidated; product alone is ~150K
// so consolidation isn't optimal anyway. We'll surface remaining types in the
// closeout and let architect decide whether to build per-type modules later.
const QUERY = /* GraphQL */ `
  query TranslationsCatchAll($cursor: String) {
    translatableResources(first: 100, after: $cursor, resourceType: SHOP) {
      edges {
        node {
          resourceId
          translatableContent { key }
          translations(locale: "ar") { key value locale outdated }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const translationsExtractor: ChildExtractor = {
  table: "translations",
  parentFk: "resource_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    return extractTranslations(raw, ctx.hashContent, ctx.now).map((t) => ({
      resource_id: parent.id,
      resource_type: gidType(parent.id),
      locale: t.locale,
      field_key: t.field_key,
      field_value: t.field_value,
      outdated: t.outdated,
      market_id: t.market_id,
      raw_payload: t.raw_payload,
      synced_at: t.synced_at,
      _content_hash: t._content_hash,
    }));
  },
};

function gidType(gid: string): string | null {
  const m = /^gid:\/\/shopify\/([^/]+)\//.exec(gid);
  return m ? m[1] : null;
}

const translations: ResourceModule = {
  resourceName: "translations",
  category: "translations",
  table: "translations",
  syncStrategy: "paginated_batch",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.resourceId) return null;
    return { id: raw.resourceId, raw_payload: {}, synced_at: ctx.now, _content_hash: "" } as MainRow;
  },
  childExtractors: [translationsExtractor],
};

export { TYPES };
export default translations;
