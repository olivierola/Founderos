/**
 * Read-only renderer for an artifact document.
 *
 * Editor.js's runtime is for EDITING. Displaying a saved document only needs to
 * walk its `blocks` array and draw each type — no editor, no contenteditable,
 * no 200 kB of tooling on a page nobody is typing into. That is what this file
 * does, and it is the only thing that turns an artifact into pixels.
 *
 * Series colours come from the app's validated categorical palette, assigned in
 * order and never cycled (a 9th series falls back to the de-emphasis grey rather
 * than inventing an unvalidated hue).
 */
import { useId } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter,
} from "recharts";
import {
  TrendingUp, TrendingDown, Minus, Info, CheckCircle2, AlertTriangle, AlertOctagon, Check, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCategorical, useContextGreys, STATUS } from "@/features/crm/overview/vizPalette";
import {
  type ArtifactBlock, type ArtifactDocument, type BannerData, type CalloutData,
  type ChartData, type ChecklistData, type CodeData, type ComparisonData, type HeaderData,
  type ImageData, type KpiData, type ListData, type MatrixData, type ParagraphData,
  type QuoteData, type TableData, toSlides,
} from "./blocks";

// Editor.js stores inline formatting as HTML fragments (<b>, <i>, <a>, <code>,
// <mark>). Rendering them as text would show the tags; rendering them raw would
// be an injection hole. Allow that closed list and drop everything else.
const INLINE_ALLOWED = /<\/?(b|strong|i|em|u|s|code|mark|br|a)( [^>]*)?>/gi;
function inlineHtml(text: string): { __html: string } {
  const stripped = String(text ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, (tag) => (tag.match(INLINE_ALLOWED) ? tag : ""))
    .replace(/ on\w+="[^"]*"/gi, "");
  return { __html: stripped };
}

