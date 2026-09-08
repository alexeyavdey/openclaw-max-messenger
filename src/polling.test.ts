import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const botInstances: MockBot[] = [];

class MockBot {
  handlers = new Map<string, unknown>();
  stop = vi.fn();
  catch = vi.fn();
  api = {};
  private rejectStart?: (err: Error) => void;

  start = vi.fn((_opts?: unknown) =>
    new Promise<void>((_resolve, reject) => {
      this.rejectStart = reject;
    }),
  );

  constructor(public token: string) {
    botInstances.push(this);
  }

  on(event: string, handler: unknown) {
    this.handlers.set(event, handler);
  }

  /** Make this bot's poll loop fail the way a network error would. */
  crash(err: Error) {
    this.rejectStart?.(err);
  }
}

vi.mock("@maxhub/max-bot-api", () => ({ Bot: MockBot }));

const { startPolling, stopPolling } = await import("./polling.js");
const { getApi, clearRegistry } = await import("./registry.js");

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  botInstances.length = 0;
  clearRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  stopPolling();
  vi.useRealTimers();
});

describe("startPolling", () => {
  it("attaches handlers to every bot it creates", async () => {
    await startPolling({ accounts: { default: { token: "tok-a" } }, logger });

    expect(botInstances).toHaveLength(1);
    expect([...botInstances[0].handlers.keys()]).toEqual([
      "message_created",
      "bot_started",
    ]);
    expect(botInstances[0].catch).toHaveBeenCalled();
  });

  it("passes allowedUpdates from the account config", async () => {
    await startPolling({
      accounts: { default: { token: "tok-a", allowedUpdates: ["message_created"] } },
      logger,
    });

    expect(botInstances[0].start).toHaveBeenCalledWith({
      allowedUpdates: ["message_created"],
    });
  });

  it("falls back to the default update list", async () => {
    await startPolling({ accounts: { default: { token: "tok-a" } }, logger });

    expect(botInstances[0].start).toHaveBeenCalledWith({
      allowedUpdates: ["message_created", "bot_started"],
    });
  });
});

describe("stopPolling", () => {
  it("stops only the named account and leaves siblings polling", async () => {
    await startPolling({
      accounts: { default: { token: "tok-a" }, support: { token: "tok-b" } },
      logger,
    });
    const [botA, botB] = botInstances;

    stopPolling("support");

    expect(botB.stop).toHaveBeenCalled();
    expect(botA.stop).not.toHaveBeenCalled();
    expect(getApi("tok-a")).toBeDefined();
    expect(getApi("tok-b")).toBeUndefined();
  });

  it("stops every account when no id is given", async () => {
    await startPolling({
      accounts: { default: { token: "tok-a" }, support: { token: "tok-b" } },
      logger,
    });

    stopPolling();

    for (const bot of botInstances) {
      expect(bot.stop).toHaveBeenCalled();
    }
    expect(getApi("tok-a")).toBeUndefined();
    expect(getApi("tok-b")).toBeUndefined();
  });
});

describe("crash restart", () => {
  it("gives the replacement bot the same handlers", async () => {
    vi.useFakeTimers();
    await startPolling({ accounts: { default: { token: "tok-a" } }, logger });

    botInstances[0].crash(new Error("poll crashed"));
    await vi.advanceTimersByTimeAsync(2000);

    expect(botInstances.length).toBeGreaterThan(1);
    const replacement = botInstances[botInstances.length - 1];
    expect([...replacement.handlers.keys()]).toEqual([
      "message_created",
      "bot_started",
    ]);
    expect(getApi("tok-a")).toBe(replacement.api);
  });

  it("does not resurrect a bot after the account was stopped", async () => {
    vi.useFakeTimers();
    await startPolling({ accounts: { default: { token: "tok-a" } }, logger });

    botInstances[0].crash(new Error("poll crashed"));
    await Promise.resolve();
    await Promise.resolve();

    stopPolling("default");
    const countAfterStop = botInstances.length;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(botInstances).toHaveLength(countAfterStop);
    expect(getApi("tok-a")).toBeUndefined();
  });
});
