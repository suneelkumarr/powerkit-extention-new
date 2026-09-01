/* Lovable PowerKits — licensing gate.
   Build identity + API endpoint are injected at package time by scripts/build-extension.mjs. */
(function () {
  var _cfg = {
    build_id: "pk_v1673_202608291549",
    version: "16.73",
    api_url: "https://powerkit-extention.onrender.com",
    issued_at: 1787996981,
  };
  try { Object.freeze(_cfg); } catch (_e) { }
  try { self.__PK_BUILD__ = _cfg; } catch (_e) { }
  try { if (typeof window !== "undefined") window.__PK_BUILD__ = _cfg; } catch (_e) { }
})();
console.log("[PowerKits] service worker started");

try {
  importScripts("hwFingerprint.js");
} catch (e) {
  console.error("[PowerKits] probes:", e && e.message);
}

(function () {
  const STORAGE_KEY = "ql_handshake_token";
  const LAST_RESULT_KEY = "ql_handshake_last_result";
  const HEARTBEAT_MS = 6 * 60 * 60 * 1000; // 6h — idle installs must not burn CF Free quota
  const RETRY_MS = 15 * 60 * 1000; // transient failures: back off hard (was 30s storm)
  const ALARM_NAME = "pk-heartbeat";
  // Offline grace: the gate keeps working this long past the token's expiry
  // if (and only if) the network is unreachable. Server denials are immediate.
  const OFFLINE_GRACE_MS = 2 * 60 * 60 * 1000; // 2h while offline

  const FATAL_REASONS = new Set(["build_revoked", "unknown_build", "no_build_config"]);
  const LOGOUT_REASONS = new Set([
    "device_mismatch",
    "device_limit",
    "license_revoked",
    "license_expired",
    "license_disabled",
    "license_deleted",
    "invalid_license",
  ]);

  let _loopStarted = false;
  let _inFlight = null;

  function cfg() {
    try {
      return self.__PK_BUILD__ || null;
    } catch (e) {
      return null;
    }
  }

  function api(path) {
    const c = cfg();
    if (!c || !c.api_url) return null;
    return String(c.api_url).replace(/\/+$/, "") + path;
  }

  // Stable fallback host. If the stamped origin fails at the transport level
  // (DNS hiccup, blocked redirect, edge blip) one retry goes here before the
  // user is told anything at all.
  const FALLBACK_API = "https://powerkit-extention.onrender.com";

  function altApi(path) {
    const c = cfg();
    const primary = c && c.api_url ? String(c.api_url).replace(/\/+$/, "") : "";
    const fallback = FALLBACK_API.replace(/\/+$/, "");
    if (!primary || primary === fallback) return null;
    return fallback + path;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const INSTALLATION_ID_KEY = "pk_installation_id";
  let _deviceIdPromise = null;
  async function getDeviceId() {
    if (_deviceIdPromise) return _deviceIdPromise;
    _deviceIdPromise = new Promise((resolve) => {
      try {
        chrome.storage.local.get([INSTALLATION_ID_KEY], (res) => {
          if (res && res[INSTALLATION_ID_KEY]) return resolve(res[INSTALLATION_ID_KEY]);
          const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
          // This UUID represents one extension installation/browser profile.
          // Hardware fingerprints are intentionally not used for license slots:
          // Chrome, Edge and Brave on one computer must count separately.
          chrome.storage.local.set(
            { [INSTALLATION_ID_KEY]: id, ql_device_id: id },
            () => resolve(id),
          );
        });
      } catch (e) {
        // Never collapse storage failures from multiple installations onto one
        // shared sentinel ID. A per-runtime UUID is safer until storage recovers.
        resolve((crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random());
      }
    });
    return _deviceIdPromise;
  }

  function getDeviceLabel() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    let browser = "Chromium browser";
    if (/Edg\//.test(ua)) browser = "Microsoft Edge";
    else if (/OPR\//.test(ua)) browser = "Opera";
    else if (/Brave/i.test(ua)) browser = "Brave";
    else if (/Chrome\//.test(ua)) browser = "Google Chrome";
    return `${browser} installation`;
  }

  function get(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function set(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  async function getLicenseKey() {
    const res = await get(["ql_license_key"]);
    return (res && res.ql_license_key) || null;
  }

  async function readToken() {
    const res = await get([STORAGE_KEY]);
    return (res && res[STORAGE_KEY]) || null;
  }

  async function saveToken(token) {
    return set({ [STORAGE_KEY]: token });
  }

  async function saveLastResult(result) {
    return set({ [LAST_RESULT_KEY]: Object.assign({ checked_at: Date.now() }, result || {}) });
  }

  const NOTICE_KEY = "pk_notice";

  /** Store the release/broadcast notice returned by a successful handshake. */
  async function storeNotice(notice) {
    updateBadge(notice);
    if (!notice) return set({ [NOTICE_KEY]: null });
    return set({ [NOTICE_KEY]: Object.assign({ received_at: Date.now() }, notice) });
  }

  /** Toolbar hint so a pending update is visible without opening the panel. */
  function updateBadge(notice) {
    try {
      if (!chrome.action || !chrome.action.setBadgeText) return;
      if (notice && notice.outdated) {
        chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
        chrome.action.setBadgeText({ text: "1" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    } catch (_) { }
  }

  async function readNotice() {
    return null;
  }

  async function applyFatalBlock(reason, message) {
    return set({
      ql_license_valid: false,
      ql_native_chat: false,
      ql_blocked_reason: reason || "blocked",
      ql_blocked_message: message || "This copy of the extension has been blocked.",
    });
  }

  async function applyLicenseLogout(reason, message) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(
          [
            STORAGE_KEY,
            "ql_license_valid",
            "ql_license_key",
            "ql_session_id",
            "ql_user_name",
            "ql_expires_at",
            "ql_activated_at",
            "ql_license_status",
          ],
          () => {
            chrome.storage.local.set(
              {
                ql_native_chat: false,
                ql_show_activation: true,
                ql_blocked_reason: reason || "license_invalid",
                ql_blocked_message: message || "Your license is no longer valid.",
              },
              () => resolve(),
            );
          },
        );
      } catch (e) {
        resolve();
      }
    });
  }

  function isTokenValid(token) {
    if (!token || typeof token !== "object" || !token.token) return false;
    if (!token.expires_at) return false;
    return token.expires_at > Math.floor(Date.now() / 1000);
  }

  /** True when a token is expired but we are inside the offline grace window. */
  function isTokenInGrace(token) {
    if (!token || !token.token || !token.cached_at) return false;
    return Date.now() - token.cached_at < OFFLINE_GRACE_MS;
  }

  /**
   * One POST attempt. Never invents a diagnosis: a thrown request, an HTML
   * body and a real 4xx answer are three different outcomes and are reported
   * as such, with the HTTP status and host attached.
   */
  async function postOnce(url, body) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch (e) {
        return url;
      }
    })();
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        redirect: "follow",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        transportError: true,
        retryable: true,
        data: {
          ok: false,
          reason: "network",
          host,
          message: "Could not reach the licensing server (no connection). Check your network and try again.",
        },
      };
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      // HTML means we hit an error page / redirect instead of the licensing
      // API. That is a server-side fault, not the user's connection.
      return {
        transportError: true,
        retryable: true,
        data: {
          ok: false,
          reason: "server_unreachable",
          status: res.status,
          host,
          message: `The licensing server is not responding correctly (HTTP ${res.status} from ${host}). Please try again shortly.`,
        },
      };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return {
        transportError: true,
        retryable: true,
        data: {
          ok: false,
          reason: "server_unreachable",
          status: res.status,
          host,
          message: `The licensing server returned an unreadable response (HTTP ${res.status} from ${host}).`,
        },
      };
    }

    data.status = res.status;
    data.host = host;
    if (!data.ok && !data.reason) {
      data.reason = "server_error";
      data.message = data.message || `Licensing server error (HTTP ${res.status}).`;
    }
    if (!data.ok && res.status >= 500) {
      data.reason = data.reason || "server_error";
      data.message =
        (data.message || "The licensing server hit an internal error.") +
        (data.ref ? ` (ref ${data.ref})` : "");
      return { transportError: false, retryable: true, data };
    }
    // A real 400/403 answer is the truth — never retried, never disguised.
    return { transportError: false, retryable: false, data };
  }

  async function post(path, body) {
    const url = api(path);
    if (!url) return { networkError: false, data: { ok: false, reason: "no_build_config" } };

    let attempt = await postOnce(url, body);
    if (attempt.retryable) {
      console.warn("[PowerKits] licensing call failed, retrying:", attempt.data);
      await sleep(1200);
      attempt = await postOnce(url, body);
    }
    if (attempt.retryable) {
      const alt = altApi(path);
      if (alt) {
        console.warn("[PowerKits] falling back to", alt);
        const viaFallback = await postOnce(alt, body);
        if (!viaFallback.retryable) attempt = viaFallback;
        else attempt = viaFallback;
      }
    }
    if (attempt.retryable) console.error("[PowerKits] licensing call failed:", attempt.data);
    return { networkError: attempt.transportError, data: attempt.data };
  }

  function storeSession(data) {
    const now = Math.floor(Date.now() / 1000);
    const lic = data.license || {};
    const token = {
      token: data.token,
      expires_at: now + (data.ttl || 300),
      ttl: data.ttl || 300,
      license: lic,
      cached_at: Date.now(),
    };
    return saveToken(token).then(() =>
      set({
        ql_license_valid: true,
        ql_license_status: "active",
        ql_expires_at: lic.expires_at || null,
        ql_blocked_reason: null,
        ql_blocked_message: null,
      }),
    ).then(() => storeMethodsPolicy(data.methods).catch(() => { })).then(() => token);
  }

  function storeMethodsPolicy(methods) {
    if (!methods || typeof methods !== "object") return Promise.resolve();
    const enabledIn = methods.enabled && typeof methods.enabled === "object" ? methods.enabled : {};
    const enabled = {
      v6: enabledIn.v6 !== false,
      v5: enabledIn.v5 !== false,
      v7: enabledIn.v7 !== false,
    };
    if (!enabled.v6 && !enabled.v5 && !enabled.v7) enabled.v6 = true;
    let defaultMethod = String(methods.defaultMethod || "v6").toLowerCase();
    if (defaultMethod !== "v5" && defaultMethod !== "v6" && defaultMethod !== "v7") defaultMethod = "v6";
    if (!enabled[defaultMethod]) {
      defaultMethod = enabled.v6 ? "v6" : enabled.v5 ? "v5" : "v7";
    }
    const capRaw = Number(methods.rateLimitPerHour);
    const policy = {
      enabled,
      defaultMethod,
      rotationEnabled: methods.rotationEnabled === true,
      rateLimitPerHour:
        Number.isFinite(capRaw) && capRaw > 0 ? Math.min(100000, Math.trunc(capRaw)) : 0,
    };
    return chrome.storage.local.get(["ql_send_method"]).then((stored) => {
      let method = String(stored.ql_send_method || defaultMethod).trim().toLowerCase();
      if (method === "7" || method === "method3" || method === "3" || method === "v7") method = "v7";
      else if (method === "5" || method === "method2" || method === "2" || method === "v5") method = "v5";
      else method = method === "v6" || method === "6" || method === "method1" || method === "1" ? "v6" : defaultMethod;
      if (!enabled[method]) method = defaultMethod;
      return set({ ql_methods_policy: policy, ql_send_method: method });
    });
  }

  /** Exchange a license key for a fresh session (first activation / re-activation). */
  async function activate(licenseKey) {
    const c = cfg();
    const deviceId = await getDeviceId();
    const { networkError, data } = await post("/api/public/ext/activate", {
      licenseKey: String(licenseKey || "").trim().toUpperCase(),
      deviceId,
      buildId: c && c.build_id,
      label: getDeviceLabel(),
      userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || null,
    });

    if (networkError) {
      const reason = data.reason || "network";
      await saveLastResult({ ok: false, reason, message: data.message });
      return {
        ok: false,
        reason,
        message: data.message || "Could not reach the licensing server.",
      };
    }
    if (!data.ok) {
      await saveLastResult({ ok: false, reason: data.reason, message: data.message });
      if (FATAL_REASONS.has(data.reason)) await applyFatalBlock(data.reason, data.message);
      return { ok: false, reason: data.reason, message: data.message };
    }

    await set({ ql_license_key: String(licenseKey).trim().toUpperCase() });
    const token = await storeSession(data);
    await saveLastResult({ ok: true });
    // A manual activation revives the heartbeat loop that a definitive denial
    // had stopped.
    try {
      schedule(HEARTBEAT_MS);
    } catch (e) { }
    return { ok: true, token, license: data.license };
  }

  /** Re-validate the current session against the server. */
  async function heartbeat() {
    if (_inFlight) return _inFlight;
    _inFlight = (async () => {
      const c = cfg();
      const existing = await readToken();
      const deviceId = await getDeviceId();

      // No session yet — try to re-establish it from the saved key.
      if (!existing || !existing.token) {
        const key = await getLicenseKey();
        if (!key) return { ok: false, reason: "no_license" };
        return activate(key);
      }

      const { networkError, data } = await post("/api/public/ext/handshake", {
        token: existing.token,
        deviceId,
        buildId: c && c.build_id,
      });

      if (networkError) {
        // Offline: keep running only while inside the grace window.
        if (isTokenValid(existing) || isTokenInGrace(existing)) {
          return { ok: true, token: existing, offline: true };
        }
        await applyLicenseLogout("network", "Could not reach the licensing server.");
        return { ok: false, reason: "network" };
      }

      if (!data.ok) {
        await saveLastResult({ ok: false, reason: data.reason, message: data.message });
        if (FATAL_REASONS.has(data.reason)) {
          await applyFatalBlock(data.reason, data.message);
        } else if (LOGOUT_REASONS.has(data.reason)) {
          // The token is dead. If we still hold the key, one retry through
          // activate() covers "device was reset by an admin".
          const key = await getLicenseKey();
          if (key && data.reason === "device_mismatch") {
            const retry = await activate(key);
            if (retry.ok) return retry;
          }
          await applyLicenseLogout(data.reason, data.message);
        }
        return { ok: false, reason: data.reason, message: data.message };
      }

      const token = await storeSession(data);
      await saveLastResult({ ok: true });
      await storeNotice(data.notice || null);
      return { ok: true, token, license: data.license };
    })();

    try {
      return await _inFlight;
    } finally {
      _inFlight = null;
    }
  }

  async function ensureToken() {
    const existing = await readToken();
    if (isTokenValid(existing)) return { ok: true, token: existing };
    return heartbeat();
  }

  // A definitive answer (bad key, device limit, expired, revoked…) will not
  // change by asking again every few minutes: that loop is what buries the
  // server in thousands of identical failures. Stop, and wait for a manual retry.
  const STOP_REASONS = new Set([
    "no_license",
    "invalid_license",
    "license_expired",
    "license_disabled",
    "license_revoked",
    "license_deleted",
    "device_limit",
    "build_revoked",
    "unknown_build",
    "no_build_config",
  ]);

  function nextDelay(res) {
    if (res && res.ok) return HEARTBEAT_MS;
    if (res && STOP_REASONS.has(res.reason)) return null;
    return RETRY_MS;
  }

  function schedule(ms) {
    if (ms === null) return; // definitive denial: nothing to poll for
    // MV3 suspends the service worker after ~30s idle, which kills setTimeout
    // chains. chrome.alarms survives suspension, so it drives the heartbeat and
    // the timer is only a same-session backup.
    try {
      if (chrome.alarms && chrome.alarms.create) {
        chrome.alarms.create(ALARM_NAME, { when: Date.now() + Math.max(30 * 1000, ms) });
        return;
      }
    } catch (e) { }
    setTimeout(async () => {
      let next = HEARTBEAT_MS;
      try {
        next = nextDelay(await heartbeat());
      } catch (e) {
        next = RETRY_MS;
      }
      schedule(next);
    }, ms);
  }

  function startBackgroundLoop() {
    if (_loopStarted) return;
    _loopStarted = true;
    heartbeat().catch(() => { });
    schedule(HEARTBEAT_MS);
  }

  try {
    if (chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (!alarm || alarm.name !== ALARM_NAME) return;
        let next = HEARTBEAT_MS;
        try {
          next = nextDelay(await heartbeat());
        } catch (e) {
          next = RETRY_MS;
        }
        schedule(next);
      });
    }
  } catch (e) { }

  self.PowerKitsGate = {
    activate,
    heartbeat,
    ensureToken,
    performHandshake: heartbeat,
    readToken,
    readNotice,
    isTokenValid,
    startBackgroundLoop,
    getDeviceId,
  };
  // Back-compat alias for older call sites.
  self.LovaSiriHandshake = self.PowerKitsGate;
})();

