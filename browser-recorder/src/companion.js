// companion.js — ce que le compagnon fait DANS la page.
//
// Deux fonctions, passées à chrome.scripting.executeScript comme `func` : Chrome
// en sérialise le source. Comme pour executor.js et coach.js, aucune référence
// extérieure — pas d'import, pas de constante de module, chaque fonction porte
// ses propres helpers, quitte à les dupliquer.
//
//   extractPage(opts)    lit la page : texte principal en markdown, titre, url,
//                        sélection. Les VALEURS des champs ne sont jamais lues,
//                        et ce qui ressemble à un secret est masqué ici, avant
//                        de quitter la page.
//
//   runCompanion(cmd)    l'overlay : surlignages, bulles, pastille de sélection,
//                        pointage d'un élément. Installé à la demande, jamais
//                        par le manifeste : panneau fermé et rien à afficher,
//                        il n'existe pas dans vos pages.
//
// Rien ici ne clique, ne saisit ni ne valide. Le compagnon montre et lit ; agir
// reste le canal `control`, avec son propre armement.

export function extractPage(opts) {
  const o = opts || {};
  const MAX = Math.min(Math.max(Number(o.maxChars) || 24000, 2000), 60000);
  const offset = Math.max(0, Number(o.offset) || 0);
  const clean = (s) => (s || "").replace(/[   ]/g, " ").replace(/[ \t\r\f\v]+/g, " ");

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME", "TEMPLATE", "INPUT", "SELECT",
    "TEXTAREA", "OPTION", "BUTTON", "OBJECT", "EMBED", "VIDEO", "AUDIO", "MAP", "DIALOG"]);
  const BLOCK = new Set(["DIV", "P", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "UL", "OL",
    "LI", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "FORM",
    "FIELDSET", "DL", "DT", "DD", "HR", "DETAILS", "SUMMARY", "ADDRESS", "CENTER", "BODY"]);
  const NOISE = /(^|[\s_-])(cookie|consent|gdpr|newsletter-popup|onetrust|didomi)/i;

  const hidden = (el) => {
    if (el.hasAttribute?.("data-fos-companion")) return true;
    if (el.getAttribute?.("aria-hidden") === "true") return true;
    if (typeof el.checkVisibility === "function") {
      try { return !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }); } catch { /* ancien navigateur */ }
    }
    return false;
  };
  const skip = (el) => SKIP.has(el.tagName) || hidden(el)
    || NOISE.test(`${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`);
  const isBlock = (el) => BLOCK.has(el.tagName) || (el.tagName.includes("-") && el.children.length > 0);

  function inline(node) {
    if (node.nodeType === 3) return clean(node.nodeValue);
    if (node.nodeType !== 1) return "";
    const el = node;
    if (skip(el)) return "";
    if (el.tagName === "BR") return "\n";
    if (el.tagName === "IMG") { const a = clean(el.getAttribute("alt")).trim(); return a ? ` [image : ${a}] ` : ""; }
    let inner = "";
    for (const c of el.childNodes) inner += inline(c);
    if (el.tagName === "A") {
      const t = inner.trim();
      const href = el.href || "";
      if (t && /^https?:/.test(href) && href.length < 160 && !href.startsWith(location.href + "#")) return ` [${t}](${href}) `;
      return inner;
    }
    if (el.tagName === "CODE") return inner.trim() ? `\`${inner.trim()}\`` : "";
    return inner;
  }

  const out = [];
  const push = (s) => { const t = (s || "").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(); if (t) out.push(t); };

  function table(el) {
    const rows = Array.from(el.querySelectorAll("tr")).slice(0, 60);
    if (!rows.length) return;
    const cells = rows.map((r) => Array.from(r.children).slice(0, 12).map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 100)));
    const width = Math.max(...cells.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    push([line(cells[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n"));
  }

  function list(el, depth, lines) {
    let i = 0;
    for (const li of el.children) {
      if (li.tagName !== "LI" || skip(li)) continue;
      i++;
      let text = "";
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
        else text += inline(c);
      }
      const bullet = el.tagName === "OL" ? `${i}.` : "-";
      const t = text.replace(/\s+/g, " ").trim();
      if (t) lines.push(`${"  ".repeat(depth)}${bullet} ${t}`);
      for (const n of nested) list(n, depth + 1, lines);
    }
  }

  function block(el) {
    if (skip(el)) return;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) { push(`${"#".repeat(Number(tag[1]))} ${inline(el).replace(/\s+/g, " ").trim()}`); return; }
    // Une liste reste d'un seul tenant : ses lignes ne passent pas par push(),
    // qui écraserait l'indentation des sous-niveaux.
    if (tag === "UL" || tag === "OL") {
      const lines = [];
      list(el, 0, lines);
      if (lines.length) out.push(lines.join("\n"));
      return;
    }
    if (tag === "TABLE") { table(el); return; }
    if (tag === "PRE") { const t = el.innerText || ""; if (t.trim()) push("```\n" + t.slice(0, 4000) + "\n```"); return; }
    if (tag === "HR") return;
    if (tag === "BLOCKQUOTE") { const t = inline(el).trim(); if (t) push(t.split("\n").map((l) => `> ${l}`).join("\n")); return; }
    // Contenu mixte : les nœuds en ligne consécutifs forment un paragraphe,
    // chaque enfant de bloc est traité pour lui-même.
    let run = "";
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && isBlock(c)) { push(run); run = ""; block(c); }
      else run += inline(c);
    }
    push(run);
  }

  // La racine : le contenu principal s'il est déclaré et consistant, sinon la
  // page entière. Une page de résultats sans <main> se lit quand même.
  const candidates = Array.from(document.querySelectorAll("main, [role=main], article"));
  let root = candidates.find((c) => !hidden(c) && (c.innerText || "").trim().length > 400) || document.body;
  if (!root) return { ok: false, error: "page vide" };
  block(root);

  let text = out.join("\n\n");
  // Ce qui ressemble à un secret ne quitte jamais la page.
  const MASK = "[masqué]";
  text = text
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, MASK)
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, MASK)
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, MASK)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, MASK)
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, MASK)
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK)
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, MASK)
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
      // Luhn : un numéro de commande de seize chiffres n'est pas une carte.
      const d = m.replace(/\D/g, "");
      let sum = 0;
      for (let i = 0; i < d.length; i++) {
        let n = Number(d[d.length - 1 - i]);
        if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
      }
      return sum % 10 === 0 ? MASK : m;
    });

  const total = text.length;
  const slice = text.slice(offset, offset + MAX);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }

  const meta = (n) => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.getAttribute("content") || "";
  let selection = "";
  try { selection = clean(String(window.getSelection() || "")).trim().slice(0, 6000); } catch { /* cadre isolé */ }

  return {
    ok: true,
    url: location.href,
    title: clean(document.title).trim().slice(0, 200),
    lang: document.documentElement.lang || "",
    description: clean(meta("description") || meta("og:description")).trim().slice(0, 300),
    site: clean(meta("og:site_name")).trim().slice(0, 80) || location.hostname,
    text: slice,
    chars: total,
    offset,
    truncated: offset + slice.length < total,
    hash: h.toString(16),
    selection,
  };
}

