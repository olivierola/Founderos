// Report Artisan — the report engine, ported from the skill's build_report.py.
//
// A report is written ONCE, as a content document (title + blocks), and built
// into ONE self-contained HTML file: CSS, runtime, Editor.js bundle and content
// all inlined, so it opens from disk, survives being emailed, and prints to PDF
// with no network. That file is the deliverable.
//
// Two builds from the same document:
//   editable (default) — carries the Editor.js bundle + the toolbar, ~450 kB.
//                        The recipient clicks into the text and fixes a typo.
//   static (--static)  — no editor, no toolbar, ~90 kB. What you send a client.
//
// The 450 kB of assets live in `report_artisan_assets` (seeded by migration),
// NOT in this module: every function that imports the agent toolset would
// otherwise carry them into its bundle. They are fetched once per isolate.
//
// Keep in step with report-artisan-src/ — that folder is the source the
// asset migration is generated from, and its references/*.md are what the agent
// reads. A change to the schema here that is not written there is a change the
// agent will never know about.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---------------------------------------------------------------------------
// The content document
// ---------------------------------------------------------------------------

export interface ReportBlock { type: string; data: Record<string, unknown> }

/** A cited source. Declared ONCE at the root; blocks cite it by name, so a URL
 *  and an icon are written once and every citation of them stays in step. */
export interface ReportSource {
  name: string;
  url?: string;
  /** Filled by resolveSourceIcons at build time — a data URI, never a link, so
   *  the file still shows its marks offline and in a mail client. */
  icon?: string;
}

export interface ReportDoc {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  accent?: string;
  typeface?: string;
  theme?: string;
  locale?: string;
  lang?: string;
  footer?: string;
  meta?: Record<string, string>;
  heroBanner?: Record<string, unknown>;
  sources?: ReportSource[];
  blocks?: ReportBlock[];
}

export const BLOCK_TYPES = [
  "paragraph", "lead", "header", "list", "checklist", "table", "quote", "delimiter",
  "banner", "chart", "kpis", "callout", "figure", "sources",
] as const;
export const CHART_TYPES = ["bar", "hbar", "line", "area", "stackedBar", "donut"] as const;
export const ACCENTS = ["blue", "indigo", "teal", "green", "amber", "rose", "plum", "slate"] as const;
export const BANNER_STYLES = [
  "aurora", "waves", "grid", "topo", "dots", "prism", "ribbon",
  "strata", "arcs", "blueprint", "glow", "bars",
] as const;
export const TYPEFACES = ["editorial", "modern"] as const;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?'
  + "family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1"
  + '&display=swap" rel="stylesheet">';

// ---------------------------------------------------------------------------
// Normalisation — let the author write the short form
// ---------------------------------------------------------------------------

interface ListItem { content: string; meta: Record<string, unknown>; items: ListItem[] }

/** The Editor.js list tool wants every item as {content, meta, items}. Writing
 *  that by hand is tedious and easy to get wrong, so plain strings are accepted
 *  and filled in here — same tolerance as the Python builder. */
function normItems(items: unknown): ListItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const it = (typeof raw === "string" ? { content: raw } : (raw ?? {})) as Record<string, unknown>;
    return {
      content: typeof it.content === "string" ? it.content : String(it.content ?? ""),
      meta: (it.meta && typeof it.meta === "object" ? it.meta : {}) as Record<string, unknown>,
      items: normItems(it.items),
    };
  });
}