try {
  if (self.LovaSiriHandshake && typeof self.LovaSiriHandshake.startBackgroundLoop === "function") {
    self.LovaSiriHandshake.startBackgroundLoop();
  }
} catch (e) {
  console.error("[Background] loop:", e && e.message);
}

// Lista de actions que exigem token válido para serem executadas.
// Sem handshake aprovado pelo servidor, essas ações são recusadas.
const PROTECTED_ACTIONS = new Set([
  "lovableApiFetch",
  "createLovableProjectInPage",
  "proxyFetch",
  "downloadProject",
  "readCookies",
  "lovableSync",
  "activateSidebar",
  "deactivateSidebar",
  "openSidePanel",
  "pkMethodSend",
  "pkOptimizePrompt",
]);

const PK_OPTIMIZE_SYSTEM_PROMPT = [
  "You are a careful prompt editor for Lovable (an AI web-app builder).",
  "Your job is to make the user's instruction clearer for Lovable - not to redesign their request.",
  "",
  "Hard rules:",
  "1) Preserve the user's exact intent, scope, and action verb (verify/check vs fix/implement vs add vs refactor vs explain).",
  "2) Preserve the user's language (English, Portuguese, Spanish, etc.).",
  "3) Do NOT invent file paths, CSS selectors, component names, APIs, libraries, routes, or features the user did not mention.",
  "4) Do NOT expand into a bigger project. Prefer light clarification over creative rewriting.",
  "5) If the original is already clear, only polish wording slightly.",
  "6) Keep it concise: usually 2-6 short sentences (or a short bullet list when steps help).",
  "7) When helpful and clearly implied, add: goal, constraints, acceptance criteria, and what not to change.",
  "8) Prefer generic wording (global stylesheet, the badge, the login form) over guessed IDs/classes.",
  "",
  "Return ONLY the rewritten prompt text. No preamble, no explanations, no markdown fences.",
].join(" ");

