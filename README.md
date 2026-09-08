# openclaw-max-messenger

[OpenClaw](https://openclaw.ai) channel plugin for **Max Messenger** (max.ru) via Bot API.

Connect your OpenClaw AI agents to Max Messenger — send and receive messages, files, images, audio, and video.

## Features

- **Text messaging** — send and receive messages with Markdown support
- **File sending** — PDF, documents, archives, any file type (with download link)
- **Audio** — mp3/ogg/wav/m4a sent as playable audio with inline player
- **Images** — png/jpg/gif/webp displayed inline
- **Video** — mp4/mov/avi/webm with video player
- **Media from URLs** — automatically downloads and re-uploads media from external URLs
- **Local file paths** — agent can reference local files by absolute path, plugin sends them as attachments
- **Inbound attachments** — files sent by users are downloaded and saved for the agent to process
- **Access control** — `allowlist` and `pairing` policies to control who can talk to the bot
- **Per-sender agent routing** — route different users to different agents via `bindings`
- **Tool: `max_send_file`** — registered tool that allows agents to send files from the filesystem

## Requirements

| | |
|---|---|
| OpenClaw | **2026.9.2 or newer** |
| Node | 22.22.3+, 24.15+, or 25.9+ |
| Max bot token | from **@MasterBot** in the Max app |
| TLS trust | the Russian Trusted Root CA — see below |

This plugin targets the 2026.9 plugin SDK. It will **not** load on OpenClaw older
than 2026.9.2 — the narrow `openclaw/plugin-sdk/*` subpaths it imports do not
exist there. See [CHANGELOG.md](CHANGELOG.md) for details.

## Installation

```bash
git clone https://github.com/alexeyavdey/openclaw-max-messenger.git
cd openclaw-max-messenger
npm install
openclaw plugins install --link /path/to/openclaw-max-messenger
```

## Configuration

Minimal working config in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "max": {
      "enabled": true,
      "accounts": {
        "default": {
          "token": "YOUR_BOT_TOKEN",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

Accounts are keyed by id. The key `default` is used whenever no account id is
given, so a single-bot setup only ever needs `default`.

## Read this before you go live

Five things bite people setting this up. None of them produce an obvious error.

### 1. An unset `dmPolicy` now means pairing, not open

Up to v0.3.0 the access check ran only when `dmPolicy` was set, so leaving the
field out meant **no allowlist and no pairing** — anyone who found the bot
reached the agent, while the channel still reported itself as pairing-gated.

From v0.4.0 an unset `dmPolicy` is treated as `"pairing"`, matching what the
channel already reported to OpenClaw. **If you upgrade with no `dmPolicy` in
your config, existing users will have to pair before the bot answers them
again.** Set `dmPolicy: "open"` explicitly if you really want an ungated bot,
and understand that it means what it says.

### 2. Keep the plugin's `openclaw` devDependency equal to your gateway version

Because the plugin is linked from its own directory, Node resolves
`openclaw/plugin-sdk/*` from **this repo's** `node_modules` — not from the
gateway's installation. If the two versions differ, two separate copies of the
SDK run inside one process and fail in confusing ways at the boundary between
them, while the channel still looks healthy from the outside.

```bash
openclaw --version
node -p "require('./node_modules/openclaw/package.json').version"
```

Whenever you upgrade OpenClaw, re-run `npm install openclaw@<that version> --save-dev`.

### 3. The token is a plain string

`token` is read verbatim and handed to the Max Bot API client. OpenClaw's secret
and env reference forms (`{"source": "env", ...}`) are **not** resolved by this
plugin, so a reference object would be sent as-is and authentication would fail.
Keep `~/.openclaw/openclaw.json` readable only by you.

### 4. The Max API host needs a certificate your machine probably does not trust

Since `@maxhub/max-bot-api` 0.2.4 the client talks to `platform-api2.max.ru`,
whose certificate is issued by the Russian Trusted Sub CA (Минцифры). That root
is not in the default trust store, so without it every request fails with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and the channel never connects.

Get the PEM from [gosuslugi.ru/crt](https://www.gosuslugi.ru/crt) (direct link:
`https://gu-st.ru/content/Other/doc/russiantrustedca.pem`) and make the gateway
process trust it. `NODE_EXTRA_CA_CERTS` has to be set **before Node starts** —
supplying it through OpenClaw's `env.vars` at runtime is too late and silently
does nothing.

The upload hosts (`iu.oneme.ru`, `fu.oneme.ru`) use Let's Encrypt and need
nothing extra.

Do **not** reach for `NODE_TLS_REJECT_UNAUTHORIZED=0`: that disables certificate
verification for every host the gateway talks to, not just Max.

### 5. Bot chats look like groups

Max treats bot conversations as group-style chats internally (`isGroup: true`).
The plugin compensates: DM policy is applied to every chat regardless of the
flag, and routing uses the sender id. Just don't be surprised when session keys
read `max:group:...` for what is plainly a 1:1 conversation.

## Access control

```json
{
  "channels": {
    "max": {
      "accounts": {
        "default": {
          "token": "YOUR_BOT_TOKEN",
          "dmPolicy": "allowlist",
          "allowFrom": ["123456789", "987654321"]
        }
      }
    }
  }
}
```

| Policy | Behavior |
|--------|----------|
| *(field omitted)* | Same as `"pairing"` |
| `"open"` | Anyone can message the bot |
| `"allowlist"` | Only user ids listed in `allowFrom` are allowed |
| `"pairing"` | New users receive a pairing code; owner approves via CLI |

Entries in `allowFrom` may carry a `max:` prefix; it is stripped before matching.

**Pairing flow:**

1. Unknown user messages the bot and receives a pairing code
2. Owner approves: `openclaw pairing approve max <CODE>`
3. User is added to the allow list and can now chat

## Multiple bots

Add one entry per bot. Each needs its own token:

```json
{
  "channels": {
    "max": {
      "enabled": true,
      "accounts": {
        "default": { "token": "TOKEN_A", "dmPolicy": "pairing" },
        "support": { "token": "TOKEN_B", "dmPolicy": "allowlist", "allowFrom": ["123456789"] }
      }
    }
  }
}
```

Multi-account outbound routing requires **v0.2.0 or newer**. Earlier versions
resolved the account incorrectly and sent every outbound message through
whichever bot happened to start first.

## Per-sender agent routing

Route different Max users to different OpenClaw agents:

```json
{
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "max",
        "peer": { "kind": "direct", "id": "123456789" }
      }
    },
    {
      "agentId": "assistant",
      "match": {
        "channel": "max",
        "peer": { "kind": "direct", "id": "987654321" }
      }
    }
  ]
}
```

## Getting a bot token

1. Open the Max Messenger app
2. Find **Master Bot** (search for "Master Bot" or "@masterbot")
3. Send `/newbot` and follow the instructions
4. Copy the token into your config

## Verifying the setup

```bash
openclaw plugins info openclaw-max-messenger   # expect: Status: loaded
openclaw channels status                       # expect: Max Messenger default: enabled, configured, running
```

After a gateway restart the log should contain, in order:

```
Max Messenger tool max_send_file registered
[default] starting Max Messenger polling
Max polling started for account "default"
```

The gateway log file path is printed by `openclaw gateway status` (`File logs: ...`).
`openclaw channels dead-letters list --channel max` lists inbound events that
failed to process.

`openclaw plugins info` reports a provenance warning for link-installed plugins
("OpenClaw can't verify where this plugin came from"). That is expected and does
not block loading.

## Known issues

- **Buffer uploads are staged through a temp file**: the SDK names a Buffer upload with a random UUID, which would otherwise reach the recipient instead of the real filename. Uploading by path also takes the SDK's chunked path, which is what lets large files through.

- **Local media is confined to the agent's media roots**: outbound sends read local files only through the reader OpenClaw supplies, or from inside the roots it allows. A path outside them is refused rather than uploaded, so an agent cannot be talked into attaching an arbitrary file from the host.

- **Deprecated inbound dispatch**: the plugin still calls `dispatchInboundReplyWithBase`, which the SDK marks deprecated. It keeps working until the next plugin-SDK major release.

## Project structure

```
src/
  index.ts          — Channel plugin entry point (defineChannelPluginEntry)
  setup-entry.ts    — Setup-only entry loaded while the channel is unconfigured
  channel.ts        — Channel definition (outbound, message adapter, pairing, security, gateway)
  inbound.ts        — Inbound message processing, access control, delivery
  polling.ts        — Max Bot API long-polling, event handling
  send-file-tool.ts — Agent tool for sending files
  media-access.ts   — Local-media confinement and SSRF-guarded remote fetch
  upload-file.ts    — Raw upload helper, media type detection, utilities
  registry.ts       — Bot instance registry
  runtime.ts        — Plugin runtime store
  types.ts          — TypeScript type definitions
```

## Development

```bash
# Typecheck
npx tsc --noEmit

# Run tests
npm test

# Watch mode
npm run test:watch

# After code changes, restart the gateway
openclaw gateway restart
```

## License

MIT
