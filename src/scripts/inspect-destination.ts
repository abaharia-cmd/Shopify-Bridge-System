import { query } from "../lib/shopify/client";
(async () => {
  const r = await query<{
    __type: {
      fields: { name: string; type: { name: string | null; kind: string; ofType: { name: string | null } | null } }[];
    };
  }>(`{ __type(name:"FulfillmentOrderDestination") { fields { name type { name kind ofType { name } } } } }`);
  console.log("FulfillmentOrderDestination fields:");
  for (const f of r.__type.fields) {
    console.log(`  ${f.name}: ${f.type.name ?? f.type.ofType?.name ?? f.type.kind}`);
  }
})();
