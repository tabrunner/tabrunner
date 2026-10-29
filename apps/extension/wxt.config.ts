import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

/**
 * ONE keyed build serves every channel. The `key` below is what gives the
 * unpacked install and every dev load the store listing's own id (see below);
 * CWS derives that same id from its item record, so the field is redundant
 * there but harmless — the keyed zip is the upload.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: "src",
  outDir: "dist",
  manifest: {
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    homepage_url: "https://tabrunner.app",
    // Public half of the Chrome Web Store item's key, straight from the
    // dashboard. It pins every unpacked and dev load to the store's own id,
    // ilnohobdcigbmlikjbkdpbkhciephdle, so one id covers every channel and the
    // MCP bridge expects the id real users actually have.
    //
    // Consequence to know: a store install and an unpacked build can no longer
    // be loaded side by side — Chrome keys its registry by id and refuses the
    // second. Uninstall one to test the other.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr8xjfiPm9mUAaxGNJ0zla9zh5+VZrRBvvTWy6QgNNucXYro47OPOUSroT6r2+4Xl3ZFJ372UD/EOB/OvAljGYOHmvhoHLpFNthHYKl6xv/LhtEte2Op8KTuu3giXc6U+fV48NfQQbIb32xnc6QZIDXjwCPkvR1ZBvMgZ62w3j9tnzht/UTTMkWKcXOv3Fd60ZnixoGlNqb0Fd34NzpG4CGkvVPkf0Mc/NLh09n4ZTJZuMVWfkSNBAmKSXC56gNkiD1pAX2YzISMqaSjaAVeX6pIweK+D0vqV/ZtJcNQYH6ff1WEBxIRG6W2seQEpb53wn/fYzgT1tqDiFBtUAbpLVQIDAQAB",
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png",
    },
    permissions: [
      "debugger",
      "storage",
      "scripting",
      "sidePanel",
      "tabs",
      "activeTab",
      "notifications",
      // Background runs open their own tab and label its group with the task.
      "tabGroups",
      // The MCP bridge's reconcile alarm — wakes a suspended worker to reconnect.
      "alarms",
      // Walkthrough frames are blobs in IndexedDB and a documented run can run
      // to tens of megabytes. No install prompt, and it exempts us from the
      // eviction that would otherwise take a recording the user meant to keep.
      "unlimitedStorage",
      // Lets the browser strip Origin from our own provider calls: a subscription
      // OAuth token is refused by Anthropic's per-organization CORS gate when it
      // arrives with a browser Origin, which is exactly what the worker's fetch
      // sends (an MV3 service worker is a document context). A CLI has no Origin
      // at all; removing it makes our request look the same way.
      "declarativeNetRequestWithHostAccess",
    ],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "/sidepanel.html",
    },
    action: {
      default_title: "__MSG_actionTitle__",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Extension pages load in an isolated world, so Chrome rejects Vite's
      // <link rel="modulepreload"> for our own chunks as a "cross-world resource
      // mismatch" and warns twice per chunk. The module graph is local and the
      // script tag pulls it in anyway — the preload buys nothing here.
      modulePreload: false,
      // The shared UI chunk (React + Base UI + i18n, ~556 kB) trips Vite's
      // 500 kB warning, which is tuned for pages shipped over a network.
      // Extension pages load from disk, the service worker stays lean (the
      // ESLint runtime boundary keeps UI out of it), and code-splitting the
      // panel would buy nothing — 750 leaves headroom while still catching a
      // genuinely accidental heavyweight import.
      chunkSizeWarningLimit: 750,
    },
  }),
});
