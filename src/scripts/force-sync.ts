// Throwaway: force one incremental sync. Usage:
//   npx tsx --env-file=.env.local src/scripts/force-sync.ts <resource> <gid>
import { runIncremental } from "../worker/runners/incrementalRunner";

const [resource, id] = process.argv.slice(2);
if (!resource || !id) {
  console.error("usage: force-sync.ts <resource> <gid://shopify/...>");
  process.exit(1);
}
(async () => {
  console.log(`Force-syncing ${resource} ${id}...`);
  const r = await runIncremental({ resourceName: resource, id, triggeredBy: "manual:force-sync" });
  console.log(JSON.stringify(r, null, 2));
})();
