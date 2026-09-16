import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query AppInstallationsPage($first: Int!, $after: String) {
    appInstallations(first: $first, after: $after) {
      edges {
        node {
          id
          launchUrl
          uninstallUrl
          accessScopes {
            handle
          }
          app {
            id
            title
            handle
            description
            developerName
            developerUrl
            icon {
              transformedSrc
            }
            installUrl
            appStoreAppUrl
            appStoreDeveloperUrl
            embedded
            failedRequirements {
              message
              action {
                title
              }
            }
            navigationItems {
              id
              title
              url
            }
            privacyPolicyUrl
            pricingDetails
            pricingDetailsSummary
            published
            shopifyDeveloped
            uninstallMessage
            webhookApiVersion
            optionalAccessScopes {
              handle
            }
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const apps_installed: ResourceModule = {
  resourceName: "apps_installed",
  category: "operational",
  table: "apps_installed",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.app?.id) return null;
    const a = raw.app;
    const legacy = ctx.parseGid(a.id).legacyId;
    const row: MainRow = {
      id: a.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      title: a.title ?? null,
      handle: a.handle ?? null,
      description: a.description ?? null,
      developer_name: a.developerName ?? null,
      developer_url: a.developerUrl ?? null,
      icon_url: a.icon?.transformedSrc ?? null,
      installation_url: a.installUrl ?? raw.launchUrl ?? null,
      app_store_app_url: a.appStoreAppUrl ?? null,
      app_store_developer_url: a.appStoreDeveloperUrl ?? null,
      embedded: a.embedded ?? null,
      failed_requirements: a.failedRequirements ?? null,
      feedback: null,
      navigation_items: a.navigationItems ?? null,
      privacy_policy_url: a.privacyPolicyUrl ?? null,
      pricing_details: a.pricingDetails ?? null,
      pricing_details_summary: a.pricingDetailsSummary ?? null,
      published: a.published ?? null,
      shopify_developed: a.shopifyDeveloped ?? null,
      uninstall_message: a.uninstallMessage ?? null,
      webhook_api_version: a.webhookApiVersion ?? null,
      access_scopes: (raw.accessScopes ?? []).map((s: { handle: string }) => s.handle),
      optional_access_scopes: (a.optionalAccessScopes ?? []).map((s: { handle: string }) => s.handle),
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default apps_installed;
