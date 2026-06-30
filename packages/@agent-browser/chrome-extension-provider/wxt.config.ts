import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Agent Browser Bridge",
    version: "0.31.1",
    minimum_chrome_version: "120",
    permissions: ["debugger", "tabs", "storage", "alarms"],
    host_permissions: ["http://127.0.0.1/*"],
    optional_permissions: ["scripting"],
    optional_host_permissions: ["<all_urls>"],
    action: {
      default_title: "Agent Browser Bridge",
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    },
  },
});
