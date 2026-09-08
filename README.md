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
| TLS trust | the Russian Trusted Root CA — [see below](#4-the-max-api-host-needs-a-certificate-your-machine-probably-does-not-trust) |

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
whose certificate chains to the **Russian Trusted Root CA** (Минцифры). That
root ships in no default trust store, so until you install it every request
fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and the channel never connects.

The server sends the intermediate itself, so **installing the root certificate
is enough**. The upload hosts (`iu.oneme.ru`, `fu.oneme.ru`) use Let's Encrypt
and need nothing.

**Check first — you may already have it.** Many machines in Russia do:

```bash
NODE_USE_SYSTEM_CA=1 node -e 'fetch("https://platform-api2.max.ru/me").then(r=>console.log("ok",r.status)).catch(e=>console.log("fail",e.cause?.code))'
```

`ok 401` means the root is trusted and you can skip this whole section. Note
that `curl` on macOS reads a file bundle rather than the keychain, so a curl
failure here proves nothing — test with Node.

Otherwise download it from [gosuslugi.ru/crt](https://www.gosuslugi.ru/crt), or directly:

```bash
curl -O https://gu-st.ru/content/Other/doc/russiantrustedca.pem
# the PEM holds both the root and the intermediate; split them out
awk '/BEGIN CERT/{n++} {print > ("cert" n ".pem")}' russiantrustedca.pem
# cert2.pem is the root — check before installing anything
openssl x509 -in cert2.pem -noout -subject -fingerprint -sha256
```

Expected root fingerprint (SHA-256):

```
D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

#### macOS

OpenClaw's gateway service already runs with `NODE_USE_SYSTEM_CA=1`, so Node
reads the system keychain and no environment variable is needed — installing
into the keychain is all it takes.

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain russian_trusted_root_ca.pem
```

`-d` installs into the admin (machine-wide) domain. To keep it to your own user,
drop `-d` and use `-k ~/Library/Keychains/login.keychain-db` — but verify that
Node still picks it up, since user trust settings are not always consulted.

Verify, then restart the gateway:

```bash
curl -sSI https://platform-api2.max.ru/me | head -1   # expect 401, not a TLS error
openclaw gateway restart
```

To undo:

```bash
sudo security delete-certificate -c "Russian Trusted Root CA" /Library/Keychains/System.keychain
```

#### Windows

Run an elevated prompt:

```powershell
certutil -addstore -f Root russian_trusted_root_ca.pem
```

For the current user only, use `certutil -user -addstore Root russian_trusted_root_ca.pem`.
Remove with `certutil -delstore Root "Russian Trusted Root CA"`.

#### Linux

Node on Linux does not read the system trust store unless it is told to, so
installing into the system store is **not** the cheaper path here: it widens
trust to everything on the host *and* still needs an environment variable on the
gateway. Unless something else on the machine has to reach
`platform-api2.max.ru`, give the root to the gateway process alone.

**Gateway only (recommended).** Put the PEM somewhere the gateway cannot rewrite
— it runs model-driven agents with file access, and a trust anchor writable by
that process is not a trust anchor:

```bash
sudo install -D -m 644 -o root -g root \
  russian_trusted_root_ca.pem /usr/local/share/openclaw-certs/russian_trusted_root_ca.pem
```

Point the service at it with a **systemd drop-in** rather than editing the unit:
OpenClaw's own service install/repair flows write that unit file, a drop-in is
not part of what they rewrite, and rolling back is deleting one file. Substitute
your unit name (`systemctl list-units '*openclaw*'`):

```bash
sudo mkdir -p /etc/systemd/system/openclaw-gateway.service.d
printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/openclaw-certs/russian_trusted_root_ca.pem\n' \
  | sudo tee /etc/systemd/system/openclaw-gateway.service.d/russian-trusted-ca.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart openclaw-gateway.service
```

For a user-scope unit, drop `sudo` and use
`~/.config/systemd/user/<unit>.d/` with `systemctl --user`. Not under systemd at
all? Export the variable in whatever launches the gateway — it only has to be in
the environment before Node starts.

Verify against the running process, not just the unit file:

```bash
sudo tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value openclaw-gateway.service)/environ \
  | grep NODE_EXTRA_CA_CERTS
```

Then confirm the API is actually reachable. `polling started` in the log only
means the loop was launched, not that TLS succeeded:

```bash
NODE_EXTRA_CA_CERTS=/usr/local/share/openclaw-certs/russian_trusted_root_ca.pem \
  node -e 'fetch("https://platform-api2.max.ru/me").then(r=>console.log("ok",r.status)).catch(e=>console.log("fail",e.cause?.code))'
```

To undo: delete the drop-in, `sudo systemctl daemon-reload`, restart the gateway.

**Machine-wide**, if other software on the host needs the root too. Convert to
DER-backed `.crt` first if your distro expects it:

```bash
openssl x509 -outform der -in russian_trusted_root_ca.pem -out russian_trusted_root_ca.crt
```

Debian / Ubuntu:

```bash
sudo mkdir -p /usr/local/share/ca-certificates/russian-trusted
sudo cp russian_trusted_root_ca.crt /usr/local/share/ca-certificates/russian-trusted/
sudo update-ca-certificates -v
trust list | grep Russian
```

RHEL / CentOS: copy into `/etc/pki/ca-trust/source/anchors/`, then `sudo update-ca-trust`.
Arch: copy into `/etc/ca-certificates/trust-source/anchors/`, then `sudo update-ca-trust`.

This still leaves Node out of the loop, so the gateway additionally needs
`NODE_USE_SYSTEM_CA=1` — same drop-in, same before-Node-starts rule.

#### What this actually grants

A trusted root can vouch for a certificate on *any* domain, not only Max. In the
admin/machine domain that applies to everything on the host; through
`NODE_EXTRA_CA_CERTS` it applies to that one process. Pick the narrowest scope
that works for you.

Two properties of `NODE_EXTRA_CA_CERTS` are worth being precise about, because
they cut in opposite directions. It **adds** to Node's bundled roots instead of
replacing them, so every host the gateway already reached keeps validating
normally. But it is scoped per *process*, not per *host*: inside the gateway
that root is equally valid for every domain it talks to — your model providers
included, not only `max.ru`. Scoping the trust to this one API would take a
dedicated TLS agent inside the plugin; the environment variable cannot express
it.

`NODE_EXTRA_CA_CERTS` cannot be supplied through OpenClaw's `env.vars`: Node
reads it while initializing TLS, before plugin config is loaded, so setting it
at runtime silently does nothing. Do **not** substitute
`NODE_TLS_REJECT_UNAUTHORIZED=0` — that turns off certificate verification for
every host the gateway talks to.

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
