// Les ressources d'un agent : ses pools, et rien d'autre (0310).
//
// Outils, applications, serveurs MCP, compétences, connaissances, collègues :
// un agent n'atteint que l'union de ses pools. Sans pool, il n'a que les outils
// de base. Ce qu'on lui donnait directement va désormais dans son pool
// personnel (« Accès de … »), un pool comme les autres.
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  StackIcon, XIcon, ArrowRightIcon, CircleNotchIcon, ShieldCheckIcon, PlusIcon, UsersThreeIcon, BuildingsIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { Pill } from "@/features/custom-connectors/ui";
import { IssuesList } from "./PoolsTab";
import { assignPool, poolFromAgent, qk, unassignPool, useAgentIssues, usePools, useRegistry, type Pool } from "./model";
import { CompositionBar, FamilyCounts, countFamilies } from "./visuals";

export function AgentPoolsPanel({ agent, dashboardId }: {
  agent: { id: string; name: string; service_dashboard_id?: string | null };
  /** Le service, pour les liens vers l'onglet Pools ; null : pas de lien. */
  dashboardId: string | null;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId, role } = useCurrentContext();
  const canEdit = role === "owner" || role === "admin" || role === "member";
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: pools } = usePools(projectId);
  const { data: registry } = useRegistry(projectId);
  const { data: issues } = useAgentIssues(agent.id);
  const [converting, setConverting] = useState(false);

  const byId = useMemo(() => new Map((registry ?? []).map((r) => [r.id, r])), [registry]);
  const poolsBase = dashboardId ? `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}/pools` : null;
  const openPools = (poolId?: string) => { if (poolsBase) navigate(poolId ? `${poolsBase}/${poolId}` : poolsBase); };
  const service = agent.service_dashboard_id ?? dashboardId ?? null;
  const mine = (pools ?? []).filter((p) => p.agents.some((a) => a.agent_id === agent.id));
  const available = (pools ?? []).filter((p) => !mine.includes(p) && (!p.service_dashboard_id || p.service_dashboard_id === service));
  const poolMode = mine.length > 0;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.pools(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.agentIssues(agent.id) });
    queryClient.invalidateQueries({ queryKey: qk.report(projectId) });
  };

  async function give(poolId: string) {
    try { await assignPool(agent.id, poolId, user?.id ?? null); refresh(); }
    catch (e) { toast.error("Attribution refusée", e instanceof Error ? e.message : String(e)); }
  }
  async function take(poolId: string) {
    try { await unassignPool(agent.id, poolId); refresh(); }
    catch (e) { toast.error("Retrait impossible", e instanceof Error ? e.message : String(e)); }
  }
  async function convert() {
    setConverting(true);
    try {
      const out = await poolFromAgent(agent.id);
      refresh();
      queryClient.invalidateQueries({ queryKey: qk.registry(projectId) });
      if (out.assigned) {
        toast.success(`« ${out.name} » créé et donné à ${agent.name}`, "Il n'atteint plus que ses pools.");
      } else {
        toast.error(`« ${out.name} » créé, mais pas encore donné`, out.errors[0] ?? "Il n'est pas cohérent : corrigez-le avant de le donner.");
        openPools(out.pool_id);
      }
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally { setConverting(false); }
  }

  const tileCls = "flex min-h-[132px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-60";

  return (
    <section className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-2xl font-semibold tracking-tight">Ressources</h2>
            {poolMode
              ? <Pill tone="violet"><StackIcon weight="fill" className="h-3 w-3" /> {mine.length} pool{mine.length > 1 ? "s" : ""}</Pill>
              : <Pill>Aucun pool</Pill>}
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {poolMode
              ? <>{agent.name} n'atteint que ce que ses pools lui donnent : outils, applications, compétences, connaissances et collègues.</>
              : <>{agent.name} n'a que les outils de base. Donnez-lui un pool pour lui ouvrir des outils, des applications, des compétences ou des connaissances.</>}
          </p>
        </div>
        {poolsBase && (
          <Button size="sm" variant="ghost" onClick={() => openPools()}>
            Tous les pools <ArrowRightIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {mine.map((p) => (
          <AgentPoolCard
            key={p.id} pool={p}
            counts={countFamilies(p.items.map((i) => byId.get(i.registry_id)))}
            onOpen={() => openPools(p.id)}
            onRemove={canEdit ? () => void take(p.id) : undefined}
          />
        ))}

        {canEdit && available.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={tileCls}>
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><PlusIcon className="h-4 w-4" /></span>
                <span className="font-medium text-foreground">{poolMode ? "Ajouter un pool" : "Donner un pool"}</span>
                <span className="text-xs">{available.length} disponible{available.length > 1 ? "s" : ""}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto rounded-xl">
              <DropdownMenuLabel className="text-[10px] uppercase">Donner à {agent.name}</DropdownMenuLabel>
              {available.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => void give(p.id)}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><StackIcon weight="duotone" className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{p.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {p.items.length} ressource{p.items.length > 1 ? "s" : ""} · {p.service_dashboard_id ? "ce service" : "tout le projet"}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {canEdit && !poolMode && (
          <button className={tileCls} disabled={converting} onClick={() => void convert()}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              {converting ? <CircleNotchIcon className="h-4 w-4 animate-spin" /> : <ShieldCheckIcon weight="duotone" className="h-4 w-4" />}
            </span>
            <span className="font-medium text-foreground">Créer son pool personnel</span>
            <span className="max-w-[30ch] text-xs">Ses collègues du service et le travail qu'on lui confie, en un pool, donné s'il est cohérent.</span>
          </button>
        )}

        {!poolMode && !canEdit && (
          <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground md:col-span-2 lg:col-span-3">
            Aucun pool : {agent.name} n'a que les outils de base.
          </p>
        )}
      </div>

      {poolMode && (
        <div className="mt-4">
          <IssuesList
            issues={issues ?? []}
            empty="Ses pools sont cohérents : tout ce qu'on lui confie est à sa portée, et ses collègues peuvent lui répondre."
          />
        </div>
      )}
    </section>
  );
}

function AgentPoolCard({ pool, counts, onOpen, onRemove }: {
  pool: Pool; counts: ReturnType<typeof countFamilies>; onOpen: () => void; onRemove?: () => void;
}) {
  return (
    <Card className="group relative flex flex-col gap-3 p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <StackIcon weight="duotone" className="h-[18px] w-[18px]" />
        </span>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-semibold hover:underline">{pool.name}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {pool.service_dashboard_id
              ? <><UsersThreeIcon className="h-3 w-3" /> Ce service</>
              : <><BuildingsIcon className="h-3 w-3" /> Tout le projet</>}
            <span>· {pool.items.length} ressource{pool.items.length > 1 ? "s" : ""}</span>
          </span>
        </button>
        {onRemove && (
          <button onClick={onRemove} title="Retirer ce pool" aria-label="Retirer ce pool"
            className={cn("rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100")}>
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <CompositionBar counts={counts} />
      {pool.items.length > 0
        ? <FamilyCounts counts={counts} />
        : <p className="text-[11px] text-muted-foreground">Pool vide : l'agent n'atteint rien par lui.</p>}
    </Card>
  );
}
