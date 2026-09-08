import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "./index.js";
import setupEntry from "./setup-entry.js";
import { maxChannel } from "./channel.js";
import { extractAttachments } from "./polling.js";
import { clearRegistry } from "./registry.js";
import { clearMaxRuntime } from "./runtime.js";
import { isPathInsideRoots } from "./media-access.js";
import { verifyChannelMessageReceiveAckPolicyAdapterProofs } from "openclaw/plugin-sdk/channel-outbound";

describe("plugin object", () => {
  it("has correct id and name", () => {
    expect(plugin.id).toBe("openclaw-max-messenger");
    expect(plugin.name).toBe("Max Messenger");
  });

  it("has configSchema", () => {
    expect(plugin.configSchema).toBeDefined();
  });

  it("register wires the channel and the tool in full mode", () => {
    const registerChannel = vi.fn();
    const registerTool = vi.fn();
    const mockApi = {
      registrationMode: "full",
      runtime: {
        config: { current: vi.fn() },
        channel: { routing: {}, session: {}, reply: {} },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerChannel,
      registerTool,
    } as any;

    plugin.register(mockApi);

    expect(registerChannel).toHaveBeenCalledWith({ plugin: maxChannel });
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "max_send_file" }),
    );
  });
});

afterEach(() => {
  // The runtime store is a process-global slot, so a stub installed by one
  // test would otherwise stay visible to every later test and module instance.
  clearMaxRuntime();
});

describe("setup entry", () => {
  it("exposes the channel plugin without runtime wiring", () => {
    expect(setupEntry.plugin).toBe(maxChannel);
  });
});

describe("maxChannel", () => {
  describe("meta", () => {
    it("has correct id and label", () => {
      expect(maxChannel.meta.id).toBe("max");
      expect(maxChannel.meta.label).toBe("Max Messenger");
      expect(maxChannel.meta.aliases).toContain("max-messenger");
    });
  });

  describe("capabilities", () => {
    it("supports direct and group chats", () => {
      expect(maxChannel.capabilities.chatTypes).toContain("direct");
      expect(maxChannel.capabilities.chatTypes).toContain("group");
    });

    it("supports media but not edit/threads/reactions", () => {
      expect(maxChannel.capabilities.media).toBe(true);
      // No adapter core could call to perform an edit, so it must not claim one.
      expect(maxChannel.capabilities.edit).toBe(false);
      expect(maxChannel.capabilities.threads).toBe(false);
      expect(maxChannel.capabilities.reactions).toBe(false);
    });
  });

  describe("config", () => {
    const cfg = {
      channels: {
        max: {
          accounts: {
            default: { token: "tok-1" },
            secondary: { token: "tok-2" },
          },
        },
      },
    };

    it("listAccountIds returns all account keys", () => {
      const ids = maxChannel.config.listAccountIds(cfg);
      expect(ids).toEqual(["default", "secondary"]);
    });

    it("listAccountIds returns empty array for missing config", () => {
      expect(maxChannel.config.listAccountIds({})).toEqual([]);
    });

    it("resolveAccount returns correct account", () => {
      const account = maxChannel.config.resolveAccount(cfg, "secondary");
      expect(account.token).toBe("tok-2");
    });

    it("resolveAccount defaults to 'default'", () => {
      const account = maxChannel.config.resolveAccount(cfg);
      expect(account.token).toBe("tok-1");
    });

    it("resolveAccount throws for unknown account", () => {
      expect(() => maxChannel.config.resolveAccount(cfg, "unknown")).toThrow(
        'Max account "unknown" not found'
      );
    });
  });

  describe("outbound", () => {
    beforeEach(() => {
      clearRegistry();
    });

    it("has direct delivery mode", () => {
      expect(maxChannel.outbound?.deliveryMode).toBe("direct");
    });

    it("has sendMedia method", () => {
      expect(maxChannel.outbound?.sendMedia).toBeTypeOf("function");
    });

    it("exposes a message adapter for the shared core message tool", () => {
      expect(maxChannel.message?.send).toBeDefined();
    });

    it("sendText throws when the account's bot is not running", async () => {
      await expect(
        maxChannel.outbound!.sendText!({
          cfg: { channels: { max: { accounts: { default: { token: "no-such-token" } } } } } as any,
          to: "123",
          text: "hello",
          accountId: "default",
        })
      ).rejects.toThrow('Max bot for account "default" is not running');
    });

    it("never falls back to another account's bot", async () => {
      const { registerBot } = await import("./registry.js");
      const sendMessageToChat = vi.fn();
      registerBot("tok-a", { api: { sendMessageToChat } } as any);

      const cfg = {
        channels: {
          max: {
            accounts: {
              default: { token: "tok-a" },
              second: { token: "tok-b" },
            },
          },
        },
      } as any;

      await expect(
        maxChannel.outbound!.sendText!({ cfg, to: "123", text: "hi", accountId: "second" })
      ).rejects.toThrow('Max bot for account "second" is not running');
      expect(sendMessageToChat).not.toHaveBeenCalled();
    });

    it("rejects targets that are not a usable chat id", async () => {
      const { registerBot } = await import("./registry.js");
      registerBot("tok-c", { api: { sendMessageToChat: vi.fn() } } as any);
      const cfg = {
        channels: { max: { accounts: { default: { token: "tok-c" } } } },
      } as any;

      // Number("") is 0, which passes a naive isFinite check.
      await expect(
        maxChannel.outbound!.sendText!({ cfg, to: "max:", text: "hi", accountId: "default" })
      ).rejects.toThrow("empty chat id");

      await expect(
        maxChannel.outbound!.sendText!({ cfg, to: "12.5", text: "hi", accountId: "default" })
      ).rejects.toThrow("must be an integer");
    });

    it("sendMedia throws when source is missing for non-image types", async () => {
      // Register a mock bot so requireApi passes
      const { registerBot } = await import("./registry.js");
      const mockApi = {
        uploadAudio: vi.fn(),
        sendMessageToChat: vi.fn(),
      };
      const mockBot = { api: mockApi } as any;
      registerBot("test-tok", mockBot);

      await expect(
        maxChannel.outbound!.sendMedia!({
          cfg: { channels: { max: { accounts: { default: { token: "test-tok" } } } } } as any,
          to: "123",
          text: "",
          accountId: "default",
          // no mediaUrl
        })
      ).rejects.toThrow("No media URL provided");
    });
  });

  describe("message adapter", () => {
    beforeEach(() => {
      clearRegistry();
    });

    it("declares only ack policies it can prove", async () => {
      const results = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
        adapterName: "max",
        adapter: maxChannel.message!,
        proofs: {
          // Max long-polling exposes no provider-side ack: the plugin
          // acknowledges by completing its own inbound handler.
          manual: () => {
            expect(maxChannel.message!.receive?.defaultAckPolicy).toBe("manual");
          },
        },
      });
      expect(results).toContainEqual({ policy: "manual", status: "verified" });
    });

    it("send.text delivers through the Max API and returns the platform message id", async () => {
      const { registerBot } = await import("./registry.js");
      const sendMessageToChat = vi.fn().mockResolvedValue({
        body: { mid: "mid-42" },
        timestamp: 1700000000,
      });
      registerBot("adapter-tok", { api: { sendMessageToChat } } as any);

      const result = await maxChannel.message!.send!.text!({
        cfg: { channels: { max: { accounts: { default: { token: "adapter-tok" } } } } } as any,
        to: "max:777",
        text: "hi",
        accountId: "default",
      });

      expect(sendMessageToChat).toHaveBeenCalledWith(777, "hi");
      expect(result.messageId).toBe("mid-42");
    });
  });

  describe("media access", () => {
    it("confines local media to the roots the host allows", () => {
      const roots = ["/tmp/media"];
      expect(isPathInsideRoots("/tmp/media/photo.png", roots)).toBe(true);
      expect(isPathInsideRoots("/tmp/media", roots)).toBe(true);
      // Prefix match alone would wrongly accept a sibling directory.
      expect(isPathInsideRoots("/tmp/media-other/secret", roots)).toBe(false);
      expect(isPathInsideRoots("/tmp/media/../../etc/passwd", roots)).toBe(false);
      expect(isPathInsideRoots("/Users/me/.openclaw/openclaw.json", roots)).toBe(false);
    });

    it("refuses every local path when no roots are provided", () => {
      expect(isPathInsideRoots("/tmp/anything", [])).toBe(false);
    });
  });

  describe("gateway", () => {
    it("has startAccount method", () => {
      expect(maxChannel.gateway?.startAccount).toBeTypeOf("function");
    });

    it("startAccount throws when token is missing", async () => {
      const abortController = new AbortController();
      await expect(
        maxChannel.gateway!.startAccount!({
          cfg: {} as any,
          accountId: "test",
          account: { token: "" },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as any,
          abortSignal: abortController.signal,
          getStatus: vi.fn() as any,
          setStatus: vi.fn(),
        })
      ).rejects.toThrow("missing token");
    });
  });
});

