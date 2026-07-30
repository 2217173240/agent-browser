import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { BridgeDaemon } from "../dist/daemon/server.js";

test("daemon validates CDP tokens and routes core CDP traffic through the extension bridge", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    await assertInvalidToken(port);

    const session = await postJson(port, "/sessions", {});
    const cdp = await connectCdp(port, session.sessionId, session.token);

    const targets = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.equal(targets.result.targetInfos.length, 1);
    assert.equal(targets.result.targetInfos[0].url, "https://example.com");

    const created = await cdpCommand(cdp, {
      id: 2,
      method: "Target.createTarget",
      params: { url: "https://example.org" },
    });
    assert.match(created.result.targetId, /^tab:profile-a:/);

    const attached = await cdpCommand(cdp, {
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: created.result.targetId, flatten: true },
    });
    assert.match(attached.result.sessionId, /^session:/);

    const evaluated = await cdpCommand(cdp, {
      id: 4,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.equal(evaluated.result.result.value, "ok");

    const closed = await cdpCommand(cdp, {
      id: 5,
      method: "Browser.close",
      params: {},
    });
    assert.deepEqual(closed.result, {});

    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon requires an explicit profile when multiple extension profiles are connected", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const first = await connectExtension(port, "profile-a", [
    { tabId: 1, url: "https://a.example", title: "A", active: true },
  ]);
  const second = await connectExtension(port, "profile-b", [
    { tabId: 2, url: "https://b.example", title: "B", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {});
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const response = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.match(response.error.message, /Multiple Chrome extension profiles/);
    cdp.close();
  } finally {
    first.close();
    second.close();
    await daemon.stop();
  }
});

test("page takeover fences queued and future CDP commands and emits a bounded owner event", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", { ownerSessionId: "nex-aaaaaaaaaaaaaaaa" });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "control-event",
        profileId: "profile-a",
        tabId: 101,
        sessionId: attached.result.sessionId,
        action: "takeover",
      }),
    );
    await waitFor(async () => {
      const events = await fetchJson(port, "/control/events?after=0");
      return events.events.length === 1;
    });

    const blocked = await cdpCommand(cdp, {
      id: 2,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.match(blocked.error.message, /held by the user/);

    const observer = await cdpCommand(cdp, {
      id: 20,
      sessionId: attached.result.sessionId,
      method: "Page.startScreencast",
      params: { format: "png", quality: 99, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
    });
    assert.equal(observer.error, undefined);
    assert.deepEqual(
      extension.commands.find((command) => command.method === "Page.startScreencast")?.params,
      {
        format: "jpeg",
        quality: 60,
        maxWidth: 640,
        maxHeight: 360,
        everyNthFrame: 6,
      },
    );
    assert.ok(
      extension.commands.some(
        (command) => command.method === "Bridge.activateTab" && command.tabId === 101,
      ),
      "takeover should focus the controlled Chrome tab",
    );

    const ack = await cdpCommand(cdp, {
      id: 21,
      sessionId: attached.result.sessionId,
      method: "Page.screencastFrameAck",
      params: { sessionId: 1 },
    });
    assert.equal(ack.error, undefined);

    const events = await fetchJson(port, "/control/events?after=0");
    assert.equal(events.events[0].ownerSessionId, "nex-aaaaaaaaaaaaaaaa");
    assert.equal(events.events[0].action, "takeover");
    assert.equal(events.events[0].pendingActionRisk, false);

    const resumed = await postJson(port, "/control/sessions/nex-aaaaaaaaaaaaaaaa", {
      phase: "agent",
    });
    assert.equal(resumed.matched, 1);
    const evaluated = await cdpCommand(cdp, {
      id: 3,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.equal(evaluated.result.result.value, "ok");
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon routes CDP events only to the owning bridge session", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://a.example", title: "A", active: true },
    { tabId: 202, windowId: 1, url: "https://b.example", title: "B", active: false },
  ]);

  try {
    const firstSession = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const secondSession = await postJson(port, "/sessions", {
      ownerSessionId: "nex-bbbbbbbbbbbbbbbb",
    });
    const first = await connectCdp(port, firstSession.sessionId, firstSession.token);
    const second = await connectCdp(port, secondSession.sessionId, secondSession.token);
    const firstAttached = await cdpCommand(first, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    const secondAttached = await cdpCommand(second, {
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:202", flatten: true },
    });
    const firstEvents = [];
    const secondEvents = [];
    first.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) firstEvents.push(message);
    });
    second.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) secondEvents.push(message);
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-event",
        profileId: "profile-a",
        tabId: 101,
        sessionId: firstAttached.result.sessionId,
        method: "Page.screencastFrame",
        params: { sessionId: 1, data: "first" },
      }),
    );
    await waitFor(() => firstEvents.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondEvents.length, 0);
    assert.equal(firstEvents[0].sessionId, firstAttached.result.sessionId);

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-event",
        profileId: "profile-a",
        tabId: 202,
        sessionId: secondAttached.result.sessionId,
        method: "Page.screencastFrame",
        params: { sessionId: 2, data: "second" },
      }),
    );
    await waitFor(() => secondEvents.length === 1);
    assert.equal(firstEvents.length, 1);
    assert.equal(secondEvents[0].sessionId, secondAttached.result.sessionId);

    first.close();
    second.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

async function connectExtension(port, profileId, tabs) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  ws.commands = [];
  await onceOpen(ws);
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.kind !== "cdp-command") return;
    ws.commands.push(message);
    if (message.method === "Bridge.createTab") {
      const tab = {
        tabId: 202,
        windowId: 1,
        url: message.params.url,
        title: "Created",
        active: true,
      };
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "cdp-result",
          reqId: message.reqId,
          result: tab,
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-result",
        reqId: message.reqId,
        result: {
          result: { type: "string", value: "ok" },
        },
      }),
    );
  });
  ws.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      profileId,
      extensionId: "extension-id",
      chromeVersion: "120.0.0.0",
      tabs,
    }),
  );
  await waitFor(async () => {
    const health = await fetchJson(port, "/health");
    return health.profiles.some((profile) => profile.profileId === profileId);
  });
  return ws;
}

async function assertInvalidToken(port) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/devtools/browser/bridge?session=missing&token=bad`,
    );
    ws.on("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, 401);
      resolve();
    });
    ws.on("open", () => reject(new Error("invalid token unexpectedly connected")));
    ws.on("error", () => undefined);
  });
}

async function connectCdp(port, sessionId, token) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/devtools/browser/bridge?session=${sessionId}&token=${token}`,
  );
  await onceOpen(ws);
  return ws;
}

async function cdpCommand(ws, command) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for ${command.method}`));
    }, 5000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== command.id) return;
      ws.off("message", onMessage);
      clearTimeout(timer);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(command));
  });
}

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.ok, true);
  return await response.json();
}

async function fetchJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(response.ok, true);
  return await response.json();
}

async function onceOpen(ws) {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function waitFor(check) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("wait timed out");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
