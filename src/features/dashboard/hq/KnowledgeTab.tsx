// Connaissances — the RAG side of the workforce: what is indexed, who can reach
// it, and whether the searches actually come back with something.
//
// One honest limitation, surfaced in the UI: the runtime logs THAT an agent ran
// search_knowledge, not which collection answered. Per-collection search counts
// are therefore attributed through the agent's rag_search grant.
import {
  BookOpen, Database, Search, Users, AlertTriangle, FileText, CheckCircle2,
  Link2, Layers, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { foldToSlots } from "@/features/crm/overview/vizPalette";
import type { CollectionStat } from "../hqUsage";
import type { HqView } from "./model";
import {
  SectionCard, Empty, KpiGrid, Donut, BarList, useHqPalette, rateTone, timeAgo, Pill,
} from "./primitives";

export function KnowledgeTab({ view, onOpenCollection }: {
  view: HqView; onOpenCollection?: (id: string) => void;
}) {
  const { cat, status } = useHqPalette();
  const k = view.knowledge;

  const alerts = [
    k.failedSources > 0 && { tone: "bad" as const, label: `${k.failedSources} source(s) en échec d'indexation` },
    k.pendingSources > 0 && { tone: "warn" as const, label: `${k.pendingSources} source(s) en cours de traitement` },
    k.orphanCollections > 0 && { tone: "warn" as const, label: `${k.orphanCollections} collection(s) qu'aucun agent n'utilise` },
    k.unscopedAgents > 0 && { tone: "muted" as const, label: `${k.unscopedAgents} agent(s) cherchent sans périmètre défini` },
    k.hitRate != null && k.hitRate < 50 && { tone: "bad" as const, label: `${100 - k.hitRate}% des recherches ne trouvent rien` },
  ].filter(Boolean) as { tone: "bad" | "warn" | "muted"; label: string }[];

  if (k.totalCollections === 0 && k.searches === 0) {
    return <Empty label="Aucune collection de connaissances et aucune recherche sur la période." className="h-40" />;
  }

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "coll", label: "Collections", value: String(k.totalCollections), sub: `${k.activeCollections} active(s)`, icon: BookOpen, accent: cat[0] },
          { key: "docs", label: "Documents indexés", value: String(k.totalSources), sub: `${k.failedSources} en échec`, icon: FileText, accent: cat[1] },
          { key: "chunks", label: "Fragments vectorisés", value: k.totalChunks.toLocaleString("fr-FR"), icon: Database, accent: cat[4] },
          {
            key: "search", label: "Recherches", value: String(k.searches), icon: Search, accent: cat[3],
            curve: { name: "Recherches de connaissance", data: view.bucket(view.toolEvents, (e) => e.created_at, (e) => e.kind === "tool_call" && e.tool === "search_knowledge"), labels: view.labels, fullLabels: view.fullLabels },
          },
          { key: "hit", label: "Taux de réponse", value: k.hitRate == null ? "—" : `${k.hitRate}%`, sub: k.hitRate == null ? "Aucun résultat observé" : `${k.hits} trouvées · ${k.misses} vides`, icon: CheckCircle2, accent: cat[5], tone: rateTone(k.hitRate) },
          { key: "cov", label: "Agents connectés", value: String(k.connectedAgents), sub: k.coverage == null ? undefined : `${k.coverage}% de la force de travail`, icon: Users, accent: cat[6] },
        ]}
      />

      {alerts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="text-xs font-medium">À traiter</span>
          {alerts.map((a) => <Pill key={a.label} tone={a.tone}>{a.label}</Pill>)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Réponses de la base" subtitle="Recherches ayant renvoyé au moins un extrait" icon={<Search className="h-3.5 w-3.5" />}>
          {k.hits + k.misses === 0 ? <Empty label="Aucune recherche observée." /> : (
            <Donut
              unit="recherches"
              total={k.hits + k.misses}
              colors={[status.good, status.critical]}
              slices={[{ label: "Trouvé", value: k.hits }, { label: "Sans résultat", value: k.misses }]}
            />
          )}
        </SectionCard>

        <SectionCard title="Collections les plus sollicitées" subtitle="Recherches des agents qui y ont accès" icon={<Layers className="h-3.5 w-3.5" />}>
          <BarList
            emptyLabel="Aucune collection connectée à un agent."
            labelWidth="w-32"
            rows={foldToSlots(k.collections.filter((c) => c.searches > 0).map((c) => ({ label: c.collection.name, count: c.searches })))
              .map((c, i) => ({ key: c.label, label: c.label, value: c.count, caption: `${c.count} recherches`, color: cat[Math.min(i, cat.length - 1)] }))}
          />
        </SectionCard>

        <SectionCard title="Agents chercheurs" subtitle="Qui interroge la connaissance" icon={<Users className="h-3.5 w-3.5" />}>
          {k.byAgent.length === 0 ? <Empty label="Aucune recherche sur la période." /> : (
            <div className="scrollbar-slim max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {k.byAgent.slice(0, 8).map((a) => (
                <div key={a.agentId} className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs">
                  <AgentIdentity url={view.agentById.get(a.agentId)?.avatar_url} seed={view.agentName(a.agentId)} size={20} rounded="rounded-md" />
                  <span className="min-w-0 flex-1 truncate">{view.agentName(a.agentId)}</span>
                  <Pill tone="muted">{a.collections || "—"} coll.</Pill>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{a.searches}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Collections" subtitle="Contenu indexé, agents connectés et usage" icon={<BookOpen className="h-3.5 w-3.5" />}>
        {k.collections.length === 0 ? <Empty label="Aucune collection dans ce projet." /> : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {k.collections.map((c) => (
              <CollectionCard key={c.collection.id} stat={c} view={view}
                onOpen={onOpenCollection ? () => onOpenCollection(c.collection.id) : undefined} />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Matrice d'accès"
        subtitle="Quel agent peut interroger quelle collection (droit rag_search)"
        icon={<Link2 className="h-3.5 w-3.5" />}
      >
        <AccessMatrix view={view} />
      </SectionCard>

      <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Le moteur journalise les recherches par agent, pas la collection qui a répondu. Les compteurs par collection
          sont donc attribués via le droit d'accès de chaque agent — un agent connecté à deux collections compte pour
          les deux.
        </span>
      </div>
    </div>
  );
}

function CollectionCard({ stat, view, onOpen }: { stat: CollectionStat; view: HqView; onOpen?: () => void }) {
  const { status } = useHqPalette();
  const c = stat;
  const total = Math.max(1, c.sources);
  const segments = [
    { v: c.ready, color: status.good, label: "Prêtes" },
    { v: c.pending, color: status.warning, label: "En cours" },
    { v: c.failed, color: status.critical, label: "En échec" },
  ].filter((s) => s.v > 0);

  return (
    <div
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter") onOpen(); } : undefined}
      className={cn(
        "rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm transition-all",
        onOpen && "cursor-pointer hover:-translate-y-0.5 hover:shadow-md",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500"><BookOpen className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{c.collection.name}</span>
            {!c.collection.enabled && <Pill tone="muted">désactivée</Pill>}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {c.sources} document{c.sources > 1 ? "s" : ""} · {c.chunks.toLocaleString("fr-FR")} fragments
          </p>
        </div>
      </div>

      {segments.length > 0 && (
        <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
          {segments.map((s) => <span key={s.label} className="h-full ring-1 ring-card" style={{ width: `${(s.v / total) * 100}%`, background: s.color }} title={`${s.label} : ${s.v}`} />)}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {c.agentIds.slice(0, 4).map((id) => (
            <AgentIdentity key={id} url={view.agentById.get(id)?.avatar_url} seed={view.agentName(id)} size={20} rounded="rounded-md" />
          ))}
          {c.agentIds.length > 4 && <span className="text-[10px] text-muted-foreground">+{c.agentIds.length - 4}</span>}
          {c.agentIds.length === 0 && <span className="text-[10px] text-muted-foreground">Aucun agent connecté</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {c.searches > 0 && <Pill tone="accent">{c.searches} recherches</Pill>}
          <span>{c.lastIndexedAt ? `MAJ ${timeAgo(c.lastIndexedAt)}` : "jamais indexée"}</span>
        </div>
      </div>
    </div>
  );
}

/** Binary access grid: a filled cell = this agent's rag_search grant names that
 *  collection. Kept separate from the heat map because access is not a volume. */
function AccessMatrix({ view }: { view: HqView }) {
  const { cat } = useHqPalette();
  const collections = view.knowledge.collections.slice(0, 10);
  const agents = view.agents
    .map((a) => ({ agent: a, stat: view.knowledge.byAgent.find((x) => x.agentId === a.id) }))
    .filter((r) => view.knowledge.collections.some((c) => c.agentIds.includes(r.agent.id)) || (r.stat?.searches ?? 0) > 0)
    .slice(0, 14);

  if (collections.length === 0 || agents.length === 0) {
    return <Empty label="Aucun accès configuré — activez une collection sur l'outil « rag_search » d'un agent." />;
  }

  return (
    <div className="scrollbar-slim overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-1 pb-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent</th>
            {collections.map((c) => (
              <th key={c.collection.id} className="px-1 pb-1.5 text-[10px] font-medium text-muted-foreground" title={c.collection.name}>
                <span className="block max-w-[84px] truncate">{c.collection.name}</span>
              </th>
            ))}
            <th className="px-1 pb-1.5 text-[10px] font-medium text-muted-foreground">Recherches</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(({ agent, stat }) => (
            <tr key={agent.id}>
              <td className="sticky left-0 z-10 bg-card pr-2">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AgentIdentity url={agent.avatar_url} seed={agent.name} size={18} rounded="rounded-md" />
                  <span className="max-w-[130px] truncate">{agent.name}</span>
                </span>
              </td>
              {collections.map((c) => {
                const granted = c.agentIds.includes(agent.id);
                return (
                  <td key={c.collection.id} className="p-0">
                    <div
                      title={`${agent.name} ${granted ? "peut" : "ne peut pas"} interroger « ${c.collection.name} »`}
                      className="flex h-8 min-w-[52px] items-center justify-center rounded-md"
                      style={{ background: granted ? `color-mix(in srgb, ${cat[0]} 55%, transparent)` : "hsl(var(--muted) / 0.4)" }}
                    >
                      {granted
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-foreground" />
                        : <span className="text-muted-foreground/40">·</span>}
                    </div>
                  </td>
                );
              })}
              <td className="p-0">
                <div className="flex h-8 min-w-[52px] items-center justify-center rounded-md bg-muted/40 tabular-nums text-foreground">
                  {stat?.searches ?? 0}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
