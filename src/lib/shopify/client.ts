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
    // The Shopify SDK puts the readable problems under `graphQLErrors`. Fall
    // back to the generic `message` if absent.
    const errs = response.errors as unknown as {
      message?: string;
      graphQLErrors?: { message: string }[];
    };
    const detail =
      errs.graphQLErrors && errs.graphQLErrors.length
        ? errs.graphQLErrors.map((e) => e.message).join("; ")
        : (errs.message ?? "unknown");
    throw new Error(`Shopify GraphQL error: ${detail}`);
  }

  if (!response.data) {
    log.error({ elapsedMs }, "Shopify GraphQL returned no data");
    throw new Error("Shopify GraphQL returned no data");
  }

  log.debug({ elapsedMs }, "Shopify GraphQL request ok");
  return response.data;
}
