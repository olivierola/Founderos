/**
 * Plain text for the PDF.
 *
 * Every producer writes inline HTML into its text fields (<b>, <i>, <a>, <mark>,
 * <br>, entities). A PDF component takes a string, and a tag left in it is
 * printed as-is — "<b>68 %</b>" on paper. The emphasis is lost here, the words
 * are not.
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–", euro: "€",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", middot: "·",
};

export function htmlToText(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = typeof input === "string" ? input : String(input);
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A cell value of any shape, as one line of text. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Oui" : "Non";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return htmlToText(v);
}

/** Markdown down to readable prose: headings, emphasis and link syntax go,
 *  their words stay. Enough for dashboard notes, which are short. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .trim();
}

export function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A safe file name from a title. */
export function pdfFileName(title: string): string {
  const base = (title || "document")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 80).toLowerCase();
  return `${base || "document"}.pdf`;
}
