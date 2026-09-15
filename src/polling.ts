import { Bot } from "@maxhub/max-bot-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { handleMaxInbound } from "./inbound.js";
import { registerBot, unregisterBot } from "./registry.js";
import type { MaxAccountConfig, InboundAttachment, PluginLogger } from "./types.js";

interface RawAttachment {
  type: string;
  payload?: { url?: string; token?: string };
  filename?: string;
  size?: number;
}

const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "image", "video", "audio", "file", "sticker", "contact", "location", "share",
]);

// UpdateType is not re-exported by the package, so take it from the public
// start() signature instead of reaching into the SDK's internal paths.
type PollingStart = Extract<NonNullable<Parameters<Bot["start"]>[0]>, { mode: "polling" }>;
type AllowedUpdates = NonNullable<NonNullable<PollingStart["options"]>["allowedUpdates"]>;

const DEFAULT_ALLOWED_UPDATES: AllowedUpdates = ["message_created", "bot_started"];

export function extractAttachments(
  rawAttachments: RawAttachment[] | null | undefined
): InboundAttachment[] | undefined {
  if (!rawAttachments?.length) return undefined;

  const result = rawAttachments
    .filter((a) => SUPPORTED_ATTACHMENT_TYPES.has(a.type))
    .map((a): InboundAttachment => {
      const attachment: InboundAttachment = {
        type: a.type as InboundAttachment["type"],
        url: a.payload?.url,
        token: a.payload?.token,
      };

      if (a.type === "file") {
        attachment.filename = a.filename;
        attachment.size = a.size;
      }

      return attachment;
    });

  return result.length ? result : undefined;
}

type AccountState = {
  bot: Bot;
  token: string;
  stopped: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
};

const activeBots = new Map<string, AccountState>();

const MAX_RESTART_DELAY_MS = 60_000;

type AccountContext = {
  accountId: string;
  config: MaxAccountConfig;
  logger: PluginLogger;
  runtime?: RuntimeEnv;
  /** Already validated and normalised; undefined means the SDK's default host. */
  apiBaseUrl?: string;
};

/**
 * Validate a configured base URL and make it safe to resolve against.
 *
 * The SDK builds every call as `new URL("messages", baseUrl)`, so a base that
 * carries a path loses it unless it ends in a slash, and a malformed base
 * throws on the first call — deep inside the poll loop, where it surfaces only
 * as an endless restart cycle.
 */
function resolveApiBaseUrl(
  raw: string | undefined,
  accountId: string,
  logger: PluginLogger,
): string | undefined {
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Max account "${accountId}": apiBaseUrl is not a valid URL ("${raw}")`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Max account "${accountId}": apiBaseUrl must be http(s), got "${url.protocol}//"`,
    );
  }

  if (url.protocol === "http:") {
    logger.warn(
      `Max account "${accountId}": apiBaseUrl is plain http, so the bot token travels unencrypted`,
    );
  }

  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** Build a bot with every handler attached. Restarts reuse this so a
 *  replacement bot is never left polling without listeners. */
function createBot(ctx: AccountContext): Bot {
  const { accountId, config, logger, runtime, apiBaseUrl } = ctx;
  const bot = new Bot(
    config.token,
    apiBaseUrl ? { clientOptions: { baseUrl: apiBaseUrl } } : undefined,
  );

  bot.on("message_created", (botCtx: unknown) => {
    const c = botCtx as Record<string, unknown>;
    const chatId = c.chatId as number | undefined;
    const user = c.user as Record<string, unknown> | undefined;
    const userId = user?.user_id as number | undefined;
    const messageId = c.messageId as number | undefined;
    const myId = c.myId as number | undefined;

    if (!chatId || !userId) return;

    // Ignore messages sent by the bot itself
    const selfId = myId ?? (config.botId ? Number(config.botId) : undefined);
    if (selfId && userId === selfId) return;

    const message = c.message as Record<string, unknown> | undefined;
    const body = message?.body as Record<string, unknown> | undefined;
    const text = (body?.text as string) ?? "";
    const attachments = extractAttachments(
      body?.attachments as RawAttachment[] | null
    );

    if (!text && !attachments?.length) return;

    const chat = c.chat as Record<string, unknown> | undefined;

    handleMaxInbound({
      message: {
        channel: "max",
        accountId,
        chatId: String(chatId),
        userId: String(userId),
        messageId: String(messageId),
        text,
        timestamp: Date.now(),
        username: user?.username as string | undefined,
        displayName: user?.name as string | undefined,
        isGroup: chat?.type !== "dialog",
        attachments,
        payload: { update: c.update },
      },
      account: config,
      accountId,
      runtime,
    }).catch((err) => {
      logger.error(`Max inbound handling error (${accountId}):`, err);
    });
  });

  bot.on("bot_started", (botCtx: unknown) => {
    const c = botCtx as Record<string, unknown>;
    const user = c.user as Record<string, unknown> | undefined;
    const userId = user?.user_id as number | undefined;
    const chatId = c.chatId as number | undefined;

    if (!userId || !chatId) return;

    handleMaxInbound({
      message: {
        channel: "max",
        accountId,
        chatId: String(chatId),
        userId: String(userId),
        messageId: `start_${Date.now()}`,
        text: "/start",
        timestamp: Date.now(),
        username: user?.username as string | undefined,
        displayName: user?.name as string | undefined,
        payload: {
          startPayload: c.startPayload,
          update: c.update,
        },
      },
      account: config,
      accountId,
      runtime,
    }).catch((err) => {
      logger.error(`Max inbound handling error (${accountId}):`, err);
    });
  });

  bot.catch((err: unknown) => {
    logger.error(`Max bot error (${accountId}):`, err);
  });

  return bot;
}

