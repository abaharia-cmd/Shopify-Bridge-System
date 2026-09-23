// Stream a Shopify Bulk Operation JSONL URL line-by-line. Memory bounded —
// we never hold more than one batch in memory.
//
// Bulk JSONL nesting model:
// - Each line is a JSON object with `id` (Shopify GID).
// - Children include `__parentId` referencing the parent's GID.
// - Children appear immediately after their parent in the stream, but a
//   parent may have many children of multiple types.
//
// Resumable: yields `{obj, byteEnd}` where byteEnd is the absolute byte
// position immediately after this line's terminating newline. Persist
// byteEnd of the last successfully-flushed line; on resume, pass it as
// `startByte` and the streamer issues a Range request to skip ahead.
// Shopify's GCS-served URLs support byte-range gets.

import { logger } from "../lib/logger";
import { withRetry } from "./retry";

const log = logger.child({ module: "jsonlStreamer" });

export interface JsonlObject {
  id: string;
  __parentId?: string;
  // reason: bulk JSONL has open-ended fields per resource
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface JsonlLine {
  obj: JsonlObject;
  // Absolute byte position immediately after the newline terminating this
  // line. Safe checkpoint: resuming from this offset starts at the next line.
  byteEnd: number;
}

export interface StreamJsonlOpts {
  startByte?: number;
  checkpoint?: () => Promise<void>;
  heartbeat?: () => Promise<void>;
}

export async function* streamJsonl(
  url: string,
  opts: StreamJsonlOpts = {},
): AsyncGenerator<JsonlLine> {
  const startByte = opts.startByte ?? 0;
  log.debug({ url, startByte }, "Starting JSONL stream");

  // Wrap fetch in withRetry — long-running bulk fetches can hit transient
  // network errors that shouldn't kill the run.
  const res = await withRetry(
    async () => {
      const headers: Record<string, string> = {};
      if (startByte > 0) headers["Range"] = `bytes=${startByte}-`;
      const r = await fetch(url, { headers });
      // Treat 200 (full) and 206 (partial) as success. Anything else throws.
      if (!r.ok || !r.body) {
        throw new Error(`JSONL fetch failed ${r.status}: ${url}`);
      }
      // If we asked for a Range and the server returned 200, it ignored the
      // header — fall back to discarding the prefix manually below.
      return r;
    },
    { label: "jsonlStreamer.fetch", retries: 5 },
  );

  // If the server honored the Range request, body starts at startByte.
  // Otherwise (200 OK to a Range request), we need to skip startByte bytes.
  const honoredRange = res.status === 206 || startByte === 0;
  let bytesConsumed = honoredRange ? startByte : 0;
  let bytesToSkip = honoredRange ? 0 : startByte;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lineCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      // Skip ahead bytes if the server didn't honor the Range header.
      let chunk = value;
      if (bytesToSkip > 0) {
        if (chunk.length <= bytesToSkip) {
          bytesToSkip -= chunk.length;
          bytesConsumed += chunk.length;
          continue;
        }
        chunk = chunk.subarray(bytesToSkip);
        bytesConsumed += bytesToSkip;
        bytesToSkip = 0;
      }
      buffer += decoder.decode(chunk, { stream: !done });
      bytesConsumed += chunk.length;
    }
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // byteEnd for this line: bytesConsumed minus what's still in `buffer`.
      // Buffer holds everything past the newline we just consumed.
      const byteEnd = bytesConsumed - utf8ByteLength(buffer);
      if (line) {
        lineCount += 1;
        try {
          const obj = JSON.parse(line) as JsonlObject;
          yield { obj, byteEnd };
        } catch (err) {
          log.error(
            { lineCount, err: err instanceof Error ? err.message : err },
            "Malformed JSONL line — skipping",
          );
        }
        if (opts.checkpoint && lineCount % 500 === 0) {
          await opts.checkpoint();
        }
        if (opts.heartbeat && lineCount % 100 === 0) {
          await opts.heartbeat();
        }
      }
      nl = buffer.indexOf("\n");
    }
    if (done) break;
  }

  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim()) as JsonlObject;
      yield { obj, byteEnd: bytesConsumed };
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        "Malformed final JSONL chunk — skipping",
      );
    }
  }
  log.debug({ lineCount, bytesConsumed }, "JSONL stream complete");
}

function utf8ByteLength(s: string): number {
  // TextEncoder is available in Node 18+ and the Edge runtime.
  return new TextEncoder().encode(s).length;
}

