// Capture a structured, lightweight snapshot of the page the user is looking at,
// so the global assistant can answer about what's on screen. Extracts the route
// location, page title/headings, visible KPI/stat cards, tables, and the main
// visible text — robustly, without per-page wiring.

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r) return false;
  if (r.width === 0 && r.height === 0) return false;
  const style = window.getComputedStyle(el as HTMLElement);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function text(el: Element | null | undefined, max = 200): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Find the main content root (the <main> AppShell renders), falling back to body.
function contentRoot(): HTMLElement {
  return (document.querySelector("main") as HTMLElement) ?? document.body;
}

function extractHeadings(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("h1, h2, h3"))
    .filter(visible)
    .map((h) => `${h.tagName.toLowerCase()}: ${text(h, 120)}`)
    .filter((t) => t.length > 4)
    .slice(0, 25);
}

// Heuristic KPI/stat extraction: small cards where a large number sits next to a
// short label. We scan for elements that look like stat cards.
function extractStats(root: HTMLElement): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  // Candidate cards: elements with a class hint or a big-number child.
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[class*='card'], [class*='Card'], [class*='kpi'], [class*='stat'], [class*='metric']"))
    .filter(visible)
    .slice(0, 80);
  for (const card of cards) {
    const t = card.innerText?.replace(/\s+/g, " ").trim() ?? "";
    if (!t || t.length > 120) continue;
    // value = first number-ish token; label = the rest.
    const numMatch = t.match(/[$€£]?\s?-?[\d.,]+\s?[%KkMmBb]?/);
    if (!numMatch) continue;
    const value = numMatch[0].trim();
    const label = t.replace(value, "").replace(/\s+/g, " ").trim().slice(0, 60);
    const key = `${label}|${value}`;
    if (label && !seen.has(key)) { seen.add(key); out.push({ label, value }); }
    if (out.length >= 16) break;
  }
  return out;
}

function extractTables(root: HTMLElement): Array<{ columns: string[]; rows: string[][] }> {
  const tables: Array<{ columns: string[]; rows: string[][] }> = [];
  for (const table of Array.from(root.querySelectorAll("table")).filter(visible).slice(0, 3)) {
    const columns = Array.from(table.querySelectorAll("thead th, thead td")).map((c) => text(c, 40));
    const rows = Array.from(table.querySelectorAll("tbody tr"))
      .slice(0, 15)
      .map((tr) => Array.from(tr.querySelectorAll("td, th")).map((c) => text(c, 40)));
    if (rows.length) tables.push({ columns, rows });
  }
  return tables;
}

function mainText(root: HTMLElement): string {
  // Clone, strip nav/scripts, take the visible-ish text.
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style, svg, nav, [aria-hidden='true']").forEach((n) => n.remove());
  return (clone.innerText ?? "").replace(/\n{2,}/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, 2500);
}

export interface PageSnapshot {
  url: string;
  pageTitle: string;
  headings: string[];
  stats: Array<{ label: string; value: string }>;
  tables: Array<{ columns: string[]; rows: string[][] }>;
  mainText: string;
}

export function capturePageSnapshot(routeLabel?: string): PageSnapshot {
  const root = contentRoot();
  return {
    url: window.location.pathname,
    pageTitle: routeLabel || text(root.querySelector("h1")) || document.title,
    headings: extractHeadings(root),
    stats: extractStats(root),
    tables: extractTables(root),
    mainText: mainText(root),
  };
}

// Render the snapshot to a compact text block for the LLM prompt.
export function snapshotToText(s: PageSnapshot): string {
  const parts: string[] = [];
  parts.push(`Emplacement: ${s.url}`);
  if (s.pageTitle) parts.push(`Titre: ${s.pageTitle}`);
  if (s.headings.length) parts.push(`Sections visibles:\n${s.headings.map((h) => `- ${h}`).join("\n")}`);
  if (s.stats.length) parts.push(`Indicateurs/KPIs à l'écran:\n${s.stats.map((k) => `- ${k.label}: ${k.value}`).join("\n")}`);
  for (const t of s.tables) {
    parts.push(`Tableau (${t.columns.join(" | ")}):\n${t.rows.map((r) => r.join(" | ")).join("\n")}`);
  }
  if (s.mainText) parts.push(`Texte de la page (extrait):\n${s.mainText}`);
  return parts.join("\n\n");
}
