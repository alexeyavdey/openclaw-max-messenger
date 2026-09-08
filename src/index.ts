import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { maxChannel } from "./channel.js";
import { setMaxRuntime } from "./runtime.js";
import { sendFileTool } from "./send-file-tool.js";

// Spelled out because the entry's inferred type names an internal SDK chunk,
// which `declaration: true` cannot emit.
type MaxPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: unknown;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: typeof maxChannel;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

const entry: MaxPluginEntry = defineChannelPluginEntry({
  id: "openclaw-max-messenger",
  name: "Max Messenger",
  description: "Max Messenger channel plugin",
  plugin: maxChannel,
  setRuntime: setMaxRuntime,
  registerFull(api) {
    api.registerTool(sendFileTool);
    api.logger.info("Max Messenger tool max_send_file registered");
  },
});

export default entry;

export { maxChannel } from "./channel.js";
export { startPolling, stopPolling } from "./polling.js";
export { registerBot, unregisterBot, clearRegistry } from "./registry.js";
export { getMaxRuntime, setMaxRuntime, clearMaxRuntime } from "./runtime.js";
export { handleMaxInbound } from "./inbound.js";
export type {
  MaxAccountConfig,
  MaxChannelsConfig,
  MaxSendContext,
  MaxSendResult,
  MediaType,
  InboundAttachment,
  InboundMessage,
  PluginLogger,
} from "./types.js";