// Group sequential bulk-JSONL output into parents with their children
// attached at `_children[<typeKey>]`. typeKey is derived from the GID type
// (e.g. 'gid://shopify/CustomerAddress/...' → 'customer_address').
export interface ParentWithChildren extends JsonlObject {
  _children: Record<string, JsonlObject[]>;
}

export interface ParentBlock {
  parent: ParentWithChildren;
  // byteEnd of the last line consumed for this parent (parent line itself
  // or any of its children). Resuming from this offset starts at the next
  // top-level parent.
  byteEnd: number;
}

function gidTypeKey(gid: string): string {
  // gid://shopify/Foo/123 → 'foo' (snake_case singular)
  const m = /^gid:\/\/shopify\/([^/]+)\//.exec(gid);
  if (!m) return "unknown";
  return m[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// Pick flattened children from a ParentWithChildren by GID type key
// (e.g. 'product_variant', 'line_item'). Pass multiple keys to merge across
// subtypes (e.g. media: 'media_image', 'video', 'external_video', 'model3d').
// Used by resource modules that need bulk JSONL-flattened children.
// reason: ParentWithChildren bag is loosely typed; resource extractors know the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickChildren(parent: any, ...gidTypeKeys: string[]): JsonlObject[] {
  const out: JsonlObject[] = [];
  const c = parent?._children as Record<string, JsonlObject[]> | undefined;
  if (!c) return out;
  for (const k of gidTypeKeys) {
    const arr = c[k];
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

// Pick flattened children by predicate — for child types that have no `id`
// in the JSONL (e.g. ResourcePublicationV2). groupByParent puts these under
// `_children.unknown`; we filter by shape.
export function pickChildrenWhere(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parent: any,
  predicate: (child: JsonlObject) => boolean,
): JsonlObject[] {
  const out: JsonlObject[] = [];
  const c = parent?._children as Record<string, JsonlObject[]> | undefined;
  if (!c) return out;
  for (const arr of Object.values(c)) {
    for (const item of arr) if (predicate(item)) out.push(item);
  }
  return out;
}

export async function* groupByParent(
  source: AsyncIterable<JsonlLine>,
): AsyncGenerator<ParentBlock> {
  let current: ParentWithChildren | null = null;
  let lastByteEndOfCurrent = 0;
  // Map of in-tree id → node, scoped to the current top-level parent block.
  // Lets us attach grandchildren (CONNECTION nested inside CONNECTION, e.g.
  // Order → Returns → ReturnLineItems) to their actual parent in the tree
  // rather than dropping them as "orphans". Reset whenever a new top-level
  // parent starts.
  const ancestors = new Map<string, ParentWithChildren>();
  for await (const { obj, byteEnd } of source) {
    if (!obj.__parentId) {
      // Top-level object — emit any in-flight parent first. The byteEnd we
      // emit is the byteEnd of the LAST line that belongs to the previous
      // parent (children + parent itself), NOT the byteEnd of this new line.
      // Resuming from `lastByteEndOfCurrent` correctly starts at this new
      // parent's first byte.
      if (current) yield { parent: current, byteEnd: lastByteEndOfCurrent };
      current = { ...obj, _children: {} };
      ancestors.clear();
      if (current.id) ancestors.set(current.id, current);
      lastByteEndOfCurrent = byteEnd;
    } else {
      // Find the ancestor (could be the top-level current, or a previously-
      // attached child acting as a grandparent). Bulk Ops emits descendants
      // immediately under their direct parent, never crossing top-level
      // boundaries — so the lookup is always within the current root's tree.
      const parent = ancestors.get(obj.__parentId);
      if (!parent) {
        log.warn(
          { parentId: obj.__parentId, childId: obj.id },
          "Child without matching ancestor in JSONL stream",
        );
        continue;
      }
      // Wrap the child as a ParentWithChildren so it can ALSO be a grandparent
      // for further nesting. Existing extractors that iterate children as
      // plain objects don't care about the extra `_children` field.
      const childNode: ParentWithChildren = { ...obj, _children: {} };
      const key = gidTypeKey(obj.id);
      const arr = parent._children[key] ?? [];
      arr.push(childNode);
      parent._children[key] = arr;
      if (childNode.id) ancestors.set(childNode.id, childNode);
      lastByteEndOfCurrent = byteEnd;
    }
  }
  if (current) yield { parent: current, byteEnd: lastByteEndOfCurrent };
}