export function runCompanion(payload) {
  const cmd = payload || {};
  if (window.__fosCompanion && window.__fosCompanion.v === 1) return window.__fosCompanion.handle(cmd);

  const rt = (globalThis.browser ?? globalThis.chrome).runtime;
  const BLUE = "#006EDD";
  const clean = (s) => (s || "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plain = (md) => String(md || "")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ── L'hôte : un shadow root fermé, au-dessus de la page, sans la toucher ──
  const host = document.createElement("div");
  host.setAttribute("data-fos-companion", "1");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .mark { position: fixed; border-radius: 4px; background: rgba(0,110,221,.16); box-shadow: 0 0 0 2px rgba(0,110,221,.55);
        pointer-events: none; animation: fosPulse 1.8s ease-out 2; }
      .mark.el { background: rgba(0,110,221,.06); border-radius: 8px; }
      @keyframes fosPulse { 0% { box-shadow: 0 0 0 2px rgba(0,110,221,.55), 0 0 0 0 rgba(0,110,221,.35); }
        100% { box-shadow: 0 0 0 2px rgba(0,110,221,.55), 0 0 0 12px rgba(0,110,221,0); } }
      .badge { position: fixed; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: ${BLUE}; color: #fff;
        font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 6px; pointer-events: auto; cursor: default;
        box-shadow: 0 4px 14px rgba(15,23,40,.25); white-space: nowrap; max-width: 300px; }
      .badge span { overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
      .bar { position: fixed; top: 12px; right: 12px; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px;
        border-radius: 999px; background: #0F1728; color: #fff; font-size: 12px; pointer-events: auto; box-shadow: 0 10px 30px rgba(15,23,40,.35); }
      .bar button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.12); font-size: 12px; }
      .bar button:hover { background: rgba(255,255,255,.22); }
      .stack { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; width: 340px; max-width: calc(100vw - 32px); }
      .bubble { pointer-events: auto; width: 100%; background: #fff; color: #0F1728; border: 1px solid #E6E9EF; border-radius: 18px;
        box-shadow: 0 18px 50px rgba(15,23,40,.22); padding: 12px 14px; font-size: 13.5px; line-height: 1.5;
        animation: fosIn .22s ease-out; }
      .bubble.anchored { position: fixed; width: 300px; }
      @keyframes fosIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .av { width: 26px; height: 26px; border-radius: 999px; display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 600; flex: none; background-size: cover; background-position: center; }
      .who { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tag { font-size: 10.5px; font-weight: 600; color: ${BLUE}; background: rgba(0,110,221,.1); padding: 2px 8px; border-radius: 999px; flex: none; }
      .x { all: unset; cursor: pointer; color: #8A93A6; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
      .x:hover { color: #0F1728; background: #F2F4F8; }
      .body { white-space: pre-wrap; word-break: break-word; color: #2B3445; max-height: 220px; overflow: auto; }
      .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .btn { all: unset; cursor: pointer; font-size: 12px; font-weight: 500; padding: 6px 12px; border-radius: 999px; border: 1px solid #E6E9EF; color: #0F1728; }
      .btn:hover { background: #F2F4F8; }
      .btn.primary { background: ${BLUE}; border-color: ${BLUE}; color: #fff; }
      .btn.primary:hover { background: #0057C2; }
      .reply { display: none; margin-top: 10px; gap: 6px; }
      .reply.on { display: flex; }
      .reply input { flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 7px 12px; border: 1px solid #D5DAE3; border-radius: 999px; outline: none; color: #0F1728; background: #fff; }
      .reply input:focus { border-color: ${BLUE}; }
      .wait { margin-top: 8px; font-size: 12px; color: #6B7487; display: none; align-items: center; gap: 6px; }
      .wait.on { display: flex; }
      .dot { width: 6px; height: 6px; border-radius: 999px; background: ${BLUE}; animation: fosBlink 1s infinite; }
      @keyframes fosBlink { 50% { opacity: .25; } }
      .pill { position: fixed; display: none; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; background: #0F1728;
        box-shadow: 0 10px 28px rgba(15,23,40,.35); pointer-events: auto; }
      .pill.on { display: flex; }
      .pill button { all: unset; cursor: pointer; color: #fff; font-size: 12px; padding: 5px 10px; border-radius: 999px; white-space: nowrap; }
      .pill button:hover { background: rgba(255,255,255,.16); }
      .pill button.main { background: ${BLUE}; font-weight: 600; }
      .pill button.main:hover { background: #0057C2; }
      .pick { position: fixed; border: 2px solid ${BLUE}; border-radius: 6px; background: rgba(0,110,221,.08); pointer-events: none; display: none; transition: all .06s ease-out; }
      .pickhint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #0F1728; color: #fff; font-size: 12.5px;
        padding: 8px 14px; border-radius: 999px; pointer-events: none; display: none; box-shadow: 0 10px 30px rgba(15,23,40,.35); }
    </style>
    <div id="marks"></div>
    <div class="bar" id="bar" style="display:none"></div>
    <div class="pill" id="pill"></div>
    <div class="pick" id="pick"></div>
    <div class="pickhint" id="pickhint">Cliquez l'élément à envoyer au collaborateur · Échap pour annuler</div>
    <div class="stack" id="stack"></div>
  `;
  (document.body || document.documentElement).appendChild(host);
  const $ = (id) => root.getElementById(id);

  // ── Trouver ce dont on parle ──────────────────────────────────────────────
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
    if (tag === "input") return ["checkbox", "radio"].includes(type) ? type : (type === "submit" || type === "button") ? "button" : "textbox";
    return tag || "generic";
  };
  const nameOf = (el) => {
    let base = clean(el.getAttribute?.("aria-label"));
    if (!base && el.labels?.length) base = clean(el.labels[0].innerText);
    if (!base) base = clean(el.tagName === "INPUT" ? "" : el.innerText);
    if (!base) base = clean(el.getAttribute?.("placeholder") || el.getAttribute?.("title") || el.getAttribute?.("name"));
    return base;
  };

  function resolveElement(t) {
    const tries = [];
    if (t.testid) tries.push(() => document.querySelector(`[data-testid="${CSS.escape(t.testid)}"]`));
    if (t.css) tries.push(() => document.querySelector(t.css));
    if (t.label) {
      const wanted = clean(t.label).toLowerCase();
      tries.push(() => {
        const all = Array.from(document.querySelectorAll("a,button,input,textarea,select,label,summary,[role],[tabindex],[contenteditable='true'],h1,h2,h3,h4,th,td"));
        const hits = all.filter(isVisible).filter((el) => {
          if (t.role && roleOf(el) !== t.role) return false;
          const n = nameOf(el).toLowerCase();
          return n === wanted || (n.length > 2 && n.length < 120 && (n.includes(wanted) || wanted.includes(n)));
        });
        return hits.find((el) => nameOf(el).toLowerCase() === wanted) ?? hits[0] ?? null;
      });
    }
    for (const fn of tries) { try { const el = fn(); if (el && isVisible(el)) return el; } catch { /* sélecteur invalide */ } }
    return null;
  }

  /** Un passage de texte, retrouvé malgré les espaces, les retours à la ligne
   *  et les guillemets typographiques : un modèle recopie rarement à l'octet. */
  function resolveText(needleRaw) {
    const norm = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[   ]/g, " ");
    const words = norm(needleRaw).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(p.tagName) || p.closest("[data-fos-companion]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let full = "";
    const map = [];
    let prevSpace = true;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = norm(n.nodeValue);
      for (let i = 0; i < v.length; i++) {
        const ch = /\s/.test(v[i]) ? " " : v[i];
        if (ch === " " && prevSpace) continue;
        full += ch; map.push([n, i]); prevSpace = ch === " ";
      }
      if (!prevSpace) { full += " "; map.push([n, n.nodeValue.length]); prevSpace = true; }
    }
    // Phrase entière, puis des fenêtres plus courtes : une citation légèrement
    // reformulée garde presque toujours ses premiers mots intacts.
    const attempts = [words.join(" ")];
    for (let k = Math.min(words.length - 1, 14); k >= 4; k -= 2) attempts.push(words.slice(0, k).join(" "));
    for (const a of attempts) {
      const at = full.indexOf(a);
      if (at < 0) continue;
      const end = at + a.length - 1;
      if (!map[at] || !map[end]) continue;
      const range = document.createRange();
      try {
        range.setStart(map[at][0], map[at][1]);
        range.setEnd(map[end][0], Math.min(map[end][1] + 1, map[end][0].nodeValue.length));
        return range;
      } catch { /* nœud détaché */ }
    }
    return null;
  }

  // ── Surlignages ───────────────────────────────────────────────────────────
  let marks = [];
  let raf = 0;
  let agentName = "Collaborateur";

  function draw() {
    raf = 0;
    const layer = $("marks");
    layer.innerHTML = "";
    marks.forEach((m, i) => {
      let rects = [];
      try {
        rects = m.range ? Array.from(m.range.getClientRects()) : (m.el && m.el.isConnected ? [m.el.getBoundingClientRect()] : []);
      } catch { rects = []; }
      rects = rects.filter((r) => r.width > 1 && r.height > 1).slice(0, 12);
      if (!rects.length) return;
      for (const r of rects) {
        const d = document.createElement("div");
        d.className = m.range ? "mark" : "mark el";
        const pad = m.range ? 2 : 4;
        d.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
        layer.appendChild(d);
      }
      const first = rects[0];
      const b = document.createElement("div");
      b.className = "badge";
      b.innerHTML = `${i + 1}${m.note ? ` <span>${esc(m.note)}</span>` : ""}`;
      b.title = m.note || "";
      b.style.top = `${Math.max(4, first.top - 24)}px`;
      b.style.left = `${Math.max(4, Math.min(first.left - 4, innerWidth - 220))}px`;
      layer.appendChild(b);
    });
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);

  function renderBar() {
    const bar = $("bar");
    if (!marks.length) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    bar.innerHTML = `<span>${esc(agentName)} · ${marks.length} repère${marks.length > 1 ? "s" : ""}</span><button id="clear">Effacer</button>`;
    root.getElementById("clear").onclick = () => clearMarks();
  }
  function clearMarks() { marks = []; $("marks").innerHTML = ""; renderBar(); }

  function highlight(targets, agent) {
    if (agent) agentName = agent;
    marks = [];
    const missing = [];
    for (const t of (targets || []).slice(0, 8)) {
      if (!t || typeof t !== "object") continue;
      const label = t.text || t.label || t.css || t.testid || "";
      const range = t.text ? resolveText(String(t.text)) : null;
      const el = range ? null : resolveElement(t);
      if (!range && !el) { missing.push(String(label).slice(0, 80)); continue; }
      marks.push({ range, el, note: t.note ? String(t.note).slice(0, 80) : "" });
    }
    if (marks.length) {
      const m = marks[0];
      const r = m.range ? m.range.getBoundingClientRect() : m.el.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 60) {
        scrollBy({ top: r.top - innerHeight / 3, behavior: "smooth" });
      }
    }
    renderBar();
    draw();
    return { ok: true, shown: marks.length, missing };
  }

  // ── Bulles ────────────────────────────────────────────────────────────────
  const bubbles = new Map();

  function avatar(agent) {
    const a = agent || {};
    const color = /^#[0-9a-f]{3,8}$/i.test(a.accent_color || "") ? a.accent_color : BLUE;
    const initial = esc(clean(a.name || "C").charAt(0).toUpperCase());
    return a.avatar_url
      ? `<div class="av" style="background-image:url('${esc(a.avatar_url)}');background-color:${color}"></div>`
      : `<div class="av" style="background:${color}">${initial}</div>`;
  }

  function dismiss(key, notify) {
    const b = bubbles.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    b.node.remove();
    bubbles.delete(key);
    if (notify && b.item) rt.sendMessage({ type: "companion:bubble", action: "dismiss", item: b.item }).catch(() => {});
  }

  function armTimer(key, ms) {
    const b = bubbles.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      // Une bulle qu'on est en train de lire ou d'écrire ne s'en va pas.
      if (b.node.matches(":hover") || b.node.contains(root.activeElement)) armTimer(key, 6000);
      else dismiss(key, false);
    }, ms);
  }

  function bubble(item) {
    const it = item || {};
    // Une bulle par conversation : la réponse remplace « … réfléchit ».
    const key = it.conversation_id || it.id || String(Math.random());
    dismiss(key, false);
    const node = document.createElement("div");
    node.className = "bubble";
    const tag = it.kind === "approval" ? "À valider" : it.kind === "question" ? "Question" : it.kind === "say" ? "" : "Réponse";
    const text = plain(it.text);
    const long = text.length > 420;
    node.innerHTML = `
      <div class="head">${avatar(it.agent)}<div class="who">${esc(it.agent?.name || "Collaborateur")}</div>${tag ? `<span class="tag">${tag}</span>` : ""}<button class="x" title="Fermer">×</button></div>
      <div class="body">${esc(long ? text.slice(0, 420) + "…" : text)}</div>
      <div class="row">
        ${(it.options || []).slice(0, 6).map((o, i) => `<button class="btn" data-opt="${i}">${esc(o)}</button>`).join("")}
        ${it.conversation_id ? `<button class="btn primary" data-act="open">${it.kind === "approval" ? "Voir et valider" : long ? "Lire la suite" : "Ouvrir"}</button>` : ""}
        ${it.conversation_id && it.kind !== "approval" ? `<button class="btn" data-act="reply">Répondre</button>` : ""}
      </div>
      <div class="reply"><input placeholder="Votre réponse…" /><button class="btn primary" data-act="send">Envoyer</button></div>
      <div class="wait"><span class="dot"></span><span>${esc(it.agent?.name || "Le collaborateur")} réfléchit…</span></div>`;
    if (it.anchor) {
      node.classList.add("anchored");
      root.appendChild(node);
      const r = it.anchor;
      node.style.top = `${Math.min(innerHeight - 180, Math.max(8, r.bottom + 10))}px`;
      node.style.left = `${Math.min(innerWidth - 310, Math.max(8, r.left))}px`;
    } else {
      $("stack").appendChild(node);
    }
    bubbles.set(key, { node, item: it, timer: 0 });

    const send = (text) => {
      const t = String(text || "").trim();
      if (!t) return;
      node.querySelector(".reply").classList.remove("on");
      node.querySelector(".row").style.display = "none";
      node.querySelector(".wait").classList.add("on");
      rt.sendMessage({ type: "companion:bubble", action: "reply", item: it, text: t }).catch(() => {});
      armTimer(key, 120000);
    };
    node.querySelector(".x").onclick = () => dismiss(key, true);
    node.querySelectorAll("[data-opt]").forEach((b) => { b.onclick = () => send(it.options[Number(b.dataset.opt)]); });
    const open = node.querySelector('[data-act="open"]');
    if (open) open.onclick = () => { rt.sendMessage({ type: "companion:bubble", action: "open", item: it }).catch(() => {}); dismiss(key, false); };
    const reply = node.querySelector('[data-act="reply"]');
    const box = node.querySelector(".reply");
    const input = box.querySelector("input");
    if (reply) reply.onclick = () => { box.classList.toggle("on"); if (box.classList.contains("on")) input.focus(); };
    box.querySelector('[data-act="send"]').onclick = () => send(input.value);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // la page ne doit pas voir les touches de notre champ
      if (e.key === "Enter") { e.preventDefault(); send(input.value); }
      if (e.key === "Escape") box.classList.remove("on");
    });
    for (const ev of ["keyup", "keypress", "input"]) input.addEventListener(ev, (e) => e.stopPropagation());
    armTimer(key, it.kind === "approval" || it.kind === "question" ? 90000 : 40000);
    // Pas plus de trois bulles : la plus ancienne cède la place.
    const keys = [...bubbles.keys()];
    while (keys.length > 3) dismiss(keys.shift(), false);
    return { ok: true, shown: true };
  }

  function say(message, target, agent) {
    if (agent) agentName = agent;
    let anchor = null;
    if (target && typeof target === "object") {
      const range = target.text ? resolveText(String(target.text)) : null;
      const el = range ? null : resolveElement(target);
      if (range || el) {
        marks = [{ range, el, note: "" }];
        renderBar(); draw();
        anchor = (range || el).getBoundingClientRect();
      }
    }
    return bubble({ id: `say:${Date.now()}`, kind: "say", agent: { name: agentName }, text: message, anchor });
  }

  // ── Pastille de sélection (panneau ouvert seulement) ──────────────────────
  let selectionOn = false;
  let pillText = "";
  function hidePill() { $("pill").classList.remove("on"); pillText = ""; }
  function onSelect() {
    if (!selectionOn) return;
    setTimeout(() => {
      let sel;
      try { sel = window.getSelection(); } catch { return; }
      const text = clean(String(sel || ""));
      if (!sel || sel.rangeCount === 0 || text.length < 12) { hidePill(); return; }
      const anchorNode = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      if (anchorNode && anchorNode.closest && anchorNode.closest("input,textarea,[contenteditable='true']")) { hidePill(); return; }
      const rects = Array.from(sel.getRangeAt(0).getClientRects());
      const r = rects[rects.length - 1];
      if (!r) { hidePill(); return; }
      pillText = text.slice(0, 6000);
      const pill = $("pill");
      pill.innerHTML = `<button class="main" data-a="ask">Demander à ${esc(agentName)}</button><button data-a="explain">Expliquer</button><button data-a="summarize">Résumer</button><button data-a="translate">Traduire</button>`;
      pill.classList.add("on");
      const w = pill.offsetWidth || 320;
      pill.style.top = `${Math.min(innerHeight - 44, r.bottom + 8)}px`;
      pill.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w / 2))}px`;
      pill.querySelectorAll("button").forEach((b) => {
        b.onmousedown = (e) => e.preventDefault(); // garder la sélection visible
        b.onclick = () => {
          rt.sendMessage({ type: "companion:selection", action: b.dataset.a, text: pillText, url: location.href, title: document.title }).catch(() => {});
          hidePill();
        };
      });
    }, 0);
  }
  document.addEventListener("mouseup", onSelect, true);
  document.addEventListener("keyup", (e) => { if (e.shiftKey || e.key === "Shift") onSelect(); }, true);
  document.addEventListener("selectionchange", () => {
    if (!pillText) return;
    try { if (!clean(String(window.getSelection() || ""))) hidePill(); } catch { /* ignore */ }
  });
  addEventListener("scroll", () => { if (pillText) hidePill(); }, true);

  // ── Pointer un élément ────────────────────────────────────────────────────
  function pick() {
    return new Promise((done) => {
      const box = $("pick");
      const hint = $("pickhint");
      hint.style.display = "block";
      let current = null;
      const under = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        return el && el !== host ? el : null;
      };
      const move = (e) => {
        current = under(e);
        if (!current) { box.style.display = "none"; return; }
        const r = current.getBoundingClientRect();
        Object.assign(box.style, {
          display: "block", top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`,
        });
      };
      const finish = (value) => {
        removeEventListener("mousemove", move, true);
        removeEventListener("click", click, true);
        removeEventListener("keydown", key, true);
        box.style.display = "none";
        hint.style.display = "none";
        done(value);
      };
      const click = (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const el = under(e) || current;
        if (!el) return finish({ ok: false, cancelled: true });
        // Un clic sur une icône désigne presque toujours son bouton.
        const target = el.closest("a,button,[role=button],label,li,tr,article,section,figure,p,h1,h2,h3,h4,td") || el;
        const heading = (() => {
          let n = target;
          for (let i = 0; n && i < 8; i++, n = n.parentElement) {
            const h = n.querySelector?.("h1,h2,h3");
            if (h && h !== target) return clean(h.innerText).slice(0, 120);
          }
          return "";
        })();
        const path = [];
        for (let n = target; n && n.nodeType === 1 && path.length < 5; n = n.parentElement) {
          let s = n.tagName.toLowerCase();
          if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { s += `#${n.id}`; path.unshift(s); break; }
          const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter((c) => /^[A-Za-z][\w-]{1,30}$/.test(c)).slice(0, 2) : [];
          if (cls.length) s += "." + cls.join(".");
          path.unshift(s);
        }
        finish({
          ok: true,
          tag: target.tagName.toLowerCase(),
          role: roleOf(target),
          label: nameOf(target).slice(0, 160),
          text: clean(target.innerText || target.textContent || "").slice(0, 3000),
          href: target.href || target.closest?.("a")?.href || "",
          css: path.join(" > "),
          heading,
          url: location.href,
          title: document.title,
        });
        // Montrer ce qui a été pris : on le surligne le temps de l'envoi.
        marks = [{ range: null, el: target, note: "envoyé" }];
        renderBar(); draw();
        setTimeout(() => { if (marks.length === 1 && marks[0].el === target) clearMarks(); }, 2500);
      };
      const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish({ ok: false, cancelled: true }); } };
      addEventListener("mousemove", move, true);
      addEventListener("click", click, true);
      addEventListener("keydown", key, true);
    });
  }

  function teardown() {
    selectionOn = false;
    hidePill();
  }

  rt.onMessage.addListener((msg) => {
    if (msg?.type === "companion:teardown") teardown();
    if (msg?.type === "companion:selection_mode") { selectionOn = !!msg.on; if (!selectionOn) hidePill(); if (msg.agent) agentName = msg.agent; }
  });

  function handle(c) {
    if (c.agent) agentName = String(c.agent);
    switch (c.kind) {
      case "install": selectionOn = c.selection !== false; return { ok: true };
      case "selection_mode": selectionOn = !!c.on; if (!selectionOn) hidePill(); return { ok: true };
      case "highlight": return highlight(c.targets, c.agent);
      case "say": return say(c.message, c.target, c.agent);
      case "clear": clearMarks(); for (const k of [...bubbles.keys()]) dismiss(k, false); return { ok: true };
      case "bubble": return bubble(c.item);
      case "pick": return pick();
      case "teardown": teardown(); return { ok: true };
      default: return { ok: false, error: `commande inconnue : ${c.kind}` };
    }
  }

  window.__fosCompanion = { v: 1, handle };
  return handle(cmd);
}
