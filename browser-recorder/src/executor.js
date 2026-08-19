// executor.js — l'exécution d'un ordre dans une page.
//
// `runCommand` est passée à chrome.scripting.executeScript comme `func` : Chrome
// en SÉRIALISE LE SOURCE et l'exécute dans la page. Elle ne doit donc référencer
// aucune variable extérieure — pas d'import, pas de constante du module. En
// échange, sa valeur de retour revient directement au service worker, sans
// aller-retour de messages.
//
// Le point important est la RÉSOLUTION DE CIBLE. Une skill apprise par
// démonstration décrit ses cibles avec le vocabulaire de l'enregistreur
// (`testid`, `css`, `role` + `label`, `text`). L'exécuteur les relit dans le
// même ordre de fiabilité, du plus stable au plus fragile — c'est ce qui permet
// de rejouer une procédure sur une page qui a un peu bougé depuis la démo.

export function runCommand(command) {
  const { action, params = {} } = command;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) + "…" : t; };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };

  const roleOf = (el) => {
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
      return "textbox";
    }
    return tag || "generic";
  };

  const nameOf = (el) => {
    let base = clean(el.getAttribute?.("aria-label"));
    if (!base) {
      const ids = el.getAttribute?.("aria-labelledby");
      if (ids) for (const id of ids.split(/\s+/)) {
        const t = document.getElementById(id);
        if (t) { base = clean(t.innerText); if (base) break; }
      }
    }
    if (!base && el.labels?.length) base = clean(el.labels[0].innerText);
    if (!base) base = clean(el.tagName === "INPUT" ? "" : el.innerText);
    if (!base) base = clean(el.getAttribute?.("placeholder") || el.getAttribute?.("title") || el.getAttribute?.("name"));
    return base;
  };

  /**
   * Retrouve l'élément visé. On essaie chaque piste dans l'ordre de fiabilité
   * et on rend la PREMIÈRE qui désigne un élément visible — un sélecteur CSS qui
   * matche un élément caché est presque toujours le mauvais.
   */
  function resolve(t) {
    if (!t) return null;
    const tries = [];

    if (typeof t === "string") tries.push(() => document.querySelector(t));
    else {
      if (t.testid) tries.push(() => document.querySelector(`[data-testid="${CSS.escape(t.testid)}"], [data-test="${CSS.escape(t.testid)}"], [data-cy="${CSS.escape(t.testid)}"]`));
      if (t.id) tries.push(() => document.getElementById(t.id));
      if (t.css) tries.push(() => document.querySelector(t.css));
      if (t.name) tries.push(() => document.querySelector(`[name="${CSS.escape(t.name)}"]`));
      if (t.placeholder) tries.push(() => document.querySelector(`[placeholder="${CSS.escape(t.placeholder)}"]`));

      // Rôle + nom accessible : la piste la plus robuste au re-design, parce
      // qu'elle décrit ce que l'utilisateur VOIT, pas comment c'est construit.
      if (t.label || t.text) {
        const wanted = clean(t.label || t.text).toLowerCase();
        const wantedRole = t.role;
        tries.push(() => {
          const all = Array.from(document.querySelectorAll("a,button,input,textarea,select,label,[role],[tabindex],[contenteditable='true']"));
          const scored = all.filter(isVisible).filter((el) => {
            if (wantedRole && roleOf(el) !== wantedRole) return false;
            const n = nameOf(el).toLowerCase();
            return n === wanted || (n.length > 2 && wanted.includes(n)) || (wanted.length > 2 && n.includes(wanted));
          });
          // L'égalité exacte prime sur l'inclusion.
          return scored.find((el) => nameOf(el).toLowerCase() === wanted) ?? scored[0] ?? null;
        });
      }
    }

    for (const fn of tries) {
      try {
        const el = fn();
        if (el && isVisible(el)) return el;
      } catch { /* sélecteur invalide : on passe à la piste suivante */ }
    }
    // Dernier recours : un élément trouvé mais invisible vaut mieux que rien —
    // l'appelant saura que le clic peut échouer.
    for (const fn of tries) {
      try { const el = fn(); if (el) return el; } catch { /* ignore */ }
    }
    return null;
  }

  const describe = (el) => ({
    tag: el.tagName?.toLowerCase(),
    role: roleOf(el),
    label: clip(nameOf(el), 80),
    visible: isVisible(el),
  });

  const notFound = (t) => ({
    ok: false,
    error: `Cible introuvable : ${JSON.stringify(t).slice(0, 200)}`,
    hint: "Utilise l'action 'elements' pour lister ce qui est réellement présent sur la page.",
  });

  // Les frameworks (React, Vue…) écoutent les événements natifs et ignorent une
  // affectation directe de .value. Il faut passer par le setter natif puis
  // émettre input+change, sinon le champ paraît rempli et le state reste vide.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  try {
    switch (action) {
      case "click": {
        const el = resolve(params.target);
        if (!el) return notFound(params.target);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        return { ok: true, clicked: describe(el), url: location.href };
      }

      case "fill": {
        const el = resolve(params.target);
        if (!el) return notFound(params.target);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        if (el.getAttribute("contenteditable") === "true") {
          el.textContent = String(params.value ?? "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          setNativeValue(el, String(params.value ?? ""));
        }
        return { ok: true, filled: describe(el) };
      }

      case "select": {
        const el = resolve(params.target);
        if (!el || el.tagName !== "SELECT") return notFound(params.target);
        const wanted = String(params.value ?? "").toLowerCase();
        const opt = Array.from(el.options).find(
          (o) => o.value.toLowerCase() === wanted || clean(o.text).toLowerCase() === wanted,
        );
        if (!opt) {
          return { ok: false, error: `Option « ${params.value} » absente`, options: Array.from(el.options).map((o) => clean(o.text)).slice(0, 40) };
        }
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: clean(opt.text) };
      }

      case "check": {
        const el = resolve(params.target);
        if (!el) return notFound(params.target);
        const want = params.value !== false && params.value !== "false";
        if (el.checked !== want) el.click();
        return { ok: true, checked: el.checked };
      }

      case "press": {
        const el = resolve(params.target) ?? document.activeElement ?? document.body;
        const key = String(params.value ?? "Enter");
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
        }
        // Entrée dans un champ de formulaire : les pages qui n'écoutent que le
        // submit ne réagiraient pas au seul événement clavier.
        if (key === "Enter" && el.form) el.form.requestSubmit?.();
        return { ok: true, pressed: key };
      }

      case "scroll": {
        const dir = String(params.value ?? "down");
        window.scrollBy({ top: dir === "up" ? -window.innerHeight * 0.8 : window.innerHeight * 0.8, behavior: "instant" });
        return { ok: true, scrollY: Math.round(window.scrollY) };
      }

      case "read": {
        const el = params.target ? resolve(params.target) : document.body;
        if (!el) return notFound(params.target);
        return {
          ok: true,
          url: location.href,
          title: document.title,
          text: clip(el.innerText, Number(params.limit) || 6000),
        };
      }

      case "find": {
        const needle = String(params.value ?? "").toLowerCase();
        const found = clean(document.body.innerText).toLowerCase().includes(needle);
        return { ok: true, found, url: location.href };
      }

      // Le pendant de l'action 'read' pour AGIR : la liste de ce qui est
      // cliquable, décrite comme l'enregistreur l'aurait décrit.
      case "elements": {
        const sel = params.selector || "a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[data-testid],[contenteditable='true']";
        const out = [];
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisible(el)) continue;
          const label = clip(nameOf(el), 70);
          if (!label && !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) continue;
          out.push({
            role: roleOf(el),
            label,
            testid: el.getAttribute("data-testid") || undefined,
            name: el.getAttribute("name") || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            value: el.type === "password" ? undefined : clip(el.value, 40) || undefined,
          });
          if (out.length >= 120) break;
        }
        return { ok: true, url: location.href, title: document.title, elements: out };
      }

      default:
        return { ok: false, error: `Action inconnue « ${action} »` };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
