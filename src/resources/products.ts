import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

// Bulk inner query for products with full nested set.
const QUERY = /* GraphQL */ `
  products {
    edges {
      node {
        id
        legacyResourceId
        title
        handle
        description
        descriptionHtml
        productType
        vendor
        status
        tags
        templateSuffix
        isGiftCard
        combinedListingRole
        category {
          id
          fullName
        }
        totalInventory
        tracksInventory
        hasOnlyDefaultVariant
        hasOutOfStockVariants
        hasVariantsThatRequiresComponents
        onlineStoreUrl
        onlineStorePreviewUrl
        variantsCount {
          count
        }
        mediaCount {
          count
        }
        requiresSellingPlan
        seo {
          title
          description
        }
        priceRangeV2 {
          minVariantPrice {
            amount
            currencyCode
          }
          maxVariantPrice {
            amount
            currencyCode
          }
        }
        compareAtPriceRange {
          minVariantCompareAtPrice {
            amount
            currencyCode
          }
          maxVariantCompareAtPrice {
            amount
            currencyCode
          }
        }
        featuredMedia {
          preview {
            image {
              url
              altText
            }
          }
        }
        createdAt
        updatedAt
        publishedAt
        options {
          id
          name
          position
          values
          linkedMetafield {
            namespace
            key
          }
          optionValues {
            id
            name
            hasVariants
            swatch {
              color
              image {
                id
              }
            }
            linkedMetafieldValue
          }
        }
        variants {
          edges {
            node {
              id
              legacyResourceId
              title
              displayName
              sku
              barcode
              position
              price
              compareAtPrice
              taxable
              taxCode
              inventoryPolicy
              inventoryQuantity
              inventoryItem {
                id
              }
              availableForSale
              requiresComponents
              selectedOptions {
                name
                value
              }
              image {
                id
                url
                altText
              }
              createdAt
              updatedAt
            }
          }
        }
        media {
          edges {
            node {
              id
              mediaContentType
              alt
              status
              ... on MediaImage {
                image {
                  url
                  width
                  height
                  altText
                }
                mimeType
              }
              ... on Video {
                duration
                originalSource {
                  url
                }
                preview {
                  image {
                    url
                    altText
                  }
                }
              }
              ... on ExternalVideo {
                embedUrl
                host
              }
              ... on Model3d {
                originalSource {
                  url
                }
              }
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
        resourcePublicationsV2 {
          edges {
            node {
              isPublished
              publishDate
              publication {
                id
              }
            }
          }
        }
      }
    }
  }
`;

import { pickChildren, pickChildrenWhere } from "../worker/jsonlStreamer";
import { query } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

function edgeNodes(connOrChildren: unknown): RawPayload[] {
  const c = connOrChildren as RawPayload | undefined;
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (c.edges) return c.edges.map((e: RawPayload) => e.node);
  return [];
}

// Shape-agnostic accessors. Bulk JSONL flattens connections under
// `_children.<gidType>`; regular GraphQL returns `raw.<field>.edges[].node`.
// Extractors (and the transform) have to handle both because the same
// `transform` runs from `bulkRunner.applyBatch` AND `applyOne` (incremental).
function variantsOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildren(raw, "product_variant");
  return fromBulk.length ? fromBulk : edgeNodes(raw.variants);
}
function mediaOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildren(raw, "media_image", "video", "external_video", "model3d");
  return fromBulk.length ? fromBulk : edgeNodes(raw.media);
}
function metafieldsOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildren(raw, "metafield");
  return fromBulk.length ? fromBulk : edgeNodes(raw.metafields);
}
function publicationsOf(raw: RawPayload): RawPayload[] {
  const fromBulk = pickChildrenWhere(
    raw,
    (c) => Boolean(c?.publication?.id) && "isPublished" in c,
  );
  return fromBulk.length ? fromBulk : edgeNodes(raw.resourcePublicationsV2);
}

const optionsExtractor: ChildExtractor = {
  table: "product_options",
  parentFk: "product_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) =>
    (raw.options ?? []).map((o: RawPayload) => ({
      id: o.id,
      product_id: parent.id,
      name: o.name,
      position: o.position ?? null,
      values: o.values ?? null,
      linked_metafield_namespace: o.linkedMetafield?.namespace ?? null,
      linked_metafield_key: o.linkedMetafield?.key ?? null,
      raw_payload: o,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(o),
    })),
};

