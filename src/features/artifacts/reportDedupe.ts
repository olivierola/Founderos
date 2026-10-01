// Display-time twin of the report engine's duplicate guard
// (supabase/functions/_shared/report-artisan.ts: blockKey, sameSubstance,
// tidyBlocks). The server now refuses rewritten duplicates before the file is
// built; this pass cleans the reports that were built BEFORE that, straight
// from the document the file embeds — no regeneration needed.
//
// Keep the rules in step with the server: identical blocks go; KPI rows whose
// figures mostly coincide are one row (the later writing wins, in the first
// one's place); empty text blocks and runs of delimiters go.

type Block = { type?: string; data?: Record<string, unknown> };

const REPEATABLE = new Set(["delimiter"]);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canon(o[k]); return acc; }, {});
  }
  return typeof v === "string" ? v.trim() : v;
}
const blockKey = (b: Block) => JSON.stringify([String(b?.type ?? ""), canon(b?.data ?? {})]);

function kpiFigures(b: Block): string[] | null {
  if (String(b?.type ?? "") !== "kpis") return null;
  return (list(b?.data?.items) as Array<Record<string, unknown>>)
    .map((k) => `${String(k?.value ?? "")}${String(k?.unit ?? "")}`
      .toLowerCase().replace(/[\s  ]+/g, "").replace(/[‐‑‒–—−]/g, "-").replace(/,/g, "."))
    .filter(Boolean);
}

function sameKpiRow(a: Block, b: Block): boolean {
  const fa = kpiFigures(a), fb = kpiFigures(b);
  if (!fa || !fb) return false;
  const small = fa.length <= fb.length ? fa : fb;
  const big = new Set(fa.length <= fb.length ? fb : fa);
  if (small.length < 2) return false;
  const shared = small.filter((f) => big.has(f)).length;
  return shared >= 2 && shared >= Math.ceil(small.length * 0.6);
}

function blank(b: Block): boolean {
  const t = String(b?.type ?? "");
  if (t !== "paragraph" && t !== "header" && t !== "quote") return false;
  return !String(b?.data?.text ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

/** Blocks as a reader should get them. Returns the same array untouched when
 *  there is nothing to fix. */
export function dedupeReportBlocks<T extends Block>(blocks: T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const b of blocks) {
    if (blank(b)) continue;
    if (REPEATABLE.has(String(b?.type))) {
      if (kept.length === 0 || kept[kept.length - 1]?.type === "delimiter") continue;
      kept.push(b);
      continue;
    }
    const k = blockKey(b);
    if (seen.has(k)) continue;
    seen.add(k);
    const at = kept.findIndex((x) => sameKpiRow(x, b));
    if (at >= 0) { kept[at] = b; continue; }
    kept.push(b);
  }
  while (kept.length && kept[kept.length - 1]?.type === "delimiter") kept.pop();
  return kept.length === blocks.length ? blocks : kept;
}
