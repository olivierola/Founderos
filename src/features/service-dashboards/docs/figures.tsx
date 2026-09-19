import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InfoIcon, LightbulbIcon, WarningIcon } from "@phosphor-icons/react";

/**
 * Les figures de la documentation.
 *
 * Elles sont DESSINÉES et non photographiées, et c'est le choix structurant de
 * tout ce dossier.
 *
 * Une capture d'écran est une photographie d'un instant : elle porte le thème
 * de celui qui l'a prise, ses données, la largeur de sa fenêtre, et la version
 * du produit ce jour-là. Trois mois plus tard elle montre une interface qui
 * n'existe plus, et le lecteur ne sait pas si c'est lui qui se trompe d'écran
 * ou le manuel qui a vieilli. Multipliée par quarante pages, elle devient une
 * dette qu'on ne rembourse jamais.
 *
 * Un schéma dit autre chose : il montre la STRUCTURE — où se trouve quoi, ce
 * qui est groupé avec quoi — et il se moque du détail. Il suit le thème du
 * lecteur, se redimensionne, et reste juste tant que l'organisation ne change
 * pas, ce qui arrive bien plus rarement qu'un changement de couleur.
 *
 * Les captures gardent une place, mais une seule : montrer un rendu qu'aucun
 * schéma ne peut restituer honnêtement (une vraie page de rapport, un canevas
 * peuplé). Ces emplacements-là sont déclarés par `<Shot />`, qui affiche un
 * cadre nommé tant que l'image n'est pas fournie — un manque visible vaut
 * mieux qu'un trou silencieux.
 */

// ── Enveloppes ──────────────────────────────────────────────────────────────

export function Figure({
  caption, children, className,
}: { caption?: string; children: ReactNode; className?: string }) {
  return (
    <figure className={cn("my-5", className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-muted/20 p-4">
        {children}
      </div>
      {caption && (
        <figcaption className="mt-2 text-12 leading-snug text-tertiary">{caption}</figcaption>
      )}
    </figure>
  );
}

/**
 * L'emplacement d'une capture d'écran réelle.
 *
 * Tant qu'aucune image n'est déposée, le cadre affiche CE QU'IL FAUT
 * photographier et où. C'est délibérément voyant : une documentation à trous
 * invisibles se publie sans qu'on s'en aperçoive.
 */
export function Shot({
  file, alt, ratio = "16 / 9",
}: { file: string; alt: string; ratio?: string }) {
  return (
    <figure className="my-5">
      <div
        className="flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-muted/30 p-6 text-center"
        style={{ aspectRatio: ratio }}
      >
        <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-11 text-tertiary">
          {file}
        </span>
        <span className="max-w-md text-12 leading-snug text-tertiary">{alt}</span>
      </div>
      <figcaption className="mt-2 text-12 leading-snug text-tertiary">{alt}</figcaption>
    </figure>
  );
}

export function Callout({
  kind = "note", title, children,
}: { kind?: "note" | "tip" | "warn"; title?: string; children: ReactNode }) {
  const meta = kind === "tip"
    ? { Icon: LightbulbIcon, cls: "border-emerald-500/30 bg-emerald-500/8", ic: "text-emerald-600" }
    : kind === "warn"
      ? { Icon: WarningIcon, cls: "border-amber-500/30 bg-amber-500/8", ic: "text-amber-600" }
      : { Icon: InfoIcon, cls: "border-primary/25 bg-primary/8", ic: "text-primary" };

  return (
    <div className={cn("my-4 flex gap-2.5 rounded-lg border px-3.5 py-3", meta.cls)}>
      <meta.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.ic)} />
      <div className="min-w-0 space-y-1 text-13 leading-relaxed">
        {title && <p className="font-medium">{title}</p>}
        <div className="text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="my-4 space-y-2.5 [counter-reset:step]">
      {children}
    </ol>
  );
}

export function Step({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-13 leading-relaxed text-muted-foreground [counter-increment:step]">
      <span
        aria-hidden
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-11 font-medium tabular-nums text-foreground before:content-[counter(step)]"
      />
      <span className="min-w-0 [&_strong]:font-medium [&_strong]:text-foreground">{children}</span>
    </li>
  );
}

/** Un terme de l'interface, cité tel qu'il s'affiche. */
export function Ui({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-border/70 bg-muted/50 px-1 py-px text-[0.92em] font-medium text-foreground">
      {children}
    </span>
  );
}

export function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-11 shadow-raised-100">
      {children}
    </kbd>
  );
}

