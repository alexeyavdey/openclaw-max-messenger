import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

// Keyed by plugin id so duplicate SDK module instances share one runtime slot.
const { setRuntime: setMaxRuntime, getRuntime: getMaxRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "openclaw-max-messenger",
    errorMessage: "Max Messenger runtime not initialized",
  });

export { getMaxRuntime, setMaxRuntime };
