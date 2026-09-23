// Wave 2 Group D: collection_rules — fetched by walking collections and
// extracting the `ruleSet.rules` LIST per smart collection. skipParentUpsert
// since `collections` is already complete.
//
// Each rule is a row with surrogate UUID PK + (collection_id, rule_column,
// relation, condition) as the natural key. No DB UNIQUE constraint enforces
// the natural key, but replaceByParent handles re-runs cleanly: delete-by-
// parent (when not skipped) then insert fresh.

import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

const QUERY = /* GraphQL */ `
  query CollectionRulesPage($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          ruleSet {
            appliedDisjunctively
            rules { column relation condition conditionObject { __typename } }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const rulesExtractor: ChildExtractor = {
  table: "collection_rules",
  parentFk: "collection_id",
  replaceByParent: true,
  extract: (raw, parent) => {
    const rules: RawPayload[] = raw?.ruleSet?.rules ?? [];
    return rules.map((r) => ({
      collection_id: parent.id,
      rule_column: r.column ?? null,
      relation: r.relation ?? null,
      condition: r.condition ?? null,
      condition_object_id: null,
      raw_payload: r,
      synced_at: parent.synced_at,
    }));
  },
};

const collection_rules: ResourceModule = {
  resourceName: "collection_rules",
  category: "catalog",
  table: "collections",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  skipParentUpsert: true,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    return { id: raw.id, raw_payload: {}, synced_at: ctx.now, _content_hash: "" } as MainRow;
  },
  childExtractors: [rulesExtractor],
};

export default collection_rules;
