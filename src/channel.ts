import {
  buildAccountScopedDmSecurityPolicy,
} from "openclaw/plugin-sdk";
import { getApi as getApiFromRegistry, getAllBots } from "./registry.js";
import { startPolling, stopPolling } from "./polling.js";
import { rawUpload, resolveUploadType, stripMaxPrefix } from "./upload-file.js";
import type { MaxAccountConfig, MaxChannelsConfig, MaxOutboundContext } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

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

export const maxChannel = {
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
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    edit: true,
    threads: false,
    reply: true,
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry: string) => stripMaxPrefix(entry),
    notifyApproval: async ({ id }: { cfg: unknown; id: string; runtime?: unknown }) => {
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
    resolveDmPolicy: ({ cfg, accountId, account }: { cfg: unknown; accountId?: string | null; account: MaxAccountConfig }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg: cfg as Record<string, unknown>,
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
    listAccountIds: (cfg: MaxChannelsConfig): string[] =>
      Object.keys(cfg.channels?.max?.accounts ?? {}),

    resolveAccount: (
      cfg: MaxChannelsConfig,
      accountId?: string
    ): MaxAccountConfig => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = cfg.channels?.max?.accounts?.[id];
      if (!account) {
        throw new Error(`Max account "${id}" not found in configuration`);
      }
      return { ...account, accountId: id };
    },
  },

  outbound: {
    deliveryMode: "direct" as const,

    resolveTarget: (params: { to?: string; cfg?: unknown; accountId?: string }) => {
      const to = params.to?.trim();
      if (!to) return { ok: false, error: new Error("No target specified") };
      // Strip channel prefix: "max:226805445" → "226805445"
      const stripped = stripMaxPrefix(to);
      return { ok: true, to: stripped };
    },

    sendText: async (ctx: MaxOutboundContext) => {
      const api = requireApi(ctx.account);
      // ctx.chatId or ctx.to may contain "max:123" prefix
      const rawId = ctx.chatId ?? (ctx as unknown as Record<string, unknown>).to as string ?? "";
      const chatId = Number(stripMaxPrefix(String(rawId)));

      if (ctx.messageId) {
        await api.editMessage(ctx.messageId, { text: ctx.text });
      } else {
        await api.sendMessageToChat(chatId, ctx.text);
      }

      return { ok: true };
    },

    sendMedia: async (ctx: Record<string, unknown>) => {
      const api = requireApi(ctx.account as MaxAccountConfig);
      const rawId = (ctx.chatId ?? ctx.to ?? "") as string;
      const chatId = Number(stripMaxPrefix(String(rawId)));

      // OpenClaw passes mediaUrl — can be a URL or a local file path
      const mediaUrl = (ctx.mediaUrl ?? ctx.url) as string | undefined;
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
      await api.sendMessageToChat(chatId, (ctx.text as string) ?? (uploadType === "file" ? filename : ""), {
        attachments: [attachment],
      });

      return { ok: true };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: MaxAccountConfig;
      runtime: { log?: (msg: string) => void; error?: (msg: string) => void };
      abortSignal: AbortSignal;
      log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    }) => {
      const { accountId, account, runtime, abortSignal } = ctx;

      if (!account.token) {
        throw new Error(
          `Max not configured for account "${accountId}" (missing token)`,
        );
      }

      ctx.log?.info(`[${accountId}] starting Max Messenger polling`);

      const logger: import("./types.js").PluginLogger = ctx.log
        ? { ...ctx.log, debug: (ctx.log as Record<string, unknown>).debug as ((...args: unknown[]) => void) ?? (() => {}) }
        : {
            info: (...args: unknown[]) => runtime.log?.(String(args.join(" "))),
            warn: (...args: unknown[]) => runtime.log?.(String(args.join(" "))),
            error: (...args: unknown[]) => runtime.error?.(String(args.join(" "))),
            debug: () => {},
          };

      await startPolling({
        accounts: { [accountId]: account },
        logger,
        runtime: runtime as import("openclaw/plugin-sdk").RuntimeEnv,
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
  },
};
