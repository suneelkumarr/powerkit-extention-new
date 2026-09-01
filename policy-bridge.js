/**
 * Isolated-world stamp of admin send-method policy onto the page DOM.
 * pageHook (MAIN) reads these attrs to clamp Method 1/2/3 before streamed core loads.
 */
(function () {
  var KEYS = ["ql_methods_policy", "ql_send_method"];

  function enabledList(en) {
    var list = [];
    if (en.v6 !== false) list.push("v6");
    if (en.v5 !== false) list.push("v5");
    if (en.v7 !== false) list.push("v7");
    if (!list.length) list.push("v6");
    return list;
  }

  function paint(policy, sendMethod) {
    try {
      if (!policy || typeof policy !== "object") return;
      var en = policy.enabled && typeof policy.enabled === "object" ? policy.enabled : {};
      var list = enabledList(en);
      var def = String(policy.defaultMethod || "v6").toLowerCase();
      if (def !== "v5" && def !== "v6" && def !== "v7") def = "v6";
      if (list.indexOf(def) === -1) def = list[0];
      var capRaw = Number(policy.rateLimitPerHour);
      var cap = Number.isFinite(capRaw) && capRaw > 0 ? String(Math.trunc(capRaw)) : "0";
      var method = String(sendMethod || def).toLowerCase();
      if (method === "7" || method === "method3" || method === "3") method = "v7";
      else if (method === "5" || method === "method2" || method === "2") method = "v5";
      else if (method === "6" || method === "method1" || method === "1") method = "v6";
      if (list.indexOf(method) === -1) method = def;

      var root = document.documentElement;
      root.setAttribute("data-pk-enabled-methods", list.join(","));
      root.setAttribute("data-pk-default-method", def);
      root.setAttribute("data-pk-rotation", policy.rotationEnabled === true ? "1" : "0");
      root.setAttribute("data-pk-hourly-cap", cap);
      root.setAttribute("data-lovasiri-method", method);
      root.setAttribute("data-lovasiri-intent", method === "v5" ? "security_scan" : "fix_error");
    } catch (_) {}
  }

  function load() {
    try {
      chrome.storage.local.get(KEYS, function (r) {
        paint(r && r.ql_methods_policy, r && r.ql_send_method);
      });
    } catch (_) {}
  }

  load();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (changes.ql_methods_policy || changes.ql_send_method) load();
    });
  } catch (_) {}
})();