export function normalizeReportDoc(input: ReportDoc): ReportDoc {
  const doc: ReportDoc = { ...input };
  doc.blocks = (Array.isArray(input.blocks) ? input.blocks : []).map((raw) => {
    const b: ReportBlock = { type: String(raw?.type ?? ""), data: { ...(raw?.data ?? {}) } };
    const d = b.data;
    // `{"type":"paragraph","data":{"lead":true}}` is the shape a model reaches
    // for when it has read "lead" in the schema but not the block list.
    if (b.type === "paragraph" && d.lead) { delete d.lead; b.type = "lead"; }
    if (b.type === "list") {
      if (!d.style) d.style = "unordered";
      if (!d.meta) d.meta = {};
      d.items = normItems(d.items);
    } else if (b.type === "checklist") {
      d.items = (Array.isArray(d.items) ? d.items : []).map((it) =>
        typeof it === "string"
          ? { text: it, checked: false }
          : {
            text: String((it as Record<string, unknown>)?.text ?? ""),
            checked: Boolean((it as Record<string, unknown>)?.checked),
          });
    } else if (b.type === "table") {
      if (d.withHeadings === undefined) d.withHeadings = true;
    }
    return b;
  });
  return doc;
}

// ---------------------------------------------------------------------------
// Validation — warnings guide, errors stop the build
// ---------------------------------------------------------------------------

export interface Validation { errors: string[]; warnings: string[] }

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A block's identity, for spotting one that is already in the document.
 *
 * A model that does not see its own effect repeats itself, and a retried round
 * replays the call it had already made — either way the same KPI row lands four
 * times and the reader scrolls through the same four tiles over and over. Keys
 * are sorted so two writings of the same object compare equal.
 */
export function blockKey(b: ReportBlock): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canon(o[k]);
        return acc;
      }, {});
    }
    return typeof v === "string" ? v.trim() : v;
  };
  return JSON.stringify([String(b?.type ?? ""), canon(b?.data ?? {})]);
}

/** Types a document may legitimately repeat verbatim. Everything else that
 *  arrives twice is a repetition, not a rhythm. */
export const REPEATABLE_BLOCKS = new Set(["delimiter"]);

/**
 * What a reader recognises as "I have already seen this", ignoring the wording
 * around it. Null when the block has no such identity.
 *
 * `blockKey` compares a block verbatim, which a second writing defeats by
 * changing one word — and a second writing is exactly what the loop produces:
 * the author has no way to CORRECT a block it has already added (there is no
 * replace tool), so when validation says "cette rangée n'a pas de variation",
 * its only move is to send the row again with the deltas filled in. Two KPI
 * strips, same figures, different notes — which is what the reader was seeing.
 *
 * Only blocks whose identity is unambiguous are listed here. Headings are
 * deliberately absent: "Constats" under two different parts is a legitimate
 * repetition, and collapsing those would eat a real section.
 */
export function blockSubstanceKey(b: ReportBlock): string | null {
  const d = (b?.data ?? {}) as Record<string, unknown>;
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  switch (String(b?.type ?? "")) {
    case "kpis": {
      // The tiles' labels and figures ARE the row; deltas, notes and captions
      // are the decoration a rewrite rephrases freely.
      const tiles = (list(d.items) as Array<Record<string, unknown>>)
        .map((k) => `${norm(k?.label)}=${norm(k?.value)}${norm(k?.unit)}`)
        .filter((s) => s !== "=");
      return tiles.length ? `kpis:${tiles.sort().join("|")}` : null;
    }
    case "chart": {
      // Same figures plotted the same way. The title is in (a chart re-titled
      // over identical data is still the same chart), the caption is not.
      const series = (list(d.series) as Array<Record<string, unknown>>)
        .map((s) => `${norm(s?.name)}[${list(s?.data).map(norm).join(",")}]`);
      const items = (list(d.items) as Array<Record<string, unknown>>)
        .map((i) => `${norm(i?.label ?? i?.name)}=${norm(i?.value)}`);
      const body = [...series, ...items].sort().join("|");
      return body ? `chart:${norm(d.type) || "bar"}:${norm(d.title)}:${list(d.categories).map(norm).join(",")}:${body}` : null;
    }
    case "table": {
      const rows = (list(d.content) as unknown[][]).map((r) => list(r).map(norm).join(""));
      return rows.length ? `table:${rows.join("")}` : null;
    }
    default:
      return null;
  }
}

