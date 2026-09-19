// coach.js — ce que le formé VOIT.
//
// Le pendant exact de executor.js, et son contraire : là où l'exécuteur clique
// à la place de la personne, le coach pose un repère sur le bouton, écrit la
// phrase, et ATTEND qu'elle clique elle-même. C'est toute la différence entre
// faire le travail et former quelqu'un.
//
// Comme `runCommand`, `runCoach` est passée à chrome.scripting.executeScript
// comme `func` : Chrome en SÉRIALISE LE SOURCE. Aucune référence extérieure —
// pas d'import, pas de constante de module, pas de helper partagé avec
// executor.js même quand le code se ressemble. La résolution de cible est donc
// dupliquée, volontairement : la factoriser casserait l'injection.
//
// LE RETOUR EST EN DEUX TEMPS, et c'est le point de conception important :
//   1. la valeur rendue par `runCoach` dit seulement si le repère a pu être
//      POSÉ (cible trouvée, overlay affiché) — c'est immédiat ;
//   2. ce que la personne FAIT arrive bien plus tard, par un
//      chrome.runtime.sendMessage("coach:outcome").
// Attendre l'humain dans la valeur de retour aurait lié le sort de l'étape à
// celui du service worker, que MV3 décharge après ~30 s d'inactivité — soit
// exactement le temps qu'il faut à quelqu'un pour lire une page inconnue.

