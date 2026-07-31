import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DEFAULT_BRIDGE_PORT = 19826;

export type BridgeConfig = {
  port: number;
  profileId?: string;
  profileUrlHint?: string;
  daemonCommand?: string;
  extensionId?: string;
  logPath?: string;
  statePath?: string;
};

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const logPath = nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_LOG);
  return {
    port: parsePort(env.AGENT_BROWSER_CHROME_BRIDGE_PORT),
    profileId: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE),
    profileUrlHint: parseProfileUrlHint(env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT),
    daemonCommand: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_DAEMON),
    extensionId: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID),
    logPath,
    statePath:
      nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_STATE) ||
      join(logPath ? dirname(logPath) : process.cwd(), "sessions.json"),
  };
}

export function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `AGENT_BROWSER_CHROME_BRIDGE_PORT must be an integer from 1 to 65535; got ${value}`,
    );
  }
  return port;
}

export function parseProfileUrlHint(value: string | undefined): string | undefined {
  const hint = nonEmpty(value);
  if (!hint) return undefined;
  if (!hint.startsWith("/") || hint.length > 512 || /[\u0000-\u001f\u007f]/.test(hint)) {
    throw new Error(
      "AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT must be a pathname suffix of at most 512 characters",
    );
  }
  return hint.length > 1 ? hint.replace(/\/+$/, "") : hint;
}

export function defaultDaemonScriptUrl(): URL {
  return new URL("./daemon/cli.js", import.meta.url);
}

export function defaultDaemonScriptPath(): string {
  return fileURLToPath(defaultDaemonScriptUrl());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