/** One block, checked on its own — so `report_add_block` can refuse a malformed
 *  block on the spot. A block accepted now and dropped at build time is a
 *  paragraph the author believes they wrote. */
export function validateBlock(b: ReportBlock, i: number): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = String(b?.type ?? "");
  const d = (b?.data ?? {}) as Record<string, unknown>;
  const where = `blocs[${i}] (${t || "sans type"})`;

  if (!(BLOCK_TYPES as readonly string[]).includes(t)) {
    errors.push(`${where} : type de bloc inconnu ; autorisés : ${BLOCK_TYPES.join(", ")}.`);
    return { errors, warnings };
  }
  if (t === "chart") {
    const ct = text(d.type) || "bar";
    if (!(CHART_TYPES as readonly string[]).includes(ct)) {
      errors.push(`${where} : type de graphique « ${ct} » inconnu ; autorisés : ${CHART_TYPES.join(", ")}.`);
    }
    const series = list(d.series) as Array<Record<string, unknown>>;
    const cats = list(d.categories);
    if (ct === "donut") {
      if (list(d.items).length === 0 && series.length === 0) {
        errors.push(`${where} : un donut exige \`items\` ou une série unique.`);
      }
    } else {
      if (cats.length === 0) errors.push(`${where} : \`categories\` est requis.`);
      if (series.length === 0) errors.push(`${where} : \`series\` est requis.`);
      for (const s of series) {
        const pts = list(s?.data).length;
        if (pts !== cats.length) {
          errors.push(`${where} : la série « ${text(s?.name) || "?"} » a ${pts} points pour ${cats.length} catégories.`);
        }
      }
    }
    if (series.length > 8) {
      errors.push(`${where} : ${series.length} séries — la palette en tient 8 ; replie la queue dans « Autres » ou coupe le graphique en deux.`);
    }
    if (ct === "hbar") {
      const longest = cats.reduce((m: number, c) => Math.max(m, String(c).length), 0);
      if (longest > 34) {
        warnings.push(`${where} : un libellé de catégorie fait ${longest} caractères — il sera tronqué à 34. Raccourcis-le ou déplace le détail dans la légende.`);
      }
    }
    if (d.showValues && series.length > 1) {
      warnings.push(`${where} : \`showValues\` avec ${series.length} séries — les étiquettes se chevauchent dans la bande et sont supprimées. L'infobulle les porte déjà.`);
    }
    if (ct === "donut" && list(d.items).length > 6) {
      warnings.push(`${where} : ${list(d.items).length} parts dans un donut — au-delà de six, un \`hbar\` se lit mieux.`);
    }
    if (!text(d.title).trim()) warnings.push(`${where} : pas de \`title\` — un graphique sans titre laisse deviner le lecteur.`);
    if (!text(d.caption).trim()) warnings.push(`${where} : pas de \`caption\` — dis ce que le graphique MONTRE, pas ce qu'il est.`);
  }
  if (t === "banner") {
    const st = text(d.style);
    if (st && !(BANNER_STYLES as readonly string[]).includes(st)) {
      errors.push(`${where} : style de bannière « ${st} » inconnu ; autorisés : ${BANNER_STYLES.join(", ")}.`);
    }
  }
  if (t === "kpis") {
    const items = list(d.items) as Array<Record<string, unknown>>;
    if (items.length === 0) errors.push(`${where} : aucun item.`);
    else if (items.length > 5) warnings.push(`${where} : ${items.length} tuiles — au-delà de quatre, ça cesse d'être un coup d'œil.`);
    // A tile is roughly 170px wide; long strings wrap and unbalance the row.
    const caps: Array<[string, number]> = [["label", 26], ["deltaLabel", 14], ["deltaNote", 14], ["note", 34]];
    items.forEach((k, j) => {
      for (const [field, cap] of caps) {
        const val = k?.[field];
        if (typeof val === "string" && val.length > cap) {
          warnings.push(`${where} : item ${j} \`${field}\` fait ${val.length} caractères (garde-le sous ~${cap}) — il passera à la ligne.`);
        }
      }
      if (k?.delta === undefined && !text(k?.deltaLabel).trim()) {
        warnings.push(`${where} : item ${j} n'a pas de variation (\`delta\` ou \`deltaLabel\`) — un chiffre sans point de comparaison ne dit rien.`);
      }
    });
  }
  if (t === "table") {
    const content = list(d.content);
    if (content.length === 0) errors.push(`${where} : \`content\` est vide.`);
    const widths = new Set(content.map((r) => list(r).length));
    if (widths.size > 1) errors.push(`${where} : les lignes n'ont pas toutes le même nombre de cellules (${[...widths].join(", ")}).`);
  }
  if (t === "figure" && !text(d.src).trim() && !text(d.alt).trim()) {
    warnings.push(`${where} : ni \`src\` ni \`alt\` — le substitut sera vide.`);
  }
  if (t === "callout" && !text(d.text).trim()) {
    errors.push(`${where} : \`text\` est requis.`);
  }
  if ((t === "paragraph" || t === "lead" || t === "header") && !text(d.text).trim()) {
    errors.push(`${where} : \`text\` est requis.`);
  }
  if ((t === "list" || t === "checklist") && list(d.items).length === 0) {
    errors.push(`${where} : \`items\` est vide.`);
  }
  if (t === "sources" && list(d.items).length === 0) {
    errors.push(`${where} : \`items\` est vide — cite au moins une source, par son nom tel qu'il est déclaré à la racine.`);
  }
  return { errors, warnings };
}

