import type { ResourceModule, RunnerResult } from "../../resources/types";
import { query } from "../../lib/shopify/client";
import { withRetry } from "../retry";
import { applyOne } from "./runner";
import { updateProgress } from "../progress";

// For resources that return a single object (e.g. shop). The module's
// graphqlQuery should select the singleton; transform() receives the data
// object and returns the row.

export async function runSingleton(opts: {
  module: ResourceModule;
  syncRunId: string;
}): Promise<RunnerResult> {
  const data = await withRetry(
    () => query<unknown>(opts.module.graphqlQuery),
    { label: `singleton:${opts.module.resourceName}` },
  );
  const result = await applyOne(opts.module, data, opts.syncRunId);
  await updateProgress({
    runId: opts.syncRunId,
    recordsProcessed: 1,
    recordsInserted: result.inserted,
    recordsFailed: result.failed,
  });
  return {
    recordsProcessed: 1,
    recordsInserted: result.inserted,
    recordsUpdated: 0,
    recordsFailed: result.failed,
  };
}
