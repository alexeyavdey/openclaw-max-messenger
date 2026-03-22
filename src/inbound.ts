import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  dispatchInboundReplyWithBase,
  resolveOutboundMediaUrls,
  resolveDmGroupAccessWithLists,
  issuePairingChallenge,
  createScopedPairingAccess,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import { getMaxRuntime } from "./runtime.js";
import { getApi } from "./registry.js";
import { rawUpload, resolveUploadType, stripMaxPrefix } from "./upload-file.js";
import type { InboundMessage, MaxAccountConfig } from "./types.js";

async function saveInboundFile(
  _core: PluginRuntime,
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

const CHANNEL_ID = "max" as const;

async function deliverMaxReply(params: {
  payload: OutboundReplyPayload;
  chatId: string;
  account: MaxAccountConfig;
}): Promise<void> {
  const { payload, chatId, account } = params;

  const api = getApi(account.token);
  if (!api) {
    throw new Error("Max API client not available for outbound delivery");
  }

  const numericChatId = Number(chatId);
  const mediaUrls = resolveOutboundMediaUrls(payload);

  // Send media files first — use rawUpload for all types to avoid SDK token bugs with Buffers
  for (const url of mediaUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "";
      const urlFilename = url.split("/").pop()?.split("?")[0] || "file";

      const uploadType = resolveUploadType(undefined, contentType);

      const attachment = await rawUpload(api, uploadType, buf, urlFilename);
      await api.sendMessageToChat(numericChatId, "", {
        attachments: [attachment],
      });
    } catch {
      // Fall back to text link if media send fails
    }
  }

  // Extract local file paths from text and send them as attachments
  let text = payload.text?.trim() ?? "";
  const filePathRegex = /(?:^|\s)(\/[\w/._ -]+\.[\w]+)/g;
  let match: RegExpExecArray | null;
  const filePaths: string[] = [];
  while ((match = filePathRegex.exec(text)) !== null) {
    const fp = match[1].trim();
    if (fs.existsSync(fp)) {
      filePaths.push(fp);
    }
  }

  for (const fp of filePaths) {
    try {
      const filename = path.basename(fp);
      const ext = path.extname(fp).toLowerCase();
      const uploadType = resolveUploadType(ext);
      const attachment = await rawUpload(api, uploadType, fp, filename);
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

export async function handleMaxInbound(params: {
  message: InboundMessage;
  account: MaxAccountConfig;
  accountId: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { message, account, accountId, runtime } = params;
  const core = getMaxRuntime();

  let rawBody = message.text?.trim() ?? "";

  // Handle inbound file attachments — download and add context for the agent
  if (message.attachments?.length) {
    const fileDescriptions: string[] = [];
    for (const att of message.attachments) {
      if (att.url) {
        try {
          const res = await fetch(att.url);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            const filename = att.filename || att.type || "file";
            const savedPath = await saveInboundFile(core, buf, filename, accountId);
            fileDescriptions.push(`[Attached ${att.type}: ${filename}, saved to: ${savedPath}]`);
          } else {
            fileDescriptions.push(`[Attached ${att.type}: ${att.filename || att.type} (download failed)]`);
          }
        } catch {
          fileDescriptions.push(`[Attached ${att.type}: ${att.filename || att.type} (download failed)]`);
        }
      }
    }
    if (fileDescriptions.length) {
      rawBody = rawBody
        ? `${rawBody}\n\n${fileDescriptions.join("\n")}`
        : fileDescriptions.join("\n");
    }
  }

  if (!rawBody) {
    return;
  }

  const cfg = core.config.loadConfig() as OpenClawConfig;
  const isGroup = message.isGroup ?? false;
  const senderId = message.userId;
  const senderName = message.displayName ?? message.username ?? senderId;
  const chatId = message.chatId;

  // --- Access control: check DM policy / pairing ---
  // Max bots live in group-style chats, so apply policy regardless of isGroup
  const dmPolicy = account.dmPolicy;
  if (dmPolicy && dmPolicy !== "open") {
    const pairing = createScopedPairingAccess({
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
      await issuePairingChallenge({
        channel: CHANNEL_ID,
        senderId: String(senderId),
        senderIdLine: `maxUserId: ${senderId}`,
        upsertPairingRequest: (params: { id: string; meta?: Record<string, string | null | undefined> }) =>
          pairing.upsertPairingRequest({
            id: params.id,
            meta: params.meta,
          }),
        sendPairingReply: async (text: string) => {
          if (api) {
            await api.sendMessageToChat(Number(chatId), text);
          }
        },
      });
      return;
    }

    if (decision === "block") {
      return;
    }
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
