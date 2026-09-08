import type { Bot, Api } from "@maxhub/max-bot-api";

const botInstances = new Map<string, Bot>();

export function registerBot(token: string, bot: Bot): void {
  botInstances.set(token, bot);
}

export function unregisterBot(token: string): void {
  botInstances.delete(token);
}

export function getBot(token: string): Bot | undefined {
  return botInstances.get(token);
}

export function getApi(token: string): Api | undefined {
  return getBot(token)?.api;
}

export function clearRegistry(): void {
  botInstances.clear();
}
