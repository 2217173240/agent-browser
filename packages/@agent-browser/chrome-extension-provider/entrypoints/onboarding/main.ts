type StoredConfig = {
  bridgePort?: number;
  bridgePorts?: number[];
};

type BridgeStatus = {
  connected?: boolean;
  port?: number;
};

const DEFAULT_PORT = 19826;
const POLL_INTERVAL_MS = 2000;

const copy = {
  zh: {
    checking: "正在检查连接…",
    connected: (port: number) => `已连接到 daemon(端口 ${port})`,
    disconnected: "未连接到 daemon",
    portLine: "daemon 应监听的端口:",
    guidance:
      "本扩展是 Nexolyra 本地工作台的配套组件。请先在本地安装并启动 Nexolyra;daemon 运行后,本扩展会自动完成连接。",
  },
  en: {
    checking: "Checking connection…",
    connected: (port: number) => `Connected to the daemon (port ${port})`,
    disconnected: "Not connected to the daemon",
    portLine: "The daemon should be listening on:",
    guidance:
      "This extension is a companion component of the Nexolyra local workbench. Install and start Nexolyra locally first; once its daemon is running, the extension connects automatically.",
  },
} as const;

const language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const text = copy[language];
document.documentElement.lang = language;

const statusElement = document.getElementById("status") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const portText = document.getElementById("port-text") as HTMLElement;
const guidanceText = document.getElementById("guidance-text") as HTMLElement;

const manifest = chrome.runtime.getManifest();
document.title = manifest.name;
(document.getElementById("extension-name") as HTMLElement).textContent = manifest.name;
(document.getElementById("extension-version") as HTMLElement).textContent = `v${manifest.version}`;
guidanceText.textContent = text.guidance;

// Same port resolution as entrypoints/background.ts configuredPorts(): explicit
// bridgePorts first, then bridgePort, then the default, deduped and validated.
async function configuredPorts(): Promise<number[]> {
  const stored = await chrome.storage.local.get(["bridgePort", "bridgePorts"]);
  const config = stored as StoredConfig;
  const ports = [
    ...(Array.isArray(config.bridgePorts) ? config.bridgePorts : []),
    typeof config.bridgePort === "number" ? config.bridgePort : DEFAULT_PORT,
    DEFAULT_PORT,
  ];
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

// Connection state comes from the background worker, which owns the bridge
// WebSocket. Extension pages declare no host permissions, so fetching the
// loopback daemon directly from this page would be blocked by Private Network
// Access; the worker message is both simpler and accurate.
async function queryBridgeStatus(): Promise<BridgeStatus | undefined> {
  try {
    return (await chrome.runtime.sendMessage({ kind: "bridge-status-query" })) as BridgeStatus;
  } catch {
    return undefined;
  }
}

let refreshInFlight = false;

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  statusText.textContent = text.checking;
  try {
    const ports = await configuredPorts();
    portText.textContent = "";
    portText.append(text.portLine, " ");
    const portCode = document.createElement("code");
    portCode.textContent = ports.map((port) => `http://127.0.0.1:${port}/health`).join(", ");
    portText.append(portCode);
    const status = await queryBridgeStatus();
    const connectedPort = status?.connected === true ? status.port : undefined;
    statusElement.dataset.connected = connectedPort === undefined ? "false" : "true";
    statusText.textContent =
      connectedPort === undefined ? text.disconnected : text.connected(connectedPort);
  } finally {
    refreshInFlight = false;
  }
}

setInterval(() => void refresh(), POLL_INTERVAL_MS);
void refresh();
