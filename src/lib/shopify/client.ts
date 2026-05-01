import { createAdminApiClient } from "@shopify/admin-api-client";
import { config } from "../config";
import { logger } from "../logger";

const log = logger.child({ module: "shopify" });

export const shopify = createAdminApiClient({
  storeDomain: config.SHOPIFY_SHOP_DOMAIN,
  apiVersion: config.SHOPIFY_API_VERSION,
  accessToken: config.SHOPIFY_ADMIN_API_TOKEN,
});

export type GraphQLVariables = Record<string, unknown>;

export async function query<T>(
  operation: string,
  variables?: GraphQLVariables,
): Promise<T> {
  const start = Date.now();
  const response = await shopify.request<T>(operation, { variables });
  const elapsedMs = Date.now() - start;

  if (response.errors) {
    log.error(
      { errors: response.errors, elapsedMs },
      "Shopify GraphQL request failed",
    );
    throw new Error(
      `Shopify GraphQL error: ${response.errors.message ?? "unknown"}`,
    );
  }

  if (!response.data) {
    log.error({ elapsedMs }, "Shopify GraphQL returned no data");
    throw new Error("Shopify GraphQL returned no data");
  }

  log.debug({ elapsedMs }, "Shopify GraphQL request ok");
  return response.data;
}
