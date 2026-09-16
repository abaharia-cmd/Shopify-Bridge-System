// Wave 2 Group F: collection translations.
import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { extractTranslations } from "./_translations_helpers";

const QUERY = /* GraphQL */ `
  query CollectionTranslationsPage($cursor: String) {
    translatableResources(first: 100, after: $cursor, resourceType: COLLECTION) {
      edges {
        node {
          resourceId
          translations(locale: "ar") { key value locale outdated }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const translationsExtractor: ChildExtractor = {
  table: "collection_translations",
  parentFk: "collection_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    return extractTranslations(raw, ctx.hashContent, ctx.now).map((t) => ({
      collection_id: parent.id,
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

const collection_translations: ResourceModule = {
  resourceName: "collection_translations",
  category: "catalog",
  table: "collections",
  syncStrategy: "paginated_batch",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.resourceId) return null;
    return { id: raw.resourceId, raw_payload: {}, synced_at: ctx.now, _content_hash: "" } as MainRow;
  },
  childExtractors: [translationsExtractor],
};

export default collection_translations;