function useSeriesColor() {
  const cat = useCategorical();
  const { context } = useContextGreys();
  return (i: number) => (i < cat.length ? cat[i] : context);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function BannerBlock({ d }: { d: BannerData }) {
  const tones: Record<string, string> = {
    default: "from-indigo-600 to-indigo-800",
    info: "from-sky-600 to-sky-800",
    success: "from-emerald-600 to-emerald-800",
    warning: "from-amber-600 to-amber-800",
    danger: "from-rose-600 to-rose-800",
  };
  return (
    <header className={cn("relative overflow-hidden rounded-2xl bg-gradient-to-br p-6 text-white shadow-sm", tones[d.tone ?? "default"])}>
      {d.imageUrl && <img src={d.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />}
      <div className="relative">
        {d.subtitle && <div className="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/70">{d.subtitle}</div>}
        <h1 className="text-2xl font-bold tracking-tight">{d.title}</h1>
        {d.author && <div className="mt-3 text-[11px] text-white/70">{d.author}</div>}
      </div>
    </header>
  );
}

/**
 * The document's header — system chrome, not content.
 *
 * The title of an artifact is a property of the artifact, so it belongs to the
 * application, not to a block the agent may or may not have written. Letting the
 * model author the header meant a document could open with no title, two, or one
 * that no longer matched the name in the gallery. It is drawn here, full-bleed
 * and flush with the top edge, from the record itself.
 */
export function ArtifactHeader({ title, kind, subtitle, aside }: {
  title: string;
  kind: string;
  subtitle?: string;
  aside?: React.ReactNode;
}) {
  return (
    <header className="relative overflow-hidden bg-gradient-to-br from-indigo-600 to-indigo-800 px-5 pb-7 pt-12 text-white sm:px-8">
      <div className="mx-auto w-full max-w-[1060px]">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-white/70">
          <span>{kind}</span>
          {subtitle && <><span aria-hidden>·</span><span className="truncate normal-case tracking-normal">{subtitle}</span></>}
          {aside && <span className="ml-auto flex items-center">{aside}</span>}
        </div>
        <h1 className="mt-1.5 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">{title}</h1>
      </div>
    </header>
  );
}

function KpiBlock({ d }: { d: KpiData }) {
  const items = d.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((k, i) => {
        const Icon = k.trend === "up" ? TrendingUp : k.trend === "down" ? TrendingDown : Minus;
        return (
          <div key={i} className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
            <div className="truncate text-[11px] font-medium text-muted-foreground">{k.label}</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="truncate text-2xl font-bold tabular-nums">{k.value}</span>
              {k.delta && (
                <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium",
                  k.trend === "up" ? "text-emerald-600 dark:text-emerald-400"
                    : k.trend === "down" ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                  <Icon className="h-3 w-3" />{k.delta}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChartBlock({ d }: { d: ChartData }) {
  const color = useSeriesColor();
  const uid = useId().replace(/:/g, "");
  const data = d.data ?? [];
  const x = d.x ?? "name";
  const series = d.series?.length
    ? d.series
    : Object.keys(data[0] ?? {}).filter((k) => k !== x && typeof (data[0] as Record<string, unknown>)[k] === "number");
  if (data.length === 0) return null;

  const axis = { tick: { fontSize: 11, fill: "hsl(var(--muted-foreground))" }, tickLine: false, axisLine: false } as const;
  const tip = {
    contentStyle: { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 },
  } as const;

  const body = () => {
    if (d.chartType === "pie" || d.chartType === "donut") {
      const key = series[0];
      return (
        <PieChart>
          <Pie data={data} dataKey={key} nameKey={x} innerRadius={d.chartType === "donut" ? 52 : 0} outerRadius={78}
            paddingAngle={2} stroke="hsl(var(--card))" strokeWidth={2}>
            {data.map((_, i) => <Cell key={i} fill={color(i)} />)}
          </Pie>
          <Tooltip {...tip} /><Legend />
        </PieChart>
      );
    }
    if (d.chartType === "radar") {
      return (
        <RadarChart data={data}>
          <PolarGrid stroke="hsl(var(--border))" /><PolarAngleAxis dataKey={x} {...axis} /><PolarRadiusAxis {...axis} />
          {series.map((s, i) => <Radar key={s} name={s} dataKey={s} stroke={color(i)} fill={color(i)} fillOpacity={0.3} />)}
          <Tooltip {...tip} /><Legend />
        </RadarChart>
      );
    }
    if (d.chartType === "scatter") {
      return (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
          <XAxis dataKey={x} {...axis} /><YAxis dataKey={series[0]} {...axis} />
          <Tooltip {...tip} /><Scatter data={data} fill={color(0)} />
        </ScatterChart>
      );
    }
    if (d.chartType === "line") {
      return (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
          <XAxis dataKey={x} {...axis} /><YAxis {...axis} width={44} /><Tooltip {...tip} /><Legend />
          {series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={color(i)} strokeWidth={2} dot={false} />)}
        </LineChart>
      );
    }
    if (d.chartType === "area") {
      return (
        <AreaChart data={data}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s} id={`g-${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color(i)} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color(i)} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
          <XAxis dataKey={x} {...axis} /><YAxis {...axis} width={44} /><Tooltip {...tip} /><Legend />
          {series.map((s, i) => <Area key={s} type="monotone" dataKey={s} stroke={color(i)} strokeWidth={2} fill={`url(#g-${uid}-${i})`} />)}
        </AreaChart>
      );
    }
    return (
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
        <XAxis dataKey={x} {...axis} /><YAxis {...axis} width={44} /><Tooltip {...tip} /><Legend />
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} stackId={d.stacked ? "s" : undefined} fill={color(i)} maxBarSize={30}
            radius={d.stacked ? 0 : [4, 4, 0, 0]} stroke="hsl(var(--card))" strokeWidth={1.5} />
        ))}
      </BarChart>
    );
  };

  return (
    <figure className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {d.title && <figcaption className="mb-2 text-xs font-medium text-muted-foreground">{d.title}</figcaption>}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">{body()}</ResponsiveContainer>
      </div>
    </figure>
  );
}

function TableBlock({ d }: { d: TableData }) {
  const rows = d.content ?? [];
  if (rows.length === 0) return null;
  const [head, ...body] = d.withHeadings === false ? [null as unknown as string[], ...rows] : rows;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        {head && (
          <thead className="bg-muted/40">
            <tr>{head.map((c, i) => <th key={i} className="px-3 py-2 text-left font-semibold" dangerouslySetInnerHTML={inlineHtml(c)} />)}</tr>
          </thead>
        )}
        <tbody className="divide-y divide-border/60">
          {body.map((r, ri) => (
            <tr key={ri} className="transition-colors hover:bg-muted/20">
              {r.map((c, ci) => <td key={ci} className="px-3 py-2 align-top text-muted-foreground" dangerouslySetInnerHTML={inlineHtml(c)} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonBlock({ d }: { d: ComparisonData }) {
  const cols = d.columns ?? [];
  const rows = d.rows ?? [];
  if (cols.length === 0 || rows.length === 0) return null;
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {d.title && <figcaption className="border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">{d.title}</figcaption>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">Critère</th>
              {cols.map((c, i) => (
                <th key={i} className={cn("px-3 py-2 text-left font-semibold", i === d.highlight ? "bg-primary/10 text-primary" : "text-foreground")}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((r, ri) => (
              <tr key={ri} className="transition-colors hover:bg-muted/20">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left align-top font-medium text-foreground">
                  {r.label}
                  {r.note && <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">{r.note}</span>}
                </th>
                {cols.map((_, ci) => {
                  const cell = r.cells?.[ci];
                  return (
                    <td key={ci} className={cn("px-3 py-2 align-top", ci === d.highlight && "bg-primary/5")}>
                      {cell === true ? <Check className="h-4 w-4 text-emerald-500" />
                        : cell === false ? <X className="h-4 w-4 text-muted-foreground/50" />
                        : cell == null || cell === "" ? <span className="text-muted-foreground/40">—</span>
                        : <span className="text-muted-foreground">{String(cell)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function MatrixBlock({ d }: { d: MatrixData }) {
  const color = useSeriesColor();
  const items = (d.items ?? []).filter((i) => typeof i?.x === "number" && typeof i?.y === "number");
  if (items.length === 0) return null;
  const clamp = (v: number) => Math.max(2, Math.min(98, v));
  const q = d.quadrants ?? [];
  const corner = ["left-2 top-2", "right-2 top-2 text-right", "right-2 bottom-2 text-right", "bottom-2 left-2"];
  return (
    <figure className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {d.title && <figcaption className="mb-3 text-xs font-medium text-muted-foreground">{d.title}</figcaption>}
      <div className="flex gap-3">
        <div className="flex w-5 shrink-0 items-center justify-center">
          <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>{d.yLabel}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative aspect-[4/3] w-full rounded-lg border border-border/70 bg-muted/20">
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border" />
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border" />
            {q.slice(0, 4).map((label, i) => (
              <span key={i} className={cn("pointer-events-none absolute max-w-[42%] text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70", corner[i])}>{label}</span>
            ))}
            {items.map((it, i) => (
              <div key={i} title={it.note ? `${it.label} — ${it.note}` : it.label}
                className="absolute -translate-x-1/2 translate-y-1/2"
                style={{ left: `${clamp(it.x)}%`, bottom: `${clamp(it.y)}%` }}>
                <div className="flex flex-col items-center gap-1">
                  <span className={cn("block h-3 w-3 rounded-full ring-2 ring-card", it.highlight && "h-4 w-4 ring-4")}
                    style={{ background: it.highlight ? "hsl(var(--primary))" : color(i) }} />
                  <span className={cn("max-w-[92px] truncate rounded bg-card/90 px-1 text-[10px] leading-tight backdrop-blur",
                    it.highlight ? "font-semibold text-foreground" : "text-muted-foreground")}>{it.label}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{d.xLow ?? "–"}</span>
            <span className="font-medium uppercase tracking-wider">{d.xLabel}</span>
            <span>{d.xHigh ?? "+"}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function CalloutBlock({ d }: { d: CalloutData }) {
  const map = {
    info: { icon: Info, cls: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
    success: { icon: CheckCircle2, cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
    warning: { icon: AlertTriangle, cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
    danger: { icon: AlertOctagon, cls: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  } as const;
  const { icon: Icon, cls } = map[d.tone] ?? map.info;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border p-3.5 text-sm", cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span dangerouslySetInnerHTML={inlineHtml(d.text)} />
    </div>
  );
}

function ImageBlock({ d }: { d: ImageData }) {
  const url = d.file?.url;
  if (!url) return null;
  return (
    <figure className={cn("overflow-hidden rounded-xl", d.withBorder && "border border-border", d.withBackground && "bg-muted/40 p-4")}>
      <img src={url} alt={d.caption ?? ""} loading="lazy"
        className={cn("w-full object-contain", d.stretched ? "max-h-none" : "max-h-[460px]")} />
      {d.caption && <figcaption className="px-3 py-2 text-xs text-muted-foreground" dangerouslySetInnerHTML={inlineHtml(d.caption)} />}
    </figure>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export function Block({ block }: { block: ArtifactBlock }) {
  const d = (block.data ?? {}) as never;
  switch (block.type) {
    case "banner": return <BannerBlock d={d as BannerData} />;
    case "header": {
      const h = d as HeaderData;
      const sizes: Record<number, string> = { 1: "text-2xl", 2: "text-xl", 3: "text-lg", 4: "text-base" };
      return <h2 className={cn("font-bold tracking-tight text-foreground", sizes[h.level ?? 2] ?? "text-xl")}
        dangerouslySetInnerHTML={inlineHtml(h.text)} />;
    }
    case "paragraph":
      return <p className="text-sm leading-relaxed text-foreground/90" dangerouslySetInnerHTML={inlineHtml((d as ParagraphData).text)} />;
    case "list": {
      const l = d as ListData;
      const Tag = l.style === "ordered" ? "ol" : "ul";
      return (
        <Tag className={cn("space-y-1 pl-5 text-sm text-foreground/90", l.style === "ordered" ? "list-decimal" : "list-disc")}>
          {(l.items ?? []).map((it, i) => <li key={i} dangerouslySetInnerHTML={inlineHtml(it)} />)}
        </Tag>
      );
    }
    case "checklist":
      return (
        <ul className="space-y-1.5 text-sm">
          {((d as ChecklistData).items ?? []).map((it, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                it.checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-border")}>
                {it.checked && <Check className="h-3 w-3" />}
              </span>
              <span className={cn(it.checked && "text-muted-foreground line-through")} dangerouslySetInnerHTML={inlineHtml(it.text)} />
            </li>
          ))}
        </ul>
      );
    case "image": return <ImageBlock d={d as ImageData} />;
    case "table": return <TableBlock d={d as TableData} />;
    case "quote": {
      const q = d as QuoteData;
      return (
        <blockquote className="border-l-2 border-primary/50 pl-4 text-sm italic text-muted-foreground">
          <span dangerouslySetInnerHTML={inlineHtml(q.text)} />
          {q.caption && <cite className="mt-1 block text-xs not-italic opacity-70">— {q.caption}</cite>}
        </blockquote>
      );
    }
    case "code":
      return <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 text-xs"><code>{(d as CodeData).code}</code></pre>;
    case "delimiter":
      return <hr className="my-2 border-border" />;
    case "warning": {
      const w = d as { title?: string; message?: string };
      return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          {w.title && <p className="text-sm font-semibold text-amber-900 dark:text-amber-100" dangerouslySetInnerHTML={inlineHtml(w.title)} />}
          {w.message && <p className="mt-0.5 text-sm text-amber-900/80 dark:text-amber-100/80" dangerouslySetInnerHTML={inlineHtml(w.message)} />}
        </div>
      );
    }
    case "embed": {
      // The tool stores an already-embeddable URL; anything else is a link the
      // reader can follow rather than a frame that silently fails to load.
      const e = d as { embed?: string; source?: string; caption?: string; width?: number; height?: number };
      if (!e.embed) {
        return e.source
          ? <a href={e.source} target="_blank" rel="noreferrer" className="text-sm text-primary underline underline-offset-2">{e.source}</a>
          : null;
      }
      return (
        <figure className="overflow-hidden rounded-xl border border-border">
          <div className="relative w-full" style={{ aspectRatio: `${e.width ?? 16} / ${e.height ?? 9}` }}>
            <iframe src={e.embed} title={e.caption || "Contenu intégré"} loading="lazy"
              allowFullScreen className="absolute inset-0 h-full w-full" />
          </div>
          {e.caption && <figcaption className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{e.caption}</figcaption>}
        </figure>
      );
    }
    case "raw":
      // Deliberately NOT injected as HTML: this block exists so an agent can
      // keep a snippet verbatim, and rendering arbitrary markup from a model
      // into the reader is a script-injection surface for no gain.
      return <pre className="overflow-x-auto rounded-xl border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground"><code>{(d as { html?: string }).html}</code></pre>;
    case "kpi": return <KpiBlock d={d as KpiData} />;
    case "chart": return <ChartBlock d={d as ChartData} />;
    case "comparison": return <ComparisonBlock d={d as ComparisonData} />;
    case "matrix": return <MatrixBlock d={d as MatrixData} />;
    case "callout": return <CalloutBlock d={d as CalloutData} />;
    case "slide": return null; // consumed by the slide splitter
    default: return null;      // unknown type degrades to nothing, never to a crash
  }
}

/** A report: the blocks, top to bottom. */
export function ArtifactReport({ doc }: { doc: ArtifactDocument }) {
  if (doc.blocks.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Document vide.</p>;
  }
  return (
    <article className="mx-auto w-full max-w-[1060px] space-y-5 px-5 py-8 sm:px-8">
      {doc.blocks.map((b, i) => <Block key={b.id ?? i} block={b} />)}
    </article>
  );
}

/** A deck: the same blocks, cut on `slide` boundaries, one page per slide. */
export function ArtifactDeck({ doc }: { doc: ArtifactDocument }) {
  const slides = toSlides(doc);
  if (slides.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Présentation vide.</p>;
  }
  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-6 px-6 py-8">
      {slides.map((s, i) => (
        <section key={i} className="relative flex aspect-[16/9] flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-card p-8 shadow-sm">
          {s.slide.title && <h2 className="text-xl font-bold tracking-tight">{s.slide.title}</h2>}
          <div className="min-h-0 flex-1 space-y-4">
            {s.blocks.map((b, bi) => <Block key={b.id ?? bi} block={b} />)}
          </div>
          <span className="absolute bottom-3 right-4 text-[10px] tabular-nums text-muted-foreground/60">{i + 1}/{slides.length}</span>
        </section>
      ))}
    </div>
  );
}
