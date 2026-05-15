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
- **Message editing** — supports editing previously sent messages
- **Access control** — `allowlist` and `pairing` policies to control who can talk to the bot
- **Per-sender agent routing** — route different users to different agents via `bindings`
- **Tool: `max_send_file`** — registered tool that allows agents to send files from the filesystem

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and configured
- A Max Messenger bot token (obtained from the Master Bot in the Max app)

## Installation

Clone the repo and install dependencies:

```bash
git clone https://github.com/alexeyavdey/openclaw-max-messenger.git
cd openclaw-max-messenger
npm install
```

Register the plugin with OpenClaw:

```bash
openclaw plugins install --link /path/to/openclaw-max-messenger
```

## Configuration

Add the Max channel to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "max": {
      "enabled": true,
      "accounts": {
        "default": {
          "token": "YOUR_BOT_TOKEN"
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

### Access control

Control who can interact with your bot using `dmPolicy`:

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

**Policies:**

| Policy | Behavior |
|--------|----------|
| `"open"` | Anyone can message the bot (default) |
| `"allowlist"` | Only user IDs listed in `allowFrom` are allowed |
| `"pairing"` | New users receive a pairing code; owner approves via CLI |

**Pairing flow:**

1. Unknown user messages the bot and receives a pairing code
2. Owner approves: `openclaw pairing approve max <CODE>`
3. User is added to the allow list and can now chat

### Per-sender agent routing

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

1. Open Max Messenger app
2. Find **Master Bot** (search for "Master Bot" or "@masterbot")
3. Send `/newbot` and follow the instructions
4. Copy the token and add it to your config

Keep bot tokens out of chats, issues, screenshots, and logs. If a token appears in public support text, rotate it in Max Messenger before reusing the bot.

## Related X/Twitter workflows

Keep this plugin responsible for Max Messenger conversations, files, images, audio, video, inbound attachments, message edits, access control, and per-sender OpenClaw agent routing. When the same OpenClaw agent also needs public X/Twitter data or visible X/Twitter actions, install TweetClaw as a separate OpenClaw plugin:

```bash
openclaw plugins install @xquik/tweetclaw
```

[TweetClaw](https://github.com/Xquik-dev/tweetclaw) covers scrape tweets, search tweets, search tweet replies, follower export, user lookup, media upload and download, direct messages, monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or post tweet replies. Use the [TweetClaw GitHub repo](https://github.com/Xquik-dev/tweetclaw) and [npm package](https://www.npmjs.com/package/@xquik/tweetclaw) for setup; the [ClawHub discovery page](https://clawhub.ai/plugins/@xquik/tweetclaw) remains useful for browsing while that listing lags behind npm. Keep X/Twitter connection settings separate from Max Messenger bot settings and review visible X/Twitter actions through OpenClaw approval flows.

## Known issues

- **Max Bot API SDK token bug**: The official `@maxhub/max-bot-api` SDK loses the upload token when uploading files via Buffer. This plugin works around it with a raw upload helper (`rawUpload`) that calls `getUploadUrl` + manual multipart upload. A patch for the SDK is included in `patches/`.

- **Bot chats are groups**: Max treats bot conversations as group-style chats internally (`isGroup: true`). The plugin handles this transparently — access control and per-sender routing work correctly despite this quirk.

- **Large file uploads**: Files over ~10MB may timeout depending on network conditions. The SDK has a 20-second upload timeout. For large files, consider compressing or splitting them.

## Project structure

```
src/
  index.ts          — Plugin registration entry point
  channel.ts        — Channel definition (outbound, pairing, security, gateway)
  inbound.ts        — Inbound message processing, access control, delivery
  polling.ts        — Max Bot API long-polling, event handling
  send-file-tool.ts — Agent tool for sending files
  upload-file.ts    — Raw upload helper, media type detection, utilities
  registry.ts       — Bot instance registry
  runtime.ts        — Plugin runtime store
  types.ts          — TypeScript type definitions
```

## Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# After code changes, restart the gateway
openclaw gateway restart
```

## License

MIT
