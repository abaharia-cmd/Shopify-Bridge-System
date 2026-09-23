import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query StaffMembersPage($first: Int!, $after: String) {
    staffMembers(first: $first, after: $after) {
      edges {
        node {
          id
          firstName
          lastName
          name
          email
          phone
          initials
          locale
          isShopOwner
          active
          exists
          accountType
          avatar {
            transformedSrc
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

const staff_users: ResourceModule = {
  resourceName: "staff_users",
  category: "operational",
  table: "staff_users",
  syncStrategy: "paginated",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    const row: MainRow = {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      first_name: raw.firstName ?? null,
      last_name: raw.lastName ?? null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      initials: raw.initials ?? null,
      locale: raw.locale ?? null,
      is_shop_owner: raw.isShopOwner ?? null,
      active: raw.active ?? null,
      exists: raw.exists ?? null,
      account_type: raw.accountType ?? null,
      avatar_url: raw.avatar?.transformedSrc ?? null,
      privacy_policy_acceptance: null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    };
    return row;
  },
};

export default staff_users;
