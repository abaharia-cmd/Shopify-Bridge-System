import type { ResourceModule, MainRow, RawPayload, ChildExtractor } from "./types";
import { query } from "../lib/shopify/client";
import { getSupabaseAdmin } from "../lib/supabase/admin";

// Bulk inner query (no {} wrapper, no `first:` args on connections — Bulk Ops
// rules). Children come back interleaved via __parentId.
const QUERY = /* GraphQL */ `
  customers {
    edges {
      node {
        id
        legacyResourceId
        email
        phone
        firstName
        lastName
        displayName
        multipassIdentifier
        note
        state
        locale
        taxExempt
        taxExemptions
        verifiedEmail
        hasTimelineComment
        productSubscriberStatus
        validEmailAddress
        numberOfOrders
        amountSpent {
          amount
          currencyCode
        }
        lifetimeDuration
        dataSaleOptOut
        emailMarketingConsent {
          marketingState
          marketingOptInLevel
          consentUpdatedAt
        }
        smsMarketingConsent {
          marketingState
          marketingOptInLevel
          consentUpdatedAt
          consentCollectedFrom
        }
        defaultAddress {
          id
        }
        tags
        createdAt
        updatedAt
        addresses {
          id
          address1
          address2
          city
          province
          provinceCode
          country
          countryCodeV2
          zip
          phone
          firstName
          lastName
          name
          company
          latitude
          longitude
          formatted
          formattedArea
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

const addressesExtractor: ChildExtractor = {
  table: "customer_addresses",
  parentFk: "customer_id",
  replaceByParent: true,
  extract: (raw: RawPayload, parent, ctx) => {
    const addrs: RawPayload[] = raw.addresses ?? [];
    const defaultId = raw.defaultAddress?.id;
    return addrs.map((a) => {
      const legacy = ctx.parseGid(a.id).legacyId;
      return {
        id: a.id,
        customer_id: parent.id,
        legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
        address1: a.address1 ?? null,
        address2: a.address2 ?? null,
        city: a.city ?? null,
        province: a.province ?? null,
        province_code: a.provinceCode ?? null,
        country: a.country ?? null,
        country_code_v2: a.countryCodeV2 ?? null,
        country_name: null,
        zip: a.zip ?? null,
        phone: a.phone ?? null,
        first_name: a.firstName ?? null,
        last_name: a.lastName ?? null,
        name: a.name ?? null,
        company: a.company ?? null,
        latitude: a.latitude ?? null,
        longitude: a.longitude ?? null,
        formatted: a.formatted ?? null,
        formatted_area: a.formattedArea ?? null,
        is_default: a.id === defaultId,
        raw_payload: a,
        synced_at: ctx.now,
        _content_hash: ctx.hashContent(a),
      };
    });
  },
};

const metafieldsExtractor: ChildExtractor = {
  table: "customer_metafields",
  parentFk: "customer_id",
  replaceByParent: true,
  // Composite UNIQUE on (customer_id, namespace, key) — Shopify can re-emit
  // the same metafield with a different GID after edits, so route the upsert
  // to the natural-key constraint, not just the surrogate `id` PK.
  onConflict: "customer_id,namespace,key",
  extract: (raw: RawPayload, parent, ctx) => {
    const edges: RawPayload[] = raw.metafields?.edges ?? raw._children?.metafield ?? [];
    return edges.map((e: RawPayload) => {
      const m = e.node ?? e;
      const legacy = ctx.parseGid(m.id).legacyId;
      return {
        id: m.id,
        customer_id: parent.id,
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

const customers: ResourceModule = {
  resourceName: "customers",
  category: "customers",
  table: "customers",
  syncStrategy: "bulk",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number(raw.legacyResourceId ?? legacy) || null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      first_name: raw.firstName ?? null,
      last_name: raw.lastName ?? null,
      display_name: raw.displayName ?? null,
      // default_address_id: deferred — see CLAUDE.md note. Set null to avoid FK trip on first run.
      default_address_id: null,
      multipass_identifier: raw.multipassIdentifier ?? null,
      note: raw.note ?? null,
      state: raw.state ?? null,
      locale: raw.locale ?? null,
      tax_exempt: raw.taxExempt ?? null,
      tax_exemptions: raw.taxExemptions ?? null,
      verified_email: raw.verifiedEmail ?? null,
      has_timeline_comment: raw.hasTimelineComment ?? null,
      product_subscriber_status: raw.productSubscriberStatus ?? null,
      validate_email_format: raw.validEmailAddress ?? null,
      number_of_orders: raw.numberOfOrders ? Number(raw.numberOfOrders) : null,
      amount_spent_amount: raw.amountSpent?.amount ?? null,
      amount_spent_currency: raw.amountSpent?.currencyCode ?? null,
      lifetime_duration: raw.lifetimeDuration ?? null,
      has_done_first_purchase: null,
      data_sale_opt_out: raw.dataSaleOptOut ?? null,
      email_marketing_consent_state: raw.emailMarketingConsent?.marketingState ?? null,
      email_marketing_consent_opt_in_level: raw.emailMarketingConsent?.marketingOptInLevel ?? null,
      email_marketing_consent_consent_updated_at: raw.emailMarketingConsent?.consentUpdatedAt ?? null,
      sms_marketing_consent_state: raw.smsMarketingConsent?.marketingState ?? null,
      sms_marketing_consent_opt_in_level: raw.smsMarketingConsent?.marketingOptInLevel ?? null,
      sms_marketing_consent_consent_updated_at: raw.smsMarketingConsent?.consentUpdatedAt ?? null,
      sms_marketing_consent_consent_collected_from: raw.smsMarketingConsent?.consentCollectedFrom ?? null,
      // last_order_id: deferred until orders table populated.
      last_order_id: null,
      last_order_name: null,
      tags: raw.tags ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
  childExtractors: [addressesExtractor, metafieldsExtractor],

  // ─── Phase 3B incremental sync ───────────────────────────────────────────
  // Single-record GraphQL fetch by GID. Mirrors the bulk QUERY's per-customer
  // shape so the existing transform + childExtractors work unchanged.
  // Connections that were unwrapped in bulk (metafields) get an explicit
  // `first: N` here; LIST fields (addresses) come back inline as in bulk.
  // Maintenance: when adding a field to the bulk QUERY, add it here too.
  incremental: async (id: string): Promise<RawPayload | null> => {
    const data = await query<{ customer: RawPayload | null }>(
      /* GraphQL */ `
        query CustomerById($id: ID!) {
          customer(id: $id) {
            id
            legacyResourceId
            email
            phone
            firstName
            lastName
            displayName
            multipassIdentifier
            note
            state
            locale
            taxExempt
            taxExemptions
            verifiedEmail
            hasTimelineComment
            productSubscriberStatus
            validEmailAddress
            numberOfOrders
            amountSpent {
              amount
              currencyCode
            }
            lifetimeDuration
            dataSaleOptOut
            emailMarketingConsent {
              marketingState
              marketingOptInLevel
              consentUpdatedAt
            }
            smsMarketingConsent {
              marketingState
              marketingOptInLevel
              consentUpdatedAt
              consentCollectedFrom
            }
            defaultAddress {
              id
            }
            tags
            createdAt
            updatedAt
            addresses {
              id
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
              firstName
              lastName
              name
              company
              latitude
              longitude
              formatted
              formattedArea
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
    return data.customer ?? null;
  },

  // Soft-delete: customers/delete webhook → mark deleted_at on the row, never
  // hard-delete (CASCADE FKs from customer_addresses + customer_metafields
  // would propagate, and removing a Shopify customer typically still leaves
  // their orders behind which reference customer_id).
  softDelete: async (id: string): Promise<void> => {
    const dataDb = getSupabaseAdmin("shopify");
    const { error } = await dataDb
      .from("customers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`customers.softDelete ${id}: ${error.message}`);
  },
};

export default customers;
