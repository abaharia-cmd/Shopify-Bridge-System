// Standalone CLI: verifies Shopify + Supabase connectivity.
// Run with `npm run verify` (uses Node's native --env-file=.env.local).
// Exits 0 on success, 1 on any failure.
import { query } from "../lib/shopify/client";
import type { ShopQueryResult } from "../lib/shopify/types";
import { supabaseAdmin } from "../lib/supabase/admin";
import { logger } from "../lib/logger";

const SHOP_QUERY = /* GraphQL */ `
  query VerifyShop {
    shop {
      id
      name
      email
      myshopifyDomain
      plan {
        displayName
      }
    }
  }
`;

async function main(): Promise<number> {
  let failed = 0;

  try {
    const data = await query<ShopQueryResult>(SHOP_QUERY);
    logger.info(
      {
        shopName: data.shop.name,
        plan: data.shop.plan.displayName,
        domain: data.shop.myshopifyDomain,
      },
      "Shopify OK",
    );
  } catch (err) {
    failed++;
    logger.error({ err: err instanceof Error ? err.message : err }, "Shopify FAILED");
  }

  try {
    const { count, error, status, statusText } = await supabaseAdmin
      .from("resource_registry")
      .select("*", { count: "exact", head: true });
    if (error) {
      logger.error(
        {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          status,
          statusText,
        },
        "Supabase query error",
      );
      throw new Error(error.message || `Supabase ${status} ${statusText}`);
    }
    logger.info(
      { resourceCount: count ?? 0, schema: "shopify_sync" },
      "Supabase OK",
    );
  } catch (err) {
    failed++;
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "Supabase FAILED",
    );
  }

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err }, "Unexpected verify-connections failure");
    process.exit(1);
  });