export async function startPolling(params: {
  accounts: Record<string, MaxAccountConfig>;
  logger: PluginLogger;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { accounts, logger, runtime } = params;

  // Resolved up front: a bad base URL must fail the whole call before any
  // account starts polling, not leave some accounts running and others not.
  const baseUrls = new Map<string, string | undefined>(
    Object.entries(accounts).map(([accountId, config]) => [
      accountId,
      resolveApiBaseUrl(config.apiBaseUrl, accountId, logger),
    ]),
  );

  for (const [accountId, config] of Object.entries(accounts)) {
    if (activeBots.has(accountId)) {
      logger.warn(`Polling already active for account "${accountId}"`);
      continue;
    }

    const ctx: AccountContext = {
      accountId,
      config,
      logger,
      runtime,
      apiBaseUrl: baseUrls.get(accountId),
    };
    const bot = createBot(ctx);
    const state: AccountState = { bot, token: config.token, stopped: false };

    activeBots.set(accountId, state);
    registerBot(config.token, bot);

    runWithRestart(ctx, state);

    logger.info(
      `Max polling started for account "${accountId}"` +
        (ctx.apiBaseUrl ? ` (apiBaseUrl ${ctx.apiBaseUrl})` : ""),
    );
  }
}

function runWithRestart(ctx: AccountContext, state: AccountState, attempt = 0): void {
  const { accountId, config, logger } = ctx;

  // A stale state object must never revive a bot that has been replaced.
  const isCurrent = () => !state.stopped && activeBots.get(accountId) === state;

  state.bot.start({
    mode: "polling",
    options: {
      allowedUpdates: (config.allowedUpdates as AllowedUpdates | undefined) ?? DEFAULT_ALLOWED_UPDATES,
    },
  }).then(() => {
    logger.info(`Max poll loop ended normally (${accountId})`);
  }).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err ?? "unknown");
    logger.error(`Max poll loop crashed (${accountId}): ${errMsg}`);

    if (!isCurrent()) return;

    const delay = Math.min(1000 * 2 ** attempt, MAX_RESTART_DELAY_MS);
    logger.info(`Max poll loop restarting (${accountId}) in ${delay}ms (attempt ${attempt + 1})`);

    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined;
      if (!isCurrent()) return;

      unregisterBot(state.token);
      const freshBot = createBot(ctx);
      state.bot = freshBot;
      state.token = config.token;
      registerBot(config.token, freshBot);
      runWithRestart(ctx, state, attempt + 1);
    }, delay);
  });
}

function stopAccountState(accountId: string, state: AccountState): void {
  state.stopped = true;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = undefined;
  }
  state.bot.stop();
  unregisterBot(state.token);
  activeBots.delete(accountId);
}

/** Stop one account, or every account when no id is given. */
export function stopPolling(accountId?: string): void {
  if (accountId !== undefined) {
    const state = activeBots.get(accountId);
    if (state) stopAccountState(accountId, state);
    return;
  }
  for (const [id, state] of [...activeBots]) {
    stopAccountState(id, state);
  }
}
