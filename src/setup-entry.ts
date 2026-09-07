import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { maxChannel } from "./channel.js";

// Loaded instead of the full entry while the channel is disabled or unconfigured.
export default defineSetupPluginEntry(maxChannel);
