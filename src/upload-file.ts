import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api } from "@maxhub/max-bot-api";

export type UploadType = "image" | "video" | "audio" | "file";

// Neither AttachmentRequest nor UpdateType is re-exported by the package, so
// derive the attachment shape from the public sendMessageToChat signature.
type SendMessageExtra = NonNullable<Parameters<Api["sendMessageToChat"]>[2]>;
export type MaxAttachmentRequest = NonNullable<SendMessageExtra["attachments"]>[number];

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

function safeFileName(filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "file";
}

/**
 * Upload media and return the attachment payload for sendMessage.
 *
 * Buffers are staged through a temp file on purpose: the SDK names a Buffer
 * upload with a random UUID, which would reach the recipient instead of the
 * real filename. Going through a path also takes the SDK's chunked upload
 * path, which is what makes large files survive.
 */
export async function uploadAttachment(
  api: Api,
  type: UploadType,
  source: string | Buffer,
  filename: string,
): Promise<MaxAttachmentRequest> {
  let tempDir: string | undefined;
  let uploadPath: string;

  if (typeof source === "string") {
    uploadPath = source;
  } else {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "max-upload-"));
    uploadPath = path.join(tempDir, safeFileName(filename));
    await fs.promises.writeFile(uploadPath, source);
  }

  try {
    switch (type) {
      case "image":
        return (await api.uploadImage({ source: uploadPath })).toJson();
      case "video":
        return (await api.uploadVideo({ source: uploadPath })).toJson();
      case "audio":
        return (await api.uploadAudio({ source: uploadPath })).toJson();
      default:
        return (await api.uploadFile({ source: uploadPath })).toJson();
    }
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
}
