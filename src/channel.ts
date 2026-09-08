import { buildAccountScopedDmSecurityPolicy } from "openclaw/plugin-sdk/channel-policy";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getApi as getApiFromRegistry } from "./registry.js";
import { startPolling, stopPolling } from "./polling.js";
import { uploadAttachment, resolveUploadType, stripMaxPrefix } from "./upload-file.js";
import { fetchRemoteMedia, readLocalMedia, type MediaAccessContext } from "./media-access.js";
import type {
  MaxAccountConfig,
  MaxChannelsConfig,
  MaxSendContext,
  MaxSendResult,
} from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

function readAccounts(cfg: unknown): Record<string, MaxAccountConfig> {
  return (cfg as MaxChannelsConfig)?.channels?.max?.accounts ?? {};
}

function findAccount(cfg: unknown, accountId?: string | null): MaxAccountConfig | undefined {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const account = readAccounts(cfg)[id];
  return account ? { ...account, accountId: id } : undefined;
}

/**
 * Resolve the bot for one account. There is deliberately no "use whichever bot
 * started first" fallback: it silently sends from the wrong account whenever a
 * poll loop is down or a token was rotated.
 */
function requireApiFor(cfg: unknown, accountId?: string | null) {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const account = findAccount(cfg, id);
  if (!account?.token) {
    throw new Error(`Max account "${id}" is not configured`);
  }
  const api = getApiFromRegistry(account.token);
  if (!api) {
    throw new Error(`Max bot for account "${id}" is not running`);
  }
  return api;
}

function resolveChatId(to: string | undefined): number {
  const raw = stripMaxPrefix(String(to ?? "").trim()).trim();
  if (!raw) {
    throw new Error(`Invalid Max target "${to}": empty chat id`);
  }
  const chatId = Number(raw);
  // Number("") is 0 and Number("1.5") is finite, so neither check is redundant.
  if (!Number.isSafeInteger(chatId)) {
    throw new Error(`Invalid Max target "${to}": chat id must be an integer`);
  }
  return chatId;
}

async function sendMaxText(ctx: MaxSendContext): Promise<MaxSendResult> {
  const api = requireApiFor(ctx.cfg, ctx.accountId);
  const chatId = resolveChatId(ctx.to);

  const sent = await api.sendMessageToChat(chatId, ctx.text);
  return {
    channel: "max",
    messageId: sent.body.mid,
    target: { kind: "chat", id: String(chatId) },
    timestamp: sent.timestamp,
  };
}

async function sendMaxMedia(
  ctx: MaxSendContext & { mediaUrl?: string } & MediaAccessContext,
): Promise<MaxSendResult> {
  const api = requireApiFor(ctx.cfg, ctx.accountId);
  const chatId = resolveChatId(ctx.to);

  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    throw new Error("No media URL provided");
  }

  const urlPath = mediaUrl.split("?")[0];
  const filename = urlPath.split("/").pop() || "file";
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : "";

  let contentType = "";
  let source: Buffer;
  if (mediaUrl.startsWith("/")) {
    source = await readLocalMedia(mediaUrl, ctx);
  } else {
    const fetched = await fetchRemoteMedia(mediaUrl);
    source = fetched.buffer;
    contentType = fetched.contentType;
  }

  const uploadType = resolveUploadType(ext ?? "", contentType);

  const attachment = await uploadAttachment(api, uploadType, source, filename);
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

const maxOutbound = {
  deliveryMode: "direct" as const,

  resolveTarget: ({ to }: { to?: string }) => {
    const trimmed = to?.trim();
    if (!trimmed) return { ok: false as const, error: new Error("No target specified") };
    // Strip channel prefix: "max:226805445" → "226805445"
    return { ok: true as const, to: stripMaxPrefix(trimmed) };
  },

  sendText: (ctx: unknown) => sendMaxText(ctx as MaxSendContext),
  sendMedia: (ctx: unknown) =>
    sendMaxMedia(ctx as MaxSendContext & { mediaUrl?: string } & MediaAccessContext),
};

type MessageAdapterOutbound = Parameters<
  typeof createChannelMessageAdapterFromOutbound
>[0]["outbound"];

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
    // Max can edit, but this plugin exposes no adapter core could call to do
    // it, so advertising the capability would just misroute edit features.
    edit: false,
    threads: false,
    reply: true,
  },

  // Every block Max delivers is its own Bot API call, so coalesce into
  // chunky pieces: smaller values make the reply visibly stutter.
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 280,
      idleMs: 900,
    },
  },

  reload: {
    configPrefixes: ["channels.max"],
    accountScopedRestart: true,
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry: string) => stripMaxPrefix(entry),
    notifyApproval: async ({ cfg, id, accountId }) => {
      const account = findAccount(cfg, accountId);
      const api = account?.token ? getApiFromRegistry(account.token) : undefined;
      if (!api) return;
      try {
        await api.sendMessageToUser(
          Number(stripMaxPrefix(String(id))),
          "✅ OpenClaw access approved. Send a message to start chatting.",
        );
      } catch {
        // User might not have started conversation with bot yet
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

  outbound: maxOutbound,

  // Same adapter object, so the message tool cannot drift from outbound.
  message: createChannelMessageAdapterFromOutbound({
    id: "max",
    outbound: maxOutbound as unknown as MessageAdapterOutbound,
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
      // Forward arguments untouched to the host sink: joining them here would
      // flatten Error objects and lose the stack the gateway log needs.
      const logger: import("./types.js").PluginLogger = log
        ? {
            info: (...args) => (log.info as (...a: unknown[]) => void)(...args),
            warn: (...args) => (log.warn as (...a: unknown[]) => void)(...args),
            error: (...args) => (log.error as (...a: unknown[]) => void)(...args),
            debug: (...args) => (log.debug as ((...a: unknown[]) => void) | undefined)?.(...args),
          }
        : {
            info: (...args) => runtime.log?.(join(args)),
            warn: (...args) => runtime.log?.(join(args)),
            error: (...args) => runtime.error?.(join(args)),
            debug: () => {},
          };

      await startPolling({
        accounts: { [accountId]: account },
        logger,
        runtime,
      });

      // Keep the promise pending until abort signal fires
      await new Promise<void>((resolve) => {
        const stop = () => {
          stopPolling(accountId);
          resolve();
        };
        if (abortSignal.aborted) {
          stop();
          return;
        }
        abortSignal.addEventListener("abort", stop, { once: true });
      });
    },

    // Scoped to the account core asked about; sibling accounts keep polling.
    stopAccount: async (ctx) => {
      stopPolling(ctx.accountId);
    },
  },
};
