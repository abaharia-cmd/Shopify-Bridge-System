import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query MarketingEventsPage($first: Int!, $after: String) {
    marketingEvents(first: $first, after: $after) {
      edges {
        node {
          id
          type
          remoteId
          channelHandle
          description
          manageUrl
          previewUrl
          utmSource
          utmMedium
          utmCampaign
          sourceAndMedium
          app {
            id
          }
          startedAt
          endedAt
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

const marketing_events: ResourceModule = {
  resourceName: "marketing_events",
  category: "marketing",
  table: "marketing_events",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      type: raw.type ?? null,
      remote_id: raw.remoteId ?? null,
      marketing_channel: raw.channelHandle ?? null,
      paid: null,
      budget_amount: null,
      budget_currency: null,
      budget_type: null,
      description: raw.description ?? null,
      manage_url: raw.manageUrl ?? null,
      preview_url: raw.previewUrl ?? null,
      utm_source: raw.utmSource ?? null,
      utm_medium: raw.utmMedium ?? null,
      utm_campaign: raw.utmCampaign ?? null,
      source_and_medium: raw.sourceAndMedium ?? null,
      referring_domain: null,
      breadcrumb_id: null,
      marketing_activity_id: null,
      app_id: raw.app?.id ?? null,
      marketed_resources: null,
      scheduled_to_end_at: null,
      started_at: raw.startedAt ?? null,
      ended_at: raw.endedAt ?? null,
      created_at: null,
      updated_at: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default marketing_events;