export function runCoach(payload) {
  const { kind, command_id: commandId, step = {}, session = {} } = payload || {};

  // ── Ré-entrance ───────────────────────────────────────────────────────────
  // Un coach existe déjà dans cette page (étape précédente, ou ré-injection
  // après un rechargement) : on le réutilise plutôt que d'empiler deux
  // overlays. Sans ça, chaque étape laisserait son cercle derrière elle.
  if (window.__fosCoach && window.__fosCoach.version === 1) {
    return window.__fosCoach.handle({ kind, commandId, step, session });
  }

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) + "…" : t; };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
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

  /** Même ordre de fiabilité que l'exécuteur : ce qui a été démontré doit
   *  pouvoir être RE-DÉSIGNÉ, pas seulement re-cliqué. */
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
          return scored.find((el) => nameOf(el).toLowerCase() === wanted) ?? scored[0] ?? null;
        });
      }
    }
    for (const fn of tries) {
      try { const el = fn(); if (el && isVisible(el)) return el; } catch { /* sélecteur invalide */ }
    }
    return null;
  }

  /**
   * Une application moderne peint sa page APRÈS le chargement : viser une
   * cible à l'instant où l'ordre arrive la manquerait une fois sur deux. On
   * réessaie donc pendant quelques secondes, réveillé par les mutations du DOM
   * plutôt que par un intervalle — c'est ce qui fait la différence entre « le
   * bouton n'existe pas » et « le bouton n'existait pas encore ».
   */
  function resolveSoon(t, budgetMs) {
    return new Promise((done) => {
      const first = resolve(t);
      if (first) return done(first);
      let settled = false;
      const finish = (el) => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearTimeout(timer);
        clearInterval(tick);
        done(el);
      };
      const attempt = () => { const el = resolve(t); if (el) finish(el); };
      const obs = new MutationObserver(attempt);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      // Un rendu en canvas ou dans un shadow root ne produit pas toujours de
      // mutation observable : un battement lent sert de filet.
      const tick = setInterval(attempt, 400);
      const timer = setTimeout(() => finish(null), budgetMs);
    });
  }

  // ── L'overlay ─────────────────────────────────────────────────────────────
  // Tout vit dans un shadow root : la page peut avoir n'importe quel CSS, un
  // reset agressif, un z-index de 2 milliards — rien de tout ça ne traverse.

  const host = document.createElement("div");
  host.id = "founderos-coach";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }

      /* Le halo : un seul élément, dont l'ombre EXTÉRIEURE assombrit tout le
         reste de la page. Un calque plein aurait fallu percer, et le trou
         aurait dû suivre la cible au pixel près à chaque scroll. */
      .ring {
        position: fixed; border-radius: 10px; pointer-events: none;
        border: 2px solid #7C5CFF;
        box-shadow: 0 0 0 4px rgba(124,92,255,.28), 0 0 0 9999px rgba(9,9,14,.42);
        transition: top .18s cubic-bezier(.4,0,.2,1), left .18s cubic-bezier(.4,0,.2,1),
                    width .18s cubic-bezier(.4,0,.2,1), height .18s cubic-bezier(.4,0,.2,1);
        opacity: 0;
      }
      .ring.on { opacity: 1; }
      .ring::after {
        content: ""; position: absolute; inset: -6px; border-radius: 14px;
        border: 2px solid rgba(124,92,255,.55); animation: pulse 1.9s ease-out infinite;
      }
      @keyframes pulse {
        0%   { transform: scale(1);    opacity: .8; }
        70%  { transform: scale(1.09); opacity: 0; }
        100% { transform: scale(1.09); opacity: 0; }
      }

      .bubble {
        position: fixed; width: 330px; max-width: calc(100vw - 24px);
        background: #14141c; color: #f4f4f7; border: 1px solid #2c2c3a;
        border-radius: 14px; padding: 14px 15px 12px;
        box-shadow: 0 18px 48px rgba(0,0,0,.55);
        pointer-events: auto; font-size: 13.5px; line-height: 1.5;
        opacity: 0; transform: translateY(4px);
        transition: opacity .18s ease, transform .18s ease, top .18s, left .18s;
      }
      .bubble.on { opacity: 1; transform: translateY(0); }
      .arrow {
        position: absolute; width: 12px; height: 12px; background: #14141c;
        border-left: 1px solid #2c2c3a; border-top: 1px solid #2c2c3a;
        transform: rotate(45deg);
      }
      .arrow.up   { top: -7px; }
      .arrow.down { bottom: -7px; transform: rotate(225deg); }

      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
      .avatar {
        width: 22px; height: 22px; border-radius: 7px; flex: none;
        display: grid; place-items: center; font-size: 12px;
        background: linear-gradient(140deg, #7C5CFF, #4f3fd8);
      }
      .who { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: #b9b9c8; flex: 1; min-width: 0;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .count { font-size: 11px; color: #8b8b9c; font-variant-numeric: tabular-nums; flex: none; }

      .title { font-size: 12px; font-weight: 600; color: #a99cff; margin-bottom: 3px; }
      .instruction { font-size: 14px; font-weight: 500; color: #f4f4f7; }
      .tip {
        margin-top: 9px; padding: 8px 10px; border-radius: 9px;
        background: rgba(124,92,255,.12); border: 1px solid rgba(124,92,255,.22);
        font-size: 12.5px; color: #d6d2ff;
      }
      .tip b { color: #fff; font-weight: 600; }

      .actions { display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap; }
      button {
        font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
        padding: 6px 11px; border-radius: 8px; border: 1px solid #33334a;
        background: #1e1e2b; color: #e9e9f2; transition: background .12s, border-color .12s;
      }
      button:hover { background: #262636; border-color: #45455e; }
      button.primary { background: #7C5CFF; border-color: #7C5CFF; color: #fff; }
      button.primary:hover { background: #8d70ff; }
      button.icon { padding: 5px 7px; line-height: 1; }
      .spacer { flex: 1; }

      /* La carte de session : elle reste quand le repère bouge. C'est elle qui
         dit qu'une formation est en cours, et par qui. */
      .dock {
        position: fixed; right: 18px; bottom: 18px; width: 268px;
        background: #14141c; color: #f4f4f7; border: 1px solid #2c2c3a;
        border-radius: 13px; padding: 11px 13px 12px; pointer-events: auto;
        box-shadow: 0 14px 40px rgba(0,0,0,.5); font-size: 12.5px;
      }
      .dock .prog { height: 3px; border-radius: 3px; background: #2a2a3a; margin-top: 9px; overflow: hidden; }
      .dock .prog i { display: block; height: 100%; background: #7C5CFF; transition: width .3s ease; }
      .dock .name { font-size: 12.5px; font-weight: 600; margin-bottom: 1px; }
      .dock .sub { font-size: 11px; color: #8b8b9c; }
      .dock .row { display: flex; align-items: center; gap: 8px; }
      .dock .tools { display: flex; gap: 4px; margin-top: 9px; }
      .done-mark { color: #4ade80; font-weight: 600; }
    </style>
    <div class="ring" id="ring"></div>
    <div class="bubble" id="bubble"></div>
    <div class="dock" id="dock" style="display:none"></div>
  `;
  (document.body || document.documentElement).appendChild(host);

  const $ring = root.getElementById("ring");
  const $bubble = root.getElementById("bubble");
  const $dock = root.getElementById("dock");

  const coach = {
    version: 1,
    // L'étape en cours, et l'unique chose qui compte : a-t-on déjà rendu compte ?
    // Un double compte rendu écraserait le premier verdict par le second.
    current: null,
    muted: (() => { try { return localStorage.getItem("__fos_coach_mute") === "1"; } catch { return false; } })(),
  };
  window.__fosCoach = coach;

  // ── Voix ──────────────────────────────────────────────────────────────────
  // « Lui dire quoi faire » au sens propre : quelqu'un qui cherche un bouton a
  // les yeux occupés, et l'oreille libre. Coupable d'un clic, et retenu.
  function speak(text) {
    if (coach.muted || !text) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 240));
      u.lang = "fr-FR";
      u.rate = 1.02;
      synth.speak(u);
    } catch { /* la synthèse vocale n'est pas partout : ce n'est pas bloquant */ }
  }
  function hush() { try { window.speechSynthesis?.cancel(); } catch { /* idem */ } }

  // ── Compte rendu ──────────────────────────────────────────────────────────
  function report(outcome, extra) {
    const cur = coach.current;
    if (!cur || cur.reported) return;
    cur.reported = true;
    detach(cur);
    try {
      const sent = chrome.runtime.sendMessage({
        type: "coach:outcome",
        command_id: cur.commandId,
        outcome,
        url: location.href,
        duration_ms: Date.now() - cur.startedAt,
        hints: cur.hints,
        ...(extra || {}),
      });
      // L'étape a pu expirer pendant qu'on cherchait le bouton. Le dire vaut
      // mieux que laisser quelqu'un cliquer « C'est fait » sur une bulle qui
      // ne répond plus à personne — le silence, ici, ressemble à une panne.
      sent?.then?.((r) => { if (r && r.stale === true) markStale(); }, () => {});
    } catch { /* extension rechargée : le service worker périmera l'étape */ }
  }

  /** L'étape n'attend plus : on retire les boutons plutôt que de les laisser
   *  mentir, et on dit ce qui se passe. */
  function markStale() {
    const acts = root.getElementById("acts");
    if (!acts) return;
    acts.innerHTML = "";
    const p = document.createElement("div");
    p.className = "count";
    p.textContent = "Cette étape a expiré — l'agent revient vers vous.";
    acts.appendChild(p);
  }

  function detach(cur) {
    if (!cur) return;
    (cur.listeners || []).forEach(([t, ev, fn, opt]) => { try { t.removeEventListener(ev, fn, opt); } catch { /* noeud parti */ } });
    cur.listeners = [];
    if (cur.raf) cancelAnimationFrame(cur.raf);
    cur.raf = null;
  }

  // ── Placement ─────────────────────────────────────────────────────────────
  // Le repère doit SUIVRE : les pages défilent, les listes se replient, les
  // modales poussent le contenu. Une position calculée une fois est fausse dès
  // le premier coup de molette.
  function place(cur) {
    const el = cur.el;
    if (!el || !el.isConnected) {
      // La cible a disparu du DOM. Souvent parce que la personne vient de
      // faire ce qu'on lui demandait (le menu s'est fermé) — d'où l'aveu
      // plutôt que l'acharnement.
      $ring.classList.remove("on");
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    $ring.style.top = `${r.top - pad}px`;
    $ring.style.left = `${r.left - pad}px`;
    $ring.style.width = `${r.width + pad * 2}px`;
    $ring.style.height = `${r.height + pad * 2}px`;
    $ring.classList.add("on");

    const bh = $bubble.offsetHeight || 150;
    const bw = $bubble.offsetWidth || 330;
    const below = r.bottom + 14;
    const fitsBelow = below + bh < window.innerHeight - 8;
    const top = fitsBelow ? below : Math.max(8, r.top - bh - 14);
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - bw - 10));
    $bubble.style.top = `${top}px`;
    $bubble.style.left = `${left}px`;

    const arrow = root.getElementById("arrow");
    if (arrow) {
      arrow.className = `arrow ${fitsBelow ? "up" : "down"}`;
      arrow.style.left = `${Math.max(12, Math.min(r.left + r.width / 2 - left - 6, bw - 24))}px`;
    }
  }

  /** Sans cible : la bulle se pose au-dessus de la carte de session, là où
   *  l'œil la cherchera de toute façon. */
  function placeFloating() {
    $ring.classList.remove("on");
    const bh = $bubble.offsetHeight || 140;
    $bubble.style.left = `${Math.max(10, window.innerWidth - 348)}px`;
    $bubble.style.top = `${Math.max(10, window.innerHeight - bh - ($dock.style.display === "none" ? 18 : $dock.offsetHeight + 30))}px`;
  }

  /** Le repère suit sa cible tant qu'il est à l'écran — y compris après avoir
   *  rendu compte : un message qui reste affiché doit rester bien placé quand
   *  la page défile. C'est `detach` (compte rendu, remplacement, fermeture) qui
   *  arrête la boucle, pas le fait d'avoir répondu. */
  function follow(cur) {
    const loop = () => {
      if (coach.current !== cur) return;
      if (cur.el) place(cur); else placeFloating();
      cur.raf = requestAnimationFrame(loop);
    };
    cur.raf = requestAnimationFrame(loop);
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderDock(s) {
    if (!s || !s.program) { $dock.style.display = "none"; return; }
    const pct = s.total ? Math.round(((s.step ?? 0) / s.total) * 100) : 0;
    $dock.style.display = "";
    $dock.innerHTML = `
      <div class="row">
        <div class="avatar">${esc(s.emoji || "🎓")}</div>
        <div style="min-width:0;flex:1">
          <div class="name">${esc(clip(s.program, 40))}</div>
          <div class="sub">${esc(s.agent || "Formation")}${s.total ? ` · étape ${s.step ?? 0}/${s.total}` : ""}</div>
        </div>
      </div>
      <div class="prog"><i style="width:${pct}%"></i></div>
      <div class="tools">
        <button class="icon" id="dock-mute" title="Voix">${coach.muted ? "🔇" : "🔊"}</button>
        <div class="spacer" style="flex:1"></div>
        <button id="dock-quit">Quitter</button>
      </div>
    `;
    $dock.querySelector("#dock-mute").addEventListener("click", () => {
      coach.muted = !coach.muted;
      try { localStorage.setItem("__fos_coach_mute", coach.muted ? "1" : "0"); } catch { /* mode privé */ }
      if (coach.muted) hush();
      renderDock(coach.session);
    });
    $dock.querySelector("#dock-quit").addEventListener("click", () => {
      report("quit", { note: "la personne a quitté la formation" });
      teardown();
    });
  }

  function renderBubble(cur) {
    const st = cur.step;
    const s = coach.session || {};
    const choices = Array.isArray(st.choices) ? st.choices.slice(0, 5) : [];
    $bubble.innerHTML = `
      ${cur.el ? '<div class="arrow up" id="arrow"></div>' : ""}
      <div class="head">
        <div class="avatar">${esc(s.emoji || "🎓")}</div>
        <div class="who">${esc(s.agent || "Formateur")}</div>
        ${st.step && st.total ? `<div class="count">${esc(st.step)}/${esc(st.total)}</div>` : ""}
      </div>
      ${st.title ? `<div class="title">${esc(st.title)}</div>` : ""}
      <div class="instruction">${esc(st.instruction || "")}</div>
      ${st.tip ? `<div class="tip"><b>Astuce</b> · ${esc(st.tip)}</div>` : ""}
      <div class="actions" id="acts"></div>
    `;
    const acts = $bubble.querySelector("#acts");
    const btn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener("click", fn);
      acts.appendChild(b);
      return b;
    };

    if (choices.length) {
      choices.forEach((c, i) => btn(String(c), i === 0 ? "primary" : "", () => report("answered", { answer: String(c) })));
    } else if (cur.kind === "step") {
      // Le bouton « c'est fait » n'est PAS un doublon de la détection
      // automatique : celle-ci ne voit pas tout (glisser-déposer, canvas,
      // iframe d'un autre domaine). Sans lui, une étape non détectable
      // bloquerait la formation entière.
      btn(cur.gesture === "none" ? "Continuer" : "C'est fait", "primary", () => report("done", { note: "confirmé manuellement" }));
      btn("Je suis bloqué", "", () => {
        cur.hints += 1;
        report("stuck", { note: "la personne demande de l'aide" });
      });
      btn("Passer", "", () => report("skipped"));
    } else if (cur.kind === "say" && st.ack) {
      btn(st.ack_label || "Compris", "primary", () => report("done"));
    }

    const sp = document.createElement("div");
    sp.className = "spacer";
    acts.appendChild(sp);
    btn(coach.muted ? "🔇" : "🔊", "icon", (e) => {
      coach.muted = !coach.muted;
      try { localStorage.setItem("__fos_coach_mute", coach.muted ? "1" : "0"); } catch { /* mode privé */ }
      if (coach.muted) hush(); else speak(st.instruction);
      e.target.textContent = coach.muted ? "🔇" : "🔊";
      renderDock(coach.session);
    });

    $bubble.classList.add("on");
  }

  // ── Détection du geste ────────────────────────────────────────────────────
  // C'est ce qui fait qu'on n'a pas à demander « avez-vous cliqué ? ». On
  // écoute en phase de CAPTURE : beaucoup d'applications arrêtent la
  // propagation de leurs propres clics.
  function watch(cur) {
    const el = cur.el;
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); cur.listeners.push([t, ev, fn, opt]); };

    if (cur.gesture === "click" || cur.gesture === "check") {
      on(document, "click", (e) => {
        if (!el) return;
        const path = e.composedPath ? e.composedPath() : [e.target];
        if (path.includes(el) || el.contains(e.target)) {
          // Un instant de grâce : l'application doit avoir le temps de réagir
          // avant qu'on démonte le repère, sinon le clic paraît sans effet.
          setTimeout(() => report("done"), 120);
        }
      }, true);
      return;
    }

    if (cur.gesture === "fill" || cur.gesture === "select") {
      const expected = clean(cur.step.value || "").toLowerCase();
      const check = () => {
        const v = clean(el.value ?? el.textContent ?? "").toLowerCase();
        if (!v) return;
        // Avec une valeur attendue, on ne valide que si elle y est : c'est ce
        // qui permet de rattraper une faute de frappe au lieu de la laisser
        // partir en base.
        if (expected && !v.includes(expected) && !expected.includes(v)) return;
        report("done", { typed: clip(el.type === "password" ? "" : (el.value ?? ""), 60) });
      };
      on(el, "change", check);
      on(el, "blur", check);
      // La saisie se valide à la pause, pas à chaque touche : sinon « Marie »
      // serait accepté dès le « M ».
      let t = null;
      on(el, "input", () => { clearTimeout(t); t = setTimeout(check, 1100); });
      return;
    }

    if (cur.gesture === "keypress") {
      const key = cur.step.value || "Enter";
      on(document, "keydown", (e) => { if (e.key === key) setTimeout(() => report("done"), 120); }, true);
    }
    // gesture "navigate" et "none" : le service worker tranche (changement
    // d'URL de l'onglet), ou la personne clique « C'est fait ».
  }

  function teardown() {
    detach(coach.current);
    coach.current = null;
    hush();
    try { host.remove(); } catch { /* déjà parti */ }
    delete window.__fosCoach;
  }

  // ── Le point d'entrée réutilisé à chaque ordre ────────────────────────────
  async function handle({ kind, commandId, step, session }) {
    // Une nouvelle étape remplace la précédente. Si celle-ci attendait encore,
    // c'est que l'agent a décidé d'avancer : on le dit, pour que le journal ne
    // garde pas une étape éternellement ouverte.
    if (coach.current && !coach.current.reported) report("superseded");
    detach(coach.current);
    coach.current = null;

    if (session && Object.keys(session).length) coach.session = { ...(coach.session || {}), ...session };

    if (kind === "end") {
      const msg = step.instruction || "Formation terminée.";
      speak(msg);
      $bubble.innerHTML = `
        <div class="head"><div class="avatar">${esc(coach.session?.emoji || "🎓")}</div>
        <div class="who">${esc(coach.session?.agent || "Formateur")}</div></div>
        <div class="instruction"><span class="done-mark">✓</span> ${esc(msg)}</div>`;
      $bubble.classList.add("on");
      $ring.classList.remove("on");
      renderDock(null);
      placeFloating();
      setTimeout(teardown, 6000);
      return { ok: true, ended: true };
    }

    const cur = {
      kind, commandId, step,
      gesture: step.gesture || (step.target ? "click" : "none"),
      startedAt: Date.now(),
      hints: 0,
      reported: false,
      listeners: [],
      el: null,
    };
    coach.current = cur;
    renderDock(coach.session);

    if (step.target) {
      cur.el = await resolveSoon(step.target, Number(step.find_ms) || 5000);
      if (coach.current !== cur) return { ok: false, superseded: true };
      if (!cur.el) {
        // On ne fait pas semblant : sans repère, l'instruction serait « cliquez
        // sur un bouton que je ne vois pas ». L'agent doit re-viser.
        cur.reported = true;
        coach.current = null;
        $bubble.classList.remove("on");
        $ring.classList.remove("on");
        return {
          ok: false,
          reason: "target_not_found",
          url: location.href,
          title: document.title,
          hint: "Appelle guide_user action=\"look\" pour lire ce qui est à l'écran, puis re-vise avec un libellé réellement présent.",
        };
      }
      cur.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    renderBubble(cur);
    if (cur.el) place(cur); else placeFloating();
    follow(cur);
    watch(cur);
    speak(step.instruction);

    const shown = {
      ok: true,
      shown: true,
      url: location.href,
      waiting: kind === "step" || (kind === "say" && !!step.ack),
      target: cur.el ? { tag: cur.el.tagName?.toLowerCase(), role: roleOf(cur.el), label: clip(nameOf(cur.el), 60) } : null,
    };

    // Un simple message n'attend personne : il est délivré, point. C'est le
    // service worker qui, à la lecture de `waiting`, décide s'il doit garder
    // l'étape en suspens ou rendre compte tout de suite. Le repère, lui, reste
    // affiché — et suivi — jusqu'à l'étape suivante : `reported` neutralise
    // seulement le compte rendu qu'une écoute résiduelle tenterait d'envoyer.
    if (!shown.waiting) cur.reported = true;
    return shown;
  }

  coach.handle = handle;
  coach.teardown = teardown;
  coach.reportExternal = (outcome, extra) => report(outcome, extra);

  // Un ordre de guidage peut arriver alors que la personne a changé de page :
  // le service worker ré-injecte, et c'est cette écoute qui reçoit la suite
  // sans repasser par une nouvelle injection.
  try {
    chrome.runtime.onMessage.addListener((msg, _s, respond) => {
      if (msg?.type === "coach:show") { handle(msg.payload || {}).then(respond); return true; }
      if (msg?.type === "coach:resolve") { report(msg.outcome || "done", msg.extra); respond({ ok: true }); return false; }
      if (msg?.type === "coach:teardown") { teardown(); respond({ ok: true }); return false; }
      return false;
    });
  } catch { /* pas de canal : l'injection par ordre suffit */ }

  return handle({ kind, commandId, step, session });
}