// ── Primitives de schéma ────────────────────────────────────────────────────
//
// Toutes les figures sont bâties avec ces quatre briques : une barre de titre,
// un bloc gris, une pastille et une carte. Le vocabulaire réduit est voulu —
// il fait que deux schémas de deux pages différentes se lisent pareil.

function Bar({ w = "60%", tone = "mid" }: { w?: string; tone?: "strong" | "mid" | "soft" }) {
  return (
    <span
      className={cn(
        "block h-1.5 rounded-full",
        tone === "strong" ? "bg-foreground/45" : tone === "mid" ? "bg-foreground/22" : "bg-foreground/10",
      )}
      style={{ width: w }}
    />
  );
}

function Pill({ color, w = 22 }: { color: string; w?: number }) {
  return <span className="block h-1.5 rounded-full" style={{ width: w, background: color }} />;
}

function MiniCard({
  title = "70%", color, tag, className,
}: { title?: string; color?: string; tag?: string; className?: string }) {
  return (
    <div className={cn("space-y-1.5 rounded-md border border-border/70 bg-card p-2 shadow-raised-100", className)}>
      <Bar w={title} tone="strong" />
      <Bar w="45%" tone="soft" />
      <div className="flex items-center gap-1 pt-0.5">
        {color && <Pill color={color} />}
        {tag && <span className="text-[8px] font-medium text-tertiary">{tag}</span>}
        <span className="flex-1" />
        <span className="h-3 w-3 rounded-full bg-foreground/12" />
      </div>
    </div>
  );
}

const HUE = {
  urgent: "#dc2626", high: "#ea580c", medium: "#ca8a04", low: "#2563eb",
  design: "#a855f7", back: "#0ea5e9", front: "#22c55e",
};

// ── Les figures ─────────────────────────────────────────────────────────────

