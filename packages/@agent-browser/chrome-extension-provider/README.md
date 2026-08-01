# @agent-browser/chrome-extension-provider

Optional Chrome extension bridge provider for `agent-browser`.

This package lets `agent-browser` connect to the user's already running desktop Chrome through an unpacked MV3 extension. It exposes a `browser.provider` plugin that returns a local CDP WebSocket URL, while the bridge daemon translates CDP traffic to the extension's `chrome.debugger` transport.

## Install

```bash
pnpm add @agent-browser/chrome-extension-provider
```

Build the package if you are using it from a workspace checkout:

```bash
pnpm --filter @agent-browser/chrome-extension-provider build
```

Load the unpacked extension from:

```text
packages/@agent-browser/chrome-extension-provider/.output/chrome-mv3
```

## Configure agent-browser

Add the provider plugin:

```json
{
  "plugins": [
    {
      "name": "chrome-extension",
      "command": "agent-browser-plugin-chrome-extension",
      "capabilities": ["browser.provider", "command.run", "chrome-extension.manage"]
    }
  ]
}
```

Then run:

```bash
agent-browser --provider chrome-extension open https://example.com
agent-browser snapshot -i
```

## Status

Use the management command to see whether the daemon and extension profiles are connected:

```bash
agent-browser plugin run chrome-extension chrome-extension.status
```

The status output includes the unpacked extension path, bridge protocol version, daemon port, connected profile ids, extension id/version, and current tabs. Extension and daemon package versions are diagnostic only; compatibility is negotiated by the bridge protocol version so an automatically updated extension can remain compatible with an older daemon.

## Configuration

<table>
  <thead>
    <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
  </thead>
  <tbody>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PORT</code></td><td>Local daemon port</td><td><code>19826</code></td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PROFILE</code></td><td>Profile id to use when multiple extension profiles are connected</td><td>Auto-selects when only one profile is connected</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT</code></td><td>Private pathname suffix used to identify the owning profile when several profiles are connected</td><td>Unset; an explicit profile is still required when selection remains ambiguous</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_RETURN_ORIGIN</code></td><td>Trusted loopback origin used by the human-control Return to Nexolyra action</td><td>Unset; the Return action is hidden</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_DAEMON</code></td><td>Override daemon executable path</td><td>Bundled daemon</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID</code></td><td>Allow only one extension id to connect</td><td>Any local bridge extension</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_LOG</code></td><td>Optional daemon log file</td><td>No file logging</td></tr>
  </tbody>
</table>

The extension connects to port `19826` by default. For a custom port, set `chrome.storage.local.bridgePort` or `chrome.storage.local.bridgePorts` in the extension profile to match `AGENT_BROWSER_CHROME_BRIDGE_PORT`.

When a host provides `AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT`, the bridge uses that private route only to find the owning Chrome profile. It does not expose the host tab to the agent. Instead, it creates non-focused task windows and limits the CDP session to tabs created for that session; human takeover focuses the exact controlled tab, and provider cleanup closes session-owned tabs. The Return target is accepted only for an HTTP(S) loopback origin, is sent to the extension only during human control, and stays in the extension worker. The untrusted page receives only a boolean indicating whether the Return button should be shown, never the Nexolyra session path.

When Nexolyra owns the daemon lifecycle it starts the process with an internal supervision marker. `/health` exposes that boolean so destructive development harnesses can refuse to restart an unmanaged daemon. The marker is operational metadata, not an authentication mechanism.

The unpacked extension requests access to all page origins because local automation and the Live viewport must work on the user's task pages without a per-origin installation step. Live remains event-driven through `Page.screencastFrame`; for a static or occluded task window, the provider seeds one viewport JPEG with `chrome.tabs.captureVisibleTab` and then returns to the CDP event stream.

## Limits

The MVP targets ordinary web pages in desktop Chrome 120 or newer. It does not support `chrome://` pages, browser UI pages, automation of other extension pages, Chrome Web Store distribution, Native Messaging bootstrap, or capabilities that are already incomplete for external CDP sessions such as some recording flows.
