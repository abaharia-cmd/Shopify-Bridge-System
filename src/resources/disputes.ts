import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query DisputesPage($first: Int!, $after: String) {
    shopifyPaymentsAccount {
      disputes(first: $first, after: $after) {
        edges {
          node {
            id
            legacyResourceId
            type
            status
            reasonDetails {
              reason
              networkReasonCode
            }
            amount {
              amount
              currencyCode
            }
            evidenceDueBy
            evidenceSentOn
            finalizedOn
            initiatedAt
            order {
              id
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
  }
`;

const disputes: ResourceModule = {
  resourceName: "disputes",
  category: "financial",
  table: "disputes",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: raw.legacyResourceId ? Number(raw.legacyResourceId) : null,
      order_id: raw.order?.id ?? null,
      order_transaction_id: null,
      dispute_type: raw.type ?? null,
      status: raw.status ?? null,
      reason: raw.reasonDetails?.reason ?? null,
      network_reason_code: raw.reasonDetails?.networkReasonCode ?? null,
      amount_amount: raw.amount?.amount ?? null,
      amount_currency: raw.amount?.currencyCode ?? null,
      evidence_due_by: raw.evidenceDueBy ?? null,
      evidence_sent_on: raw.evidenceSentOn ?? null,
      finalized_on: raw.finalizedOn ?? null,
      initiated_at: raw.initiatedAt ?? null,
      created_at: raw.initiatedAt ?? null,
      updated_at: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default disputes;
