// instrument.js — injecté par Playwright dans CHAQUE page et CHAQUE iframe du
// navigateur d'enregistrement (context.addInitScript).
//
// Rôle : traduire les gestes bruts du DOM en événements sémantiques, avec assez
// de contexte pour qu'un agent puisse re-cibler l'élément plus tard. Tout ce qui
// demande le disque, le réseau ou une capture d'écran est fait côté Node : ici
// on ne fait que décrire.
//
// Deux principes non négociables :
//   1. NE JAMAIS faire remonter un secret. Le caviardage est fait ICI, à la
//      source — la valeur d'un champ mot de passe ne quitte pas la page.
//   2. NE JAMAIS casser la page observée. Tout est en try/catch, en phase de
//      capture, sans preventDefault, et le bandeau REC est pointer-events:none.

(() => {
  if (window.__skillRecorderInstalled) return;
  window.__skillRecorderInstalled = true;

  // ── Transport vers Node ────────────────────────────────────────────────────
  // Le binding Playwright est posé avant les init scripts, mais on tamponne
  // quand même : une frame peut s'exécuter avant que le binding soit visible.
  const pending = [];
  function emit(event) {
    try {
      event.t = Date.now();
      event.frame = window.top === window ? null : location.href;
      const payload = JSON.stringify(event);
      if (typeof window.__skillRecordPush === "function") {
        while (pending.length) window.__skillRecordPush(pending.shift());
        window.__skillRecordPush(payload);
      } else {
        pending.push(payload);
        if (pending.length > 200) pending.shift();
      }
    } catch { /* jamais au détriment de la page */ }
  }

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) : t; };

  // ── Caviardage ─────────────────────────────────────────────────────────────
  // Un champ est sensible par son type, son autocomplete, ou son vocabulaire
  // (nom, id, placeholder, libellé). Faux positifs assumés : une variable de
  // trop dans la skill coûte moins cher qu'un mot de passe en base.
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

  // Un id auto-généré (radix-:r3:, mui-42, uuid…) n'est pas un point d'ancrage :
  // il change au rechargement, l'agent ne doit pas s'appuyer dessus.
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

  // Rôle ARIA implicite — ce que l'agent utilisera avec getByRole().
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

  // Nom accessible, dans l'ordre de fiabilité. Un contrôle en icône seule
  // retombe sur le nom de l'icône lucide plutôt que sur rien.
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

  // Chemin CSS de repli : court, ancré au premier ancêtre identifiable.
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

  // L'élément réellement "cliqué" du point de vue de l'utilisateur : le contrôle
  // interactif le plus proche, pas le <span> décoratif à l'intérieur.
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
  // Tous en phase de CAPTURE : on voit le geste même si l'application arrête la
  // propagation, et on le voit avant qu'un re-render n'efface la cible.

  document.addEventListener("click", (e) => {
    try {
      if (e.target?.closest?.("#__skill_rec_hud")) return;
      const el = interactiveAncestor(e.target);
      // Les cases à cocher émettent un 'change' plus parlant : pas de doublon.
      const type = (el.getAttribute?.("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") return;
      emit({ kind: "click", target: describe(el), url: location.href });
    } catch { /* ignore */ }
  }, true);

  // Saisie : on veut la valeur FINALE d'un champ, pas la frappe. On émet sur
  // 'change' (fiable) et, pour les SPA qui ne l'émettent jamais, après 900 ms
  // d'inactivité. Le serveur effondre ensuite les doublons sur une même cible.
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

  // Clavier : seulement ce qui porte du sens procédural (valider, annuler,
  // raccourcis). Enregistrer chaque frappe reviendrait à enregistrer un
  // keylogger — et noierait la trace.
  document.addEventListener("keydown", (e) => {
    try {
      const combo = (e.ctrlKey || e.metaKey || e.altKey)
        && e.key.length === 1
        && !isSecretField(document.activeElement);
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

  // ── Bandeau REC ────────────────────────────────────────────────────────────
  // L'utilisateur doit savoir en permanence qu'il est enregistré — et où en est
  // le chrono. pointer-events:none : le bandeau ne peut ni être cliqué, ni
  // intercepter un geste destiné à la page.
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
      hud.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 0 rgba(239,68,68,.7);animation:__skrec 1.6s infinite"></span>'
        + '<span>Enregistrement</span><span id="__skill_rec_time" style="opacity:.6;font-variant-numeric:tabular-nums">00:00</span>';
      const style = document.createElement("style");
      style.textContent = "@keyframes __skrec{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}";
      hud.appendChild(style);
      document.body.appendChild(hud);

      // L'origine du chrono est posée par Node (window.__skillRecStartedAt) pour
      // que toutes les pages/onglets affichent le MÊME temps.
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
})();
