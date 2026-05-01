import { z } from "zod";

const schema = z.object({
  SHOPIFY_SHOP_DOMAIN: z
    .string()
    .min(1)
    .regex(/\.myshopify\.com$/, "must end in .myshopify.com"),
  SHOPIFY_ADMIN_API_TOKEN: z.string().min(1).startsWith("shpat_"),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Check .env.local (local) or your Vercel project env vars (deployed).`,
    );
  }
  return result.data;
}

export const config = load();