/** L'architecture de l'écran : rail, panneau, contenu. */
export function ShellFigure() {
  return (
    <div className="flex h-56 gap-2 text-[9px]">
      <div className="flex w-11 shrink-0 flex-col items-center gap-2 rounded-lg border border-border bg-card py-2">
        <span className="h-5 w-5 rounded-md bg-primary/25" />
        <span className="h-5 w-5 rounded-md bg-foreground/25" />
        <span className="h-5 w-5 rounded-md bg-foreground/10" />
        <span className="h-5 w-5 rounded-md bg-foreground/10" />
        <span className="flex-1" />
        <span className="h-5 w-5 rounded-md bg-foreground/10" />
        <span className="h-5 w-5 rounded-full bg-foreground/20" />
      </div>

      <div className="w-32 shrink-0 space-y-2 rounded-lg border border-border bg-muted/40 p-2">
        <Bar w="55%" tone="strong" />
        <div className="space-y-1.5 pt-1">
          <div className="rounded bg-foreground/10 px-1.5 py-1"><Bar w="70%" /></div>
          <div className="px-1.5 py-1"><Bar w="55%" tone="soft" /></div>
          <div className="px-1.5 py-1"><Bar w="62%" tone="soft" /></div>
          <div className="pl-4 pr-1.5 py-1"><Bar w="48%" tone="soft" /></div>
          <div className="pl-4 pr-1.5 py-1"><Bar w="52%" tone="soft" /></div>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-2 rounded-lg border border-border bg-card p-2.5">
        <div className="flex items-center gap-1.5 border-b border-border pb-2">
          <Bar w="30%" tone="strong" />
          <span className="flex-1" />
          <span className="h-3 w-8 rounded bg-foreground/10" />
          <span className="h-3 w-8 rounded bg-foreground/10" />
        </div>
        <div className="space-y-1.5">
          {[80, 65, 72, 58, 68].map((w, i) => (
            <div key={i} className="flex items-center gap-1.5 border-b border-border/40 pb-1.5">
              <span className="h-2 w-2 rounded-full bg-foreground/20" />
              <Bar w={`${w}%`} tone="soft" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Le board en colonnes. */
export function BoardFigure() {
  const cols = [
    { label: "Backlog", n: 3, color: "#8b8f99" },
    { label: "À faire", n: 2, color: "#6b7180" },
    { label: "En cours", n: 3, color: "#eda100" },
    { label: "Terminé", n: 2, color: "#3e9b4f" },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {cols.map((c) => (
        <div key={c.label} className="space-y-1.5">
          <div className="flex items-center gap-1 pb-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />
            <span className="text-[9px] font-medium">{c.label}</span>
            <span className="text-[9px] text-tertiary">{c.n}</span>
          </div>
          {Array.from({ length: c.n }).map((_, i) => (
            <MiniCard
              key={i}
              title={`${55 + ((i * 17) % 35)}%`}
              color={i === 0 ? HUE.urgent : i === 1 ? HUE.front : HUE.back}
              tag={i === 0 ? "URGENT" : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** L'anatomie d'une ligne de work item. */
export function IssueRowFigure() {
  const parts = [
    { label: "Référence", w: "w-10" },
    { label: "Titre", w: "flex-1" },
    { label: "Labels", w: "w-12" },
    { label: "Priorité", w: "w-8" },
    { label: "Échéance", w: "w-10" },
    { label: "Assignés", w: "w-8" },
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-2">
        <span className="h-3 w-3 rounded-full border-2 border-amber-500" />
        <span className="rounded bg-muted px-1 py-px font-mono text-[9px] text-tertiary">DEMO-14</span>
        <span className="min-w-0 flex-1 truncate text-[10px]">Écran « mot de passe oublié » inaccessible au clavier</span>
        <Pill color={HUE.design} w={16} />
        <Pill color={HUE.front} w={16} />
        <span className="rounded bg-red-500/15 px-1 text-[8px] font-medium text-red-600">Urgent</span>
        <span className="text-[9px] text-red-600">Hier</span>
        <span className="h-3.5 w-3.5 rounded-full bg-foreground/20" />
      </div>
      <div className="flex items-start gap-2 px-2 text-[8px] text-tertiary">
        {parts.map((p) => (
          <span key={p.label} className={cn("text-center", p.w)}>
            <span className="mx-auto mb-0.5 block h-2 w-px bg-border" />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Le diagramme de Gantt. */
export function GanttFigure() {
  const rows = [
    { label: "Design system", start: 0, len: 3, color: HUE.design },
    { label: "Lien magique", start: 1, len: 4, color: HUE.back },
    { label: "Squelette du dashboard", start: 3, len: 5, color: HUE.front },
    { label: "Widget consommation", start: 6, len: 3, color: HUE.front },
    { label: "Historique factures", start: 8, len: 4, color: HUE.back },
  ];
  return (
    <div className="space-y-1.5">
      <div className="ml-24 grid grid-cols-12 gap-px text-[8px] text-tertiary">
        {Array.from({ length: 12 }).map((_, i) => (
          <span key={i} className={cn("text-center", i === 4 && "font-medium text-primary")}>
            {i + 8}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="w-22 shrink-0 truncate text-right text-[9px] text-muted-foreground" style={{ width: 88 }}>
            {r.label}
          </span>
          <div className="relative grid flex-1 grid-cols-12 gap-px">
            {Array.from({ length: 12 }).map((_, i) => (
              <span key={i} className={cn("h-3.5 rounded-sm", i === 4 ? "bg-primary/10" : "bg-foreground/[0.04]")} />
            ))}
            <span
              className="absolute top-0.5 h-2.5 rounded-full"
              style={{
                background: r.color,
                left: `${(r.start / 12) * 100}%`,
                width: `${(r.len / 12) * 100}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Le graphe de travail. */
export function GraphFigure() {
  const nodes = [
    { x: 50, y: 18, label: "Projet", tone: "#0ea5e9", r: 13 },
    { x: 18, y: 52, label: "Cycle", tone: "#eda100", r: 10 },
    { x: 50, y: 58, label: "Item", tone: "#8b5cf6", r: 10 },
    { x: 82, y: 48, label: "Agent", tone: "#22c55e", r: 10 },
    { x: 32, y: 86, label: "Item", tone: "#8b5cf6", r: 9 },
    { x: 68, y: 86, label: "Note", tone: "#f59e0b", r: 9 },
  ];
  const edges: Array<[number, number, boolean]> = [
    [0, 1, false], [0, 2, false], [0, 3, true],
    [1, 4, false], [2, 4, false], [2, 5, true], [3, 2, true],
  ];
  return (
    <svg viewBox="0 0 100 100" className="h-52 w-full">
      {edges.map(([a, b, dashed], i) => (
        <line
          key={i}
          x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
          stroke="currentColor"
          className="text-foreground/20"
          strokeWidth={0.6}
          strokeDasharray={dashed ? "2 2" : undefined}
        />
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.tone} fillOpacity={0.18} stroke={n.tone} strokeWidth={0.8} />
          <text
            x={n.x} y={n.y + 1.2} textAnchor="middle"
            fontSize={4} fill="currentColor" className="fill-foreground/70"
          >
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** La chaîne mission → run → livrable → preuve. */
export function ProofFigure() {
  const steps = [
    { label: "Work item", hint: "la demande", tone: "#0ea5e9" },
    { label: "Mission", hint: "brief + critères", tone: "#8b5cf6" },
    { label: "Run", hint: "durée, coût, issue", tone: "#eda100" },
    { label: "Livrable", hint: "le résultat", tone: "#22c55e" },
  ];
  return (
    <div className="flex items-stretch gap-1.5">
      {steps.map((s, i) => (
        <div key={s.label} className="flex min-w-0 flex-1 items-center gap-1.5">
          <div
            className="min-w-0 flex-1 rounded-lg border p-2"
            style={{ borderColor: `${s.tone}55`, background: `${s.tone}14` }}
          >
            <p className="truncate text-[10px] font-medium">{s.label}</p>
            <p className="truncate text-[9px] text-tertiary">{s.hint}</p>
          </div>
          {i < steps.length - 1 && <span className="shrink-0 text-tertiary">→</span>}
        </div>
      ))}
    </div>
  );
}

/** Les six dispositions d'une liste de work items. */
export function LayoutsFigure() {
  const items: Array<{ label: string; render: ReactNode }> = [
    {
      label: "Liste",
      render: (
        <div className="space-y-1">
          {[70, 55, 62, 48].map((w, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-foreground/25" />
              <Bar w={`${w}%`} tone="soft" />
            </div>
          ))}
        </div>
      ),
    },
    {
      label: "Kanban",
      render: (
        <div className="grid grid-cols-3 gap-1">
          {[2, 1, 2].map((n, c) => (
            <div key={c} className="space-y-1">
              {Array.from({ length: n }).map((_, i) => (
                <span key={i} className="block h-3.5 rounded-sm border border-border/70 bg-card" />
              ))}
            </div>
          ))}
        </div>
      ),
    },
    {
      label: "Tableau",
      render: (
        <div className="space-y-px">
          {Array.from({ length: 4 }).map((_, r) => (
            <div key={r} className="grid grid-cols-4 gap-px">
              {Array.from({ length: 4 }).map((_, c) => (
                <span key={c} className={cn("h-2.5 rounded-[2px]", r === 0 ? "bg-foreground/18" : "bg-foreground/[0.07]")} />
              ))}
            </div>
          ))}
        </div>
      ),
    },
    {
      label: "Calendrier",
      render: (
        <div className="grid grid-cols-7 gap-px">
          {Array.from({ length: 21 }).map((_, i) => (
            <span
              key={i}
              className={cn("h-3 rounded-[2px] bg-foreground/[0.07]", [4, 9, 10, 16].includes(i) && "bg-primary/35")}
            />
          ))}
        </div>
      ),
    },
    {
      label: "Gantt",
      render: (
        <div className="space-y-1 pt-1">
          {[[0, 5], [2, 6], [4, 4], [7, 4]].map(([s, l], i) => (
            <div key={i} className="relative h-2">
              <span className="absolute h-2 rounded-full bg-primary/45" style={{ left: `${s * 8}%`, width: `${l * 8}%` }} />
            </div>
          ))}
        </div>
      ),
    },
    {
      label: "Feuille",
      render: (
        <div className="space-y-1">
          {[1, 2, 2, 1].map((depth, i) => (
            <div key={i} className="flex items-center gap-1" style={{ paddingLeft: (depth - 1) * 10 }}>
              <span className="h-1.5 w-1.5 rounded-[1px] bg-foreground/25" />
              <Bar w={`${60 - depth * 8}%`} tone="soft" />
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="space-y-1.5 rounded-lg border border-border bg-card p-2">
          <p className="text-[10px] font-medium">{it.label}</p>
          <div className="h-14">{it.render}</div>
        </div>
      ))}
    </div>
  );
}

/** Les trois familles de navigation du panneau Travail. */
export function TrackerPanelFigure() {
  const groups = [
    { label: "Reprise", items: ["Home", "Mon travail", "Brouillons"] },
    { label: "Espace", items: ["Projets", "Initiatives", "Cycles actifs", "Vues", "Analytics", "Workgraph", "Wiki", "Notes"] },
    { label: "Un projet", items: ["Overview", "Work items", "Cycles", "Modules", "Vues", "Pages", "Équipage", "Livrables"] },
  ];
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      {groups.map((g) => (
        <div key={g.label} className="rounded-lg border border-border bg-card p-2.5">
          <p className="pb-1.5 text-[10px] font-medium text-tertiary">{g.label}</p>
          <ul className="space-y-1">
            {g.items.map((i) => (
              <li key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="h-2 w-2 rounded-[3px] bg-foreground/15" />
                {i}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