const optionValuesExtractor: ChildExtractor = {
  table: "product_option_values",
  parentFk: "product_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    const rows: Record<string, unknown>[] = [];
    for (const opt of raw.options ?? []) {
      for (const v of opt.optionValues ?? []) {
        rows.push({
          id: v.id,
          option_id: opt.id,
          product_id: parent.id,
          name: v.name ?? null,
          position: null,
          has_variants: v.hasVariants ?? null,
          swatch: v.swatch ?? null,
          linked_metaobject_value: v.linkedMetafieldValue ?? null,
          raw_payload: v,
          synced_at: ctx.now,
          _content_hash: ctx.hashContent(v),
        });
      }
    }
    return rows;
  },
};

const variantsExtractor: ChildExtractor = {
  table: "product_variants",
  parentFk: "product_id",
  // upsert-only: NO replaceByParent. The DELETE-then-insert pattern would
  // CASCADE-wipe inventory_items + product_variant_metafields (different
  // modules) — that's the 2026-05-07 incident #3. Phase 1 schema migration
  // restrict_cross_module_cascades flipped those FKs to RESTRICT so a
  // future replaceByParent here would FAIL loudly instead of silently wiping.
  // Variants have natural Shopify GIDs, so id-based upsert is idempotent.
  // "Remove variants Shopify deleted" semantics will be handled by webhook
  // events (Phase 4 incremental sync) or periodic reconciliation.
  // See CLAUDE.md NEVER rule about cross-module CASCADE.
  extract: (raw, parent, ctx) => {
    // Shape-agnostic: bulk JSONL flattens variants under _children.product_variant;
    // incremental's regular GraphQL returns them under raw.variants.edges[].node.
    const variants = variantsOf(raw);
    return variants.map((v) => {
      const legacy = ctx.parseGid(v.id).legacyId;
      return {
        id: v.id,
        product_id: parent.id,
        legacy_resource_id: Number(v.legacyResourceId ?? legacy) || null,
        title: v.title ?? null,
        display_name: v.displayName ?? null,
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        position: v.position ?? null,
        price: v.price ?? null,
        compare_at_price: v.compareAtPrice ?? null,
        taxable: v.taxable ?? null,
        tax_code: v.taxCode ?? null,
        inventory_policy: v.inventoryPolicy ?? null,
        inventory_quantity: v.inventoryQuantity ?? null,
        inventory_management: null,
        inventory_item_id: v.inventoryItem?.id ?? null,
        available_for_sale: v.availableForSale ?? null,
        requires_components: v.requiresComponents ?? null,
        selected_options: v.selectedOptions ?? null,
        metafields_count: null,
        presentment_prices: v.presentmentPrices ?? null,
        contextual_pricing: null,
        weight: null,
        weight_unit: null,
        image_url: v.image?.url ?? null,
        image_alt: v.image?.altText ?? null,
        image_id: v.image?.id ?? null,
        created_at: v.createdAt ?? null,
        updated_at: v.updatedAt ?? null,
        raw_payload: v,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(v),
      };
    });
  },
};

const mediaExtractor: ChildExtractor = {
  table: "product_media",
  parentFk: "product_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    // Shape-agnostic: bulk JSONL flattens media under their concrete gid type;
    // incremental returns them inline at raw.media.edges[].node.
    const media = mediaOf(raw);
    return media.map((m, idx) => ({
      id: m.id,
      product_id: parent.id,
      media_content_type: m.mediaContentType,
      alt: m.alt ?? null,
      position: idx + 1,
      status: m.status ?? null,
      mime_type: m.mimeType ?? null,
      image_url: m.image?.url ?? null,
      image_width: m.image?.width ?? null,
      image_height: m.image?.height ?? null,
      preview_image_url: m.preview?.image?.url ?? null,
      preview_image_alt: m.preview?.image?.altText ?? null,
      sources: m.originalSource ?? null,
      duration: m.duration ?? null,
      origin_url: m.originalSource?.url ?? null,
      embed_url: m.embedUrl ?? null,
      host: m.host ?? null,
      raw_payload: m,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(m),
    }));
  },
};

