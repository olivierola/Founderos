import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon, BookOpenIcon, ChatCircleDotsIcon, ChatsCircleIcon, CheckCircleIcon,
  CircleNotchIcon as Loader2, CodeIcon, PuzzlePieceIcon, SmileyIcon, TrayIcon, UsersIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { formatRelative } from "@/features/tracker/pickers";
import { useAgentAnalytics } from "./analytics/useAgentAnalytics";
import type { Agent, PublicAgentTab } from "./AgentBuilder";
import { PaCard, PaKpi, PaKpiGrid, PaPage, PaStatus, fmtBytes, nf } from "./ui";

/**
 * Le tableau de bord d'un agent public : ce qu'ouvre sa carte.
 *
 * Même composition que celui d'un collaborateur interne (AgentHome) : un
 * bandeau teinté par l'accent de l'app, avec l'agent en grand, son état et
 * deux tuiles à sept barres ; quatre indicateurs ; puis les dernières
 * conversations et l'état de sa base de connaissances.
 */

export function publicAgentAvatarUrl(agent: Agent): string | null {
  const w = (agent.widget_config ?? {}) as Record<string, unknown>;
  if (w.avatar_type === "image" && typeof w.avatar_url === "string" && w.avatar_url) return w.avatar_url;
  if (typeof w.avatar_bot === "string" && w.avatar_bot) return `bot:${w.avatar_bot}`;
  return null;
}

interface ConvRow {
  id: string; created_at: string; source: string | null; outcome: string | null;
  country: string | null; device: string | null; rating: number | null;
}

const OUTCOME: Record<string, { label: string; tone: "ok" | "warn" | "error" | "idle" }> = {
  resolved: { label: "Résolue", tone: "ok" },
  unresolved: { label: "Sans réponse", tone: "warn" },
  escalated: { label: "Relayée", tone: "warn" },
  abandoned: { label: "Abandonnée", tone: "idle" },
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });

export function PublicAgentHome({ agent, onOpen }: { agent: Agent; onOpen: (tab: PublicAgentTab, sub?: string) => void }) {
  const { data: a, isLoading } = useAgentAnalytics(agent.id, 7);

  const { data: recent } = useQuery({
    queryKey: ["pa_home_recent", agent.id],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data: convs } = await supabase.from("rag_conversations")
        .select("id, created_at, source, outcome, country, device, rating")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(6);
      const rows = (convs ?? []) as ConvRow[];
      if (!rows.length) return [] as Array<ConvRow & { question: string }>;
      const { data: msgs } = await supabase.from("rag_messages")
        .select("conversation_id, content, created_at").eq("role", "user")
        .in("conversation_id", rows.map((r) => r.id)).order("created_at", { ascending: true });
      const first = new Map<string, string>();
      for (const m of (msgs ?? []) as Array<{ conversation_id: string; content: string }>) {
        if (!first.has(m.conversation_id)) first.set(m.conversation_id, m.content);
      }
      return rows.map((r) => ({ ...r, question: first.get(r.id) ?? "" }));
    },
  });

  const { data: sources } = useQuery({
    queryKey: ["rag_sources", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as Array<{ id: string; type: string; title: string; status: string; chunk_count: number; byte_size?: number }>;
    },
  });

  const { data: openTickets } = useQuery({
    queryKey: ["pa_home_tickets", agent.id],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase.from("resolve_tickets").select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id).in("status", ["open", "in_progress"]);
      return count ?? 0;
    },
  });

  const stats = useMemo(() => {
    const t = a?.totals;
    const daily = a?.daily ?? [];
    const last7 = daily.slice(-7);
    const involved = t?.involved ?? 0;
    return {
      total: t?.total ?? 0,
      visitors: t?.visitors ?? 0,
      resolution: involved ? Math.round(((t?.resolved ?? 0) / involved) * 100) : null,
      satisfaction: t?.rated ? Math.round(((t?.rated_positive ?? 0) / t.rated) * 100) : null,
      rated: t?.rated ?? 0,
      firstMs: t?.avg_first_ms ?? null,
      bars: last7.map((d) => d.conversations),
      rateBars: last7.map((d) => (d.conversations ? Math.round((d.resolved / d.conversations) * 100) : 0)),
      days: last7.map((d) => d.day),
      prevTotal: a?.previous?.total ?? 0,
    };
  }, [a]);

  const ready = (sources ?? []).filter((s) => s.status === "ready");
  const pending = (sources ?? []).filter((s) => s.status === "processing" || s.status === "pending").length;
  const failed = (sources ?? []).filter((s) => s.status === "failed").length;
  const chunks = ready.reduce((n, s) => n + (s.chunk_count ?? 0), 0);
  const bytes = (sources ?? []).reduce((n, s) => n + (s.byte_size ?? 0), 0);
  const trained = ready.length > 0;
  const delta = stats.prevTotal ? Math.round(((stats.total - stats.prevTotal) / stats.prevTotal) * 100) : null;

  // La prochaine chose utile à faire, dite en une phrase dans le bandeau.
  const nextStep = !trained
    ? { label: "Ajouter des connaissances", hint: "Sans source, il répond à l'aveugle", tab: "knowledge" as PublicAgentTab }
    : !agent.enabled
      ? { label: "Activer le widget", hint: "Il est désactivé dans les réglages", tab: "settings" as PublicAgentTab }
      : stats.total === 0
        ? { label: "Poser le widget sur votre site", hint: "Une ligne à coller", tab: "widget" as PublicAgentTab, sub: "integration" }
        : null;

  return (
    <PaPage className="ah-root">
      {/* ── Le bandeau ── */}
      <section
        className="ah-hero grid items-center gap-6 overflow-hidden rounded-3xl p-6 text-white"
        style={{ background: "color-mix(in oklab, hsl(var(--primary)) 28%, #09090f)" }}
      >
        <div className="ah-avatar relative h-[180px] items-center justify-center">
          <span aria-hidden className="absolute bottom-2 h-5 w-32 rounded-[50%]" style={{ background: "radial-gradient(closest-side, rgb(0 0 0 / 0.5), transparent)" }} />
          <span className="relative -translate-y-2">
            <AgentIdentity url={publicAgentAvatarUrl(agent)} seed={agent.name} size={150} rounded="rounded-[2rem]" />
          </span>
        </div>

        <div className="flex min-w-0 items-center">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wide">
              <span className={cn("h-1.5 w-1.5 rounded-full", agent.enabled ? "bg-emerald-400" : "bg-white/50")} />
              Agent public · {agent.enabled ? "En ligne" : "Hors ligne"}
            </span>
            <h1 className="mt-2.5 truncate text-[22px] font-semibold tracking-tight">
              {stats.total > 0
                ? `${agent.name} a répondu à ${nf(stats.total)} conversation${stats.total > 1 ? "s" : ""} cette semaine`
                : `${agent.name} attend ses premiers visiteurs`}
            </h1>
            <div className="mt-3 flex flex-wrap gap-2">
              {agent.description && (
                <span className="max-w-[520px] truncate text-[13px] text-white/60">{agent.description}</span>
              )}
              {nextStep && (
                <button
                  onClick={() => onOpen(nextStep.tab, nextStep.sub)}
                  className="rounded-full border border-amber-300/40 bg-amber-400/10 px-3 py-1 text-[12px] text-amber-200 transition-colors hover:bg-amber-400/20"
                >
                  {nextStep.label} · {nextStep.hint}
                </button>
              )}
              {(openTickets ?? 0) > 0 && (
                <button
                  onClick={() => onOpen("support")}
                  className="rounded-full border border-white/20 px-3 py-1 text-[12px] text-white/85 transition-colors hover:bg-white/10"
                >
                  {openTickets} demande{openTickets! > 1 ? "s" : ""} pour l'équipe
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="ah-tiles grid gap-3">
          <HeroTile
            label="Conversations, 7 j" value={isLoading ? "…" : nf(stats.total)}
            sub={delta == null ? `${nf(stats.visitors)} visiteurs` : `${delta >= 0 ? "+" : ""}${delta} % vs 7 j précédents`}
            bars={stats.bars} days={stats.days} unit={(v) => `${nf(v)} conversation${v > 1 ? "s" : ""}`}
          />
          <HeroTile
            label="Résolution" value={stats.resolution == null ? "–" : `${stats.resolution} %`}
            sub={stats.satisfaction == null ? "pas encore d'avis" : `${stats.satisfaction} % d'avis positifs`}
            bars={stats.rateBars} days={stats.days} unit={(v) => `${v} % résolues`}
          />
          <div className="flex flex-col gap-3">
            <button
              onClick={() => onOpen("playground")}
              className="group flex flex-1 items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left text-zinc-900 transition-colors hover:bg-white/90"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]">
                <ChatCircleDotsIcon weight="duotone" className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">Tester {agent.name}</span>
                <span className="block truncate text-[12px] opacity-60">Playground, comme un visiteur</span>
              </span>
              <ArrowRightIcon className="h-4 w-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
            </button>
            <button
              onClick={() => onOpen("widget", "integration")}
              className="group flex flex-1 items-center gap-3 rounded-2xl bg-white/[0.07] px-4 py-3 text-left ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.12]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10">
                <CodeIcon weight="duotone" className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">Intégrer le widget</span>
                <span className="block truncate text-[12px] text-white/60">HTML, React, Next.js, WordPress…</span>
              </span>
              <ArrowRightIcon className="h-4 w-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
            </button>
          </div>
        </div>
      </section>

      {/* ── Les indicateurs ── */}
      <PaKpiGrid>
        <PaKpi
          icon={UsersIcon} label="Visiteurs" value={nf(stats.visitors)}
          sub={`${nf(a?.totals.messages ?? 0)} messages échangés`}
          action={{ label: "Voir l'audience", onClick: () => onOpen("analytics", "audience") }}
        />
        <PaKpi
          icon={CheckCircleIcon} label="Résolues" value={nf(a?.totals.resolved ?? 0)}
          sub={`${nf(a?.totals.escalated ?? 0)} relayées · ${nf(a?.totals.unresolved ?? 0)} sans réponse`}
          meter={stats.resolution == null ? undefined : { label: "Taux de résolution", pct: stats.resolution, tone: stats.resolution < 50 ? "warn" : "accent" }}
        />
        <PaKpi
          icon={SmileyIcon} label="Satisfaction" value={stats.satisfaction == null ? "–" : `${stats.satisfaction} %`}
          sub={stats.rated ? `${nf(stats.rated)} avis` : "aucun avis sur 7 jours"}
          meter={stats.satisfaction == null ? undefined : { label: "Avis positifs", pct: stats.satisfaction, tone: "ok" }}
        />
        <PaKpi
          icon={TrayIcon} label="Demandes ouvertes" value={nf(openTickets ?? 0)}
          sub="confiées à l'équipe"
          action={{ label: "Ouvrir la file", onClick: () => onOpen("support") }}
        />
      </PaKpiGrid>

      {/* ── Conversations et connaissances ── */}
      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))]">
        <PaCard
          title="Dernières conversations"
          sub={recent?.length ? "les six plus récentes, tous canaux" : "aucune pour l'instant"}
          actions={
            <button
              onClick={() => onOpen("analytics", "performance")}
              className="rounded-full border border-border px-4 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
            >
              Analytics
            </button>
          }
          bodyClassName="pt-2"
        >
          {!recent ? (
            <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ChatsCircleIcon className="h-5 w-5" />
              </span>
              <p className="text-[13px] text-muted-foreground">Les conversations du widget et du playground s'affichent ici.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {recent.map((c) => {
                const o = c.outcome ? OUTCOME[c.outcome] : null;
                return (
                  <li key={c.id} className="flex items-center gap-3.5 py-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
                      <ChatCircleDotsIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 text-[13px] font-medium">{c.question || "Conversation sans message"}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        {c.source === "playground" ? "Playground" : "Widget"}
                        {c.country && <> · {c.country}</>}
                        {c.device && <> · {c.device === "mobile" ? "Mobile" : c.device === "tablet" ? "Tablette" : "Ordinateur"}</>}
                        <> · {formatRelative(c.created_at)}</>
                      </span>
                    </span>
                    {o ? <PaStatus tone={o.tone}>{o.label}</PaStatus> : <PaStatus tone="idle">En cours</PaStatus>}
                  </li>
                );
              })}
            </ul>
          )}
        </PaCard>

        <PaCard
          title="Connaissances"
          sub={trained ? `${ready.length} source${ready.length > 1 ? "s" : ""} prête${ready.length > 1 ? "s" : ""} · ${nf(chunks)} passages · ${fmtBytes(bytes)}` : "pas encore entraîné"}
          actions={
            <button
              onClick={() => onOpen("knowledge")}
              className="rounded-full border border-border px-4 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
            >
              Gérer
            </button>
          }
          bodyClassName="pt-2"
        >
          {(pending > 0 || failed > 0) && (
            <div className="mb-2 flex flex-wrap gap-2 pt-2">
              {pending > 0 && <PaStatus tone="live">{pending} en cours d'indexation</PaStatus>}
              {failed > 0 && <PaStatus tone="error">{failed} en échec</PaStatus>}
            </div>
          )}
          {!sources?.length ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <BookOpenIcon className="h-5 w-5" />
              </span>
              <p className="text-[13px] text-muted-foreground">Ajoutez une page, un fichier ou une FAQ pour qu'il réponde juste.</p>
              <button
                onClick={() => onOpen("knowledge")}
                className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-4 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Ajouter une source <ArrowRightIcon className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {sources.slice(0, 6).map((s) => (
                <li key={s.id} className="flex items-center gap-3.5 py-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
                    {s.status === "failed" ? <WarningCircleIcon className="h-4 w-4 text-red-500" /> : <BookOpenIcon className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-[13px] font-medium">{s.title}</span>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground">
                      {s.type === "url" ? "Page web" : s.type === "saas_structure" ? "Structure de l'app" : s.type === "file" ? "Fichier" : "Texte"}
                      {s.status === "ready" ? ` · ${nf(s.chunk_count)} passages` : ""}
                    </span>
                  </span>
                  <PaStatus tone={s.status === "ready" ? "ok" : s.status === "failed" ? "error" : "live"}>
                    {s.status === "ready" ? "Prête" : s.status === "failed" ? "Échec" : "Indexation"}
                  </PaStatus>
                </li>
              ))}
            </ul>
          )}
        </PaCard>
      </div>

      {/* ── Raccourcis de configuration ── */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
        {[
          { icon: PuzzlePieceIcon, label: "Apparence du widget", sub: "Modèle, thème, lanceur", tab: "widget" as PublicAgentTab, s: "modele" },
          { icon: BookOpenIcon, label: "Base de connaissances", sub: `${sources?.length ?? 0} source${(sources?.length ?? 0) > 1 ? "s" : ""}`, tab: "knowledge" as PublicAgentTab },
          { icon: TrayIcon, label: "Demandes et SLA", sub: "Tri, intentions, relais", tab: "support" as PublicAgentTab, s: "setup" },
          { icon: ChatsCircleIcon, label: "Comportement", sub: "Persona, ton, modèle", tab: "settings" as PublicAgentTab },
        ].map((x) => (
          <button
            key={x.label}
            onClick={() => onOpen(x.tab, x.s)}
            className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <x.icon weight="duotone" className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{x.label}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{x.sub}</span>
            </span>
            <ArrowRightIcon className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </PaPage>
  );
}

/** Une tuile du bandeau : la valeur, et sept barres pour les sept derniers jours. */
function HeroTile({ label, value, sub, bars, days, unit }: {
  label: string; value: string; sub: string; bars: number[]; days: string[]; unit: (v: number) => string;
}) {
  const max = Math.max(1, ...bars);
  const shown = bars.length ? bars : Array(7).fill(0);
  return (
    <div className="relative flex flex-col justify-between rounded-2xl bg-white/[0.07] p-4 ring-1 ring-inset ring-white/10">
      <span className="text-[12px] text-white/70">{label}</span>
      <span className="mt-3 flex items-end justify-between gap-3">
        <span className="whitespace-nowrap text-[26px] font-semibold leading-none tracking-tight">{value}</span>
        <span className="flex h-9 items-end gap-[3px]">
          {shown.map((v: number, i: number) => (
            <span key={i} className="flex h-full w-[9px] items-end" title={days[i] ? `${dayLabel(days[i])} : ${unit(v)}` : undefined}>
              <span
                className={cn("block w-full rounded-t-[3px]", i === shown.length - 1 ? "bg-white" : "bg-white/40")}
                style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
              />
            </span>
          ))}
        </span>
      </span>
      <span className="mt-2.5 truncate text-[11px] text-white/55">{sub}</span>
    </div>
  );
}
