/**
 * A page that mounts ArtifactEditor on a fixture document, with no auth, no
 * router and no network — served by the dev server at /editor-harness.html.
 *
 * It exists because "the report goes blank" was diagnosed three times from
 * reading source and fixed three times without ever being observed. This is the
 * cheapest way to actually watch the editor mount: a headless browser opens the
 * page, reads `window.__harness`, and reports what survived.
 */
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { ArtifactEditor } from "@/features/artifacts/ArtifactEditor";
import { type ArtifactDocument } from "@/features/artifacts/blocks";
import "@/styles/globals.css";

/** One block of every type an agent can emit, in the shapes the skill teaches. */
const FIXTURE: ArtifactDocument = {
  blocks: [
    { type: "banner", data: { title: "Marchés affectés par l'IA", subtitle: "Analyse — août 2026" } },
    { type: "kpi", data: { items: [
      { label: "Marché 2026", value: "4,4 T$", delta: "+18 %", trend: "up" },
      { label: "Acteurs > 1 Md$", value: 7 },
    ] } },
    { type: "header", data: { text: "Ce que montrent les chiffres", level: 2 } },
    { type: "paragraph", data: { text: "Le marché se concentre : trois acteurs captent 71 % des revenus." } },
    { type: "list", data: { style: "unordered", items: ["Premier point", "Deuxième point"] } },
    { type: "checklist", data: { items: [{ text: "Vérifié auprès de la source", checked: true }] } },
    { type: "table", data: { withHeadings: true, content: [
      ["Acteur", "Part", "Source"],
      ["Rival A", "31 %", "IDC, mars 2026"],
      ["Rival B", "24 %", "IDC, mars 2026"],
    ] } },
    { type: "chart", data: {
      chartType: "bar", title: "Revenus par segment", x: "segment", series: ["revenus"],
      data: [{ segment: "Infrastructure", revenus: 142 }, { segment: "Modèles", revenus: 88 }],
    } },
    { type: "comparison", data: { columns: ["Nous", "Rival A"], highlight: 0, rows: [
      { label: "Tarif par siège", cells: ["29 $", "99 $"] },
      { label: "SSO inclus", cells: [true, false] },
    ] } },
    { type: "matrix", data: {
      xLabel: "Prix", yLabel: "Couverture", quadrants: ["Niche", "Leaders", "Généralistes", "Entrée"],
      items: [{ label: "Rival A", x: 85, y: 72 }],
    } },
    { type: "quote", data: { text: "La bascule est déjà faite.", caption: "Rapport annuel 2025", alignment: "left" } },
    { type: "warning", data: { title: "Réserve", message: "Deux sources divergent d'un facteur trois." } },
    { type: "code", data: { code: "select 1;" } },
    { type: "delimiter", data: {} },
    { type: "callout", data: { tone: "warning", text: "Nous retenons IDC, seule méthodologie publiée." } },
  ],
};

declare global {
  interface Window {
    __harness: { expected: number; errors: string[]; saved: number | null };
  }
}
window.__harness = { expected: FIXTURE.blocks.length, errors: [], saved: null };
window.addEventListener("error", (e) => window.__harness.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__harness.errors.push(String(e.reason)));

ReactDOM.createRoot(document.getElementById("root")!).render(
  // StrictMode ON PURPOSE: the app runs in it, and its double mount is exactly
  // what broke the editor. A harness without it certifies the wrong thing.
  <StrictMode>
    <div className="mx-auto max-w-[900px] px-8 py-8">
    <ArtifactEditor doc={FIXTURE} onChange={(d) => { window.__harness.saved = d.blocks.length; }} />
    </div>
  </StrictMode>,
);
