// content.js — l'instrumentation, injectée dans VOS onglets pendant un
// enregistrement, et seulement pendant.
//
// C'est le pendant exact de skill-recorder/src/instrument.js : mêmes gestes,
// mêmes descripteurs de cible, même caviardage. Seul le transport change — un
// binding Playwright là-bas, chrome.runtime.sendMessage ici — parce que le
// serveur ne fait aucune différence entre les deux producteurs.
//
// L'injection est DYNAMIQUE (chrome.scripting, à l'ouverture d'un
// enregistrement) et non déclarée dans le manifeste : hors enregistrement, ce
// fichier n'existe dans aucune de vos pages. C'est la seule garantie de vie
// privée qui vaille — pas une promesse, une absence de code.
//
// Deux principes non négociables, inchangés :
//   1. NE JAMAIS faire remonter un secret : le caviardage est fait ICI.
//   2. NE JAMAIS casser la page observée : tout en try/catch, en capture, sans
//      preventDefault.

(() => {
  if (window.__skillRecorderInstalled) return;
  window.__skillRecorderInstalled = true;

  const rt = (globalThis.browser ?? globalThis.chrome).runtime;

  function emit(event) {
    try {
      event.t = Date.now();
      event.frame = window.top === window ? null : location.href;
      // Le service worker peut être en sommeil : sendMessage le réveille. On
      // absorbe l'erreur — un geste perdu ne doit pas casser la page.
      rt.sendMessage({ type: "rec:event", event }).catch(() => {});
    } catch { /* jamais au détriment de la page */ }
  }

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) : t; };

  // ── Caviardage ─────────────────────────────────────────────────────────────
  const SECRET_WORDS = /pass(word|e)?|mot[-_ ]?de[-_ ]?passe|\bmdp\b|secret|token|api[-_ ]?key|apikey|cvv|cvc|carte|card[-_ ]?number|iban|rib|\bssn\b|\botp\b|security[-_ ]?code|private[-_ ]?key/i;
  function isSecretField(el) {
    try {
      if (!el) return false;
      if (el.type === "password") return true;
      const auto = (el.getAttribute?.("autocomplete") || "").toLowerCase();
      if (auto.startsWith("cc-") || auto === "current-password" || auto === "new-password" || auto === "one-time-code") return true;
      const haystack = [
        el.getAttribute?.("name"), el.getAttribute?.("id"), el.getAttribute?.("placeholder"),
        el.getAttribute?.("aria-label"), labelTextFor(el),
      ].filter(Boolean).join(" ");
      return SECRET_WORDS.test(haystack);
    } catch { return false; }
  }

  // ── Description d'une cible ────────────────────────────────────────────────
  const testIdOf = (el) => {
    let p = el;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = p.getAttribute?.("data-testid") || p.getAttribute?.("data-test") || p.getAttribute?.("data-cy");
      if (t) return t;
    }
    return "";
  };

  const isStableId = (id) =>
    !!id && id.length < 60
    && !/^[:.]/.test(id)
    && !/^(radix|headlessui|mui|react|ember|ext)[-:]/i.test(id)
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)
    && !/\d{5,}/.test(id);

  function labelTextFor(el) {
    try {
      if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
      const id = el.getAttribute?.("id");
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) return clean(lab.innerText);
      }
      const wrap = el.closest?.("label");
      if (wrap) return clean(wrap.innerText);
    } catch { /* ignore */ }
    return "";
  }

  function ariaLabelledText(el) {
    const ids = el.getAttribute?.("aria-labelledby");
    if (!ids) return "";
    for (const id of ids.split(/\s+/)) {
      const t = document.getElementById(id);
      if (t) { const v = clean(t.innerText || t.getAttribute("aria-label")); if (v) return v; }
    }
    return "";
  }

  function roleOf(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = el.tagName?.toLowerCase();
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "range") return "slider";
      if (type === "file") return "file";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return tag || "generic";
  }

  function accessibleName(el) {
    let base = clean(
      el.getAttribute?.("aria-label")
      || ariaLabelledText(el)
      || labelTextFor(el)
      || (el.tagName === "INPUT" ? "" : el.innerText)
      || el.getAttribute?.("placeholder")
      || el.getAttribute?.("title")
      || el.getAttribute?.("alt")
      || el.getAttribute?.("name"),
    );
    if (!base) {
      let p = el.parentElement;
      for (let i = 0; i < 3 && p && !base; i++, p = p.parentElement) {
        base = clean(p.getAttribute?.("aria-label") || p.getAttribute?.("title"));
      }
    }
    if (!base) {
      const svg = el.matches?.("svg") ? el : el.querySelector?.("svg");
      const m = (svg?.getAttribute("class") || "").match(/lucide-([a-z0-9-]+)/i);
      if (m) base = m[1].replace(/-/g, " ") + " (icône)";
    }
    return clip(base, 100);
  }

  function cssPath(el) {
    try {
      const parts = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++, node = node.parentElement) {
        const id = node.getAttribute("id");
        if (isStableId(id)) { parts.unshift(`#${CSS.escape(id)}`); break; }
        const testid = node.getAttribute("data-testid");
        if (testid) { parts.unshift(`[data-testid="${testid}"]`); break; }
        let sel = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
      }
      return parts.join(" > ").slice(0, 300);
    } catch { return ""; }
  }

  function interactiveAncestor(el) {
    const SEL = "a,button,input,textarea,select,label,[role],[onclick],[tabindex],[data-testid],[contenteditable='true']";
    let node = el;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (node.matches?.(SEL)) return node;
      try { if (getComputedStyle(node).cursor === "pointer") return node; } catch { /* ignore */ }
    }
    return el;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return {};
    const id = el.getAttribute?.("id");
    return {
      tag: el.tagName?.toLowerCase() || "",
      role: roleOf(el),
      label: accessibleName(el),
      testid: testIdOf(el) || undefined,
      id: isStableId(id) ? id : undefined,
      name: el.getAttribute?.("name") || undefined,
      placeholder: el.getAttribute?.("placeholder") || undefined,
      text: clip(el.innerText, 100) || undefined,
      css: cssPath(el),
      href: el.getAttribute?.("href") || undefined,
    };
  }

  // ── Écouteurs ──────────────────────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    try {
      if (e.target?.closest?.("#__skill_rec_hud")) return;
      const el = interactiveAncestor(e.target);
      const type = (el.getAttribute?.("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") return; // 'change' est plus parlant
      emit({ kind: "click", target: describe(el), url: location.href });
    } catch { /* ignore */ }
  }, true);

  const fillTimers = new WeakMap();
  function emitFill(el) {
    try {
      if (!el) return;
      const secret = isSecretField(el);
      const isCE = el.getAttribute?.("contenteditable") === "true";
      const raw = isCE ? el.innerText : el.value;
      const value = secret ? "" : clip(raw, 500);
      if (!secret && !value) return;
      emit({ kind: "fill", target: describe(el), value, is_secret: secret, url: location.href });
    } catch { /* ignore */ }
  }

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || !el.matches?.("input,textarea,[contenteditable='true']")) return;
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "file") return;
    clearTimeout(fillTimers.get(el));
    fillTimers.set(el, setTimeout(() => emitFill(el), 900));
  }, true);

  document.addEventListener("change", (e) => {
    try {
      const el = e.target;
      if (!el) return;
      const tag = el.tagName?.toLowerCase();
      const type = (el.getAttribute?.("type") || "").toLowerCase();

      if (tag === "select") {
        const opt = el.selectedOptions?.[0];
        emit({ kind: "select", target: describe(el), value: clip(opt?.text || el.value, 200), url: location.href });
        return;
      }
      if (type === "checkbox" || type === "radio") {
        emit({ kind: "check", target: describe(el), value: String(!!el.checked), url: location.href });
        return;
      }
      if (type === "file") {
        const names = Array.from(el.files || []).map((f) => f.name).join(", ");
        emit({ kind: "upload", target: describe(el), value: clip(names, 300), url: location.href });
        return;
      }
      clearTimeout(fillTimers.get(el));
      emitFill(el);
    } catch { /* ignore */ }
  }, true);

  document.addEventListener("submit", (e) => {
    try { emit({ kind: "submit", target: describe(e.target), url: location.href }); } catch { /* ignore */ }
  }, true);

  document.addEventListener("keydown", (e) => {
    try {
      const combo = (e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1 && !isSecretField(document.activeElement);
      const notable = ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"].includes(e.key);
      if (!combo && !notable) return;
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.metaKey) parts.push("Meta");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      parts.push(e.key);
      emit({ kind: "press", target: describe(document.activeElement), value: parts.join("+"), url: location.href });
    } catch { /* ignore */ }
  }, true);

  document.addEventListener("copy", () => {
    try {
      const sel = clip(String(document.getSelection?.() || ""), 300);
      if (sel) emit({ kind: "copy", value: sel, target: {}, url: location.href });
    } catch { /* ignore */ }
  }, true);

  let lastScroll = 0;
  window.addEventListener("scroll", () => {
    const now = Date.now();
    if (now - lastScroll < 1500) return;
    lastScroll = now;
    emit({ kind: "scroll", target: {}, value: String(Math.round(window.scrollY)), url: location.href });
  }, true);

  // Navigations internes d'une SPA : aucun chargement de page, donc aucun
  // événement navigateur. Sans ça, tout un parcours d'application moderne
  // ressemblerait à une seule page.
  let lastUrl = location.href;
  const noteUrlChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit({ kind: "navigate", target: {}, url: location.href });
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) { const r = orig.apply(this, args); setTimeout(noteUrlChange, 0); return r; };
  }
  window.addEventListener("popstate", noteUrlChange);

  // ── Bandeau REC ────────────────────────────────────────────────────────────
  // Vous enregistrez dans VOS onglets : savoir en permanence lesquels sont
  // observés n'est pas un ornement, c'est la condition pour que la
  // fonctionnalité soit acceptable.
  if (window.top === window) {
    const install = () => {
      if (!document.body || document.getElementById("__skill_rec_hud")) return;
      const hud = document.createElement("div");
      hud.id = "__skill_rec_hud";
      hud.style.cssText = [
        "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
        "display:flex", "align-items:center", "gap:8px",
        "padding:6px 12px", "border-radius:999px",
        "background:rgba(17,17,20,.92)", "color:#fff",
        "font:600 12px/1 ui-sans-serif,system-ui,-apple-system,sans-serif",
        "box-shadow:0 4px 16px rgba(0,0,0,.35)", "pointer-events:none",
        "backdrop-filter:blur(6px)",
      ].join(";");
      hud.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;animation:__skrec 1.6s infinite"></span>'
        + '<span>Enregistrement</span><span id="__skill_rec_time" style="opacity:.6;font-variant-numeric:tabular-nums">00:00</span>';
      const style = document.createElement("style");
      style.textContent = "@keyframes __skrec{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}";
      hud.appendChild(style);
      document.body.appendChild(hud);

      setInterval(() => {
        const el = document.getElementById("__skill_rec_time");
        const t0 = window.__skillRecStartedAt;
        if (!el || !t0) return;
        const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      }, 1000);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
    else install();
  }

  // Le service worker donne l'origine du chrono, et retire le bandeau à l'arrêt.
  rt.onMessage.addListener((msg) => {
    if (msg?.type === "rec:started_at") window.__skillRecStartedAt = msg.value;
    if (msg?.type === "rec:stop") {
      document.getElementById("__skill_rec_hud")?.remove();
      window.__skillRecStopped = true;
    }
  });
  rt.sendMessage({ type: "rec:hello" }).then((r) => {
    if (r?.startedAt) window.__skillRecStartedAt = r.startedAt;
  }).catch(() => {});
})();
