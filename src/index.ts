import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { maxChannel } from "./channel.js";
import { setMaxRuntime } from "./runtime.js";
import { sendFileTool } from "./send-file-tool.js";

const plugin = {
  id: "openclaw-max-messenger",
  name: "Max Messenger",
  description: "Max Messenger channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.logger.info("Max Messenger plugin registering...");
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxChannel as never });
    api.logger.info("Max Messenger channel registered");
    api.registerTool(sendFileTool as never);
    api.logger.info("Max Messenger tool max_send_file registered");
  },
};

export default plugin;

export { maxChannel } from "./channel.js";
export { startPolling, stopPolling } from "./polling.js";
export { registerBot, unregisterBot, clearRegistry } from "./registry.js";
export { getMaxRuntime, setMaxRuntime } from "./runtime.js";
export { handleMaxInbound } from "./inbound.js";
export type {
  MaxAccountConfig,
  MaxChannelsConfig,
  MaxOutboundContext,
  MaxMediaContext,
  MediaType,
  InboundAttachment,
  InboundMessage,
  PluginLogger,
} from "./types.js";
