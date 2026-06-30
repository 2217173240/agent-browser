import { fileURLToPath } from "node:url";

export const DEFAULT_BRIDGE_PORT = 19826;

export type BridgeConfig = {
  port: number;
  profileId?: string;
  daemonCommand?: string;
  extensionId?: string;
  logPath?: string;
};

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    port: parsePort(env.AGENT_BROWSER_CHROME_BRIDGE_PORT),
    profileId: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE),
    daemonCommand: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_DAEMON),
    extensionId: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID),
    logPath: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_LOG),
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
