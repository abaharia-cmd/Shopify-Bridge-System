// Relay-cursor pagination helper. Supplies the GraphQL query + variables and
// receives back a (data) → { nodes, pageInfo } extractor. Yields nodes one
// page at a time so callers can upsert per page.

import { query } from "./client";

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PaginateOpts<TNode> {
  document: string;
  variables?: Record<string, unknown>;
  pageSize?: number;
  // Extracts {nodes, pageInfo} from a query response.
  extract: (data: unknown) => { nodes: TNode[]; pageInfo: PageInfo };
}

export async function* paginate<TNode>(
  opts: PaginateOpts<TNode>,
): AsyncGenerator<{ nodes: TNode[]; pageNumber: number; cursor: string | null }> {
  const pageSize = opts.pageSize ?? 250;
  let cursor: string | null = null;
  let pageNumber = 0;

  while (true) {
    pageNumber += 1;
    const variables = { ...opts.variables, first: pageSize, after: cursor };
    const data = await query<unknown>(opts.document, variables);
    const { nodes, pageInfo } = opts.extract(data);
    yield { nodes, pageNumber, cursor };
    if (!pageInfo.hasNextPage) return;
    cursor = pageInfo.endCursor;
    if (!cursor) return;
  }
}
