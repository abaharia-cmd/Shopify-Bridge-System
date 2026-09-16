import type { ResourceModule, MainRow, RawPayload } from "./types";

// Shopify Payments only. Returns 0 rows if the store doesn't use Shopify
// Payments. Nested connection inside shopifyPaymentsAccount singleton —
// paginated runner's extract recurses into it.
const QUERY = /* GraphQL */ `
  query PayoutsPage($first: Int!, $after: String) {
    shopifyPaymentsAccount {
      payouts(first: $first, after: $after) {
        edges {
          node {
            id
            legacyResourceId
            status
            net {
              amount
              currencyCode
            }
            gross {
              amount
              currencyCode
            }
            summary {
              chargesGross {
                amount
                currencyCode
              }
              chargesFee {
                amount
                currencyCode
              }
              refundsFee {
                amount
                currencyCode
              }
              adjustmentsGross {
                amount
                currencyCode
              }
              adjustmentsFee {
                amount
                currencyCode
              }
              reservedFundsGross {
                amount
                currencyCode
              }
              reservedFundsFee {
                amount
                currencyCode
              }
              retriedPayoutsGross {
                amount
                currencyCode
              }
              retriedPayoutsFee {
                amount
                currencyCode
              }
            }
            bankAccount {
              accountNumberLastDigits
              currency
              bankName
            }
            transactionType
            issuedAt
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

const payouts: ResourceModule = {
  resourceName: "payouts",
  category: "financial",
  table: "payouts",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const s = raw.summary ?? {};
    const ba = raw.bankAccount ?? {};
    const fees = (() => {
      const charges = Number(s.chargesFee?.amount ?? 0);
      const refunds = Number(s.refundsFee?.amount ?? 0);
      const adj = Number(s.adjustmentsFee?.amount ?? 0);
      return charges + refunds + adj;
    })();
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: raw.legacyResourceId ? Number(raw.legacyResourceId) : null,
      status: raw.status ?? null,
      net_amount: raw.net?.amount ?? null,
      net_currency: raw.net?.currencyCode ?? null,
      gross_amount: raw.gross?.amount ?? null,
      gross_currency: raw.gross?.currencyCode ?? null,
      fees_amount: fees || null,
      fees_currency: s.chargesFee?.currencyCode ?? null,
      charges_gross_amount: s.chargesGross?.amount ?? null,
      charges_fee_amount: s.chargesFee?.amount ?? null,
      refunds_fee_amount: s.refundsFee?.amount ?? null,
      refunds_gross_amount: null,
      adjustments_gross_amount: s.adjustmentsGross?.amount ?? null,
      adjustments_fee_amount: s.adjustmentsFee?.amount ?? null,
      reserved_funds_gross_amount: s.reservedFundsGross?.amount ?? null,
      reserved_funds_fee_amount: s.reservedFundsFee?.amount ?? null,
      retried_payouts_gross_amount: s.retriedPayoutsGross?.amount ?? null,
      retried_payouts_fee_amount: s.retriedPayoutsFee?.amount ?? null,
      summary_currency: s.chargesGross?.currencyCode ?? null,
      bank_account_routing_number: null,
      bank_account_last4: ba.accountNumberLastDigits ?? null,
      bank_account_country_code: null,
      bank_account_currency: ba.currency ?? null,
      bank_account_bank_name: ba.bankName ?? null,
      transaction_type: raw.transactionType ?? null,
      issued_at: raw.issuedAt ?? null,
      payout_date: raw.issuedAt ? raw.issuedAt.substring(0, 10) : null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default payouts;