const productMetafieldsExtractor: ChildExtractor = {
  table: "product_metafields",
  parentFk: "product_id",
  replaceByParent: true,
  // Composite UNIQUE on (product_id, namespace, key) — Shopify can re-emit
  // the same metafield with a different GID after edits, so route the upsert
  // to the natural-key constraint, not just the surrogate `id` PK.
  onConflict: "product_id,namespace,key",
  extract: (raw, parent, ctx) => {
    // Shape-agnostic: bulk via _children.metafield, incremental via raw.metafields.edges.
    const mfs = metafieldsOf(raw);
    return mfs.map((m) => {
      const legacy = ctx.parseGid(m.id).legacyId;
      return {
        id: m.id,
        product_id: parent.id,
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

const variantMetafieldsExtractor: ChildExtractor = {
  table: "product_variant_metafields",
  parentFk: "product_id",
  replaceByParent: true,
  extract: (raw, parent, ctx) => {
    // Variant metafields are NOT in the bulk query (had to drop to stay under
    // Shopify's 5-connection limit). Phase 3 will backfill via reconciliation.
    // Returning [] keeps the schema column shape but writes nothing.
    const rows: Record<string, unknown>[] = [];
    const variants = variantsOf(raw);
    for (const v of variants) {
      const mfs = edgeNodes(v.metafields);
      for (const m of mfs) {
        const legacy = ctx.parseGid(m.id).legacyId;
        rows.push({
          id: m.id,
          variant_id: v.id,
          product_id: parent.id,
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
        });
      }
    }
    return rows;
  },
};

const publicationsExtractor: ChildExtractor = {
  table: "product_publications",
  parentFk: "product_id",
  replaceByParent: true,
  // product_publications has composite PK (product_id, publication_id) — no `id` column.
  onConflict: "product_id,publication_id",
  extract: (raw, parent, ctx) => {
    // Shape-agnostic. Bulk: ResourcePublicationV2 has no `id`, so groupByParent
    // stores them under _children.unknown — filter by shape (publication.id).
    // Incremental: raw.resourcePublicationsV2.edges[].node.
    const pubs = publicationsOf(raw);
    return pubs.map((p) => ({
      product_id: parent.id,
      publication_id: p.publication?.id,
      is_published: p.isPublished ?? null,
      publish_date: p.publishDate ?? null,
      raw_payload: p,
      synced_at: ctx.now,
    }));
  },
};

const products: ResourceModule = {
  resourceName: "products",
  category: "catalog",
  table: "products",
  syncStrategy: "bulk",
  graphqlQuery: QUERY,
  dependsOn: ["sales_channels"],
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const variants = variantsOf(raw);
    const media = mediaOf(raw);
    const featured = raw.featuredMedia?.preview?.image;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      title: raw.title ?? null,
      handle: raw.handle ?? null,
      description: raw.description ?? null,
      description_html: raw.descriptionHtml ?? null,
      product_type: raw.productType ?? null,
      vendor: raw.vendor ?? null,
      status: raw.status ?? null,
      tags: raw.tags ?? null,
      template_suffix: raw.templateSuffix ?? null,
      is_gift_card: raw.isGiftCard ?? null,
      combined_listing_role: raw.combinedListingRole ?? null,
      category_id: raw.category?.id ?? null,
      category_full_name: raw.category?.fullName ?? null,
      product_category_id: raw.category?.id ?? null,
      product_category_full_name: raw.category?.fullName ?? null,
      total_inventory: raw.totalInventory ?? null,
      tracks_inventory: raw.tracksInventory ?? null,
      has_only_default_variant: raw.hasOnlyDefaultVariant ?? null,
      has_out_of_stock_variants: raw.hasOutOfStockVariants ?? null,
      has_variants_that_requires_components: raw.hasVariantsThatRequiresComponents ?? null,
      online_store_url: raw.onlineStoreUrl ?? null,
      online_store_preview_url: raw.onlineStorePreviewUrl ?? null,
      options_count: (raw.options ?? []).length,
      variants_count: raw.variantsCount?.count ?? variants.length,
      media_count: raw.mediaCount?.count ?? media.length,
      total_variants: variants.length,
      requires_selling_plan: raw.requiresSellingPlan ?? null,
      seo_title: raw.seo?.title ?? null,
      seo_description: raw.seo?.description ?? null,
      price_range_min_amount: raw.priceRangeV2?.minVariantPrice?.amount ?? null,
      price_range_max_amount: raw.priceRangeV2?.maxVariantPrice?.amount ?? null,
      price_range_currency: raw.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
      compare_at_price_range_min_amount:
        raw.compareAtPriceRange?.minVariantCompareAtPrice?.amount ?? null,
      compare_at_price_range_max_amount:
        raw.compareAtPriceRange?.maxVariantCompareAtPrice?.amount ?? null,
      compare_at_price_range_currency:
        raw.compareAtPriceRange?.minVariantCompareAtPrice?.currencyCode ?? null,
      featured_image_url: featured?.url ?? null,
      featured_image_alt: featured?.altText ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      published_at: raw.publishedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [
    optionsExtractor,
    optionValuesExtractor,
    variantsExtractor,
    mediaExtractor,
    productMetafieldsExtractor,
    variantMetafieldsExtractor,
    publicationsExtractor,
  ],

  // ─── Phase 3B incremental sync ───────────────────────────────────────────
  // Mirrors the bulk QUERY for ONE product. Adds `first: N` to connections
  // (variants, media, metafields, resourcePublicationsV2). Maintenance: any
  // field added to QUERY must also be added here, or incremental upserts will
  // null-overwrite that column for live updates.
  incremental: async (id: string): Promise<RawPayload | null> => {
    const data = await query<{ product: RawPayload | null }>(
      /* GraphQL */ `
        query ProductById($id: ID!) {
          product(id: $id) {
            id
            legacyResourceId
            title
            handle
            description
            descriptionHtml
            productType
            vendor
            status
            tags
            templateSuffix
            isGiftCard
            combinedListingRole
            category {
              id
              fullName
            }
            totalInventory
            tracksInventory
            hasOnlyDefaultVariant
            hasOutOfStockVariants
            hasVariantsThatRequiresComponents
            onlineStoreUrl
            onlineStorePreviewUrl
            variantsCount {
              count
            }
            mediaCount {
              count
            }
            requiresSellingPlan
            seo {
              title
              description
            }
            priceRangeV2 {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
            compareAtPriceRange {
              minVariantCompareAtPrice {
                amount
                currencyCode
              }
              maxVariantCompareAtPrice {
                amount
                currencyCode
              }
            }
            featuredMedia {
              preview {
                image {
                  url
                  altText
                }
              }
            }
            createdAt
            updatedAt
            publishedAt
            options {
              id
              name
              position
              values
              linkedMetafield {
                namespace
                key
              }
              optionValues {
                id
                name
                hasVariants
                swatch {
                  color
                  image {
                    id
                  }
                }
                linkedMetafieldValue
              }
            }
            variants(first: 250) {
              edges {
                node {
                  id
                  legacyResourceId
                  title
                  displayName
                  sku
                  barcode
                  position
                  price
                  compareAtPrice
                  taxable
                  taxCode
                  inventoryPolicy
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                  availableForSale
                  requiresComponents
                  selectedOptions {
                    name
                    value
                  }
                  image {
                    id
                    url
                    altText
                  }
                  createdAt
                  updatedAt
                }
              }
            }
            media(first: 250) {
              edges {
                node {
                  id
                  mediaContentType
                  alt
                  status
                  ... on MediaImage {
                    image {
                      url
                      width
                      height
                      altText
                    }
                    mimeType
                  }
                  ... on Video {
                    duration
                    originalSource {
                      url
                    }
                    preview {
                      image {
                        url
                        altText
                      }
                    }
                  }
                  ... on ExternalVideo {
                    embedUrl
                    host
                  }
                  ... on Model3d {
                    originalSource {
                      url
                    }
                  }
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
            resourcePublicationsV2(first: 50) {
              edges {
                node {
                  isPublished
                  publishDate
                  publication {
                    id
                  }
                }
              }
            }
          }
        }
      `,
      { id },
    );
    return data.product ?? null;
  },

  softDelete: async (id: string): Promise<void> => {
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb
      .from("products")
      .update({ deleted_at: new Date().toISOString(), status: "ARCHIVED" })
      .eq("id", id);
    if (error) throw new Error(`products.softDelete ${id}: ${error.message}`);
  },
};

export default products;
