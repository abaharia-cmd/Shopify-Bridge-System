// Wave 2 Group E: Shopify Files (15K-50K+ rows). Metadata only — table has
// no binary blob column (verified before backfill).
import type { ResourceModule, MainRow, RawPayload } from "./types";

const QUERY = /* GraphQL */ `
  query FilesPage($cursor: String) {
    files(first: 250, after: $cursor) {
      edges {
        node {
          id
          fileStatus
          fileErrors { code details }
          alt
          createdAt updatedAt
          ... on MediaImage {
            mimeType
            originalSource { fileSize url }
            image { url width height }
            preview { image { url width height } }
          }
          ... on Video {
            originalSource { mimeType fileSize url }
            sources { mimeType width height }
            duration
            preview { image { url width height } }
          }
          ... on GenericFile {
            mimeType
            originalFileSize
            url
            preview { image { url width height } }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const files: ResourceModule = {
  resourceName: "files",
  category: "files",
  table: "files",
  syncStrategy: "paginated_batch",
  graphqlQuery: QUERY,
  transform: (raw: RawPayload, ctx) => {
    if (!raw?.id) return null;
    const errs = Array.isArray(raw.fileErrors) ? raw.fileErrors : [];
    const firstErr = errs[0] ?? null;
    // Polymorphic union — pick fields based on what's present.
    const isImage = raw.image || raw.originalSource?.url && raw.mimeType?.startsWith?.("image");
    const fileType = raw.duration != null ? "VIDEO" : (raw.image ? "MEDIA_IMAGE" : raw.url ? "GENERIC_FILE" : "UNKNOWN");
    const url = raw.image?.url ?? raw.url ?? raw.originalSource?.url ?? null;
    const mime = raw.mimeType ?? raw.originalSource?.mimeType ?? null;
    const sizeBytes = raw.originalSource?.fileSize ?? raw.originalFileSize ?? null;
    const previewImg = raw.preview?.image ?? null;
    const legacy = ctx.parseGid(raw.id).legacyId;
    return {
      id: raw.id,
      legacy_resource_id: Number.isFinite(Number(legacy)) ? Number(legacy) : null,
      file_type: fileType,
      file_status: raw.fileStatus ?? null,
      file_error_code: firstErr?.code ?? null,
      file_error_details: firstErr?.details ?? null,
      alt: raw.alt ?? null,
      original_file_size: sizeBytes,
      url,
      mime_type: mime,
      image_width: raw.image?.width ?? null,
      image_height: raw.image?.height ?? null,
      duration: raw.duration ?? null,
      sources: raw.sources ?? null,
      preview_image_url: previewImg?.url ?? null,
      preview_image_width: previewImg?.width ?? null,
      preview_image_height: previewImg?.height ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
      raw_payload: raw,
      synced_at: ctx.now,
      _content_hash: ctx.hashContent(raw),
    } as MainRow;
  },
};

export default files;
