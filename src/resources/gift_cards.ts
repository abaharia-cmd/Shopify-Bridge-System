import type { ResourceModule, MainRow, RawPayload } from "./types";

// Bulk: just gift cards (not transactions). transactions connection on
// GiftCard had several 2026-01 changes that need careful handling — defer
// gift_card_transactions to a focused follow-up.
const QUERY = /* GraphQL */ `
  giftCards {
    edges {
      node {
        id
        lastCharacters
        maskedCode
        balance {
          amount
          currencyCode
        }
        initialValue {
          amount
          currencyCode
        }
        enabled
        customer {
          id
        }
        order {
          id
        }
        note
        templateSuffix
        expiresOn
        createdAt
        updatedAt
      }
    }
  }
`;

const gift_cards: ResourceModule = {
  resourceName: "gift_cards",
  category: "marketing",
  table: "gift_cards",
  syncStrategy: "bulk",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      last_characters: raw.lastCharacters ?? null,
      masked_code: raw.maskedCode ?? null,
      balance_amount: raw.balance?.amount ?? null,
      balance_currency: raw.balance?.currencyCode ?? null,
      initial_value_amount: raw.initialValue?.amount ?? null,
      initial_value_currency: raw.initialValue?.currencyCode ?? null,
      enabled: raw.enabled ?? null,
      customer_id: raw.customer?.id ?? null,
      order_id: raw.order?.id ?? null,
      recipient_attributes: null,
      note: raw.note ?? null,
      template_suffix: raw.templateSuffix ?? null,
      expires_on: raw.expiresOn ?? null,
      disabled_at: null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default gift_cards;
