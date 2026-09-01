(function () {
  try {
    const runtimeId = chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : "lovasiri";
    window.__lovasiriInjectedInstances = window.__lovasiriInjectedInstances || {};
    // Scope by extension id only — a sibling install must not block PowerKits.
    if (window.__lovasiriInjectedInstances[runtimeId]) return;
    window.__lovasiriInjectedInstances[runtimeId] = true;
    window.__lovasiriInjected = true;
  } catch (_) {
    if (window.__pkContentInjected) return;
    window.__pkContentInjected = true;
  }

  const BRIDGE_SOURCE = "LOVASIRI_EXTENSION_BRIDGE";
  const PAGE_SOURCE = "LOVASIRI_PAGE_PAYLOAD";

  function injectScript(name, then) {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(name);
    script.onload = function () {
      this.remove();
      if (typeof then === "function") then();
    };
    script.onerror = function () {
      this.remove();
      if (typeof then === "function") then();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function injectPayload() {
    // Hide prompt.txt chip in MAIN as well (isolated scan can miss this card).
    injectScript("hide-prompt-file.js");
    // i18n first, then payload (shows activation UI or loads gated core).
    injectScript("i18n.js", function () {
      injectScript("payload.js");
    });
  }

  function respond(id, ok, result, error) {
    window.postMessage({ source: BRIDGE_SOURCE, id, ok, result, error }, "*");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data || {};

    // pageHook (MAIN) → background: captured Lovable bearer / project id.
    if (msg.type === "lovableTokenFound") {
      const sync = { action: "lovableSync" };
      if (msg.token) sync.token = String(msg.token).replace(/^Bearer\s+/i, "").trim();
      if (msg.projectId) sync.projectId = String(msg.projectId).trim();
      if (sync.token || sync.projectId) {
        try {
          chrome.runtime.sendMessage(sync, function () {});
        } catch (_) {}
      }
      return;
    }

    // pageHook (MAIN) → SW license gate for credit-free /chat rewrite.
    if (msg.source === "PK_CF_REQUEST" && msg.type === "pkAllowCreditFree" && msg.id) {
      try {
        chrome.runtime.sendMessage({ action: "pkAllowCreditFree" }, function (result) {
          window.postMessage({ source: "PK_CF_BRIDGE", id: msg.id, ok: !!(result && result.ok) }, "*");
        });
      } catch (_) {
        window.postMessage({ source: "PK_CF_BRIDGE", id: msg.id, ok: false }, "*");
      }
      return;
    }

    // pageHook (MAIN) → SW → server rewrite (credit-free recipe stays server-side).
    if (msg.source === "PK_REWRITE_REQUEST" && msg.type === "pkRewriteChat" && msg.id) {
      try {
        chrome.runtime.sendMessage(
          {
            action: "pkRewriteChat",
            chatBody: msg.chatBody,
            method: msg.method,
            nativeChatActive: msg.nativeChatActive !== false,
          },
          function (result) {
            window.postMessage(
              {
                source: "PK_REWRITE_BRIDGE",
                id: msg.id,
                ok: !!(result && result.ok),
                body: result && result.body,
                human: result && result.human,
                reason: result && result.reason,
                passthrough: !!(result && result.passthrough),
              },
              "*",
            );
          },
        );
      } catch (_) {
        window.postMessage({ source: "PK_REWRITE_BRIDGE", id: msg.id, ok: false, reason: "bridge_error" }, "*");
      }
      return;
    }

    if (msg.source !== PAGE_SOURCE || !msg.id) return;

    try {
      if (msg.type === "storage.get") {
        chrome.storage.local.get(msg.keys, (result) => respond(msg.id, true, result || {}));
        return;
      }
      if (msg.type === "storage.set") {
        // Never let the page forge session/gate keys through the MAIN-world bridge.
        const blocked = {
          ql_handshake_token: 1,
          ql_handshake_last_result: 1,
        };
        const items = {};
        const src = msg.items || {};
        Object.keys(src).forEach((k) => {
          if (!blocked[k]) items[k] = src[k];
        });
        chrome.storage.local.set(items, () => respond(msg.id, true, true));
        return;
      }
      if (msg.type === "storage.remove") {
        chrome.storage.local.remove(msg.keys, () => respond(msg.id, true, true));
        return;
      }
      if (msg.type === "runtime.sendMessage") {
        chrome.runtime.sendMessage(msg.message, (result) => {
          const lastError = chrome.runtime.lastError && chrome.runtime.lastError.message;
          if (lastError) respond(msg.id, false, null, lastError);
          else respond(msg.id, true, result);
        });
        return;
      }
    } catch (err) {
      respond(msg.id, false, null, (err && err.message) || String(err));
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    window.postMessage({ source: BRIDGE_SOURCE, event: "storage.changed", changes, area }, "*");
  });

  function injectStyles() {
    try {
      const id = "lovasiri-floating-css";
      if (document.getElementById(id)) return;
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("floating.css");
      (document.head || document.documentElement).appendChild(link);
    } catch (_) {}
  }
  injectStyles();
  injectPayload();

  try {
    setTimeout(() => window.postMessage({ type: "lovableRequestToken" }, "*"), 250);
    setTimeout(() => window.postMessage({ type: "lovableRequestToken" }, "*"), 1500);
  } catch (_) {}
})();
