import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  resolveOutboundMediaUrls,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getMaxRuntime } from "./runtime.js";
import { getApi } from "./registry.js";
import { uploadAttachment, resolveUploadType, stripMaxPrefix } from "./upload-file.js";
import { fetchRemoteMedia, isPathInsideRoots } from "./media-access.js";
import { recordLastUsedContext } from "./send-file-tool.js";
import type { InboundMessage, MaxAccountConfig } from "./types.js";

const CHANNEL_ID = "max" as const;

/** Cap inbound downloads: senders control both the count and the size. */
const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INBOUND_ATTACHMENTS = 10;

/** Policy applied when the account config names none. Matches the default that
 *  security.resolveDmPolicy reports to core, so status cannot claim a gate that
 *  inbound does not enforce. */
const DEFAULT_DM_POLICY = "pairing";

async function saveInboundFile(
  buffer: Buffer,
  filename: string,
  accountId: string,
): Promise<string> {
  const dir = path.join(os.homedir(), ".openclaw", "media", "max", accountId);
  await fs.promises.mkdir(dir, { recursive: true });
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const filePath = path.join(dir, safeName);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

async function deliverMaxReply(params: {
  payload: OutboundReplyPayload;
  chatId: string;
  account: MaxAccountConfig;
  mediaRoots: readonly string[];
}): Promise<void> {
  const { payload, chatId, account, mediaRoots } = params;

  const api = getApi(account.token);
  if (!api) {
    throw new Error("Max API client not available for outbound delivery");
  }

  const numericChatId = Number(chatId);
  const mediaUrls = resolveOutboundMediaUrls(payload);

  // Send media files first, then whatever text is left.
  for (const url of mediaUrls) {
    try {
      const urlFilename = url.split("/").pop()?.split("?")[0] || "file";
      let buf: Buffer;
      let contentType = "";

      if (url.startsWith("/")) {
        if (!isPathInsideRoots(url, mediaRoots)) continue;
        buf = await fs.promises.readFile(url);
      } else {
        const fetched = await fetchRemoteMedia(url);
        buf = fetched.buffer;
        contentType = fetched.contentType;
      }

      const uploadType = resolveUploadType(undefined, contentType);
      const attachment = await uploadAttachment(api, uploadType, buf, urlFilename);
      await api.sendMessageToChat(numericChatId, "", {
        attachments: [attachment],
      });
    } catch {
      // Fall back to text link if media send fails
    }
  }

  // Extract local file paths from text and send them as attachments.
  // The text is model-authored, so only paths inside the agent's own media
  // roots are eligible — otherwise a stray path exfiltrates whatever it names.
  let text = payload.text?.trim() ?? "";
  const filePathRegex = /(?:^|\s)(\/[\w/._ -]+\.[\w]+)/g;
  let match: RegExpExecArray | null;
  const filePaths: string[] = [];
  while ((match = filePathRegex.exec(text)) !== null) {
    const fp = match[1].trim();
    if (isPathInsideRoots(fp, mediaRoots) && fs.existsSync(fp)) {
      filePaths.push(fp);
    }
  }

  for (const fp of filePaths) {
    try {
      const filename = path.basename(fp);
      const ext = path.extname(fp).toLowerCase();
      const uploadType = resolveUploadType(ext);
      const attachment = await uploadAttachment(api, uploadType, fp, filename);
      await api.sendMessageToChat(numericChatId, uploadType === "file" ? filename : "", {
        attachments: [attachment],
      });
      text = text.replace(fp, `[📎 ${filename}]`);
    } catch {
      // Keep the path in text if sending fails
    }
  }

  if (text) {
    await api.sendMessageToChat(numericChatId, text);
  }
}

/** Download inbound attachments and describe them for the agent. */
async function collectInboundAttachments(
  message: InboundMessage,
  accountId: string,
): Promise<string[]> {
  const descriptions: string[] = [];
  const attachments = (message.attachments ?? []).slice(0, MAX_INBOUND_ATTACHMENTS);

  for (const att of attachments) {
    if (!att.url) continue;
    const label = att.filename || att.type || "file";
    try {
      const { buffer } = await fetchRemoteMedia(att.url);
      if (buffer.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
        descriptions.push(`[Attached ${att.type}: ${label} (too large, skipped)]`);
        continue;
      }
      const savedPath = await saveInboundFile(buffer, label, accountId);
      descriptions.push(`[Attached ${att.type}: ${label}, saved to: ${savedPath}]`);
    } catch {
      descriptions.push(`[Attached ${att.type}: ${label} (download failed)]`);
    }
  }

  return descriptions;
}

export async function handleMaxInbound(params: {
  message: InboundMessage;
  account: MaxAccountConfig;
  accountId: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { message, account, accountId, runtime } = params;
  const core = getMaxRuntime();

  const text = message.text?.trim() ?? "";
  if (!text && !message.attachments?.length) {
    return;
  }

  const cfg = core.config.current() as OpenClawConfig;
  const isGroup = message.isGroup ?? false;
  const senderId = message.userId;
  const senderName = message.displayName ?? message.username ?? senderId;
  const chatId = message.chatId;

  // --- Access control: check DM policy / pairing ---
  // Runs before any download or state write, so a sender who is about to be
  // blocked cannot make the plugin fetch, store, or retarget anything.
  // Max bots live in group-style chats, so apply policy regardless of isGroup.
  const dmPolicy = account.dmPolicy ?? DEFAULT_DM_POLICY;
  if (dmPolicy !== "open") {
    const pairing = createChannelPairingController({
      core,
      channel: CHANNEL_ID,
      accountId,
    });
    const storeAllowFrom = await pairing.readAllowFromStore();
    const configAllowFrom = account.allowFrom ?? [];

    const { decision } = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy,
      allowFrom: configAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowList: Array<string | number>) => {
        const normalizedSender = String(senderId);
        return allowList.some(
          (entry: string | number) => stripMaxPrefix(String(entry)) === normalizedSender
        );
      },
    });

    if (decision === "pairing") {
      const api = getApi(account.token);
      // channel, accountId and the store writer are pre-bound by the controller.
      await pairing.issueChallenge({
        senderId: String(senderId),
        senderIdLine: `maxUserId: ${senderId}`,
        sendPairingReply: async (reply: string) => {
          if (api) {
            await api.sendMessageToChat(Number(chatId), reply);
          }
        },
      });
      return;
    }

    if (decision === "block") {
      return;
    }
  }

  // Only an authorized sender may become the target that max_send_file writes to.
  recordLastUsedContext(Number(chatId), account.token);

  let rawBody = text;
  if (message.attachments?.length) {
    const fileDescriptions = await collectInboundAttachments(message, accountId);
    if (fileDescriptions.length) {
      rawBody = rawBody
        ? `${rawBody}\n\n${fileDescriptions.join("\n")}`
        : fileDescriptions.join("\n");
    }
  }

  if (!rawBody) {
    return;
  }

  // For routing, use senderId as peer ID — Max bot chats appear as groups
  // but are effectively 1:1 conversations, and we route by sender
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
  });

  const mediaRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);

  const fromLabel = isGroup
    ? `group:${chatId}`
    : senderName || `user:${senderId}`;

  const storePath = core.channel.session.resolveStorePath(
    (cfg.session as Record<string, unknown> | undefined)?.store as
      | string
      | undefined,
    { agentId: route.agentId },
  );

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Max Messenger",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `max:group:${chatId}` : `max:${senderId}`,
    To: `max:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? chatId : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `max:${chatId}`,
    CommandAuthorized: true,
  });

  await dispatchInboundReplyWithBase({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload: OutboundReplyPayload) => {
      await deliverMaxReply({
        payload,
        chatId,
        account,
        mediaRoots,
      });
    },
    onRecordError: (err: unknown) => {
      runtime?.error?.(
        `max: failed updating session meta: ${String(err)}`,
      );
    },
    onDispatchError: (err: unknown, info: { kind: string }) => {
      runtime?.error?.(
        `max ${info.kind} reply failed: ${String(err)}`,
      );
    },
  });
}
