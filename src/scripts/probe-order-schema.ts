// Standalone CLI: introspect the Shopify Admin API 2026-01 to determine for
// each Order/LineItem/Fulfillment/Refund/Return field whether it's:
//   - CONNECTION (paginated, has edges/node) — counts toward bulk op's 5-conn limit
//   - LIST       (inline [Type!]) — free, but cannot contain a connection inside
//   - OBJECT     (single Type) — free
//   - MISSING    (removed in 2026-01)
//
// Used to design Phase 3 Wave 1 split passes.

import { query } from "../lib/shopify/client";

interface IntrospectField {
  name: string;
  type: TypeRef;
}

interface TypeRef {
  kind: string; // OBJECT, LIST, NON_NULL, SCALAR, ENUM, INTERFACE, UNION, INPUT_OBJECT
  name: string | null;
  ofType: TypeRef | null;
}

interface IntrospectType {
  __type: {
    name: string;
    fields: IntrospectField[] | null;
  } | null;
}

const Q = /* GraphQL */ `
  query Probe($name: String!) {
    __type(name: $name) {
      name
      fields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
`;

function classify(type: TypeRef): { kind: string; targetType: string } {
  // Unwrap NON_NULL
  let t: TypeRef | null = type;
  while (t && t.kind === "NON_NULL" && t.ofType) t = t.ofType;
  if (!t) return { kind: "UNKNOWN", targetType: "?" };

  if (t.kind === "LIST") {
    let inner = t.ofType;
    while (inner && inner.kind === "NON_NULL" && inner.ofType) inner = inner.ofType;
    return { kind: "LIST", targetType: inner?.name ?? "?" };
  }

  if (t.kind === "OBJECT") {
    if (t.name?.endsWith("Connection")) {
      return { kind: "CONNECTION", targetType: t.name.replace(/Connection$/, "") };
    }
    return { kind: "OBJECT", targetType: t.name ?? "?" };
  }

  return { kind: t.kind, targetType: t.name ?? "?" };
}

const PROBES: Record<string, string[]> = {
  Order: [
    "shippingLines",
    "discountApplications",
    "discountCodes",
    "taxLines",
    "metafields",
    "agreements",
    "risks",
    "edits",
    "returns",
    "fulfillments",
    "refunds",
    "transactions",
    "clientIp",
    "customerJourneySummary",
    "shippingAddress",
    "billingAddress",
    "currentTotalPriceSet",
    "currentSubtotalPriceSet",
  ],
  LineItem: [
    "taxLines",
    "discountAllocations",
    "duties",
  ],
  Fulfillment: [
    "fulfillmentLineItems",
    "events",
    "trackingInfo",
  ],
  Refund: [
    "refundLineItems",
    "transactions",
    "refundShippingLines",
  ],
  Return: [
    "returnLineItems",
  ],
};

async function main(): Promise<number> {
  console.log("\n═══ Shopify Admin 2026-01 schema probe ═══\n");
  for (const [typeName, wantFields] of Object.entries(PROBES)) {
    const data = await query<IntrospectType>(Q, { name: typeName });
    const t = data.__type;
    if (!t) {
      console.log(`✗ Type ${typeName} not found in schema\n`);
      continue;
    }
    console.log(`─── ${typeName} ───`);
    const present = new Set(t.fields?.map((f) => f.name) ?? []);
    for (const wf of wantFields) {
      const f = t.fields?.find((x) => x.name === wf);
      if (!f) {
        console.log(`  ${wf.padEnd(30)} MISSING (removed in 2026-01)`);
        continue;
      }
      const c = classify(f.type);
      console.log(`  ${wf.padEnd(30)} ${c.kind.padEnd(11)} ${c.targetType}`);
    }
    // Surface other interesting fields for context
    const interesting = ["staffMember", "merchantBusinessEntity", "merchantOfRecordApp"];
    for (const i of interesting) {
      if (typeName === "Order" && present.has(i)) {
        const f = t.fields!.find((x) => x.name === i)!;
        const c = classify(f.type);
        console.log(`  ${i.padEnd(30)} ${c.kind.padEnd(11)} ${c.targetType}  (also)`);
      }
    }
    console.log("");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("probe failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });