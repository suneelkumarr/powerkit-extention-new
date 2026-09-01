(function () {
  if (window.__lovasiriPayloadExecuted) return;
  window.__lovasiriPayloadExecuted = true;

  const currentScript = document.currentScript;
  const EXT_BASE =
    (typeof window !== "undefined" && window.__PK_EXT_BASE__) ||
    (currentScript && currentScript.src ? currentScript.src.replace(/[^/]*$/, "") : "") ||
    "";
  const EXT_VERSION = "16.73";
  const PAGE_SOURCE = "LOVASIRI_PAGE_PAYLOAD";
  const BRIDGE_SOURCE = "LOVASIRI_EXTENSION_BRIDGE";

  let seq = 0;
  const pending = new Map();
  const storageListeners = [];

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.source !== BRIDGE_SOURCE) return;
    if (msg.event === "storage.changed") {
      storageListeners.slice().forEach((fn) => {
        try {
          fn(msg.changes || {}, msg.area || "local");
        } catch (_) {}
      });
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "bridge_error"));
  });

  function bridge(type, payload, timeoutMs) {
    const id = "ls" + ++seq + "-" + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("bridge_timeout:" + type));
      }, timeoutMs || 30000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      window.postMessage(Object.assign({ source: PAGE_SOURCE, id, type }, payload || {}), "*");
    });
  }

  function callbackOrPromise(promise, cb) {
    if (typeof cb === "function") {
      promise.then((value) => cb(value)).catch(() => cb(undefined));
      return undefined;
    }
    return promise;
  }

  const I18N = window.__PK_I18N || null;
  function uiLocale(raw) {
    if (I18N && typeof I18N.normalize === "function") return I18N.normalize(raw);
    const v = String(raw || "en").toLowerCase().slice(0, 2);
    return v === "es" || v === "pt" || v === "de" ? v : "en";
  }
  function t(locale, key) {
    if (I18N && typeof I18N.t === "function") return I18N.t(locale, key);
    const en = {
      welcome: "Welcome",
      welcomeTitle: "Welcome to degitalservice",
      activatedLoading: "✓ License activated. Loading extension...",
      noResponse: "No response from the extension service.",
      activateSub: "Activate your license to unlock all premium tools of the extension.",
      licenseKey: "License Key",
      remember: "Save license on this device",
      activate: "Activate License",
      verifying: "Verifying...",
      enterKey: "Enter your license key.",
      language: "Language",
      close: "Close",
    };
    return en[key] || key;
  }
  function activationError(locale, reason, fallback) {
    if (I18N && typeof I18N.activationError === "function") {
      return I18N.activationError(locale, reason);
    }
    return fallback || reason || "Activation failed. Please try again.";
  }

  const chromeShim = {
    runtime: {
      id: "lovasiri",
      lastError: null,
      getURL: (path) => EXT_BASE + String(path || "").replace(/^\//, ""),
      getManifest: () => ({ name: "degitalservice", version: EXT_VERSION, manifest_version: 3 }),
      sendMessage: (message, cb) =>
        callbackOrPromise(
          bridge("runtime.sendMessage", { message })
            .then((result) => {
              chromeShim.runtime.lastError = null;
              return result;
            })
            .catch((err) => {
              chromeShim.runtime.lastError = { message: err.message || String(err) };
              if (typeof cb === "function") return undefined;
              throw err;
            }),
          cb,
        ),
      onMessage: { addListener: function () {} },
    },
    storage: {
      local: {
        get: (keys, cb) => callbackOrPromise(bridge("storage.get", { keys }), cb),
        set: (items, cb) =>
          callbackOrPromise(bridge("storage.set", { items: items || {} }).then(() => undefined), cb),
        remove: (keys, cb) =>
          callbackOrPromise(bridge("storage.remove", { keys }).then(() => undefined), cb),
      },
      onChanged: {
        addListener: (fn) => {
          if (typeof fn === "function") storageListeners.push(fn);
        },
        removeListener: (fn) => {
          const i = storageListeners.indexOf(fn);
          if (i >= 0) storageListeners.splice(i, 1);
        },
      },
    },
  };
  window.chrome = Object.assign({}, window.chrome || {}, chromeShim);
  window.chrome.runtime = chromeShim.runtime;
  window.chrome.storage = chromeShim.storage;

  function injectScriptUrl(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script_load_failed:" + src));
      document.head.appendChild(s);
    });
  }

  // NOTE: the old installEnglishUi() DOM MutationObserver translator lived
  // here. It force-replaced Portuguese words with English regardless of the
  // user's language and produced corrupted mixed-language text. All core UI
  // translation now happens server-side in the streamed bundle
  // (src/lib/ext-i18n-catalog.json), keyed by pk_ui_locale.

  function installLanguageSwitcher() {
    if (window.__pkLangSwitcherInstalled) return;
    window.__pkLangSwitcherInstalled = true;

    const labels = { en: "English", es: "Español", pt: "Português", de: "Deutsch" };
    const supported = (I18N && I18N.supported) || ["en", "es", "pt", "de"];

    function mountInto(cfgBody) {
      if (!cfgBody || cfgBody.querySelector("#pk-ui-locale-row")) return;
      chromeShim.storage.local.get(["pk_ui_locale"], (stored) => {
        if (!cfgBody.isConnected || cfgBody.querySelector("#pk-ui-locale-row")) return;
        const current = uiLocale((stored && stored.pk_ui_locale) || "en");
        const row = document.createElement("div");
        row.id = "pk-ui-locale-row";
        row.className = "qlL-cfg-section";
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;";
        const label = document.createElement("div");
        label.className = "qlL-cfg-sub";
        label.style.margin = "0";
        label.textContent = t(current, "language");
        const select = document.createElement("select");
        select.id = "pk-ui-locale-select";
        select.style.cssText =
          "background:#050a14;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#fff;padding:8px 10px;font-size:12.5px;outline:none;min-width:140px;";
        supported.forEach((code) => {
          const opt = document.createElement("option");
          opt.value = code;
          opt.textContent = labels[code] || code;
          if (code === current) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener("change", () => {
          const next = uiLocale(select.value);
          if (next === current) return;
          chromeShim.storage.local.set({ pk_ui_locale: next });
        });
        row.appendChild(label);
        row.appendChild(select);
        const foot = cfgBody.parentElement && cfgBody.parentElement.querySelector(".qlL-cfg-foot");
        if (foot && foot.parentElement === cfgBody.parentElement) {
          cfgBody.appendChild(row);
        } else {
          cfgBody.appendChild(row);
        }
      });
    }

    const scan = () => {
      document.querySelectorAll(".qlL-cfg-body").forEach(mountInto);
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function injectCode(code) {
    console.log("[degitalservice] injectCode: " + (code ? code.length : 0) + " bytes");
    let loaded = false;
    function afterInject() {
      installLanguageSwitcher();
      const fixUI = () => {
        const logoImg = document.querySelector("#ql-launcher .qlL-logo img");
        if (logoImg) logoImg.src = EXT_BASE + "icons/icon128.png";
        const launcher = document.querySelector("#ql-launcher");
        if (launcher) launcher.title = "degitalservice";
      };
      fixUI();
      setInterval(fixUI, 2000);

      if (window.__qlActivationJustHappened) {
        try {
          const tryOverride = (attempt) => {
            if (typeof window._qlShowLicenseModal === "function") {
              const orig = window._qlShowLicenseModal;
              window._qlShowLicenseModal = function () {
                console.log("[PowerKits] Activation modal suppressed (already activated via shell).");
              };
              setTimeout(() => {
                try {
                  window._qlShowLicenseModal = orig;
                } catch (_) {}
                window.__qlActivationJustHappened = false;
              }, 8000);
            } else if (attempt < 30) {
              setTimeout(() => tryOverride(attempt + 1), 100);
            }
          };
          tryOverride(0);
        } catch (_) {}
      }

      setTimeout(() => {
        const ok =
          document.getElementById("ql-launcher") ||
          document.getElementById("ql-floating") ||
          document.getElementById("qlL-license-modal");
        if (!ok) console.warn("[degitalservice] core injected but did not render UI.");
        else console.log("[degitalservice] core UI rendered:", ok.id);
      }, 2500);
    }
    const runInline = () => {
      if (loaded) return;
      loaded = true;
      try {
        const s2 = document.createElement("script");
        s2.textContent = code;
        (document.head || document.documentElement).appendChild(s2);
        s2.remove();
      } catch (e) {
        console.error("[degitalservice] inline inject failed:", e && e.message);
      }
      afterInject();
    };
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const s = document.createElement("script");
    s.src = url;
    s.onerror = () => {
      URL.revokeObjectURL(url);
      runInline();
    };
    s.onload = () => {
      URL.revokeObjectURL(url);
      loaded = true;
      afterInject();
    };
    document.head.appendChild(s);
  }

  function showLoginShell() {
    if (document.getElementById("lovasiri-activation-overlay") || document.getElementById("ql-launcher")) return;

    const ICON_URL = EXT_BASE + "icons/icon128.png";
    const supported = (I18N && I18N.supported) || ["en", "es", "pt", "de"];

    const style = document.createElement("style");
    style.textContent = [
      "#lovasiri-activation-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;animation:lsFadeIn .25s ease}",
      "@keyframes lsFadeIn{from{opacity:0}to{opacity:1}}",
      "@keyframes lsSlideUp{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}",
      "#lovasiri-activation-overlay *{box-sizing:border-box}",
      "#lovasiri-activation-modal{position:relative;width:380px;max-width:calc(100vw - 32px);background:linear-gradient(180deg,#161616 0%,#0d0d0d 100%);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:28px;color:#fff;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(37,99,235,.05);animation:lsSlideUp .3s cubic-bezier(.16,1,.3,1)}",
      "#lovasiri-activation-modal .ls-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);color:#9a9a9a;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;line-height:1;transition:all .15s}",
      "#lovasiri-activation-modal .ls-close:hover{background:rgba(255,255,255,.08);color:#fff}",
      "#lovasiri-activation-modal .ls-logo{width:64px;height:64px;border-radius:14px;display:block;margin:0 0 18px;object-fit:cover;background:#000;box-shadow:0 8px 22px rgba(37,99,235,.25)}",
      "#lovasiri-activation-modal h2{margin:0 0 8px;font-size:22px;font-weight:700;letter-spacing:-.01em;color:#fff}",
      "#lovasiri-activation-modal .ls-sub{margin:0 0 22px;font-size:13.5px;line-height:1.5;color:#9a9a9a}",
      "#lovasiri-activation-modal .ls-label{display:block;margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.12em;color:#8a8a8a;text-transform:uppercase}",
      "#lovasiri-activation-modal .ls-input{width:100%;padding:13px 14px;background:#050a14;border:1px solid rgba(37,99,235,.55);border-radius:10px;color:#fff;font-size:13.5px;font-family:'SF Mono',Menlo,Consolas,monospace;letter-spacing:.05em;outline:none;transition:border-color .15s,box-shadow .15s}",
      "#lovasiri-activation-modal .ls-input::placeholder{color:#2a3a5a}",
      "#lovasiri-activation-modal .ls-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18)}",
      "#lovasiri-activation-modal .ls-lang{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px}",
      "#lovasiri-activation-modal .ls-lang select{background:#050a14;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#fff;padding:8px 10px;font-size:12.5px;outline:none}",
      "#lovasiri-activation-modal .ls-save{display:flex;align-items:center;gap:9px;margin:14px 0 18px;font-size:13px;color:#cfcfcf;cursor:pointer;user-select:none}",
      "#lovasiri-activation-modal .ls-save input{appearance:none;-webkit-appearance:none;width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:#0a0a0a;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;flex-shrink:0;transition:all .15s}",
      "#lovasiri-activation-modal .ls-save input:checked{background:#2563eb;border-color:#2563eb}",
      "#lovasiri-activation-modal .ls-save input:checked::after{content:'';position:absolute;left:4px;top:1px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}",
      "#lovasiri-activation-modal .ls-btn{width:100%;padding:14px;border:0;border-radius:10px;background:linear-gradient(180deg,#2563eb 0%,#1d4ed8 100%);color:#fff;font-size:14.5px;font-weight:700;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 24px rgba(37,99,235,.35),inset 0 1px 0 rgba(255,255,255,.15);transition:transform .1s,box-shadow .15s}",
      "#lovasiri-activation-modal .ls-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 28px rgba(37,99,235,.45),inset 0 1px 0 rgba(255,255,255,.18)}",
      "#lovasiri-activation-modal .ls-btn:disabled{opacity:.7;cursor:wait}",
      "#lovasiri-activation-modal .ls-foot{margin:18px 0 0;text-align:center;font-size:12.5px;color:#8a8a8a}",
      "#lovasiri-activation-modal .ls-msg{min-height:16px;margin-top:10px;text-align:center;font-size:12px}",
      "#lovasiri-activation-modal .ls-err{color:#93c5fd}",
      "#lovasiri-activation-modal .ls-ok{color:#86efac}",
    ].join("\n");
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "lovasiri-activation-overlay";
    document.body.appendChild(overlay);

    let currentLocale = "en";

    function renderActivation(locale) {
      currentLocale = uiLocale(locale);
      const langOpts = supported
        .map((code) => {
          const labels = { en: "English", es: "Español", pt: "Português", de: "Deutsch" };
          return (
            '<option value="' +
            code +
            '"' +
            (code === currentLocale ? " selected" : "") +
            ">" +
            (labels[code] || code) +
            "</option>"
          );
        })
        .join("");
      overlay.innerHTML = [
        '<div id="lovasiri-activation-modal" role="dialog" aria-modal="true">',
        '<button class="ls-close" type="button" aria-label="' +
          t(currentLocale, "close") +
          '">✕</button>',
        '<img class="ls-logo" src="' + ICON_URL + '" alt="degitalservice">',
        '<h2>Welcome to <a href="https://degitalservice.com" target="_blank" style="color:inherit;text-decoration:underline;">degitalservice</a></h2>',
        '<p class="ls-sub">' + t(currentLocale, "activateSub") + "</p>",
        '<div class="ls-lang"><label class="ls-label" for="ls-locale" style="margin:0">' +
          t(currentLocale, "language") +
          '</label><select id="ls-locale">' +
          langOpts +
          "</select></div>",
        '<label class="ls-label" for="lovasiri-license-input">' + t(currentLocale, "licenseKey") + "</label>",
        '<input id="lovasiri-license-input" name="ls-' +
          Math.random().toString(36).slice(2, 10) +
          '" class="ls-input" placeholder="PKITS-XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other" value="">',
        '<label class="ls-save"><input type="checkbox" id="ls-remember" checked><span>' +
          t(currentLocale, "remember") +
          "</span></label>",
        '<button id="ls-activate" class="ls-btn" type="button">' + t(currentLocale, "activate") + "</button>",
        '<div class="ls-msg" id="ls-msg"></div>',
        '<p class="ls-foot"><a href="https://degitalservice.com" target="_blank" style="color:#8a8a8a;text-decoration:underline;">degitalservice</a></p>',
        "</div>",
      ].join("");

      const input = overlay.querySelector("#lovasiri-license-input");
      input.value = "";
      const btn = overlay.querySelector("#ls-activate");
      const msg = overlay.querySelector("#ls-msg");
      const remember = overlay.querySelector("#ls-remember");
      const closeBtn = overlay.querySelector(".ls-close");
      const localeSelect = overlay.querySelector("#ls-locale");

      function closeOverlay() {
        overlay.remove();
      }
      closeBtn.addEventListener("click", closeOverlay);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeOverlay();
      });

      localeSelect.addEventListener("change", () => {
        const next = uiLocale(localeSelect.value);
        chromeShim.storage.local.set({ pk_ui_locale: next }, () => renderActivation(next));
      });

      input.addEventListener("input", () => {
        const pos = input.selectionStart;
        const up = input.value.toUpperCase();
        if (up !== input.value) {
          input.value = up;
          try {
            input.setSelectionRange(pos, pos);
          } catch (_) {}
        }
      });

      async function activate() {
        const key = (input.value || "").trim().toUpperCase();
        if (!key || key.length < 10) {
          msg.className = "ls-msg ls-err";
          msg.textContent = t(currentLocale, "enterKey");
          return;
        }
        btn.disabled = true;
        btn.textContent = t(currentLocale, "verifying");
        msg.textContent = "";
        try {
          await new Promise((resolve) => {
            chromeShim.storage.local.set({ pk_ui_locale: currentLocale }, () => resolve());
          });
          const data = await new Promise((resolve) => {
            chromeShim.runtime.sendMessage({ action: "pkActivate", licenseKey: key }, (r) =>
              resolve(r || { ok: false, message: t(currentLocale, "noResponse") }),
            );
          });
          if (!data.ok) {
            throw new Error(
              data.message || activationError(currentLocale, data.reason, "Activation failed. Please try again."),
            );
          }
          const lic = data.license || {};
          const persistKey = remember.checked;
          await chromeShim.storage.local.set({
            ql_license_valid: true,
            ql_license_key: persistKey ? key : key,
            ql_user_name: lic.user_name || null,
            ql_expires_at: lic.expires_at || null,
            ql_license_status: "active",
            ql_plan: lic.plan || null,
            ql_is_trial: !!lic.is_trial,
            ql_sidebar_mode: false,
            ql_native_chat: true,
            ql_show_activation: false,
            pk_ui_locale: currentLocale,
          });
          msg.className = "ls-msg ls-ok";
          msg.textContent = t(currentLocale, "activatedLoading");
          window.__qlActivationJustHappened = true;
          closeOverlay();
          try {
            await new Promise((resolve) => {
              chromeShim.runtime.sendMessage({ action: "pkInjectShell", fromActivation: true }, () => resolve());
            });
          } catch (_) {}
          await loadCore(key, "floating", true, 0, "");
        } catch (err) {
          msg.className = "ls-msg ls-err";
          msg.textContent = "✗ " + ((err && err.message) || err);
          btn.disabled = false;
          btn.textContent = t(currentLocale, "activate");
        }
      }
      btn.addEventListener("click", activate);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") activate();
      });
      setTimeout(() => input.focus(), 120);
    }

    chromeShim.storage.local.get(["pk_ui_locale"], (s) => {
      renderActivation((s && s.pk_ui_locale) || "en");
    });
  }

  async function loadCore(key, layout, fromActivation, attempt, sessionId) {
    attempt = attempt || 0;
    if (window.__qlCoreInjected) return;
    try {
      if (!window.JSZip) {
        try {
          await injectScriptUrl(EXT_BASE + "jszip.min.js");
        } catch (_) {}
      }
      if (typeof window.getHardwareFingerprint !== "function") {
        try {
          await injectScriptUrl(EXT_BASE + "hwFingerprint.js");
        } catch (e) {
          console.warn("[PowerKits] failed to inject hwFingerprint into MAIN:", e && e.message);
        }
      }

      // Authorize via PowerKits session, then fetch gated /bundle (core-only).
      const auth = await new Promise((resolve) => {
        chromeShim.runtime.sendMessage({ action: "pkFetchCore", direct: true }, (r) =>
          resolve(r || { ok: false, reason: "no_response" }),
        );
      });

      if (!auth.ok) {
        const hardInvalid =
          [
            "invalid_license",
            "license_revoked",
            "license_expired",
            "license_disabled",
            "license_deleted",
            "device_mismatch",
            "device_limit",
            "not_authorized",
          ].indexOf(auth.reason) !== -1;
        if (hardInvalid) {
          await chromeShim.storage.local.remove(["ql_license_valid", "ql_license_key"]);
          showLoginShell();
          return;
        }
        if (attempt < 4) {
          setTimeout(() => loadCore(key, layout, fromActivation, attempt + 1, sessionId), 2000 * (attempt + 1));
        } else {
          console.warn("[PowerKits] Core unavailable (" + auth.reason + "). Reload the page in a moment.");
        }
        return;
      }

      let code = auth.code || "";
      let css = auth.css || "";
      if (auth.mode === "direct" && auth.url && auth.token && auth.deviceId) {
        const br = await fetch(String(auth.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: auth.token,
            deviceId: auth.deviceId,
            locale: auth.locale || "en",
          }),
          cache: "no-store",
        });
        if (!br.ok) throw new Error("bundle_http_" + br.status);
        const payload = await br.json();
        if (!payload || !payload.ok || !payload.js) {
          throw new Error((payload && payload.reason) || "bundle_unavailable");
        }
        code = payload.js;
        css = payload.css || "";
      }
      if (!code) throw new Error("bundle_empty");
      const newName = "degitalservice";
      const newLink = "https://degitalservice.com";
      code = code.replace(/Lovable Extension/gi, newName);
      code = code.replace(/Lovable PowerKits/gi, newName);

      // --- DYNAMIC THEME REPLACEMENT (RED TO BLUE) ---
      const replaceColors = (str) => {
        if (!str) return str;
        return str.replace(/#e11d48/gi, "#2563eb")
                  .replace(/#ef4444/gi, "#2563eb")
                  .replace(/#dc2626/gi, "#1d4ed8")
                  .replace(/#f43f5e/gi, "#3b82f6")
                  .replace(/#be123c/gi, "#1e40af")
                  .replace(/#fca5a5/gi, "#93c5fd")
                  .replace(/#ff3b7a/gi, "#3b82f6")
                  .replace(/rgba\(\s*239\s*,\s*68\s*,\s*68/gi, "rgba(37,99,235")
                  .replace(/rgba\(\s*225\s*,\s*29\s*,\s*72/gi, "rgba(37,99,235")
                  .replace(/rgba\(\s*244\s*,\s*63\s*,\s*94/gi, "rgba(59,130,246");
      };
      code = replaceColors(code);
      css = replaceColors(css);

      if (css) {
        try {
          const st = document.createElement("style");
          st.id = "lovasiri-floating-css-bundle";
          st.textContent = css;
          (document.head || document.documentElement).appendChild(st);
        } catch (_) {}
      }

      injectCode(code);
      window.__qlCoreInjected = true;

      // Menu filter & Popup hider
      (function() {
        var ALLOWED = ["remove watermark", "create project on lovable", "download full project", "use standard chat"];
        function filterMenu() {
          var selectors = [
            "#ql-launcher li", "#ql-launcher .qlL-row", "#ql-launcher .qlL-item",
            "#ql-launcher button", "#ql-launcher [role='menuitem']",
            "#ql-launcher .ql-menu-item", "#ql-launcher .qlMenu-item",
            ".qlL-menu li", ".qlL-menu button", ".qlL-panel li", ".qlL-panel button"
          ];
          selectors.forEach(function(sel) {
            try {
              document.querySelectorAll(sel).forEach(function(el) {
                var txt = (el.textContent || "").trim().toLowerCase();
                if (!txt) return;
                var keep = ALLOWED.some(function(a) { return txt.indexOf(a) !== -1; });
                el.style.setProperty("display", keep ? "" : "none", "important");
              });
            } catch(_) {}
          });

          // HIDE UPDATE POPUPS
          try {
            document.querySelectorAll('div, dialog').forEach(function(el) {
              var t = el.innerText || "";
              if (t.indexOf("Update required") !== -1 && t.indexOf("Download update") !== -1 && t.length < 300) {
                el.style.setProperty("display", "none", "important");
                el.style.setProperty("opacity", "0", "important");
                el.style.setProperty("pointer-events", "none", "important");
              }
            });
          } catch(e) {}
        }
        var mo = new MutationObserver(filterMenu);
        mo.observe(document.documentElement, { childList: true, subtree: true });
        filterMenu();
      })();

      if (fromActivation) {
        setTimeout(() => {
          if (!document.getElementById("ql-launcher") && !document.getElementById("ql-floating")) {
            window.dispatchEvent(new Event("resize"));
            try {
              window.qlBootstrap && window.qlBootstrap();
            } catch (_) {}
          }
        }, 1200);
      }
    } catch (err) {
      console.warn("[PowerKits] Failed to load core:", err && err.message);
      if (attempt < 4) {
        setTimeout(() => loadCore(key, layout, fromActivation, attempt + 1, sessionId), 2000 * (attempt + 1));
      }
    }
  }

  let __qlReloadingForShell = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== "local") return;
    if (__qlReloadingForShell) return;
    // Language changed after the core was injected: reload so the bundle is
    // re-fetched (and re-translated server-side) in the new language. The
    // activation modal also writes pk_ui_locale, but the core isn't injected
    // yet at that point, so this only fires for post-activation switches.
    if (
      changes &&
      changes.pk_ui_locale &&
      window.__qlCoreInjected &&
      changes.pk_ui_locale.newValue !== changes.pk_ui_locale.oldValue
    ) {
      __qlReloadingForShell = true;
      setTimeout(() => {
        try {
          location.reload();
        } catch (_) {}
      }, 120);
      return;
    }
    const invalid = changes && changes.ql_license_valid && changes.ql_license_valid.newValue === false;
    const removedKey =
      changes &&
      changes.ql_license_key &&
      (changes.ql_license_key.newValue === undefined ||
        changes.ql_license_key.newValue === "" ||
        changes.ql_license_key.newValue === null);
    const showShell = changes && changes.ql_show_activation && changes.ql_show_activation.newValue === true;
    if (invalid || removedKey || showShell) {
      __qlReloadingForShell = true;
      try {
        chrome.storage.local.set({ ql_license_valid: false, ql_show_activation: true }, () => {
          setTimeout(() => {
            try {
              location.reload();
            } catch (_) {}
          }, 80);
        });
      } catch (_) {
        setTimeout(() => {
          try {
            location.reload();
          } catch (_) {}
        }, 80);
      }
    }
  });

  // Boot: never set a fake license. Missing/invalid key → activation shell.
  chrome.storage.local.get(
    [
      "ql_license_key",
      "ql_session_id",
      "ql_license_valid",
      "ql_sidebar_mode",
      "ql_show_activation",
      "ql_shell_version",
      "pk_ui_locale",
    ],
    async (stored) => {
      const patch = {};
      if (!stored || stored.ql_shell_version !== EXT_VERSION) {
        patch.ql_shell_version = EXT_VERSION;
        patch.ql_native_chat = true;
        patch.ql_sidebar_mode = false;
      }
      if (!stored || !stored.pk_ui_locale) patch.pk_ui_locale = "en";
      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
        stored = Object.assign({}, stored || {}, patch);
      }
      const key = stored && stored.ql_license_key;
      if (key && stored.ql_license_valid !== false) {
        loadCore(key, "floating", false, 0, stored.ql_session_id || "");
      } else {
        showLoginShell();
      }
    },
  );
})();




