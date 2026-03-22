import fs from "node:fs";
import path from "node:path";

export type UploadType = "image" | "video" | "audio" | "file";
type RawUploadsApi = { raw: { uploads: { getUploadUrl: (opts: { type: UploadType }) => Promise<{ url: string; token?: string }> } } };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a"]);

/** Resolve upload type from file extension and/or content-type header. */
export function resolveUploadType(ext?: string, contentType?: string): UploadType {
  const bareExt = ext?.replace(/^\./, "").toLowerCase() ?? "";
  if (contentType?.startsWith("image/") || IMAGE_EXTS.has(bareExt)) return "image";
  if (contentType?.startsWith("video/") || VIDEO_EXTS.has(bareExt)) return "video";
  if (contentType?.startsWith("audio/") || AUDIO_EXTS.has(bareExt)) return "audio";
  return "file";
}

/** Strip "max:" prefix from IDs. */
export function stripMaxPrefix(id: string): string {
  return id.replace(/^max:/i, "");
}

/**
 * Upload any media via raw Max Bot API, bypassing the SDK's upload helpers.
 *
 * The SDK loses the token for Buffer uploads in some cases. This helper
 * uses the raw getUploadUrl endpoint and captures the token from either
 * the getUploadUrl response or the upload response itself.
 *
 * Works for all types: image, video, audio, file.
 */
export async function rawUpload(
  api: RawUploadsApi,
  type: UploadType,
  source: string | Buffer,
  filename: string,
): Promise<{ type: UploadType; payload: { token: string } }> {
  const resp = await api.raw.uploads.getUploadUrl({ type });
  const uploadUrl = resp.url;
  let token = resp.token;

  const buf = typeof source === "string" ? fs.readFileSync(source) : source;
  const name = typeof source === "string" ? path.basename(source) : filename;

  const formData = new FormData();
  formData.append("data", new Blob([buf as BlobPart]), name);
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: formData });

  // Token may come from the upload response instead of getUploadUrl
  if (!token) {
    try {
      const json = await uploadRes.json() as Record<string, unknown>;
      if (typeof json.token === "string") {
        token = json.token;
      }
    } catch {
      // response may not be JSON
    }
  }

  if (!token) {
    throw new Error(`Max API did not return an upload token for type "${type}"`);
  }

  return { type, payload: { token } };
}

