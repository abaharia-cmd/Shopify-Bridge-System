// Shopify webhook HMAC SHA-256 verification.
//
// Shopify signs every webhook with `X-Shopify-Hmac-Sha256` = base64(HMAC_SHA256(secret, rawBody)).
// The hash is computed over the EXACT bytes Shopify sent — not a re-stringified
// JSON re-serialization. The receiver MUST capture the raw request body before
// any JSON parsing (`req.text()`, never `req.json()` first).
//
// Verification uses `timingSafeEqual` to avoid leaking the comparison position
// via response-time side channels.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Shopify webhook HMAC.
 *
 * @param rawBody  Exact bytes of the request body (string or Buffer).
 * @param headerHmac  Value of the `X-Shopify-Hmac-Sha256` header (base64).
 * @param secret  Webhook signing secret from Shopify app config / dashboard.
 * @returns true iff the HMAC is valid AND the secret was non-empty.
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  headerHmac: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !headerHmac) return false;

  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

  const computed = createHmac("sha256", secret).update(bodyBuf).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(headerHmac, "base64");
  } catch {
    return false;
  }

  // timingSafeEqual requires equal-length buffers.
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(computed, provided);
}
