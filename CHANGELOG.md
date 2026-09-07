# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-07

### Added

- Block streaming support. `maxChannel.streaming.blockStreamingCoalesceDefaults`
  supplies coalescing defaults (`minChars: 280`, `idleMs: 900`), which the core
  uses as a fallback when the config sets none. Every block Max delivers is a
  separate Bot API send, so the defaults are deliberately chunky.
- `streaming` in the channel config schema, so `channels.max.streaming.*` can be
  authored without rebuilding the plugin. Declared keys: `mode` (`off`/`block`),
  `chunkMode`, and `block.{enabled,coalesce.{minChars,maxChars,idleMs}}`.
  `preview` and `progress` are deliberately left out: they configure live-preview
  editing, and this channel ships no `message.live` adapter to honour them.

Block streaming still has to be turned on. It activates only when
`agents.defaults.blockStreamingDefault` is `"on"` (or a per-channel equivalent);
these two changes just make Max participate correctly once it is.

## [0.2.0] — 2026-09-07

Migration to the OpenClaw 2026.9 plugin SDK. **Breaking:** this release requires
OpenClaw 2026.9.2 or newer and will not load on older versions.

### Fixed

- **Outbound messages were sent from the wrong bot in multi-account setups.**
  `outbound.sendText` and `outbound.sendMedia` read `ctx.account` and
  `ctx.chatId`, neither of which exists on `ChannelOutboundContext`. Account
  resolution therefore always fell through to "the first bot that registered".
  The account is now resolved from `cfg` + `accountId`.
- **Sends returned a result the gateway could not use.** `{ ok: true }` was
  returned where `OutboundDeliveryResult` requires `channel` and `messageId`,
  which broke reply correlation. Sends now return a receipt carrying the Max
  message id (`body.mid`) and timestamp.
- Gateway logging in `startAccount` no longer risks writing every line twice.

### Added

- `message` adapter (`createChannelMessageAdapterFromOutbound`), so the channel
  is reachable from the shared message tool that core now owns.
- `src/setup-entry.ts` (`defineSetupPluginEntry`), which OpenClaw loads instead
  of the full entry while the channel is disabled or unconfigured.
- `reload.configPrefixes`, `config.inspectAccount`, `config.isConfigured`,
  `config.unconfiguredReason` and `gateway.stopAccount`.
- Contract test proving the adapter's declared receive ack policy, plus a test
  covering delivery through the adapter.
- `assets/icon.png` — plugin icon, per the 2026.9.2 branding rule.

### Changed

- All SDK imports moved from the removed `openclaw/plugin-sdk` barrel to narrow
  subpaths (`channel-core`, `channel-outbound`, `channel-policy`,
  `channel-pairing`, `reply-payload`, `runtime-store`, `runtime-env`,
  `config-contracts`, `inbound-reply-dispatch`).
- Entry point moved to `defineChannelPluginEntry`, which performs channel
  registration itself and gates work by registration mode so root help no longer
  activates the full runtime.
- `maxChannel` is typed as `ChannelPlugin<MaxAccountConfig>`; both `as never`
  casts at registration are gone and the contract is now compiler-checked.
- `core.config.loadConfig()` → `core.config.current()`.
- Pairing uses `createChannelPairingController`; the previously used
  `issuePairingChallenge` and `createScopedPairingAccess` are no longer public.
- `createPluginRuntimeStore` now uses the `{ pluginId, errorMessage }` form, so
  duplicate SDK module instances share one runtime slot.
- `openclaw.plugin.json` rewritten for the current manifest format: `activation`,
  `contracts.tools`, and `channelConfigs.max` with an account schema and UI hints
  (token marked `sensitive`).
- `package.json` declares `openclaw.setupEntry`, `openclaw.compat`,
  `openclaw.build` and `engines.node`; the `openclaw` peer range is raised to
  `>=2026.9.2`.
- Exported types: `MaxOutboundContext` replaced by `MaxSendContext` and
  `MaxSendResult`, which match what the SDK actually passes and expects.

### Removed

- `engines.openclaw` from the manifest — the field no longer exists; version
  compatibility is declared through `openclaw.compat` in `package.json`.

### Known limitations

- `dispatchInboundReplyWithBase` is still used for inbound dispatch. The SDK
  marks it deprecated, but its removal is gated on the next plugin-SDK major,
  and replacing it means rewriting the inbound path.
- Secret and env references are not resolved for `token`; it must be a literal
  string.

## [0.1.0]

Initial release: Max Messenger channel plugin for OpenClaw — text, media and
file messaging, inbound attachments, DM access control, per-sender agent
routing, and the `max_send_file` tool.

[0.3.0]: https://github.com/alexeyavdey/openclaw-max-messenger/releases/tag/v0.3.0
[0.2.0]: https://github.com/alexeyavdey/openclaw-max-messenger/releases/tag/v0.2.0
[0.1.0]: https://github.com/alexeyavdey/openclaw-max-messenger/releases/tag/v0.1.0
