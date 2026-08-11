// Generative UI — typed blocks agents attach to chat replies (ui_blocks jsonb
// on internal_agent_messages, emitted via the render_ui tool). One registry
// serves every agent; unknown/malformed blocks degrade to nothing (the text
// answer still carries the information). Charts use the validated dataviz
// palette (features/crm/overview/vizPalette).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { callEdge } from "@/lib/edge";
import { AgentMarkdown, CodeBlock } from "@/components/AgentMarkdown";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  ExternalLink, TrendingUp, TrendingDown, FileText, Presentation, Table as TableIcon, Image as ImageIcon, Type,
  ShieldCheck, Check, X, Loader2, ChartBar, Braces, Code2,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { chatCard, chatHero, chatAccentText, chatOptionPill } from "@/lib/chatStyles";

export interface UiBlock { component: string; props: Record<string, unknown> }

const str = (v: unknown) =>
  typeof v === "string" ? v
    : v == null ? ""
      : typeof v === "object" ? (() => { try { return JSON.stringify(v); } catch { return ""; } })()
        : String(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// ── kpi_grid ─────────────────────────────────────────────────────────────────
const KPI_TONES: Record<string, string> = {
  emerald: "text-emerald-500", red: "text-rose-500", amber: "text-amber-500", blue: chatAccentText,
};
function KpiGrid({ props }: { props: Record<string, unknown> }) {
  const items = (Array.isArray(props.items) ? props.items : []).slice(0, 8) as Array<Record<string, unknown>>;
  if (!items.length) return null;
  return (
    <div className={cn("grid gap-2.5", items.length <= 2 ? "grid-cols-2" : items.length === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4")}>
      {items.map((it, i) => {
        const delta = str(it.delta);
        const up = delta.trim().startsWith("+");
        const down = delta.trim().startsWith("-");
        return (
          <div key={i} className={cn(chatCard, "p-3.5 transition-shadow hover:shadow-sm")}>
            <div className="truncate text-[11px] font-medium text-muted-foreground">{str(it.label)}</div>
            <div className={cn("mt-1 truncate text-xl font-semibold tracking-tight tabular-nums", KPI_TONES[str(it.tone)] ?? "text-foreground")}>{str(it.value)}</div>
            {delta && (
              <div className={cn("mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                up ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : down ? "bg-rose-500/10 text-rose-600 dark:text-rose-400" : "bg-muted text-muted-foreground")}>
                {up ? <TrendingUp className="h-3 w-3" /> : down ? <TrendingDown className="h-3 w-3" /> : null}
                {delta}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── chart ────────────────────────────────────────────────────────────────────
function ChartBlock({ props }: { props: Record<string, unknown> }) {
  const palette = useCategorical();
  const type = str(props.type) || "bar";
  const title = str(props.title);
  const data = useMemo(
    () => (Array.isArray(props.data) ? props.data : []).slice(0, 50)
      .map((d: Record<string, unknown>) => ({ x: str(d?.x).slice(0, 40), y: num(d?.y) }))
      .filter((d) => d.x !== ""),
    [props.data],
  );
  if (!data.length) return null;
  const color = palette[0];
  const axis = { tick: { fontSize: 11 }, stroke: "hsl(var(--muted-foreground) / 0.35)" } as const;
  const tooltip = (
    <Tooltip
      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }}
      cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
    />
  );
  return (
    <div className={cn(chatCard, "p-4")}>
      {title && <div className="mb-2.5 text-[13px] font-semibold tracking-tight text-foreground">{title}</div>}
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {type === "pie" ? (
            <PieChart>
              <Pie data={data} dataKey="y" nameKey="x" innerRadius={45} outerRadius={80} paddingAngle={2}>
                {data.map((_, i) => <Cell key={i} fill={palette[i % palette.length]} />)}
              </Pie>
              {tooltip}
            </PieChart>
          ) : type === "line" ? (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
              <XAxis dataKey="x" {...axis} /><YAxis width={40} {...axis} />
              {tooltip}
              <Line type="monotone" dataKey="y" stroke={color} strokeWidth={2} dot={false} />
            </LineChart>
          ) : type === "area" ? (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
              <XAxis dataKey="x" {...axis} /><YAxis width={40} {...axis} />
              {tooltip}
              <Area type="monotone" dataKey="y" stroke={color} fill={color} fillOpacity={0.18} strokeWidth={2} />
            </AreaChart>
          ) : (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
              <XAxis dataKey="x" {...axis} /><YAxis width={40} {...axis} />
              {tooltip}
              <Bar dataKey="y" fill={color} radius={[5, 5, 0, 0]} maxBarSize={42} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── table ────────────────────────────────────────────────────────────────────
function TableBlock({ props }: { props: Record<string, unknown> }) {
  const columns = (Array.isArray(props.columns) ? props.columns : []).slice(0, 10).map(str);
  const rows = (Array.isArray(props.rows) ? props.rows : []).slice(0, 50) as unknown[][];
  if (!columns.length || !rows.length) return null;
  return (
    <div className={cn(chatCard, "overflow-hidden")}>
      {str(props.title) && <div className="border-b border-border/50 px-3.5 py-2.5 text-[13px] font-semibold tracking-tight text-foreground">{str(props.title)}</div>}
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card/95 backdrop-blur">
            <tr>{columns.map((c, i) => <th key={i} className="whitespace-nowrap px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border/40 transition-colors hover:bg-muted/40">
                {columns.map((_, j) => <td key={j} className="px-3.5 py-2 tabular-nums">{str(Array.isArray(r) ? r[j] : "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── link_card ────────────────────────────────────────────────────────────────
function LinkCard({ props }: { props: Record<string, unknown> }) {
  const url = str(props.url);
  const title = str(props.title) || url;
  if (!url) return null;
  const external = /^https?:\/\//i.test(url);
  return (
    <a
      href={url}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={cn(chatHero, "group flex items-center gap-3 rounded-2xl p-4 shadow-sm transition-all hover:brightness-[1.05] hover:shadow-md")}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        {str(props.description) && <div className="truncate text-xs text-white/75">{str(props.description)}</div>}
      </div>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 transition-transform group-hover:translate-x-0.5">
        <ExternalLink className="h-4 w-4 text-white" />
      </span>
    </a>
  );
}

// ── deliverable (a produced report/file → the SAME card as an artifact) ──────
// A report an agent worked minutes on used to land as a thin one-line strip
// while a throwaway spreadsheet got the full card. Same object to the reader,
// same card: WorkCard below is shared by both.
function DeliverableBlock({ props, agentName, onOpen }: {
  props: Record<string, unknown>; agentName?: string; onOpen?: (a: ArtifactOpenTarget) => void;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const name = str(props.name) || "Livrable";
  const id = str(props.id);
  const agentId = str(props.agentId);
  const kind = str(props.kind) || "report";
  // Open IN the surrounding panel (rooms → artifacts viewer), exactly like
  // artifact cards. Always clickable — with an id we open the report directly;
  // without one we still open the panel gallery so the user can find it.
  const open = () => {
    if (onOpen) { onOpen({ id: id || undefined, table: "deliverable", kind, title: name, agentId: agentId || undefined }); return; }
    if (id) navigate(`/app/${workspaceSlug}/${projectSlug}/agent/knowledge?d=${id}`);
  };
  return (
    <WorkCard
      title={name}
      subtitle={agentName ? `Créé par ${agentName}` : (DELIVERABLE_LABELS[kind] ?? kind)}
      kind={kind}
      onOpen={open}
    />
  );
}

const DELIVERABLE_LABELS: Record<string, string> = {
  report: "Rapport", markdown: "Document", json: "Données", file: "Fichier",
  url: "Lien", code: "Code", csv: "Tableur",
};

// ── artifact (document/presentation/spreadsheet/image/text, created by
//    create_artifact → card with Open; opens in the Room panel, not a route) ──
export interface ArtifactOpenTarget {
  id?: string;
  table: "office_documents" | "office_media" | "text" | "code" | "deliverable";
  kind: string;
  title: string;
  content?: string;
  /** For code artifacts: the language (e.g. "tsx"). */
  language?: string;
  /** For deliverables: the owning agent (used only for scoping/labels). */
  agentId?: string;
}

const ARTIFACT_ICONS: Record<string, typeof FileText> = {
  document: FileText, text: Type, presentation: Presentation, spreadsheet: TableIcon, image: ImageIcon,
  // Deliverable kinds share the registry — one produced object, one visual language.
  report: ChartBar, markdown: FileText, json: Braces, code: Code2, csv: TableIcon, url: ExternalLink, file: FileText,
};

// Per-kind tone for the card's header (real photo only for a ready image;
// every other kind — and a still-generating image — gets its own colour).
const ARTIFACT_TONE: Record<string, { bg: string; icon: string }> = {
  document: { bg: "bg-sky-500/15", icon: "text-sky-600 dark:text-sky-400" },
  text: { bg: "bg-slate-500/15", icon: "text-slate-600 dark:text-slate-400" },
  presentation: { bg: "bg-amber-500/15", icon: "text-amber-600 dark:text-amber-400" },
  spreadsheet: { bg: "bg-emerald-500/15", icon: "text-emerald-600 dark:text-emerald-400" },
  image: { bg: "bg-violet-500/15", icon: "text-violet-600 dark:text-violet-400" },
  report: { bg: "bg-indigo-500/15", icon: "text-indigo-600 dark:text-indigo-400" },
  markdown: { bg: "bg-sky-500/15", icon: "text-sky-600 dark:text-sky-400" },
  json: { bg: "bg-teal-500/15", icon: "text-teal-600 dark:text-teal-400" },
  code: { bg: "bg-rose-500/15", icon: "text-rose-600 dark:text-rose-400" },
  csv: { bg: "bg-emerald-500/15", icon: "text-emerald-600 dark:text-emerald-400" },
  url: { bg: "bg-blue-500/15", icon: "text-blue-600 dark:text-blue-400" },
  file: { bg: "bg-slate-500/15", icon: "text-slate-600 dark:text-slate-400" },
};

/**
 * The card every produced object wears in the thread: a preview plate on the
 * left, the title and its author, an "Ouvrir" pill on the right.
 *
 * Shared by artifacts and deliverables on purpose — the reader does not care
 * which table a report was written to, and two different cards for the same
 * gesture read as two different features.
 */
function WorkCard({ title, subtitle, kind, imageUrl, onOpen }: {
  title: string; subtitle: string; kind: string; imageUrl?: string | null; onOpen: () => void;
}) {
  const Icon = ARTIFACT_ICONS[kind] ?? FileText;
  const tone = ARTIFACT_TONE[kind] ?? ARTIFACT_TONE.document;
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="group flex w-full max-w-2xl cursor-pointer items-stretch overflow-hidden rounded-2xl border border-border/70 bg-card transition-shadow hover:shadow-[0_8px_26px_-12px_rgba(0,0,0,0.22)]"
    >
      {/* Preview panel */}
      <div className="flex w-[36%] max-w-[210px] shrink-0 items-center justify-center border-r border-border/50 bg-muted/40 p-5">
        {imageUrl ? (
          <img src={imageUrl} alt={title} className="max-h-24 w-full rounded-lg object-cover shadow-sm" />
        ) : (
          <div className="w-[4.75rem] -rotate-3 rounded-xl border border-border/60 bg-card p-2 shadow-[0_8px_18px_-8px_rgba(0,0,0,0.25)] transition-transform duration-200 group-hover:rotate-0">
            <div className={cn("mb-1.5 flex aspect-[4/3] items-center justify-center rounded-md", tone.bg)}>
              <Icon className={cn("h-4 w-4", tone.icon)} />
            </div>
            <div className="space-y-1">
              <div className="h-1 w-full rounded-full bg-muted-foreground/20" />
              <div className="h-1 w-3/4 rounded-full bg-muted-foreground/15" />
              <div className="h-1 w-1/2 rounded-full bg-muted-foreground/15" />
            </div>
          </div>
        )}
      </div>
      {/* Content */}
      <div className="flex min-w-0 flex-1 items-center gap-4 px-6 py-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold tracking-tight text-card-foreground">{title}</div>
          <div className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="shrink-0 rounded-full border border-border px-5 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-muted"
        >
          Ouvrir
        </button>
      </div>
    </motion.div>
  );
}

function ArtifactBlock({ props, agentName, onOpen }: { props: Record<string, unknown>; agentName?: string; onOpen?: (a: ArtifactOpenTarget) => void }) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const title = str(props.title) || "Untitled";
  const kind = str(props.kind) || "document";
  const table = (str(props.table) || "office_documents") as ArtifactOpenTarget["table"];
  const id = str(props.id);

  // Images are generated async — fetch the URL (and poll until ready) so the
  // card's header shows the real photo once it lands, a colour tile until then.
  const { data: media } = useQuery({
    queryKey: ["artifact_media", id],
    enabled: kind === "image" && !!id,
    queryFn: async () => {
      const { data } = await supabase.from("office_media").select("url, status").eq("id", id).maybeSingle();
      return data as { url: string | null; status: string } | null;
    },
    refetchInterval: (q) => (q.state.data as { status?: string } | undefined)?.status === "generating" ? 1500 : false,
  });

  function open() {
    if (onOpen) { onOpen({ id: id || undefined, table, kind, title, content: str(props.content) || undefined }); return; }
    // No handler wired (a surface that renders blocks without owning a panel).
    // Documents open in their editor route; the knowledge base — which the old
    // fallback pointed at — is a different table entirely and never held these.
    if (id && table === "office_documents") {
      const k = ["document", "spreadsheet", "presentation"].includes(kind) ? kind : "document";
      navigate(`/app/${workspaceSlug}/${projectSlug}/artifact/${k}/${id}`);
    }
  }

  // One clean, wide card (Oasis-style): a preview panel on the left, then
  // title · "Créé par …" · an Open pill on the right.
  const creator = agentName ? `Créé par ${agentName}` : kind.charAt(0).toUpperCase() + kind.slice(1);
  return (
    <WorkCard
      title={title}
      subtitle={kind === "image" && media?.status === "generating" ? "Génération…" : creator}
      kind={kind}
      imageUrl={kind === "image" ? media?.url ?? null : null}
      onOpen={open}
    />
  );
}

// ── options (ask_user → clickable quick replies) ─────────────────────────────
function OptionsBlock({ props, onPick, disabled }: { props: Record<string, unknown>; onPick?: (text: string) => void; disabled?: boolean }) {
  const options = (Array.isArray(props.options) ? props.options : []).slice(0, 6).map(str).filter(Boolean);
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o, i) => (
        <button key={i} disabled={disabled || !onPick} onClick={() => onPick?.(o)} className={chatOptionPill}>
          {o}
        </button>
      ))}
    </div>
  );
}

// ── approval (approval-gated tool → inline approve/reject, then resume) ───────
function ApprovalBlock({ props }: { props: Record<string, unknown> }) {
  const approvalId = str(props.approval_id);
  const summary = str(props.summary) || str(props.tool) || "action sensible";
  const scopeLabel = str(props.scope_label);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<null | "approve" | "approve_all" | "reject">(null);
  const [error, setError] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: ["agent_approval_status", approvalId],
    enabled: !!approvalId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_approvals").select("status").eq("id", approvalId).maybeSingle();
      return (data as { status?: string } | null)?.status ?? "pending";
    },
  });

  const decided = !!status && status !== "pending";
  const busy = pending !== null;

  async function decide(decision: "approve" | "approve_all" | "reject") {
    if (busy || decided || !approvalId) return;
    setPending(decision); setError(null);
    try {
      await callEdge("internal-agent-approve", { approval_id: approvalId, decision });
      await queryClient.invalidateQueries({ queryKey: ["agent_approval_status", approvalId] });
      // Nudge the chat to pick up the resumed run + its new messages.
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de la décision");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={cn("rounded-xl border p-3", decided ? "border-border bg-muted/30" : "border-amber-500/40 bg-amber-500/5")}>
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-amber-500" /> Approbation requise
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{summary}</p>
      {decided ? (
        <div className={cn("flex items-center gap-1.5 text-sm font-medium", status === "rejected" ? "text-rose-500" : status === "failed" ? "text-amber-500" : "text-emerald-500")}>
          {status === "rejected" ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          {status === "rejected" ? "Refusé" : status === "failed" ? "Approuvé — l'exécution a échoué" : "Approuvé et exécuté"}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => decide("approve")} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50">
              {pending === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approuver
            </button>
            {scopeLabel && (
              <button disabled={busy} onClick={() => decide("approve_all")} title={`Autoriser toutes les actions ${scopeLabel} pour cette conversation`} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-50">
                {pending === "approve_all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Tout autoriser ({scopeLabel})
              </button>
            )}
            <button disabled={busy} onClick={() => decide("reject")} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
              {pending === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
        </>
      )}
    </div>
  );
}

// ── email_list (emails → readable cards, not [object Object]) ────────────────
function EmailListBlock({ props }: { props: Record<string, unknown> }) {
  const emails = (Array.isArray(props.emails) ? props.emails : []).slice(0, 25) as Record<string, unknown>[];
  if (!emails.length) return null;
  return (
    <div className="space-y-2">
      {str(props.title) && <div className="px-0.5 text-[13px] font-semibold text-foreground">{str(props.title)}</div>}
      {emails.map((e, i) => {
        const url = str(e.url) || str(e.link);
        const unread = e.unread === true || e.read === false;
        const Wrapper: any = url ? "a" : "div";
        return (
          <Wrapper
            key={i}
            {...(url ? { href: url, target: "_blank", rel: "noreferrer" } : {})}
            className={cn(chatCard, "block p-3 transition-colors hover:bg-muted/40", url && "cursor-pointer")}
          >
            <div className="flex items-center gap-2">
              {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--accent-coral))]" />}
              <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold text-foreground" : "font-medium text-foreground/90")}>
                {str(e.from) || str(e.sender) || "—"}
              </span>
              {str(e.date) && <span className="shrink-0 text-[11px] text-muted-foreground">{str(e.date)}</span>}
            </div>
            <div className={cn("mt-0.5 truncate text-sm", unread ? "font-medium text-foreground" : "text-foreground/80")}>
              {str(e.subject) || "(sans objet)"}
            </div>
            {(str(e.snippet) || str(e.preview)) && (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{str(e.snippet) || str(e.preview)}</div>
            )}
          </Wrapper>
        );
      })}
    </div>
  );
}

// ── text (a titled rich-markdown card) ───────────────────────────────────────
function TextBlock({ props }: { props: Record<string, unknown> }) {
  const text = str(props.text) || str(props.body) || str(props.content);
  if (!text) return null;
  return (
    <div className={cn(chatCard, "p-4")}>
      {str(props.title) && <div className="mb-1.5 text-[13px] font-semibold text-foreground">{str(props.title)}</div>}
      <div className="chat-prose break-words"><AgentMarkdown content={text} /></div>
    </div>
  );
}

// ── image ────────────────────────────────────────────────────────────────────
function ImageBlock({ props }: { props: Record<string, unknown> }) {
  const url = str(props.url) || str(props.src);
  if (!url) return null;
  return (
    <figure className={cn(chatCard, "overflow-hidden")}>
      <img src={url} alt={str(props.alt) || str(props.caption)} className="max-h-[420px] w-full bg-muted/30 object-contain" loading="lazy" />
      {str(props.caption) && <figcaption className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">{str(props.caption)}</figcaption>}
    </figure>
  );
}

// ── code (highlighted, copyable) ─────────────────────────────────────────────
function CodeUiBlock({ props }: { props: Record<string, unknown> }) {
  const code = str(props.code) || str(props.content);
  if (!code) return null;
  return <CodeBlock code={code} lang={str(props.language) || str(props.lang) || undefined} />;
}

// ── products (product cards grid) ────────────────────────────────────────────
function ProductsBlock({ props }: { props: Record<string, unknown> }) {
  const raw = Array.isArray(props.products) ? props.products : Array.isArray(props.items) ? props.items : [];
  const items = raw.slice(0, 12) as Record<string, unknown>[];
  if (!items.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((p, i) => {
        const url = str(p.url) || str(p.link);
        const Wrapper: any = url ? "a" : "div";
        return (
          <Wrapper
            key={i}
            {...(url ? { href: url, target: "_blank", rel: "noreferrer" } : {})}
            className={cn(chatCard, "flex flex-col overflow-hidden transition-shadow hover:shadow-sm", url && "cursor-pointer")}
          >
            {(str(p.image) || str(p.thumbnail)) && (
              <img src={str(p.image) || str(p.thumbnail)} alt={str(p.title)} className="h-28 w-full object-cover" loading="lazy" />
            )}
            <div className="flex flex-1 flex-col p-2.5">
              <div className="line-clamp-2 text-xs font-medium text-foreground">{str(p.title) || str(p.name)}</div>
              {str(p.description) && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{str(p.description)}</div>}
              {str(p.price) && <div className="mt-auto pt-1.5 text-sm font-semibold text-foreground">{str(p.price)}</div>}
            </div>
          </Wrapper>
        );
      })}
    </div>
  );
}

// ── Registry ─────────────────────────────────────────────────────────────────
function renderBlock(
  b: UiBlock, key: number | string,
  onPick?: (text: string) => void, optionsDisabled?: boolean,
  onOpenArtifact?: (a: ArtifactOpenTarget) => void,
  agentName?: string,
) {
  switch (b.component) {
    case "kpi_grid": return <KpiGrid key={key} props={b.props} />;
    case "chart": return <ChartBlock key={key} props={b.props} />;
    case "table": return <TableBlock key={key} props={b.props} />;
    case "link_card": return <LinkCard key={key} props={b.props} />;
    case "email_list": case "emails": return <EmailListBlock key={key} props={b.props} />;
    case "text": return <TextBlock key={key} props={b.props} />;
    case "image": return <ImageBlock key={key} props={b.props} />;
    case "code": return <CodeUiBlock key={key} props={b.props} />;
    case "products": case "product_card": case "product": return <ProductsBlock key={key} props={b.props} />;
    case "deliverable": return <DeliverableBlock key={key} props={b.props} onOpen={onOpenArtifact} agentName={agentName} />;
    case "artifact": return <ArtifactBlock key={key} props={b.props} onOpen={onOpenArtifact} agentName={agentName} />;
    case "options": return <OptionsBlock key={key} props={b.props} onPick={onPick} disabled={optionsDisabled} />;
    case "approval": return <ApprovalBlock key={key} props={b.props} />;
    default: return null; // unknown component → graceful no-op
  }
}

export function UiBlocks({ blocks, onPick, optionsDisabled, onOpenArtifact, agentName }: {
  blocks: UiBlock[];
  /** Called with the picked option's text (ask_user quick replies). */
  onPick?: (text: string) => void;
  /** Disable option buttons (e.g. historical messages already answered). */
  optionsDisabled?: boolean;
  /** Called when an artifact card's "Ouvrir" is clicked. */
  onOpenArtifact?: (a: ArtifactOpenTarget) => void;
  /** Name of the agent that authored these blocks — shown as "Créé par …" on artifact cards. */
  agentName?: string;
}) {
  const valid = (blocks ?? []).filter((b) => b && typeof b === "object" && b.props && typeof b.props === "object");
  if (!valid.length) return null;
  return (
    <div className="my-2 space-y-2">
      {valid.map((b, i) => renderBlock(b, i, onPick, optionsDisabled, onOpenArtifact, agentName))}
    </div>
  );
}

// ── Interleaved rendering ────────────────────────────────────────────────────
// The agent places [[ui:N]] tags (1-based, in render_ui call order) inside its
// text; we split the markdown on those tags and weave the matching blocks in.
// Unreferenced blocks render at the end; orphan tags are silently dropped.
const UI_TAG = /\[\[ui:(\d+)\]\]/g;

export function InterleavedMessage({ content, blocks, onPick, optionsDisabled, onOpenArtifact, agentName }: {
  content: string;
  blocks: UiBlock[];
  onPick?: (text: string) => void;
  optionsDisabled?: boolean;
  onOpenArtifact?: (a: ArtifactOpenTarget) => void;
  /** Name of the agent that authored this message — shown as "Créé par …" on artifact cards. */
  agentName?: string;
}) {
  const valid = (blocks ?? []).filter((b) => b && typeof b === "object" && b.props && typeof b.props === "object");
  const { segments, leftover } = useMemo(() => {
    const used = new Set<number>();
    const segs: Array<{ kind: "text"; text: string } | { kind: "block"; index: number }> = [];
    let last = 0;
    for (const m of content.matchAll(UI_TAG)) {
      const idx = Number(m[1]) - 1;
      if (m.index! > last) segs.push({ kind: "text", text: content.slice(last, m.index) });
      if (idx >= 0 && idx < valid.length && !used.has(idx)) {
        segs.push({ kind: "block", index: idx });
        used.add(idx);
      }
      last = m.index! + m[0].length;
    }
    if (last < content.length) segs.push({ kind: "text", text: content.slice(last) });
    const rest = valid.map((_, i) => i).filter((i) => !used.has(i));
    return { segments: segs, leftover: rest };
  }, [content, valid]);

  return (
    <div>
      {segments.map((s, i) =>
        s.kind === "text"
          ? (s.text.trim()
            ? <div key={i} className="chat-prose break-words"><AgentMarkdown content={s.text} /></div>
            : null)
          : <div key={i} className="my-2">{renderBlock(valid[s.index], s.index, onPick, optionsDisabled, onOpenArtifact, agentName)}</div>,
      )}
      {leftover.length > 0 && (
        <div className="my-2 space-y-2">
          {leftover.map((i) => renderBlock(valid[i], i, onPick, optionsDisabled, onOpenArtifact, agentName))}
        </div>
      )}
    </div>
  );
}
