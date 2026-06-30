import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeMessage,
  type BridgeTab,
} from "../src/protocol";

type StoredConfig = {
  bridgeProfileId?: string;
  bridgePort?: number;
  bridgePorts?: number[];
};

const DEFAULT_PORT = 19826;
const attachedTabs = new Set<number>();
let bridge: WebSocket | null = null;
let activePort = DEFAULT_PORT;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create("agent-browser-bridge-heartbeat", { periodInMinutes: 0.5 });
    void connectBridge();
  });
  chrome.runtime.onStartup.addListener(() => {
    void connectBridge();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "agent-browser-bridge-heartbeat") {
      void connectBridge().then(() => sendHeartbeat());
    }
  });
  chrome.tabs.onCreated.addListener(() => scheduleHeartbeat());
  chrome.tabs.onUpdated.addListener(() => scheduleHeartbeat());
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
    scheduleHeartbeat();
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId) return;
    void sendBridgeMessage({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "cdp-event",
      profileId: "",
      tabId: source.tabId,
      method,
      params: (params ?? {}) as Record<string, unknown>,
    });
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) attachedTabs.delete(source.tabId);
    if (!source.tabId) return;
    void sendBridgeMessage({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "cdp-event",
      profileId: "",
      tabId: source.tabId,
      method: "Inspector.detached",
      params: { reason },
    });
  });
  void connectBridge();
});

async function connectBridge(): Promise<void> {
  if (bridge && bridge.readyState === WebSocket.OPEN) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const ports = await configuredPorts();
  for (const port of ports) {
    try {
      await openBridge(port);
      activePort = port;
      return;
    } catch (error) {
      bridge = null;
    }
  }
  reconnectTimer = setTimeout(() => {
    void connectBridge();
  }, 1000);
}

async function openBridge(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    const fail = () => reject(new Error("bridge connection failed"));
    ws.onopen = () => {
      bridge = ws;
      ws.onmessage = (event) => {
        void handleBridgeMessage(event.data);
      };
      ws.onclose = () => {
        bridge = null;
        reconnectTimer = setTimeout(() => {
          void connectBridge();
        }, 1000);
      };
      ws.onerror = () => undefined;
      void sendHello().then(resolve, reject);
    };
    ws.onerror = () => {
      fail();
    };
  });
}

async function handleBridgeMessage(raw: string) {
  const message = JSON.parse(raw) as BridgeMessage;
  if (message.v !== BRIDGE_PROTOCOL_VERSION || message.kind !== "cdp-command") return;
  const command = message as BridgeCommand;
  try {
    const result = await executeCommand(command);
    await sendResult(command.reqId, result);
  } catch (error) {
    await sendResult(command.reqId, undefined, {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeCommand(command: BridgeCommand): Promise<unknown> {
  if (command.method === "Bridge.createTab") {
    const url = typeof command.params?.url === "string" ? command.params.url : "about:blank";
    const tab = await tabsCreate({ url, active: true });
    return tabToBridgeTab(tab);
  }
  if (command.method === "Bridge.activateTab") {
    const tabId = numberParam(command, "tabId");
    const tab = await tabsUpdate(tabId, { active: true });
    if (tab.windowId !== undefined) await windowsUpdate(tab.windowId, { focused: true });
    return {};
  }
  if (command.method === "Bridge.closeTab") {
    const tabId = numberParam(command, "tabId");
    await tabsRemove(tabId);
    attachedTabs.delete(tabId);
    return { success: true };
  }
  const tabId = command.tabId;
  if (typeof tabId !== "number") {
    throw new Error(`CDP command ${command.method} is missing tabId`);
  }
  await ensureDebuggerAttached(tabId);
  return await debuggerSendCommand({ tabId }, command.method, command.params ?? {});
}

async function ensureDebuggerAttached(tabId: number) {
  if (attachedTabs.has(tabId)) return;
  await debuggerAttach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

async function sendHello() {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "hello",
    profileId: await getProfileId(),
    extensionId: chrome.runtime.id,
    chromeVersion: chromeVersion(),
    tabs: await allTabs(),
  });
}

async function sendHeartbeat() {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "heartbeat",
    profileId: await getProfileId(),
    tabs: await allTabs(),
  });
}

async function sendResult(reqId: string, result?: unknown, error?: { code: number; message: string }) {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "cdp-result",
    reqId,
    result,
    error,
  });
}

async function sendBridgeMessage(message: BridgeMessage) {
  if ("profileId" in message && !message.profileId) {
    message.profileId = await getProfileId();
  }
  if (!bridge || bridge.readyState !== WebSocket.OPEN) return;
  bridge.send(JSON.stringify(message));
}

async function configuredPorts(): Promise<number[]> {
  const stored = await storageGet<StoredConfig>(["bridgePort", "bridgePorts"]);
  const ports = [
    ...(Array.isArray(stored.bridgePorts) ? stored.bridgePorts : []),
    typeof stored.bridgePort === "number" ? stored.bridgePort : DEFAULT_PORT,
    DEFAULT_PORT,
  ];
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

async function getProfileId(): Promise<string> {
  const stored = await storageGet<StoredConfig>(["bridgeProfileId"]);
  if (stored.bridgeProfileId) return stored.bridgeProfileId;
  const bridgeProfileId = crypto.randomUUID();
  await storageSet({ bridgeProfileId });
  return bridgeProfileId;
}

async function allTabs(): Promise<BridgeTab[]> {
  const tabs = await tabsQuery({});
  return tabs.map(tabToBridgeTab).filter((tab) => tab.tabId > 0);
}

function tabToBridgeTab(tab: chrome.tabs.Tab): BridgeTab {
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: tab.active,
  };
}

function scheduleHeartbeat() {
  setTimeout(() => {
    void sendHeartbeat();
  }, 50);
}

function chromeVersion(): string | undefined {
  const match = /Chrome\/([^ ]+)/.exec(navigator.userAgent);
  return match?.[1];
}

function numberParam(command: BridgeCommand, key: string): number {
  const value = command.params?.[key];
  if (typeof value !== "number") throw new Error(`${command.method} requires numeric ${key}`);
  return value;
}

function storageGet<T>(keys: string[]): Promise<T> {
  return chromeCall<T>((done) => chrome.storage.local.get(keys, done));
}

function storageSet(value: Record<string, unknown>): Promise<void> {
  return chromeCall<void>((done) => chrome.storage.local.set(value, done));
}

function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return chromeCall((done) => chrome.tabs.query(queryInfo, done));
}

function tabsCreate(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return chromeCall((done) => chrome.tabs.create(createProperties, done));
}

function tabsUpdate(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
  return chromeCall((done) => chrome.tabs.update(tabId, updateProperties, done));
}

function tabsRemove(tabId: number): Promise<void> {
  return chromeCall((done) => chrome.tabs.remove(tabId, done));
}

function windowsUpdate(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window> {
  return chromeCall((done) => chrome.windows.update(windowId, updateInfo, done));
}

function debuggerAttach(target: chrome.debugger.Debuggee, version: string): Promise<void> {
  return chromeCall((done) => chrome.debugger.attach(target, version, done));
}

function debuggerSendCommand(target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>): Promise<unknown> {
  return chromeCall((done) => chrome.debugger.sendCommand(target, method, params, done));
}

function chromeCall<T>(fn: (done: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((value) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(value);
      }
    });
  });
}