export function validateReportDoc(doc: ReportDoc): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!text(doc.title).trim()) errors.push("`title` est requis — il devient le <h1> du rapport.");
  if (doc.accent && !(ACCENTS as readonly string[]).includes(doc.accent)) {
    errors.push(`accent « ${doc.accent} » inconnu ; choisis parmi ${ACCENTS.join(", ")}.`);
  }
  if (doc.typeface && !(TYPEFACES as readonly string[]).includes(doc.typeface)) {
    errors.push(`typeface « ${doc.typeface} » inconnu ; choisis "editorial" ou "modern".`);
  }
  const hero = doc.heroBanner as Record<string, unknown> | undefined;
  const heroStyle = text(hero?.style);
  if (hero && heroStyle && !(BANNER_STYLES as readonly string[]).includes(heroStyle)) {
    errors.push(`heroBanner.style « ${heroStyle} » inconnu ; choisis parmi ${BANNER_STYLES.join(", ")}.`);
  }
  if (hero && text(hero?.title).trim() && text(hero?.title).trim() === text(doc.title).trim()) {
    warnings.push("heroBanner.title répète `title` — la bannière porte la conclusion, le titre nomme le document.");
  }

  const sources = list(doc.sources) as ReportSource[];
  const declared = new Set(sources.map((s) => text(s?.name).trim().toLowerCase()).filter(Boolean));
  sources.forEach((s, i) => {
    if (!text(s?.name).trim()) errors.push(`sources[${i}] : \`name\` est requis.`);
    const url = text(s?.url).trim();
    if (url && !/^https?:\/\//i.test(url)) {
      errors.push(`sources[${i}] (${text(s?.name)}) : \`url\` doit être une adresse http(s) complète.`);
    }
    if (!url) {
      warnings.push(`sources[${i}] (${text(s?.name)}) : pas d'\`url\` — la marque ne sera pas cliquable et n'aura pas de logo.`);
    }
  });

  const blocks = list(doc.blocks) as ReportBlock[];
  if (blocks.length === 0) errors.push("`blocks` est vide — un rapport a besoin de contenu.");

  let charts = 0;
  let cited = 0;
  blocks.forEach((b, i) => {
    if (b?.type === "chart") charts += 1;
    const v = validateBlock(b, i);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
    // A citation naming a source the document never declared still renders (as a
    // monogram), but it loses its link and its logo — which is the whole point.
    if (b?.type === "sources") {
      cited += 1;
      for (const it of list((b.data ?? {}).items)) {
        const name = (typeof it === "string" ? it : text((it as ReportSource)?.name)).trim();
        const inline = typeof it === "object" && text((it as ReportSource)?.url).trim();
        if (name && !inline && declared.size > 0 && !declared.has(name.toLowerCase())) {
          warnings.push(`blocs[${i}] (sources) : « ${name} » n'est pas déclarée dans \`sources\` — pas de lien ni de logo pour elle.`);
        }
      }
    }
  });

  if (sources.length > 0 && cited === 0) {
    warnings.push(`${sources.length} source(s) déclarée(s) mais aucune citée dans le corps — pose un bloc sources après les passages qu'elles appuient.`);
  }

  if (charts === 0) {
    warnings.push("Aucun graphique dans le rapport. S'il y a des chiffres dans le texte, l'un d'eux veut probablement devenir un graphique.");
  }
  const callouts = blocks.filter((b) => b?.type === "callout").length;
  if (callouts > Math.max(1, Math.ceil(blocks.length / 6))) {
    warnings.push(`${callouts} encadrés pour ${blocks.length} blocs — au-delà d'un par section, le lecteur cesse de les voir.`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface ReportAssets { css: string; runtime: string; shell: string; vendor: string }

/** One fetch per isolate. The rows are ~450 kB together, so a report built in a
 *  warm isolate costs nothing and a cold one costs a single round trip. */
let assetCache: ReportAssets | null = null;

export async function loadReportAssets(admin: SupabaseClient): Promise<ReportAssets> {
  if (assetCache) return assetCache;
  const { data, error } = await admin
    .from("report_artisan_assets")
    .select("name, content")
    .in("name", ["report.css", "runtime.js", "shell.html", "editorjs.bundle.js"]);
  if (error) throw new Error(`assets du moteur de rapport illisibles : ${error.message}`);
  const rows = (data ?? []) as Array<{ name?: unknown; content?: unknown }>;
  const byName = new Map<string, string>(
    rows.map((r) => [String(r.name ?? ""), String(r.content ?? "")]),
  );
  const need = (n: string): string => {
    const v = byName.get(n);
    if (!v) throw new Error(`asset « ${n} » manquant dans report_artisan_assets — la migration du moteur de rapport n'a pas été appliquée.`);
    return v;
  };
  // Built whole, then cached: assigning field by field would leave a half-filled
  // cache behind if one asset is missing, and the NEXT call would return it.
  const loaded: ReportAssets = {
    css: need("report.css"),
    runtime: need("runtime.js"),
    shell: need("shell.html"),
    vendor: need("editorjs.bundle.js"),
  };
  assetCache = loaded;
  return loaded;
}

// ---------------------------------------------------------------------------
// Source marks
// ---------------------------------------------------------------------------

/** Favicons are fetched ONCE, at build time, and inlined. A report that linked
 *  to an icon host would show a row of broken squares the moment it is opened
 *  offline or from a mail client — which is most of the time. */
const ICON_TIMEOUT_MS = 5_000;
const MAX_ICON_BYTES = 32_000;
const MAX_ICONS = 16;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toDataUri(bytes: Uint8Array, mime: string): string {
  // btoa over a spread array blows the argument limit on real payloads.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

async function fetchIcon(host: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ICON_TIMEOUT_MS);
  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
    const mime = res.headers.get("content-type")?.split(";")[0] || "image/png";
    if (!mime.startsWith("image/")) return null;
    return toDataUri(buf, mime);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill in each source's icon, in place. Best-effort by design: a source whose
 * mark cannot be fetched renders as a tinted monogram, which is a citation that
 * still works — failing the build over a favicon would be absurd.
 */
export async function resolveSourceIcons(doc: ReportDoc): Promise<{ resolved: number; missed: string[] }> {
  const sources = (list(doc.sources) as ReportSource[]).slice(0, MAX_ICONS);
  const missed: string[] = [];
  let resolved = 0;
  await Promise.all(sources.map(async (s) => {
    if (!s || text(s.icon).startsWith("data:")) { if (s?.icon) resolved += 1; return; }
    const host = hostOf(text(s.url));
    if (!host) { missed.push(text(s.name) || "?"); return; }
    const icon = await fetchIcon(host);
    if (icon) { s.icon = icon; resolved += 1; } else missed.push(text(s.name) || host);
  }));
  return { resolved, missed };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `String.replace` interprets `$&`, `$'` and friends inside the REPLACEMENT.
 *  The runtime bundle and the content JSON are full of `$`, so every
 *  substitution goes through a function replacer — a string one silently
 *  corrupts the output. */
const put = (haystack: string, token: string, value: string): string =>
  haystack.replaceAll(token, () => value);

export function buildReportHtml(doc: ReportDoc, assets: ReportAssets, opts: { static?: boolean } = {}): string {
  const isStatic = opts.static === true;
  const payload = JSON.stringify(doc).replace(/<\//g, "<\\/");

  let out = assets.shell;
  if (isStatic) {
    // Strip the toolbar from the TEMPLATE, before anything is inlined — doing it
    // afterwards means the pattern can match inside runtime.js.
    out = out.replace(/<!--RA_BAR_START-->[\s\S]*?<!--RA_BAR_END-->/g, "");
  }
  out = put(out, "<!--RA_BAR_START-->", "");
  out = put(out, "<!--RA_BAR_END-->", "");

  const title = text(doc.title).trim() || "Rapport";
  const scalars: Array<[string, string]> = [
    ["__LANG__", escapeHtml(text(doc.lang) || "fr")],
    ["__THEME__", doc.theme === "dark" ? "dark" : "light"],
    ["__ACCENT__", (ACCENTS as readonly string[]).includes(text(doc.accent)) ? text(doc.accent) : "blue"],
    ["__TYPEFACE__", (TYPEFACES as readonly string[]).includes(text(doc.typeface)) ? text(doc.typeface) : "editorial"],
    // Escaped, unlike the Python builder: this title is written by a model, and
    // it lands both in <title> and in the toolbar's text node.
    ["__TITLE__", escapeHtml(title)],
    ["__FONTS__", FONTS],
    ["__FONTS_JSON__", JSON.stringify(FONTS)],
  ];
  for (const [k, v] of scalars) out = put(out, k, v);

  // Big payloads last.
  for (const [k, v] of [
    ["__CSS__", assets.css],
    ["__VENDOR__", isStatic ? "" : assets.vendor],
    ["__RUNTIME__", assets.runtime],
    ["__DOC__", payload],
  ] as Array<[string, string]>) out = put(out, k, v);

  return out;
}

/** Plain text for search, previews and AI grounding — the reader's first screen,
 *  flattened. */
export function reportPreviewText(doc: ReportDoc): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").trim();
  const parts: string[] = [text(doc.title), text(doc.subtitle)];
  for (const b of list(doc.blocks) as ReportBlock[]) {
    const d = (b?.data ?? {}) as Record<string, unknown>;
    if (b.type === "lead" || b.type === "paragraph" || b.type === "header") parts.push(text(d.text));
    else if (b.type === "callout") parts.push(text(d.text));
    else if (b.type === "chart") parts.push([text(d.title), text(d.caption)].filter(Boolean).join(" — "));
    else if (b.type === "kpis") {
      for (const k of list(d.items) as Array<Record<string, unknown>>) {
        parts.push([text(k?.label), String(k?.value ?? "")].filter(Boolean).join(" : "));
      }
    }
  }
  return parts.map(strip).filter(Boolean).join("\n").slice(0, 4000);
}

/** How many blocks of each kind — used to tell the caller what it got back
 *  without shipping the whole document into its context. */
export function reportShape(doc: ReportDoc): string {
  const counts = new Map<string, number>();
  for (const b of list(doc.blocks) as ReportBlock[]) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${n} ${t}`).join(", ");
}
