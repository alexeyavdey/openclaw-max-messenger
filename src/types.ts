export interface MaxAccountConfig {
  token: string;
  botId?: string;
  allowedUpdates?: string[];
  accountId?: string | null;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
}

export interface MaxChannelsConfig {
  channels?: {
    max?: {
      accounts?: Record<string, MaxAccountConfig>;
    };
  };
}

/** Shape shared by the outbound adapter and the channel message adapter. */
export interface MaxSendContext {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  messageId?: string;
}

/** Delivery receipt shape required by OutboundDeliveryResult. */
export interface MaxSendResult {
  channel: "max";
  messageId: string;
  target?: { kind: "chat"; id: string };
  timestamp?: number;
}

export type MediaType = "image" | "video" | "audio" | "file";

export interface MaxMediaContext {
  accountId: string;
  chatId: string;
  account: MaxAccountConfig;
  type: MediaType;
  url?: string;
  source?: string | Buffer;
  text?: string;
}

export interface InboundAttachment {
  type: MediaType | "sticker" | "contact" | "location" | "share";
  url?: string;
  token?: string;
  filename?: string;
  size?: number;
}

export interface InboundMessage {
  channel: string;
  accountId: string;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  timestamp: number;
  username?: string;
  displayName?: string;
  isGroup?: boolean;
  attachments?: InboundAttachment[];
  payload?: Record<string, unknown>;
}

export interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}
