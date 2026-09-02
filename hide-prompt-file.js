/* ============================================================
 * PowerKits — hide ONLY the "prompt.txt" attachment chip in Lovable.
 * Visual only. Never hides the chat message or the "❤️ Lovable" seal.
 * The edge still receives prompt.txt; this just removes the chip from the UI.
 * ============================================================ */
(function () {
  "use strict";
  if (window.__pkHidePromptTxt) return;
  window.__pkHidePromptTxt = true;

  var NAME = /prompt\s*(\(\d+\))?\.txt/i;
  var FORBIDDEN = /sent by|enviado por|❤️|current task|user_request|important to follow|lead capture/i;
  var CHROME =
    /\b(text\/plain|plain|txt|file|document|attachment|attached|download|open)\b/gi;
  var SIZE = /(\d+([.,]\d+)?)\s*(b|kb|mb|bytes?)/gi;

  function txt(el) {
    return String((el && el.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isChipish(t) {
    t = String(t || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 90) return false;
    if (!NAME.test(t)) return false;
    if (FORBIDDEN.test(t)) return false;
    var left = t
      .replace(/prompt\s*(\(\d+\))?\.txt/gi, " ")
      .replace(CHROME, " ")
      .replace(SIZE, " ")
      .replace(/[\s•·|,.\-–—()[\]_]+/g, "");
    return left.length === 0;
  }

  function hide(el) {
    if (!el || el.__pkHidden) return;
    el.__pkHidden = true;
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("height", "0", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.setAttribute("data-pk-hidden-prompt-txt", "1");
  }

  function hideChipFrom(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el) return;
    var startText = txt(el);
    if (!NAME.test(startText)) return;
    if (FORBIDDEN.test(startText) && !isChipish(startText)) return;

    var chosen = el;
    var parent = el.parentElement;
    var levels = 0;
    while (parent && parent !== document.body && levels < 8) {
      var t = txt(parent);
      if (!t || FORBIDDEN.test(t) || t.length > 90) break;
      if (!NAME.test(t)) break;
      if (!isChipish(t) && t.length > 48) break;
      chosen = parent;
      parent = parent.parentElement;
      levels++;
    }
    hide(chosen);
  }

  function scanRoot(root) {
    if (!root) return;
    try {
      if (root.querySelectorAll) {
        root
          .querySelectorAll(
            '[download*="prompt.txt" i], a[href*="prompt.txt" i], [title*="prompt.txt" i], [aria-label*="prompt.txt" i]',
          )
          .forEach(hideChipFrom);
      }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n;
      var hits = [];
      while ((n = walker.nextNode())) {
        var v = String(n.nodeValue || "")
          .replace(/\s+/g, " ")
          .trim();
        if (v.length <= 40 && NAME.test(v) && n.parentElement) hits.push(n.parentElement);
      }
      hits.forEach(hideChipFrom);

      if (root.querySelectorAll) {
        var all = root.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
          var sr = all[i].shadowRoot;
          if (sr) scanRoot(sr);
        }
      }
    } catch (e) { }
  }

  function scan() {
    try {
      scanRoot(document.body || document.documentElement);
    } catch (e) { }
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      scan();
    });
  }

  function start() {
    scan();
    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) { }
    setInterval(schedule, 800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
