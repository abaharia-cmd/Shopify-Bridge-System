import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query BalanceTxPage($first: Int!, $after: String) {
    shopifyPaymentsAccount {
      balanceTransactions(first: $first, after: $after) {
        edges {
          node {
            id
            type
            test
            amount {
              amount
              currencyCode
            }
            fee {
              amount
              currencyCode
            }
            net {
              amount
              currencyCode
            }
            associatedOrder {
              id
            }
            associatedPayout {
              id
            }
            transactionDate
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

const balance_transactions: ResourceModule = {
  resourceName: "balance_transactions",
  category: "financial",
  table: "balance_transactions",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      payout_id: raw.associatedPayout?.id ?? null,
      transaction_type: raw.type ?? null,
      test: raw.test ?? null,
      amount_amount: raw.amount?.amount ?? null,
      amount_currency: raw.amount?.currencyCode ?? null,
      fee_amount: raw.fee?.amount ?? null,
      fee_currency: raw.fee?.currencyCode ?? null,
      net_amount: raw.net?.amount ?? null,
      net_currency: raw.net?.currencyCode ?? null,
      source_id: null,
      source_type: null,
      source_order_id: raw.associatedOrder?.id ?? null,
      source_order_transaction_id: null,
      processed_at: raw.transactionDate ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default balance_transactions;