describe("extractAttachments", () => {
  it("returns undefined for null/empty attachments", () => {
    expect(extractAttachments(null)).toBeUndefined();
    expect(extractAttachments(undefined)).toBeUndefined();
    expect(extractAttachments([])).toBeUndefined();
  });

  it("extracts audio attachment (voice message)", () => {
    const result = extractAttachments([
      {
        type: "audio",
        payload: {
          url: "https://max.ru/audio/123.ogg",
          token: "audio-tok-1",
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      type: "audio",
      url: "https://max.ru/audio/123.ogg",
      token: "audio-tok-1",
    });
  });

  it("extracts file attachment with filename and size", () => {
    const result = extractAttachments([
      {
        type: "file",
        payload: {
          url: "https://max.ru/files/doc.pdf",
          token: "file-tok-1",
        },
        filename: "report.pdf",
        size: 102400,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      type: "file",
      url: "https://max.ru/files/doc.pdf",
      token: "file-tok-1",
      filename: "report.pdf",
      size: 102400,
    });
  });

  it("extracts image attachment", () => {
    const result = extractAttachments([
      {
        type: "image",
        payload: {
          url: "https://max.ru/img/photo.jpg",
          token: "img-tok-1",
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("image");
    expect(result![0].url).toBe("https://max.ru/img/photo.jpg");
  });

  it("extracts multiple attachments", () => {
    const result = extractAttachments([
      {
        type: "image",
        payload: { url: "https://max.ru/img/1.jpg", token: "t1" },
      },
      {
        type: "audio",
        payload: { url: "https://max.ru/audio/voice.ogg", token: "t2" },
      },
      {
        type: "file",
        payload: { url: "https://max.ru/files/doc.pdf", token: "t3" },
        filename: "doc.pdf",
        size: 5000,
      },
    ]);

    expect(result).toHaveLength(3);
    expect(result!.map((a) => a.type)).toEqual(["image", "audio", "file"]);
  });

  it("filters out unsupported attachment types", () => {
    const result = extractAttachments([
      {
        type: "inline_keyboard",
        payload: { buttons: [] },
      } as any,
      {
        type: "audio",
        payload: { url: "https://max.ru/audio/1.ogg", token: "t1" },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("audio");
  });

  it("returns undefined when all attachments are unsupported", () => {
    const result = extractAttachments([
      { type: "inline_keyboard", payload: { buttons: [] } } as any,
    ]);
    expect(result).toBeUndefined();
  });
});
