// Build the TransformContext used by every resource module.
import { createHash } from "node:crypto";
import type { TransformContext } from "../resources/types";

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`;
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashContent(obj: unknown): string {
  return createHash("sha256").update(stableStringify(obj)).digest("hex");
}

export function parseGid(gid: string): { type: string; legacyId: string } {
  // gid://shopify/Foo/123 → {type: 'Foo', legacyId: '123'}
  const m = /^gid:\/\/shopify\/([^/]+)\/([^?]+)/.exec(gid);
  if (!m) return { type: "unknown", legacyId: gid };
  return { type: m[1], legacyId: m[2] };
}

export function makeTransformContext(opts: {
  syncRunId: string;
  resourceName: string;
}): TransformContext {
  return {
    syncRunId: opts.syncRunId,
    resourceName: opts.resourceName,
    hashContent,
    parseGid,
    now: new Date(),
  };
}