function pkCleanOptimizedPrompt(text) {
  var out = String(text || "").trim();
  if (!out) return "";
  // Strip accidental markdown fences from some models.
  out = out.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Drop a leading label like "Optimized prompt:" if the model adds one.
  out = out.replace(/^(optimized\s*prompt|rewritten\s*prompt|here(?:'s| is) (?:an? )?(?:optimized|improved) prompt)\s*:\s*/i, "").trim();
  return out;
}

async function pkOptimizeWithOpenAI(apiKey, prompt) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.25,
      messages: [
        { role: "system", content: PK_OPTIMIZE_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) { }
  if (!resp.ok) {
    const detail = String((data && data.error && data.error.message) || text || "").slice(0, 200);
    const status = resp.status;
    if (status === 401 || status === 403) return { ok: false, error: "invalid_key", detail: detail };
    if (status === 429) return { ok: false, error: "quota", detail: detail };
    return { ok: false, error: "provider_http_" + status, detail: detail };
  }
  const optimized = pkCleanOptimizedPrompt(
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "",
  );
  if (!optimized) return { ok: false, error: "empty_completion" };
  return { ok: true, optimized_prompt: optimized };
}

async function pkOptimizeWithGoogle(apiKey, prompt) {
  // gemini-2.0-flash was shut down (404). Prefer stable Flash aliases + fallbacks.
  const models = [
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-1.5-flash",
  ];
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: PK_OPTIMIZE_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.25 },
  });
  let lastFail = { ok: false, error: "optimize_failed" };

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: body,
      });
    } catch (err) {
      lastFail = { ok: false, error: "network", detail: (err && err.message) || "" };
      continue;
    }
    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) { }
    if (!resp.ok) {
      const detail = String(
        (data && data.error && data.error.message) || text || "",
      ).slice(0, 200);
      const status = resp.status;
      if (status === 400 && /API key|invalid|PERMISSION|API_KEY/i.test(detail)) {
        return { ok: false, error: "invalid_key", detail: detail };
      }
      if (status === 401 || status === 403) return { ok: false, error: "invalid_key", detail: detail };
      if (status === 429) return { ok: false, error: "quota", detail: detail };
      // Model gone / not found — try next candidate.
      if (status === 404) {
        lastFail = { ok: false, error: "model_unavailable", detail: detail };
        continue;
      }
      lastFail = { ok: false, error: "provider_http_" + status, detail: detail };
      continue;
    }
    const parts =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts;
    const optimized = pkCleanOptimizedPrompt(
      Array.isArray(parts)
        ? parts
          .map(function (p) {
            return (p && p.text) || "";
          })
          .join("")
        : "",
    );
    if (!optimized) {
      lastFail = { ok: false, error: "empty_completion" };
      continue;
    }
    return { ok: true, optimized_prompt: optimized };
  }
  return lastFail;
}

// Cache síncrono do status do token. Atualizado pelo loop de handshake.
self.__lovasiriGateOk = false;

async function refreshGateStatus() {
  try {
    if (!self.LovaSiriHandshake) {
      self.__lovasiriGateOk = false;
      return false;
    }
    const token = await self.LovaSiriHandshake.readToken();
    const ok = self.LovaSiriHandshake.isTokenValid(token);
    self.__lovasiriGateOk = !!ok;
    return self.__lovasiriGateOk;
  } catch (e) {
    self.__lovasiriGateOk = false;
    return false;
  }
}

// Atualiza cache rapidamente; o token também expira se não for revalidado em ~15s.
setInterval(refreshGateStatus, 5 * 1000);
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ql_handshake_token) refreshGateStatus();
  });
} catch (e) { }
refreshGateStatus();

// On install: open Lovable.dev and show the activation modal automatically
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Explicitly set ql_sidebar_mode: false on first install so the
    // "Voltar à Extensão" button stays hidden in the default floating mode.
    chrome.storage.local.set({ ql_show_activation: true, ql_native_chat: false, ql_sidebar_mode: false }, () => {
      chrome.tabs.create({ url: "https://lovable.dev/" });
    });
  }
});

// Initialize sidebar mode preference
chrome.storage.local.get(["ql_sidebar_mode"], (res) => {
  const sidebarMode = res.ql_sidebar_mode || false;
  chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebarMode }).catch(() => { });
  console.log("[Background] Sidebar mode:", sidebarMode);
});

// Listen for storage changes to update panel behavior
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ql_sidebar_mode) {
    const sidebarMode = changes.ql_sidebar_mode.newValue || false;
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebarMode }).catch(() => { });
    console.log("[Background] Sidebar mode updated:", sidebarMode);
  }
});

// Handle action click (icon click) — this IS a user gesture, so sidePanel.open() works here
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const res = await chrome.storage.local.get(["ql_sidebar_mode"]);
    if (res.ql_sidebar_mode) {
      (await chrome.sidePanel) && chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (err) {
    console.error("[Background] action.onClicked sidePanel error:", err);
  }
});

function isLovableTabUrl(url) {
  return /^https:\/\/([^/]+\.)?lovable\.dev\//.test(url || "");
}

function isLicenseActivationProxyFetch(msg) {
  // Activation now goes through the "pkActivate" message, which is never gated.
  return false;
}

async function fetchShellFromServer() {
  try {
    const gate = await self.PowerKitsGate.ensureToken();
    if (!gate || !gate.ok || !gate.token || !gate.token.token) {
      return { ok: false, reason: (gate && gate.reason) || "not_authorized" };
    }
    const now = Date.now();
    if (
      self.__pkShellCache &&
      self.__pkShellCache.ok &&
      self.__pkShellCache.pageHook &&
      self.__pkShellCache.payload &&
      now - self.__pkShellCache.at < 10 * 60 * 1000
    ) {
      return {
        ok: true,
        pageHook: self.__pkShellCache.pageHook,
        payload: self.__pkShellCache.payload,
        cached: true,
      };
    }
    const cfg = self.__PK_BUILD__ || {};
    const deviceId = await self.PowerKitsGate.getDeviceId();
    const apiBase = String(cfg.api_url || "https://powerkit-extention.onrender.com").replace(/\/+$/, "");
    const res = await fetch(apiBase + "/api/public/ext/shell", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: gate.token.token, deviceId }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || !payload.ok || !payload.pageHook || !payload.payload) {
      return { ok: false, reason: (payload && payload.reason) || "shell_denied", status: res.status };
    }
    self.__pkShellCache = {
      ok: true,
      pageHook: payload.pageHook,
      payload: payload.payload,
      at: now,
    };
    return { ok: true, pageHook: payload.pageHook, payload: payload.payload, cached: false };
  } catch (e) {
    return { ok: false, reason: "exception", message: String(e && e.message) };
  }
}

/**
 * CSP-safe injection: chrome.scripting.executeScript bypasses page CSP.
 * Do NOT inject gated shell via <script textContent> from content.js — Lovable blocks it.
 */
async function injectGatedShell(tabId, opts) {
  opts = opts || {};
  if (!tabId) return { ok: false, reason: "no_tab" };
  try {
    const shell = await fetchShellFromServer();
    if (!shell.ok || !shell.pageHook || !shell.payload) {
      return { ok: false, reason: (shell && shell.reason) || "shell_denied" };
    }
    const extBase = chrome.runtime.getURL("");
    const fromActivation = !!opts.fromActivation;

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: (code, base) => {
        try {
          if (window.__PK_PAGEHOOK__) return;
          window.__PK_PAGEHOOK__ = 1;
          try {
            window.__PK_EXT_BASE__ = base;
          } catch (_) { }
          (0, eval)(code);
        } catch (e) {
          console.warn("[PowerKits] pageHook eval failed", e && e.message);
        }
      },
      args: [shell.pageHook, extBase],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: (code, base, fromAct) => {
        try {
          if (window.__PK_PAYLOAD__) return;
          window.__PK_PAYLOAD__ = 1;
          try {
            window.__PK_EXT_BASE__ = base;
          } catch (_) { }
          if (fromAct) {
            try {
              window.__qlActivationJustHappened = true;
            } catch (_) { }
          }
          (0, eval)(code);
        } catch (e) {
          console.warn("[PowerKits] payload eval failed", e && e.message);
        }
      },
      args: [shell.payload, extBase, fromActivation],
    });

    console.log("[Background] gated shell injected", tabId, fromActivation ? "(post-activate)" : "");
    return { ok: true, cached: !!shell.cached };
  } catch (err) {
    console.warn("[Background] injectGatedShell failed:", err && err.message);
    return { ok: false, reason: "inject_failed", message: String(err && err.message) };
  }
}

