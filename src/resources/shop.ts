import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";

const QUERY = /* GraphQL */ `
  query ShopFull {
    shop {
      id
      name
      email
      contactEmail
      myshopifyDomain
      url
      currencyCode
      enabledPresentmentCurrencies
      ianaTimezone
      timezoneAbbreviation
      timezoneOffset
      weightUnit
      shipsToCountries
      taxesIncluded
      taxShipping
      setupRequired
      checkoutApiSupported
      shopOwnerName
      description
      createdAt
      updatedAt
      primaryDomain {
        url
        host
        sslEnabled
      }
      plan {
        displayName
        partnerDevelopment
        shopifyPlus
      }
      features {
        storefront
        giftCards
        branding
        captcha
        dynamicRemarketing
        eligibleForSubscriptionMigration
        eligibleForSubscriptions
        legacySubscriptionGatewayEnabled
        showMetrics
        avalaraAvatax
      }
      resourceLimits {
        maxProductVariants
        maxProductOptions
      }
      billingAddress {
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
        company
        latitude
        longitude
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
`;

const metafieldsExtractor: ChildExtractor = {
  table: "shop_metafields",
  // shop_metafields has no parent FK column (shop is a singleton). Use the
  // metafield's own `id` as PK, no replaceByParent needed.
  parentFk: "id",
  replaceByParent: false,
  // Composite UNIQUE on (namespace, key) — single-row shop, no shop_id col.
  // Route the upsert to the natural-key constraint so re-syncs that get a
  // different GID (rare) still UPDATE the existing row instead of throwing.
  onConflict: "namespace,key",
  extract: (raw: ShopResponse, _parent, ctx) => {
    const s = raw?.shop;
    const edges = s?.metafields?.edges ?? [];
    return edges.map((e: { node: RawPayload }) => {
      const m = e.node;
      const legacy = ctx.parseGid(m.id).legacyId;
      return {
        id: m.id,
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

interface ShopResponse {
  shop: RawPayload;
}

const shop: ResourceModule = {
  resourceName: "shop",
  category: "operational",
  table: "shop",
  syncStrategy: "singleton",
  graphqlQuery: QUERY,
  transform: (raw: ShopResponse, ctx) => {
    const s = raw?.shop;
    if (!s) return null;
    const legacy = ctx.parseGid(s.id).legacyId;
    const row: MainRow = {
      id: s.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      name: s.name ?? null,
      email: s.email ?? null,
      contact_email: s.contactEmail ?? null,
      customer_email: null,
      myshopify_domain: s.myshopifyDomain ?? null,
      primary_domain_url: s.primaryDomain?.url ?? null,
      primary_domain_host: s.primaryDomain?.host ?? null,
      primary_domain_ssl_enabled: s.primaryDomain?.sslEnabled ?? null,
      url: s.url ?? null,
      currency_code: s.currencyCode ?? null,
      enabled_presentment_currencies: s.enabledPresentmentCurrencies ?? null,
      iana_timezone: s.ianaTimezone ?? null,
      timezone_abbreviation: s.timezoneAbbreviation ?? null,
      timezone_offset: s.timezoneOffset ?? null,
      weight_unit: s.weightUnit ?? null,
      ships_to_countries: s.shipsToCountries ?? null,
      plan_display_name: s.plan?.displayName ?? null,
      plan_partner_development: s.plan?.partnerDevelopment ?? null,
      plan_shopify_plus: s.plan?.shopifyPlus ?? null,
      taxes_included: s.taxesIncluded ?? null,
      tax_shipping: s.taxShipping ?? null,
      county_taxes: null,
      setup_required: s.setupRequired ?? null,
      checkout_api_supported: s.checkoutApiSupported ?? null,
      multi_location_enabled: null,
      // Phase 1 schema gotcha: features.branding is an enum string in API
      // 2026-01 (e.g. "SHOPIFY") but the column is boolean. Park the value in
      // features_branding_status and leave the bool null.
      features_storefront: s.features?.storefront ?? null,
      features_giftcards: s.features?.giftCards ?? null,
      features_branding: null,
      features_captcha: s.features?.captcha ?? null,
      features_dynamic_remarketing: s.features?.dynamicRemarketing ?? null,
      features_eligible_for_subscription_migration:
        s.features?.eligibleForSubscriptionMigration ?? null,
      features_eligible_for_subscriptions: s.features?.eligibleForSubscriptions ?? null,
      features_legacy_subscription_gateway_enabled:
        s.features?.legacySubscriptionGatewayEnabled ?? null,
      features_storefront_password_protection: null,
      features_show_metrics: s.features?.showMetrics ?? null,
      features_paypal_express_in_context: null,
      features_avalara_avatax: s.features?.avalaraAvatax ?? null,
      features_branding_status:
        typeof s.features?.branding === "string" ? s.features.branding : null,
      resource_limits_max_product_variants: s.resourceLimits?.maxProductVariants ?? null,
      resource_limits_max_product_options: s.resourceLimits?.maxProductOptions ?? null,
      billing_address: s.billingAddress ?? null,
      shop_owner_name: s.shopOwnerName ?? null,
      description: s.description ?? null,
      created_at: s.createdAt ?? null,
      updated_at: s.updatedAt ?? null,
      raw_payload: s,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(s),
    };
    return row;
  },
  childExtractors: [metafieldsExtractor],
};

export default shop;
