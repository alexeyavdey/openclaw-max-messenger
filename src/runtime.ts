import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk";

const { setRuntime: setMaxRuntime, getRuntime: getMaxRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Max Messenger runtime not initialized");

export { getMaxRuntime, setMaxRuntime };
