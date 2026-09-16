import { NextResponse } from "next/server";
import { query } from "@/lib/shopify/client";
import type { ShopQueryResult } from "@/lib/shopify/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHOP_QUERY = /* GraphQL */ `
  query HealthShop {
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

type ShopifyHealth =
  | { ok: true; shopName: string; plan: string; myshopifyDomain: string }
  | { ok: false; error: string };

type SupabaseHealth =
  | { ok: true; resourceCount: number }
  | { ok: false; error: string };

async function checkShopify(): Promise<ShopifyHealth> {
  try {
    const data = await query<ShopQueryResult>(SHOP_QUERY);
    return {
      ok: true,
      shopName: data.shop.name,
      plan: data.shop.plan.displayName,
      myshopifyDomain: data.shop.myshopifyDomain,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Shopify health check failed");
    return { ok: false, error: message };
  }
}

async function checkSupabase(): Promise<SupabaseHealth> {
  try {
    const { count, error } = await supabaseAdmin
      .from("resource_registry")
      .select("*", { count: "exact", head: true });
    if (error) {
      logger.error({ err: error.message }, "Supabase health check failed");
      return { ok: false, error: error.message };
    }
    return { ok: true, resourceCount: count ?? 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Supabase health check threw");
    return { ok: false, error: message };
  }
}

export async function GET() {
  const [shopify, supabase] = await Promise.all([
    checkShopify(),
    checkSupabase(),
  ]);

  const body = {
    shopify,
    supabase,
    timestamp: new Date().toISOString(),
  };

  const status = shopify.ok && supabase.ok ? 200 : 500;
  return NextResponse.json(body, { status });
}
