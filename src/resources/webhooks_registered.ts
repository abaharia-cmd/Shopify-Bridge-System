import type { ResourceModule, MainRow, RawPayload } from "./types";

// Note: webhookSubscriptions returns subscriptions created BY THE CALLING APP only.
// To see all webhooks across all apps, you'd need each app's token. For our
// purposes (mirroring what *we* registered in Phase 5+), this is correct.
const QUERY = /* GraphQL */ `
  query WebhooksPage($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      edges {
        node {
          id
          legacyResourceId
          topic
          format
          apiVersion {
            handle
          }
          includeFields
          metafieldNamespaces
          filter
          createdAt
          updatedAt
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
            ... on WebhookEventBridgeEndpoint {
              arn
            }
            ... on WebhookPubSubEndpoint {
              pubSubProject
              pubSubTopic
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

const webhooks_registered: ResourceModule = {
  resourceName: "webhooks_registered",
  category: "operational",
  table: "webhooks_registered",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const ep = raw.endpoint ?? {};
    const callback =
      ep.callbackUrl ?? ep.arn ?? (ep.pubSubProject && ep.pubSubTopic ? `pubsub://${ep.pubSubProject}/${ep.pubSubTopic}` : null);
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: raw.legacyResourceId ? Number(raw.legacyResourceId) : null,
      topic: raw.topic ?? null,
      format: raw.format ?? null,
      callback_url: callback,
      endpoint_type: ep.__typename ?? null,
      api_version: raw.apiVersion?.handle ?? null,
      include_fields: raw.includeFields ?? null,
      metafield_namespaces: raw.metafieldNamespaces ?? null,
      filter: raw.filter ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default webhooks_registered;
