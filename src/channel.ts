import { buildAccountScopedDmSecurityPolicy } from "openclaw/plugin-sdk/channel-policy";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getApi as getApiFromRegistry, getAllBots } from "./registry.js";
import { startPolling, stopPolling } from "./polling.js";
import { rawUpload, resolveUploadType, stripMaxPrefix } from "./upload-file.js";
import type { MaxAccountConfig, MaxChannelsConfig, MaxSendContext, MaxSendResult } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

function readAccounts(cfg: unknown): Record<string, MaxAccountConfig> {
  return (cfg as MaxChannelsConfig)?.channels?.max?.accounts ?? {};
}

function findAccount(cfg: unknown, accountId?: string | null): MaxAccountConfig | undefined {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const account = readAccounts(cfg)[id];
  return account ? { ...account, accountId: id } : undefined;
}

function requireApi(account: MaxAccountConfig | undefined) {
  if (account?.token) {
    const api = getApiFromRegistry(account.token);
    if (api) return api;
  }
  const allBots = getAllBots();
  if (allBots.length > 0) {
    return allBots[0].api;
  }
  throw new Error("Bot not started — no API available");
}

// Outbound contexts carry cfg + accountId, never a resolved account object.
function requireApiFor(cfg: unknown, accountId?: string | null) {
  return requireApi(findAccount(cfg, accountId));
}

function resolveChatId(to: string | undefined): number {
  const chatId = Number(stripMaxPrefix(String(to ?? "")));
  if (!Number.isFinite(chatId)) {
    throw new Error(`Invalid Max target "${to}"`);
  }
  return chatId;
}

async function sendMaxText(ctx: MaxSendContext): Promise<MaxSendResult> {
  const api = requireApiFor(ctx.cfg, ctx.accountId);
  const chatId = resolveChatId(ctx.to);

  if (ctx.messageId) {
    await api.editMessage(ctx.messageId, { text: ctx.text });
    return {
      channel: "max",
      messageId: ctx.messageId,
      target: { kind: "chat", id: String(chatId) },
    };
  }

  const sent = await api.sendMessageToChat(chatId, ctx.text);
  return {
    channel: "max",
    messageId: sent.body.mid,
    target: { kind: "chat", id: String(chatId) },
    timestamp: sent.timestamp,
  };
}

async function sendMaxMedia(ctx: MaxSendContext & { mediaUrl?: string }): Promise<MaxSendResult> {
  const api = requireApiFor(ctx.cfg, ctx.accountId);
  const chatId = resolveChatId(ctx.to);

  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    throw new Error("No media URL provided");
  }

  const isLocalPath = mediaUrl.startsWith("/");
  const urlPath = mediaUrl.split("?")[0];
  const filename = urlPath.split("/").pop() || "file";
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : "";

  // For local files pass path (preserves filename), for URLs pass buffer
  let contentType = "";
  const source: string | Buffer = isLocalPath ? mediaUrl : await (async () => {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);
    contentType = res.headers.get("content-type") || "";
    return Buffer.from(await res.arrayBuffer());
  })();

  const uploadType = resolveUploadType(ext ?? "", contentType);

  // Use rawUpload for all types to avoid SDK token bugs with Buffer sources
  const attachment = await rawUpload(api, uploadType, source, filename);
  const sent = await api.sendMessageToChat(
    chatId,
    ctx.text ?? (uploadType === "file" ? filename : ""),
    { attachments: [attachment] },
  );

  return {
    channel: "max",
    messageId: sent.body.mid,
    target: { kind: "chat", id: String(chatId) },
    timestamp: sent.timestamp,
  };
}

export const maxChannel: ChannelPlugin<MaxAccountConfig> = {
  id: "max",

  meta: {
    id: "max",
    label: "Max Messenger",
    selectionLabel: "Max Messenger (Bot API)",
    docsPath: "/channels/max",
    blurb: "Connect AI agents to Max messenger via Bot API.",
    aliases: ["max-messenger"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    edit: true,
    threads: false,
    reply: true,
  },

  reload: {
    configPrefixes: ["channels.max"],
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry: string) => stripMaxPrefix(entry),
    notifyApproval: async ({ id }) => {
      const bots = getAllBots();
      const bot = bots.find(b => b.api !== undefined);
      if (bot) {
        try {
          await bot.api.sendMessageToUser(Number(id), "✅ OpenClaw access approved. Send a message to start chatting.");
        } catch {
          // User might not have started conversation with bot yet
        }
      }
    },
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg: cfg as unknown as Record<string, unknown>,
        channelKey: "max",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.dmPolicy,
        allowFrom: account.allowFrom ?? [],
        normalizeEntry: stripMaxPrefix,
      });
    },
  },

  config: {
    listAccountIds: (cfg) => Object.keys(readAccounts(cfg)),

    resolveAccount: (cfg, accountId) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = findAccount(cfg, id);
      if (!account) {
        throw new Error(`Max account "${id}" not found in configuration`);
      }
      return account;
    },

    // Diagnostics surface: same fields as resolveAccount minus the token.
    inspectAccount: (cfg, accountId) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = findAccount(cfg, id);
      return {
        accountId: id,
        present: Boolean(account),
        configured: Boolean(account?.token),
        botId: account?.botId,
        dmPolicy: account?.dmPolicy,
        allowFromCount: account?.allowFrom?.length ?? 0,
      };
    },

    isConfigured: (account) => Boolean(account?.token),
    unconfiguredReason: () => "Max bot token is not set",
  },

  outbound: {
    deliveryMode: "direct",

    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) return { ok: false, error: new Error("No target specified") };
      // Strip channel prefix: "max:226805445" → "226805445"
      return { ok: true, to: stripMaxPrefix(trimmed) };
    },

    sendText: (ctx) => sendMaxText(ctx as MaxSendContext),
    sendMedia: (ctx) => sendMaxMedia(ctx as MaxSendContext & { mediaUrl?: string }),
  },

  // Core drives its shared message tool through this adapter.
  message: createChannelMessageAdapterFromOutbound({
    id: "max",
    outbound: {
      sendText: (ctx) => sendMaxText(ctx as unknown as MaxSendContext),
      sendMedia: (ctx) => sendMaxMedia(ctx as unknown as MaxSendContext & { mediaUrl?: string }),
    },
  }),

  gateway: {
    startAccount: async (ctx) => {
      const { accountId, account, runtime, abortSignal } = ctx;

      if (!account.token) {
        throw new Error(
          `Max not configured for account "${accountId}" (missing token)`,
        );
      }

      ctx.log?.info?.(`[${accountId}] starting Max Messenger polling`);

      const log = ctx.log;
      const join = (args: unknown[]) => args.map(String).join(" ");
      const logger: import("./types.js").PluginLogger = {
        info: (...args) => (log ? log.info(join(args)) : runtime.log?.(join(args))),
        warn: (...args) => (log ? log.warn(join(args)) : runtime.log?.(join(args))),
        error: (...args) => (log ? log.error(join(args)) : runtime.error?.(join(args))),
        debug: (...args) => log?.debug?.(join(args)),
      };

      await startPolling({
        accounts: { [accountId]: account },
        logger,
        runtime,
      });

      // Keep the promise pending until abort signal fires
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          stopPolling();
          resolve();
          return;
        }
        abortSignal.addEventListener(
          "abort",
          () => {
            stopPolling();
            resolve();
          },
          { once: true },
        );
      });
    },

    stopAccount: async () => {
      stopPolling();
    },
  },
};