// Shell (pageHook + payload) ships in the zip and is injected via content_scripts /
// chrome.runtime.getURL. Do NOT auto-eval remote shell into tabs — Lovable page CSP
// blocks eval in MAIN world, and early inject races the content bridge.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "ping") {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  // Status do gate (sidepanel usa pra mostrar tela de bloqueio sem ficar adivinhando)
  if (msg && msg.action === "handshakeStatus") {
    (async () => {
      const ok = await refreshGateStatus();
      const cfg = self.__PK_BUILD__ || null;
      const token = self.LovaSiriHandshake ? await self.LovaSiriHandshake.readToken() : null;
      sendResponse({
        ok,
        build_id: cfg && cfg.build_id,
        version: cfg && cfg.version,
        expires_at: token && token.expires_at,
      });
    })();
    return true;
  }

  // Força um novo handshake (sidepanel chama no boot ou após inserir license)
  if (msg && msg.action === "handshakeRefresh") {
    (async () => {
      try {
        const res = self.LovaSiriHandshake
          ? await self.LovaSiriHandshake.performHandshake()
          : { ok: false, reason: "no_handshake" };
        await refreshGateStatus();
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // License activation from the in-page shell.
  if (msg && msg.action === "pkActivate") {
    (async () => {
      try {
        self.__pkShellCache = null;
        const res = await self.PowerKitsGate.activate(msg.licenseKey);
        await refreshGateStatus();
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // The injected shell must use the background's canonical installation ID.
  if (msg && msg.action === "pkGetDeviceId") {
    // (see pkGetNotice below for release notifications)
    self.PowerKitsGate.getDeviceId().then(
      (deviceId) => sendResponse({ ok: true, deviceId }),
      (e) => sendResponse({ ok: false, message: String(e && e.message) }),
    );
    return true;
  }

  // Release / broadcast notice for this install. Only ever populated by a
  // successful handshake, so an invalid licence never receives one.
  if (msg && msg.action === "pkGetNotice") {
    (async () => {
      try {
        const cfg = self.__PK_BUILD__ || null;
        const notice = await self.PowerKitsGate.readNotice();
        sendResponse({ ok: true, notice: null, version: cfg && cfg.version });
      } catch (e) {
        sendResponse({ ok: false, notice: null });
      }
    })();
    return true;
  }

  // Lightweight liveness check for the in-page watchdog. Renews the injected
  // bundle's session stamp while the license is good, and reports the exact
  // deny reason the moment it is not.
  if (msg && msg.action === "pkGateCheck") {
    (async () => {
      try {
        const gate = await self.PowerKitsGate.ensureToken();
        if (gate && gate.ok && gate.token && gate.token.token) {
          const now = Math.floor(Date.now() / 1000);
          const ttl = Math.max(60, (gate.token.expires_at || now + 600) - now);
          sendResponse({ ok: true, ttl, offline: !!gate.offline });
          return;
        }
        sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // pageHook may probe whether a live licensed session exists.
  // Prefer the local signed token (ensureToken). Gated server routes still
  // re-verify on rewrite/bundle/send — do not handshake on every probe.
  if (msg && msg.action === "pkAllowCreditFree") {
    (async () => {
      try {
        const now = Date.now();
        if (
          self.__pkCreditFreeCache &&
          typeof self.__pkCreditFreeCache.ok === "boolean" &&
          now - self.__pkCreditFreeCache.at < 5 * 60 * 1000
        ) {
          sendResponse({ ok: !!self.__pkCreditFreeCache.ok, cached: true });
          return;
        }
        const gate = await self.PowerKitsGate.ensureToken();
        const ok = !!(gate && gate.ok && gate.token && gate.token.token);
        self.__pkCreditFreeCache = { ok, at: now };
        sendResponse({ ok, reason: ok ? undefined : (gate && gate.reason) || "not_authorized" });
      } catch (e) {
        self.__pkCreditFreeCache = { ok: false, at: Date.now() };
        sendResponse({ ok: false, reason: "exception" });
      }
    })();
    return true;
  }

  // Server-side credit-free rewrite for native Lovable /chat posts.
  // Recipe never runs in the page — only a licensed session gets a rewritten body.
  if (msg && msg.action === "pkRewriteChat") {
    (async () => {
      try {
        const chatBody = typeof msg.chatBody === "string" ? msg.chatBody : "";
        if (!chatBody.trim()) {
          sendResponse({ ok: false, reason: "empty_body", passthrough: true });
          return;
        }
        let gate = await self.PowerKitsGate.ensureToken();
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          gate = await self.PowerKitsGate.heartbeat();
        }
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
          return;
        }
        const cfg = self.__PK_BUILD__ || {};
        const deviceId = await self.PowerKitsGate.getDeviceId();
        const apiBase = String(cfg.api_url || "https://powerkit-extention.onrender.com").replace(/\/+$/, "");
        const res = await fetch(apiBase + "/api/public/ext/rewrite-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: gate.token.token,
            deviceId,
            chatBody,
            method: msg.method || "v5",
            nativeChatActive: msg.nativeChatActive !== false,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 403 || (data && data.reason === "unauthorized")) {
          try {
            await chrome.storage.local.remove(["ql_handshake_token"]);
          } catch (_) { }
          self.__pkCreditFreeCache = { ok: false, at: Date.now() };
          sendResponse({ ok: false, reason: "unauthorized" });
          return;
        }
        if (!data || !data.ok || !data.body) {
          sendResponse({
            ok: false,
            reason: (data && data.reason) || "rewrite_denied",
            passthrough: !!(data && data.passthrough),
            status: res.status,
          });
          return;
        }
        sendResponse({
          ok: true,
          body: data.body,
          intent: data.intent,
          method: data.method,
          human: data.human,
        });
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // Gated pageHook + payload (not shipped in the installer zip).
  if (msg && msg.action === "pkFetchShell") {
    (async () => {
      const shell = await fetchShellFromServer();
      sendResponse(shell);
    })();
    return true;
  }

  // Content asks SW to inject shell CSP-safely into the active Lovable tab.
  if (msg && msg.action === "pkInjectShell") {
    (async () => {
      try {
        const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId || null;
        if (!tabId) {
          sendResponse({ ok: false, reason: "no_tab" });
          return;
        }
        const result = await injectGatedShell(tabId, { fromActivation: !!msg.fromActivation });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // Gated delivery of the feature bundle. The code never lives in the zip —
  // the server only returns it for a device holding a valid session.
  if (msg && msg.action === "pkFetchCore") {
    (async () => {
      try {
        const gate = await self.PowerKitsGate.ensureToken();
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
          return;
        }
        const cfg = self.__PK_BUILD__ || {};
        const deviceId = await self.PowerKitsGate.getDeviceId();
        // NOTE: storage helper `get()` lives inside the gate IIFE — do not call it here.
        let locale = "en";
        try {
          const stored = await chrome.storage.local.get(["pk_ui_locale"]);
          locale = String((stored && stored.pk_ui_locale) || "en")
            .toLowerCase()
            .slice(0, 2);
        } catch (_) { }
        const apiBase = String(cfg.api_url || "https://powerkit-extention.onrender.com").replace(/\/+$/, "");
        // Prefer returning credentials so the page can fetch the large bundle
        // directly (avoids MV3 message-size / port-closed failures). Keep a
        // background fallback for older shells.
        if (msg && msg.direct !== false) {
          sendResponse({
            ok: true,
            mode: "direct",
            token: gate.token.token,
            deviceId,
            locale: locale === "es" || locale === "pt" || locale === "de" ? locale : "en",
            url: apiBase + "/api/public/ext/bundle",
          });
          return;
        }
        const res = await fetch(apiBase + "/api/public/ext/bundle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: gate.token.token,
            deviceId,
            locale: locale === "es" || locale === "pt" || locale === "de" ? locale : "en",
          }),
        });
        if (!res.ok) {
          sendResponse({ ok: false, reason: "bundle_denied", status: res.status });
          return;
        }
        const payload = await res.json();
        if (!payload || !payload.ok) {
          sendResponse({ ok: false, reason: (payload && payload.reason) || "bundle_unavailable" });
          return;
        }
        sendResponse({ ok: true, code: payload.js, css: payload.css || "" });
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // Gate em tempo real: toda ação sensível força handshake se o token não foi renovado agora.
  // Mirrors a chat attachment into our own storage so the model gets a URL it
  // can actually fetch. Lovable's upload handshake only yields a write-only
  // signed URL, which is unreadable for the AI.
  if (msg && msg.action === "pkMirrorAttachment") {
    (async () => {
      try {
        const gate = await self.PowerKitsGate.ensureToken();
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
          return;
        }
        const cfg = self.__PK_BUILD__ || {};
        const deviceId = await self.PowerKitsGate.getDeviceId();
        const res = await fetch(String(cfg.api_url).replace(/\/+$/, "") + "/api/public/ext/attachment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: gate.token.token,
            deviceId,
            name: msg.name || "file",
            mime: msg.mime || null,
            data: msg.data || "",
          }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload || !payload.ok) {
          sendResponse({ ok: false, reason: (payload && payload.reason) || "mirror_failed" });
          return;
        }
        sendResponse({ ok: true, url: payload.url, name: payload.name, mime: payload.mime });
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  if (msg && msg.action && PROTECTED_ACTIONS.has(msg.action) && !isLicenseActivationProxyFetch(msg)) {
    return authorizeAndHandleMessage(msg, sender, sendResponse);
  }

  return handleAuthorizedMessage(msg, sender, sendResponse);
});

function authorizeAndHandleMessage(msg, sender, sendResponse) {
  (async () => {
    let ok = await refreshGateStatus();
    if (!ok && self.LovaSiriHandshake) {
      const res = await self.LovaSiriHandshake.performHandshake();
      ok = !!(res && res.ok);
      await refreshGateStatus();
    }
    if (!ok) {
      sendResponse({
        ok: false,
        status: 403,
        data: {
          error: "extension_not_authorized",
          message: "This copy of the extension is not authorized. Download the official version from your dashboard.",
        },
      });
      return;
    }
    handleAuthorizedMessage(msg, sender, sendResponse);
  })();
  return true;
}

async function getLovableTab(preferredTab) {
  if (preferredTab && preferredTab.id && isLovableTabUrl(preferredTab.url)) return preferredTab;
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTabs && activeTabs[0] && isLovableTabUrl(activeTabs[0].url)) return activeTabs[0];
  const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
  return (lovableTabs && lovableTabs[0]) || null;
}

function normalizeLovableSourceFiles(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.files,
    payload.data && payload.data.files,
    payload.source_code && payload.source_code.files,
    payload.sourceCode && payload.sourceCode.files,
    payload.project && payload.project.files,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      return list
        .map((file) => {
          if (!file || typeof file !== "object") return file;
          const name = file.name || file.path || file.file_path || file.filename || file.fileName;
          const content = file.content != null ? file.content : file.source != null ? file.source : file.text;
          return Object.assign({}, file, name ? { name } : {}, content != null ? { content } : {});
        })
        .filter((file) => file && (typeof file === "string" || file.name || file.path));
    }
  }
  return [];
}

function normalizeLovasiriBearerToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function addLovasiriTokenCandidate(list, seen, token, source) {
  const clean = normalizeLovasiriBearerToken(token);
  if (!clean || seen.has(clean)) return;
  seen.add(clean);
  list.push({ token: clean, source: source || "token" });
}

function buildLovasiriTokenCandidates() {
  const seen = new Set();
  const list = [];
  for (let i = 0; i < arguments.length; i++) addLovasiriTokenCandidate(list, seen, arguments[i], "background");
  list.push({ token: "", source: "cookie-only" });
  return list;
}

async function fetchLovableSourceDirect(projectId, token) {
  const cleanProjectId = encodeURIComponent(String(projectId || "").trim());
  const tokenCandidates = buildLovasiriTokenCandidates(token);
  const urls = [
    "https://lovable-api.com/projects/" + cleanProjectId + "/source-code",
    "https://api.lovable.dev/projects/" + cleanProjectId + "/source-code",
  ];
  let last = null;
  for (const url of urls) {
    for (const candidate of tokenCandidates) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(candidate.token ? { Authorization: "Bearer " + candidate.token } : {}),
          },
        });
        const text = await resp.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { raw: text };
        }
        const files = normalizeLovableSourceFiles(data);
        last = { ok: resp.ok, status: resp.status, data, files, tokenSource: candidate.source };
        if (resp.ok && files.length)
          return { success: true, ok: true, files, status: resp.status, source: url, tokenSource: candidate.source };
        if (resp.ok)
          return {
            success: false,
            ok: false,
            error: "No files found in the project.",
            status: resp.status,
            details: data,
          };
        if (resp.status !== 401 && resp.status !== 403) break;
      } catch (err) {
        last = { ok: false, status: 0, data: { error: (err && err.message) || "failed to fetch" }, files: [] };
      }
    }
  }
  const reason = last && last.data && (last.data.message || last.data.error || last.data.raw);
  return {
    success: false,
    ok: false,
    error: reason || "Download falhou",
    status: (last && last.status) || 0,
    details: last && last.data,
  };
}

async function fetchLovableSourceViaPage(projectId, token, preferredTab) {
  const tab = await getLovableTab(preferredTab);
  if (!tab || !tab.id)
    return { success: false, ok: false, status: 0, error: "Abra uma aba do Lovable antes de baixar." };
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    /* javascript-obfuscator:disable */
    func: async ({ projectId, token }) => {
      const normalizeFiles = (payload) => {
        if (!payload || typeof payload !== "object") return [];
        const candidates = [
          payload.files,
          payload.data && payload.data.files,
          payload.source_code && payload.source_code.files,
          payload.sourceCode && payload.sourceCode.files,
          payload.project && payload.project.files,
        ];
        for (const list of candidates) {
          if (Array.isArray(list)) {
            return list
              .map((file) => {
                if (!file || typeof file !== "object") return file;
                const name = file.name || file.path || file.file_path || file.filename || file.fileName;
                const content = file.content != null ? file.content : file.source != null ? file.source : file.text;
                return Object.assign({}, file, name ? { name } : {}, content != null ? { content } : {});
              })
              .filter((file) => file && (typeof file === "string" || file.name || file.path));
          }
        }
        return [];
      };

      const addCandidate = (list, seen, raw, source) => {
        const clean = String(raw || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        list.push({ token: clean, source: source || "token" });
      };

      const collectTokenCandidates = () => {
        const seen = new Set();
        const list = [];
        // 1) token vivo passado pelo core/background (capturado pelo pageHook)
        addCandidate(list, seen, token, "captured");
        // 2) globals expostos no MAIN world
        try {
          addCandidate(list, seen, window.__lovasiriLovableToken, "window.__lovasiriLovableToken");
          addCandidate(list, seen, window.__lovableAuthToken, "window.__lovableAuthToken");
          addCandidate(list, seen, window.__LOVABLE_AUTH_TOKEN__, "window.__LOVABLE_AUTH_TOKEN__");
        } catch (e) { }
        // 3) Firebase como fallback final autenticado.
        // Nunca usar sb-*-auth-token aqui: /source-code da Lovable rejeita JWT Supabase
        // com "Invalid token" / "authorization header required" e impede o cookie-only.
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || "";
            const raw = localStorage.getItem(key) || "";
            if (/firebase:authUser|authUser/i.test(key)) {
              try {
                const parsed = JSON.parse(raw);
                const user = parsed && parsed.value && typeof parsed.value === "object" ? parsed.value : parsed;
                const manager = user && (user.stsTokenManager || user.tokenManager || {});
                const fbToken = manager.accessToken || user.accessToken;
                addCandidate(list, seen, fbToken, "firebase");
              } catch (e) { }
            }
          }
        } catch (e) { }
        // 4) fallback cookie-only
        list.push({ token: "", source: "cookie-only" });
        return list;
      };

      const cleanProjectId = encodeURIComponent(String(projectId || "").trim());
      const tokenCandidates = collectTokenCandidates();
      const urls = [
        "https://api.lovable.dev/projects/" + cleanProjectId + "/source-code",
        "https://lovable-api.com/projects/" + cleanProjectId + "/source-code",
      ];
      let last = null;
      for (const url of urls) {
        for (const candidate of tokenCandidates) {
          try {
            const resp = await fetch(url, {
              method: "GET",
              cache: "no-store",
              credentials: "include",
              headers: {
                Accept: "application/json",
                ...(candidate.token ? { Authorization: "Bearer " + candidate.token } : {}),
              },
            });
            const text = await resp.text();
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = { raw: text };
            }
            const files = normalizeFiles(data);
            last = { ok: resp.ok, status: resp.status, data, files, tokenSource: candidate.source };
            if (resp.ok && files.length)
              return {
                success: true,
                ok: true,
                files,
                status: resp.status,
                source: url,
                tokenSource: candidate.source,
              };
            if (resp.ok)
              return {
                success: false,
                ok: false,
                error: "No files found in the project.",
                status: resp.status,
                details: data,
              };
            // Se 401/403, tenta o próximo token candidato automaticamente.
            if (resp.status !== 401 && resp.status !== 403) break;
          } catch (err) {
            last = { ok: false, status: 0, data: { error: (err && err.message) || "failed to fetch" }, files: [] };
          }
        }
      }
      const reason = last && last.data && (last.data.message || last.data.error || last.data.raw);
      return {
        success: false,
        ok: false,
        error: reason || "Download falhou",
        status: (last && last.status) || 0,
        details: last && last.data,
      };
    },
    /* javascript-obfuscator:enable */
    args: [{ projectId, token }],
  });
  return (
    (results && results[0] && results[0].result) || {
      success: false,
      ok: false,
      status: 0,
      error: "no response from the Lovable page",
    }
  );
}

function handleAuthorizedMessage(msg, sender, sendResponse) {
  if (msg && msg.action === "lovableSync") {
    const updates = {};
    if (msg.token) updates.lovable_token = msg.token;
    if (msg.projectId) updates.lovable_projectId = msg.projectId;
    if (Object.keys(updates).length) {
      chrome.storage.local.set(updates, () => {
        console.log("[Background] saved:", Object.keys(updates).join(", "));
      });
    }
  }

  // Shell credit-free Method send (pageHook blocked Lovable's native /chat).
  if (msg && msg.action === "pkMethodSend") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get([
          "lovable_token",
          "lovable_projectId",
          "ql_license_key",
          "ql_session_id",
          "ql_send_method",
          "ql_methods_policy",
          "ql_license_valid",
        ]);
        if (!stored || stored.ql_license_valid !== true) {
          sendResponse({ ok: false, reason: "license_invalid" });
          return;
        }
        const token = String(msg.token || stored.lovable_token || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        const projectId = String(msg.projectId || stored.lovable_projectId || "").trim();
        const text = String(msg.text || "").trim();
        let method = String(msg.method || stored.ql_send_method || "v6")
          .trim()
          .toLowerCase();
        if (method === "6" || method === "method1" || method === "1" || method === "v10" || method === "10" || method === "method6") method = "v6";
        else if (method === "7" || method === "method3" || method === "3" || method === "v7") method = "v7";
        else if (method === "5" || method === "method2" || method === "2" || method === "v8" || method === "8" || method === "method4" || method === "4" || method === "v9" || method === "9" || method === "method5" || method === "v11" || method === "11" || method === "method7") method = "v5";
        const allowed = { v5: 1, v6: 1, v7: 1 };
        if (!allowed[method]) method = "v6";
        const policy = stored.ql_methods_policy && typeof stored.ql_methods_policy === "object" ? stored.ql_methods_policy : null;
        if (policy && policy.enabled) {
          const en = policy.enabled;
          const def = policy.defaultMethod === "v5" || policy.defaultMethod === "v7" ? policy.defaultMethod : "v6";
          if (en[method] === false) method = en[def] !== false ? def : (en.v6 !== false ? "v6" : en.v5 !== false ? "v5" : "v7");
        }

        if (!token) {
          sendResponse({ ok: false, reason: "missing_token", error: "Open a Lovable project so the token can sync." });
          return;
        }
        if (!/^[0-9a-fA-F-]{36}$/.test(projectId)) {
          sendResponse({ ok: false, reason: "missing_project", error: "Open a Lovable project tab first." });
          return;
        }
        if (!text) {
          sendResponse({ ok: false, reason: "empty_prompt", error: "Empty prompt." });
          return;
        }

        const intentByMethod = {
          v5: "security_scan",
          v6: "fix_error",
          v7: "fix_error",
        };
        const intent = intentByMethod[method] || "fix_error";
        const build = self.__PK_BUILD__ || {};
        const apiBase = String(build.api_url || "").replace(/\/+$/, "");
        if (!apiBase || apiBase.indexOf("__API") !== -1) {
          sendResponse({ ok: false, reason: "bad_api_url", error: "Extension API origin is not stamped." });
          return;
        }
        let gate = await self.PowerKitsGate.ensureToken();
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          gate = await self.PowerKitsGate.heartbeat();
        }
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
          return;
        }
        const deviceId = await self.PowerKitsGate.getDeviceId();
        const url = apiBase + "/api/public/ext/send";
        const extra = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
        const payload = Object.assign({}, extra, {
          token,
          projectId,
          message: text,
          text,
          content: text,
          user_message: text,
          display_text: text,
          selected_elements: [],
          text_replacements: [],
          send_method: method,
          requested_intent: intent,
          send_mode: extra.send_mode || "native",
          view: extra.view || "preview",
          x_license_key: stored.ql_license_key || "",
        });
        const body = {
          sessionToken: gate.token.token,
          deviceId,
          payload,
        };
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const raw = await resp.text();
        let data;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (_) {
          data = { raw };
        }
        if (data && data.status === 402) {
          sendResponse({
            ok: false,
            reason: "lovable_credits",
            error: "You need at least 1 credit on your Lovable account.",
            method,
            intent,
          });
          return;
        }
        if (!resp.ok || data.ok === false || data.success === false) {
          sendResponse({
            ok: false,
            reason: data.error || data.reason || "send_failed",
            error: data.error || data.reason || "Method send failed",
            status: resp.status,
            method,
            intent,
            data,
          });
          return;
        }
        sendResponse({ ok: true, success: true, method, intent, data: data.data || data });
      } catch (err) {
        console.error("[Background] pkMethodSend error:", err);
        sendResponse({ ok: false, reason: "exception", error: (err && err.message) || String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.action === "activateSidebar") {
    // Only set the preference and behavior — cannot open side panel without user gesture
    chrome.storage.local.set({ ql_sidebar_mode: true });
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
    // Try to open if sender is a tab (content script click IS a user gesture propagated)
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel &&
        chrome.sidePanel
          .open({ tabId: sender.tab.id })
          .then(() => {
            sendResponse({ ok: true });
          })
          .catch((err) => {
            console.warn("[Background] sidePanel.open deferred — user must click extension icon:", err.message);
            sendResponse({
              ok: true,
              deferred: true,
              message: "Click the extension icon to open the side panel.",
            });
          });
    } else {
      sendResponse({ ok: true, deferred: true, message: "Click the extension icon to open the side panel." });
    }
    return true;
  }

  if (msg && msg.action === "deactivateSidebar") {
    // Always re-enable native chat when leaving sidebar mode — floating mode
    // must have chat padrão ON by default. User can disable it later via the
    // floating launcher icon.
    chrome.storage.local.get(["ql_license_valid"], (stored) => {
      chrome.storage.local.set({ ql_sidebar_mode: false, ql_native_chat: stored && stored.ql_license_valid === true });
    });
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
    // Reload the active Lovable tab so the floating launcher reappears.
    // sender.tab is undefined when called from the sidepanel, so query tabs.
    (async () => {
      try {
        let tab = null;
        if (sender && sender.tab && sender.tab.id) {
          tab = sender.tab;
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && (lovableTabs.find((t) => t.active) || lovableTabs[0])) || null;
        }
        if (tab && tab.id) {
          try {
            await chrome.tabs.reload(tab.id);
          } catch (_) { }
          try {
            await chrome.tabs.update(tab.id, { active: true });
          } catch (_) { }
        }
      } catch (_) { }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg && msg.action === "openSidePanel") {
    // This can only work if triggered from a user gesture context
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel &&
        chrome.sidePanel
          .open({ tabId: sender.tab.id })
          .then(() => {
            sendResponse({ ok: true });
          })
          .catch((err) => {
            console.warn("[Background] openSidePanel deferred:", err.message);
            sendResponse({ ok: false, error: err.message });
          });
    } else {
      sendResponse({ ok: false, error: "No tab context" });
    }
    return true;
  }

  if (msg && msg.action === "lovableApiFetch") {
    (async () => {
      try {
        let tab = null;
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs && activeTabs[0] && /^https:\/\/([^/]+\.)?lovable\.dev\//.test(activeTabs[0].url || "")) {
          tab = activeTabs[0];
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && lovableTabs[0]) || null;
        }
        if (!tab || !tab.id) {
          sendResponse({ ok: false, status: 0, data: { error: "Open a Lovable tab before sending." } });
          return;
        }
        const stored = await chrome.storage.local.get(["lovable_token"]);
        const token = String((stored && stored.lovable_token) || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        const requestHeaders = Object.assign({}, msg.headers || {});
        if (token && !requestHeaders.Authorization && !requestHeaders.authorization) {
          requestHeaders.Authorization = "Bearer " + token;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          /* javascript-obfuscator:disable */
          func: async (url, options) => {
            try {
              const r = await fetch(url, options);
              const text = await r.text();
              let data;
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = { raw: text };
              }
              return { ok: r.ok, status: r.status, data };
            } catch (err) {
              return { ok: false, status: 0, data: { error: (err && err.message) || "fetch failed in page" } };
            }
          },
          /* javascript-obfuscator:enable */
          args: [
            msg.url,
            {
              method: msg.method || "POST",
              headers: requestHeaders,
              body: msg.body || null,
              credentials: "include",
            },
          ],
        });
        const value = (results && results[0] && results[0].result) || {
          ok: false,
          status: 0,
          data: { error: "no response from the Lovable page" },
        };
        sendResponse(value);
      } catch (err) {
        console.error("[Background] lovableApiFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "executeScript failed." } });
      }
    })();
    return true;
  }

  if (msg && msg.action === "createLovableProjectInPage") {
    (async () => {
      try {
        let tab = null;
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs && activeTabs[0] && /^https:\/\/([^/]+\.)?lovable\.dev\//.test(activeTabs[0].url || "")) {
          tab = activeTabs[0];
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && lovableTabs[0]) || null;
        }
        if (!tab || !tab.id) {
          sendResponse({ ok: false, error: "Open a Lovable tab before creating the project." });
          return;
        }
        const stored = await chrome.storage.local.get(["lovable_token"]);
        const token = String(msg.token || stored.lovable_token || "")
          .replace(/^Bearer\s+/i, "")
          .trim();

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            files: ["castle-v2.js"],
          });
        } catch (e) {
          console.warn("[Background] Castle script inject falhou, seguindo sem ele:", e && e.message);
        }

        const apiBaseForPage = ["https://", "api.lovable.dev"].join("");
        const castlePkForPage = ["pk_", "TaKsqF94pjCsoyepV6mH3V24AXoM6A7M"].join("");
        const firebaseRefreshUrlForPage = [
          "https://securetoken.googleapis.com",
          "/v1/token?key=",
          "AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw",
        ].join("");

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          /* javascript-obfuscator:disable */
          func: async ({ token, title, apiBase, castlePk, firebaseRefreshUrl }) => {
            const API_BASE = apiBase;
            const CASTLE_PK = castlePk;

            const asJson = async (response) => {
              const text = await response.text();
              try {
                return JSON.parse(text);
              } catch (e) {
                return { raw: text };
              }
            };

            const readFirebaseAuth = async () => {
              const fromValue = (value) => {
                if (!value || typeof value !== "object") return null;
                const user = value.value && typeof value.value === "object" ? value.value : value;
                const manager = user.stsTokenManager || user.tokenManager || {};
                const accessToken = manager.accessToken || user.accessToken || "";
                const refreshToken = manager.refreshToken || user.refreshToken || "";
                const expirationTime = Number(manager.expirationTime || user.expirationTime || 0);
                if (!accessToken && !refreshToken) return null;
                return { accessToken, refreshToken, expirationTime };
              };

              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i) || "";
                  if (!/firebase:authUser|authUser/i.test(key)) continue;
                  const parsed = JSON.parse(localStorage.getItem(key) || "null");
                  const found = fromValue(parsed);
                  if (found) return found;
                }
              } catch (e) { }

              try {
                return await new Promise((resolve) => {
                  const req = indexedDB.open("firebaseLocalStorageDb");
                  req.onerror = () => resolve(null);
                  req.onsuccess = () => {
                    const db = req.result;
                    try {
                      const tx = db.transaction("firebaseLocalStorage", "readonly");
                      const store = tx.objectStore("firebaseLocalStorage");
                      const all = store.getAll();
                      all.onerror = () => resolve(null);
                      all.onsuccess = () => {
                        const rows = all.result || [];
                        for (const row of rows) {
                          const found = fromValue(row);
                          if (found) {
                            resolve(found);
                            return;
                          }
                        }
                        resolve(null);
                      };
                    } catch (e) {
                      resolve(null);
                    }
                  };
                });
              } catch (e) {
                return null;
              }
            };

            const refreshFirebaseToken = async (refreshToken) => {
              if (!refreshToken) return "";
              try {
                const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
                const r = await fetch(firebaseRefreshUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body,
                });
                const data = await asJson(r);
                return r.ok ? data.id_token || data.access_token || "" : "";
              } catch (e) {
                return "";
              }
            };

            const readSupabaseAuth = () => {
              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i) || "";
                  if (!/^sb-.*-auth-token$/.test(key)) continue;
                  const raw = localStorage.getItem(key);
                  if (!raw) continue;
                  let parsed;
                  try {
                    parsed = JSON.parse(raw);
                  } catch (e) {
                    continue;
                  }
                  let accessToken = "",
                    refreshToken = "",
                    expiresAt = 0;
                  if (Array.isArray(parsed)) {
                    accessToken = parsed[0] || "";
                    refreshToken = parsed[1] || "";
                  } else if (parsed && typeof parsed === "object") {
                    accessToken =
                      parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token) || "";
                    refreshToken =
                      parsed.refresh_token || (parsed.currentSession && parsed.currentSession.refresh_token) || "";
                    expiresAt = Number(
                      parsed.expires_at || (parsed.currentSession && parsed.currentSession.expires_at) || 0,
                    );
                  }
                  if (accessToken) return { accessToken, refreshToken, expirationTime: expiresAt * 1000 };
                }
              } catch (e) { }
              return null;
            };

            const getFreshToken = async () => {
              const sb = readSupabaseAuth();
              if (sb && sb.accessToken) return sb.accessToken;
              const storedAuth = await readFirebaseAuth();
              if (storedAuth) {
                const expiresSoon = storedAuth.expirationTime && storedAuth.expirationTime - Date.now() < 300000;
                if (expiresSoon && storedAuth.refreshToken) {
                  const refreshed = await refreshFirebaseToken(storedAuth.refreshToken);
                  if (refreshed) return refreshed;
                }
                if (storedAuth.accessToken) return storedAuth.accessToken;
              }
              return String(token || "")
                .replace(/^Bearer\s+/i, "")
                .trim();
            };

            const createCastleHeader = async () => {
              try {
                if (!window.Castle || typeof window.Castle.configure !== "function") return {};
                window.__lovasiriCastleClient =
                  window.__lovasiriCastleClient || window.Castle.configure({ pk: CASTLE_PK });
                const castleToken = await window.__lovasiriCastleClient.createRequestToken();
                return castleToken ? { "X-Castle-Request-Token": castleToken } : {};
              } catch (e) {
                return {};
              }
            };

            const freshToken = await getFreshToken();
            // NOTE: do not bail when there's no Bearer token. Lovable.dev now
            // authenticates API requests primarily via cookies (credentials: 'include'),
            // so we proceed and only fall back to the friendly error if the API itself
            // returns 401.

            const makeHeaders = async (json = true) => ({
              Accept: "application/json",
              ...(json ? { "Content-Type": "application/json" } : {}),
              ...(freshToken ? { Authorization: "Bearer " + freshToken } : {}),
              ...(await createCastleHeader()),
            });

            const pickWorkspaces = (payload) => {
              if (!payload || typeof payload !== "object") return [];
              if (Array.isArray(payload.workspaces)) return payload.workspaces;
              if (Array.isArray(payload.data)) return payload.data;
              if (payload.workspace) return [payload.workspace];
              return [];
            };
            const wsUrls = [API_BASE + "/user/workspaces", API_BASE + "/workspaces"];
            let workspaces = [];
            let workspaceStatus = 0;
            let workspacePayload = null;
            for (const url of wsUrls) {
              try {
                const r = await fetch(url, {
                  method: "GET",
                  headers: await makeHeaders(false),
                  credentials: "include",
                });
                workspaceStatus = r.status;
                const data = await asJson(r);
                workspacePayload = data;
                if (r.ok) {
                  workspaces = pickWorkspaces(data).filter((w) => w && w.id);
                  if (workspaces.length) break;
                }
              } catch (e) { }
            }
            if (!workspaces.length) {
              const why =
                workspacePayload && (workspacePayload.message || workspacePayload.error || workspacePayload.type);
              return {
                ok: false,
                error: why || "Could not find your Lovable workspace.",
                status: workspaceStatus,
                details: workspacePayload,
              };
            }

            const workspace = workspaces.find((w) => !/free/i.test(String(w.plan || ""))) || workspaces[0];
            const workspaceId = workspace.id;
            const projectTitle = title || "Project " + new Date().toLocaleString("en-US");
            const bodies = [
              {
                description: projectTitle,
                tech_stack: "modern",
                visibility: "private",
                metadata: { chat_mode_enabled: true, fullscreen_enabled: true },
              },
              {
                description: projectTitle,
                visibility: "private",
                metadata: { fullscreen_enabled: true },
              },
            ];
            const urls = [API_BASE + "/workspaces/" + encodeURIComponent(workspaceId) + "/projects"];
            let last = null;
            for (const url of urls) {
              for (const body of bodies) {
                try {
                  const r = await fetch(url, {
                    method: "POST",
                    headers: await makeHeaders(true),
                    credentials: "include",
                    body: JSON.stringify(body),
                  });
                  const data = await asJson(r);
                  last = { status: r.status, data, url };
                  if (r.ok) {
                    const project = data.project || data.data || data;
                    const id = project.id || project.project_id || data.id || data.projectId;
                    const link =
                      project.editor_url ||
                      project.url ||
                      project.link ||
                      data.editor_url ||
                      data.url ||
                      data.link ||
                      (id ? "https://lovable.dev/projects/" + id : "https://lovable.dev/");
                    return { ok: true, success: true, link, projectId: id || "", workspaceId, data };
                  }
                  if (r.status !== 400 && r.status !== 404 && r.status !== 422) break;
                } catch (e) {
                  last = { status: 0, data: { error: e.message }, url };
                }
              }
            }
            const msg =
              (last && last.data && (last.data.message || last.data.error || last.data.type)) ||
              "Failed to create the project in Lovable.";
            if (last && last.status === 401)
              return {
                ok: false,
                status: 401,
                error:
                  "Your Lovable session did not authorize the creation. Refresh the Lovable.dev tab, make sure you are signed in and try again.",
                details: last,
              };
            if (last && last.status === 402)
              return {
                ok: false,
                status: 402,
                error: "Your Lovable account needs available credits/plan to create a project.",
                details: last,
              };
            if (/castle|denied|captcha/i.test(String(msg)))
              return {
                ok: false,
                status: last && last.status,
                error:
                  "Lovable blocked the automation for security reasons. Refresh the Lovable.dev tab and try again from the extension panel.",
                details: last,
              };
            return { ok: false, status: last && last.status, error: msg, details: last };
          },
          /* javascript-obfuscator:enable */
          args: [
            {
              token,
              title: msg.title || "",
              apiBase: apiBaseForPage,
              castlePk: castlePkForPage,
              firebaseRefreshUrl: firebaseRefreshUrlForPage,
            },
          ],
        });
        const value = (results && results[0] && results[0].result) || {
          ok: false,
          error: "no response from the Lovable page",
        };
        if (value && value.ok && value.projectId) {
          chrome.storage.local.set({ lovable_token: value.token || token, lovable_projectId: value.projectId });
        }
        sendResponse(value);
      } catch (err) {
        console.error("[Background] createLovableProjectInPage error:", err);
        sendResponse({ ok: false, error: err.message || "Failed to create through the Lovable tab." });
      }
    })();
    return true;
  }

  if (msg && msg.action === "proxyFetch") {
    (async () => {
      try {
        var fetchUrl = String(msg.url || "");

        // Dead vendor REST polls (branding / notifications / packages / integrity).
        // Compat used to answer these with [] on every 5–15s tick and burned the
        // Cloudflare Free Worker quota. Keep the same empty payload locally —
        // UI stays storage-only; no network hop.
        if (/\/rest\/v1\//i.test(fetchUrl)) {
          sendResponse({ ok: true, status: 200, data: [] });
          return;
        }

        // validate-license stub only after PROTECTED gate (authorizeAndHandleMessage).
        // Keeps core heartbeat happy without exposing an ungated free path.
        if (/validate-license/i.test(fetchUrl)) {
          var stored = {};
          try {
            stored = await chrome.storage.local.get([
              "ql_session_id",
              "ql_user_name",
              "ql_expires_at",
              "pk_ui_locale",
            ]);
          } catch (_) { }
          var locale = String((stored && stored.pk_ui_locale) || "en")
            .toLowerCase()
            .slice(0, 2);
          var displayNames = {
            en: "Extension User",
            es: "Usuario de la extensión",
            pt: "Usuário da Extensão",
            de: "Extension-Benutzer",
          };
          var displayName = displayNames[locale] || displayNames.en;
          var existingName = String((stored && stored.ql_user_name) || "").trim();
          if (!existingName || /^powerkits\s*user$/i.test(existingName)) existingName = displayName;
          sendResponse({
            ok: true,
            status: 200,
            data: {
              valid: true,
              success: true,
              session_id: (stored && stored.ql_session_id) || "powerkits-session",
              user_name: existingName,
              status: "active",
              expires_at: (stored && stored.ql_expires_at) || "2099-01-01T00:00:00Z",
            },
          });
          return;
        }

        // Licensed send: opaque PowerKits /api/public/ext/send only.
        // Never fetch vendor function URLs from the browser.
        try {
          var build = self.__PK_BUILD__ || {};
          var apiBase = String(build.api_url || "https://powerkit-extention.onrender.com").replace(/\/+$/, "");
          var sendPath = "/api/public/ext/send";
          var looksLikeCreditFreeSend =
            /\/api\/public\/ext\/send(?:$|\?)/i.test(fetchUrl) ||
            /\/functions\/v1\/send-[a-z0-9-]+/i.test(fetchUrl);
          if (looksLikeCreditFreeSend && apiBase && apiBase.indexOf("https://powerkit-extention.onrender.com") !== -1) {
            fetchUrl = apiBase + sendPath;
            var gate = await self.PowerKitsGate.ensureToken();
            if (!gate || !gate.ok || !gate.token || !gate.token.token) {
              sendResponse({ ok: false, status: 403, data: { error: "unauthorized" } });
              return;
            }
            var deviceId = await self.PowerKitsGate.getDeviceId();
            var parsed = {};
            try {
              parsed = msg.body && typeof msg.body === "string" ? JSON.parse(msg.body) : {};
            } catch (_) {
              parsed = {};
            }
            var inner = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed;
            msg.body = JSON.stringify({
              sessionToken: gate.token.token,
              deviceId: deviceId,
              payload: inner,
            });
          } else if (
            /\/functions\/v1\//i.test(fetchUrl) &&
            !/\/api\/public\/ext\//i.test(fetchUrl)
          ) {
            sendResponse({ ok: false, status: 0, data: { error: "blocked" } });
            return;
          }
        } catch (_) { }
        var opts = {
          method: msg.method || "POST",
          headers: msg.headers || {},
        };
        if (msg.body) opts.body = msg.body;
        var resp = await fetch(fetchUrl, opts);
        var text = await resp.text();
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { raw: text };
        }
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      } catch (err) {
        console.error("[Background] proxyFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "Fetch failed in background" } });
      }
    })();
    return true;
  }

  // --- READ_COOKIES: read HttpOnly cookies for JWT token ---
  if (msg && msg.action === "readCookies") {
    var cookieNames = [
      "lovable-session-id.id",
      "lovable-session-id.custom",
      "lovable-session-id.refresh",
      "lovable-session-id.sig",
    ];
    var foundTokens = [];
    var checkedCount = 0;
    cookieNames.forEach(function (name) {
      chrome.cookies.get({ url: "https://lovable.dev", name: name }, function (cookie) {
        checkedCount++;
        if (cookie && cookie.value) {
          var parts = cookie.value.split(".");
          if (parts.length === 3 && cookie.value.indexOf("eyJ") === 0) {
            foundTokens.push({
              token: cookie.value,
              cookieName: name,
              httpOnly: cookie.httpOnly,
            });
          }
        }
        if (checkedCount === cookieNames.length) {
          sendResponse({ success: foundTokens.length > 0, tokens: foundTokens });
        }
      });
    });
    return true;
  }

  // --- BYOK Optimize with AI (user's OpenAI / Google AI Studio key) ---
  if (msg && msg.action === "pkOptimizePrompt") {
    (async function () {
      try {
        const prompt = String(msg.prompt || "").trim();
        if (!prompt) {
          sendResponse({ ok: false, error: "empty_prompt" });
          return;
        }
        const stored = await chrome.storage.local.get(["pk_opt_provider", "pk_opt_api_key"]);
        const provider = String((stored && stored.pk_opt_provider) || "google")
          .toLowerCase()
          .trim();
        const apiKey = String((stored && stored.pk_opt_api_key) || "").trim();
        if (!apiKey) {
          sendResponse({ ok: false, error: "missing_key" });
          return;
        }
        let result;
        try {
          if (provider === "openai") {
            result = await pkOptimizeWithOpenAI(apiKey, prompt);
          } else {
            result = await pkOptimizeWithGoogle(apiKey, prompt);
          }
        } catch (err) {
          console.error("[Background] pkOptimizePrompt network:", (err && err.message) || err);
          sendResponse({ ok: false, error: "network" });
          return;
        }
        if (result && result.ok && result.optimized_prompt) {
          sendResponse({ ok: true, optimized_prompt: result.optimized_prompt });
          return;
        }
        sendResponse({
          ok: false,
          error: (result && result.error) || "optimize_failed",
        });
      } catch (err) {
        console.error("[Background] pkOptimizePrompt:", (err && err.message) || err);
        sendResponse({ ok: false, error: "optimize_failed" });
      }
    })();
    return true;
  }

  // --- DOWNLOAD_PROJECT: fetch project source code from Lovable API ---
  if (msg && msg.action === "downloadProject") {
    (async function () {
      try {
        const stored = await chrome.storage.local.get(["lovable_token", "lovable_projectId"]);
        const projectId = String(msg.projectId || stored.lovable_projectId || "").trim();
        const token = String(msg.token || stored.lovable_token || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!projectId) {
          sendResponse({
            success: false,
            ok: false,
            error: "Project not identified. Open the project in Lovable and try again.",
          });
          return;
        }

        // 1) Preferir a aba Lovable: usa cookies + token vivo do localStorage
        let result = null;
        try {
          result = await fetchLovableSourceViaPage(projectId, token, sender && sender.tab);
        } catch (e) {
          result = { success: false, ok: false, status: 0, error: (e && e.message) || "page_fetch_failed" };
        }
        // 2) Fallback: chamada direta apenas se a página falhou
        const pageFailed = !result || !result.success;
        if (pageFailed) {
          try {
            const direct = await fetchLovableSourceDirect(projectId, token);
            if (direct && direct.success) result = direct;
            else if (!result) result = direct;
          } catch (e) {
            if (!result)
              result = { success: false, ok: false, status: 0, error: (e && e.message) || "direct_fetch_failed" };
          }
        }
        if (result && !result.success && /invalid.?token|401/i.test(String(result.error || result.status || ""))) {
          result.error = "Your Lovable session expired. Reload the project page (F5) and try again.";
        }
        sendResponse(result && result.success ? { success: true, ok: true, files: result.files || [] } : result);
      } catch (err) {
        sendResponse({ success: false, ok: false, status: 0, error: (err && err.message) || "Download falhou" });
      }
    })();
    return true;
  }
}


