import fs from "node:fs";
import path from "node:path";
import { getApi } from "./registry.js";
import { uploadAttachment, resolveUploadType } from "./upload-file.js";

let lastUsedContext: { chatId: number; accountToken: string } | undefined;

/** Called only for senders that passed access control. */
export function recordLastUsedContext(chatId: number, accountToken: string): void {
  lastUsedContext = { chatId, accountToken };
}

export function clearLastUsedContext(): void {
  lastUsedContext = undefined;
}

function resolveContext(): { chatId: number; api: NonNullable<ReturnType<typeof getApi>> } | null {
  if (!lastUsedContext) return null;
  // The chat id belongs to the account that received the message, so the send
  // has to go through that same bot rather than whichever one registered first.
  const api = getApi(lastUsedContext.accountToken);
  if (!api) return null;
  return { chatId: lastUsedContext.chatId, api };
}

export const sendFileTool = {
  name: "max_send_file",
  label: "Send File",
  description:
    "Send a file from the local filesystem to the current chat. " +
    "Use this when the user asks you to send, share, or deliver a file. " +
    "Supports any file type: PDF, images, documents, archives, etc.",
  parameters: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string" as const,
        description: "Absolute path to the file to send",
      },
      caption: {
        type: "string" as const,
        description: "Optional message to send with the file",
      },
    },
    required: ["file_path"],
  },
  async execute(_toolCallId: string, params: Record<string, unknown>) {
    const filePath = String(params.file_path ?? "").trim();
    if (!filePath) {
      return {
        content: [{ type: "text" as const, text: "Error: file_path is required" }],
        details: { ok: false, reason: "missing_file_path" },
      };
    }

    const resolved = resolveContext();
    if (!resolved) {
      return {
        content: [{ type: "text" as const, text: "Error: no active chat context — cannot determine where to send the file" }],
        details: { ok: false, reason: "no_chat_context" },
      };
    }

    const { chatId, api } = resolved;
    const caption = String(params.caption ?? "").trim();
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const uploadType = resolveUploadType(ext);

    try {
      const attachment = await uploadAttachment(api, uploadType, filePath, filename);
      const fileSize = fs.statSync(filePath).size;
      await api.sendMessageToChat(chatId, caption || filename, {
        attachments: [attachment],
      });

      return {
        content: [{ type: "text" as const, text: `File sent: ${filename} (${fileSize} bytes)` }],
        details: { ok: true, filename, fileSize, uploadType, chatId },
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error sending file: ${String(err)}` }],
        details: { ok: false, reason: "send_failed", error: String(err) },
      };
    }
  },
};
