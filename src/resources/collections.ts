import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { pickChildren } from "../worker/jsonlStreamer";
import { query } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

// Shape-agnostic accessors. Bulk JSONL flattens connections under
// _children.<gidType>; incremental's regular GraphQL returns raw.<field>.edges[].node.
function edgeNodes(conn: unknown): RawPayload[] {
  const c = conn as RawPayload | undefined;
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (c.edges) return c.edges.map((e: RawPayload) => e.node);
  return [];
}
function productsOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildren(raw, "product");
  return fromBulk.length ? fromBulk : edgeNodes(raw.products);
}
function metafieldsOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildren(raw, "metafield");
  return fromBulk.length ? fromBulk : edgeNodes(raw.metafields);
}

// Bulk inner-query for collections + their products membership + metafields.
// Note: collection_rules deferred to a separate module (uuid PK with no
// natural key — needs hash-based stable IDs). collection_translations
// deferred to the translations module.
const QUERY = /* GraphQL */ `
  collections {
    edges {
      node {
        id
        legacyResourceId
        title
        handle
        description
        descriptionHtml
        templateSuffix
        sortOrder
        productsCount {
          count
        }
        ruleSet {
          appliedDisjunctively
        }
        image {
          id
          url
          altText
        }
        seo {
          title
          description
        }
        updatedAt
        products {
          edges {
            node {
              id
            }
          }
        }
        metafields {
          edges {
            node {
              id
              legacyResourceId
              namespace
              key
              value
              type
              description
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
`;

const productsExtractor: ChildExtractor = {
  table: "collection_products",
  parentFk: "collection_id",
  replaceByParent: true,
  onConflict: "collection_id,product_id",
  extract: (raw, parent, ctx) => {
    const products = productsOf(raw);
    return products.map((p, idx) => ({
      collection_id: parent.id,
      product_id: p.id,
      position: idx + 1,
      added_at: ctx.now,
    }));
  },
};

const metafieldsExtractor: ChildExtractor = {
  table: "collection_metafields",
  parentFk: "collection_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    const mfs = metafieldsOf(raw);
    return mfs.map((m) => {
      const legacy = ctx.parseGid(m.id).legacyId;
      return {
        id: m.id,
        collection_id: parent.id,
        legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
        namespace: m.namespace,
        key: m.key,
        value: m.value ?? null,
        type: m.type ?? null,
        description: m.description ?? null,
        created_at: m.createdAt ?? null,
        updated_at: m.updatedAt ?? null,
        raw_payload: m,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(m),
      };
    });
  },
};

const collections: ResourceModule = {
  resourceName: "collections",
  category: "catalog",
  table: "collections",
  syncStrategy: "bulk",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      title: raw.title ?? null,
      handle: raw.handle ?? null,
      description: raw.description ?? null,
      description_html: raw.descriptionHtml ?? null,
      template_suffix: raw.templateSuffix ?? null,
      sort_order: raw.sortOrder ?? null,
      products_count: raw.productsCount?.count ?? null,
      has_product: null,
      rule_set_applied_disjunctively: raw.ruleSet?.appliedDisjunctively ?? null,
      // rule_set_rules captured as raw_payload subset; full rules go to
      // collection_rules in a future module.
      rule_set_rules: null,
      image_url: raw.image?.url ?? null,
      image_alt: raw.image?.altText ?? null,
      image_id: raw.image?.id ?? null,
      seo_title: raw.seo?.title ?? null,
      seo_description: raw.seo?.description ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [productsExtractor, metafieldsExtractor],

  // ─── Phase 3B incremental sync ───────────────────────────────────────────
  // Note: collection.products is a connection in the Admin API but the
  // membership is also reachable via product.collections — the choice here
  // mirrors the bulk QUERY for consistency (single source of truth: this
  // collection's CURRENT product membership). Smart-collection ruleSet recompute
  // on Shopify's side may also change membership; an updated_at webhook will
  // trigger this incremental pull and the new membership will replace the old
  // (replaceByParent on collection_products).
  incremental: async (id: string): Promise<RawPayload | null> => {
    const data = await query<{ collection: RawPayload | null }>(
      /* GraphQL */ `
        query CollectionById($id: ID!) {
          collection(id: $id) {
            id
            legacyResourceId
            title
            handle
            description
            descriptionHtml
            templateSuffix
            sortOrder
            productsCount {
              count
            }
            ruleSet {
              appliedDisjunctively
            }
            image {
              id
              url
              altText
            }
            seo {
              title
              description
            }
            updatedAt
            products(first: 250) {
              edges {
                node {
                  id
                }
              }
            }
            metafields(first: 250) {
              edges {
                node {
                  id
                  legacyResourceId
                  namespace
                  key
                  value
                  type
                  description
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      `,
      { id },
    );
    return data.collection ?? null;
  },

  softDelete: async (id: string): Promise<void> => {
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb
      .from("collections")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`collections.softDelete ${id}: ${error.message}`);
  },
};

export default collections;
