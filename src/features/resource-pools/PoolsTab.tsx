// L'onglet « Pools » du dashboard de service : la passerelle de ressources.
//
// Le registre recense tout ce qu'un agent peut atteindre — chaque source
// connectée avec sa liste d'outils, les collections, les compétences, les
// guardrails, les workflows et les agents eux-mêmes (pour l'A2A). Un pool en
// est un lot, donné à un agent en une fois. Un agent qui a un pool n'atteint
// plus que ses pools ; la cohérence (procédures et automatisations, A2A
// réciproque, ressources disparues) est vérifiée en base et affichée ici.
//
// Adresses : /pools (la liste), /pools/:poolId (un pool), /pools/registre,
// /pools/coherence.
//
// L'habillage reprend les briques du dashboard : la bande d'indicateurs
// (StatisticsCard7) des planifications, les cartes et états vides communs, les
// avatars des agents (AgentIdentity), les logos du catalogue Composio, et le
// petit kit des outils customisés (Pill, Segmented, Drawer, Field…).
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon, StackIcon, TrashIcon, PencilSimpleIcon, MagnifyingGlassIcon, CaretRightIcon, CaretDownIcon,
  ArrowsClockwiseIcon, WarningIcon, WarningOctagonIcon, InfoIcon, CheckCircleIcon, CircleNotchIcon,
  XIcon, RobotIcon, UsersThreeIcon, BuildingsIcon, PlugsConnectedIcon, ShieldCheckIcon, DotsThreeIcon,
  ArrowRightIcon, TextAlignLeftIcon, MagicWandIcon,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { StatisticsCard7, type StatisticsCardItem } from "@/components/ui/statistics-card-7";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ToastProvider";
import { useConfirm, usePromptText } from "@/components/ConfirmProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { InfoHint } from "@/components/ui/info-hint";
import { Drawer, Field, Pill, RISK_META, SectionTitle, Segmented } from "@/features/custom-connectors/ui";
import {
  FAMILIES, familyOf, fitsPool, kindLabel, qk, SOURCE_LABEL,
  addPoolItems, assignPool, createPool, deletePool, discoverProjectApps, rebuildRegistry, removePoolItem, unassignPool, updatePool,
  useCoherenceReport, usePoolIssues, usePools, useRegistry,
  type Family, type Issue, type Pool, type RegistryItem,
} from "./model";
import {
  AgentStack, CompositionBar, FamilyCounts, FamilyTile, ResourceIcon, countFamilies, useVisuals, type Visuals,
} from "./visuals";

type View = "pools" | "registre" | "coherence";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("fr-FR")} ${n > 1 ? many : one}`;

/** Ce que le service voit du registre : ses ressources, celles du projet, et
 *  les agents et workflows de partout (ils traversent les services). */
function visibleInService(r: RegistryItem, dashboardId: string) {
  return !r.service_dashboard_id || r.service_dashboard_id === dashboardId
    || r.kind === "agent" || r.kind === "automation" || r.kind === "procedure";
}

export function PoolsTab({ dashboardId, base, sub }: {
  dashboardId: string;
  /** Adresse de l'onglet (…/service/:id/pools). */
  base: string;
  sub: string | null;
}) {
  const navigate = useNavigate();
  const view: View = sub === "registre" ? "registre" : sub === "coherence" ? "coherence" : "pools";
  const poolId = sub && sub !== "registre" && sub !== "coherence" ? sub : null;

  if (poolId) return <PoolEditor poolId={poolId} dashboardId={dashboardId} onBack={() => navigate(base)} base={base} />;
  return <PoolsHome dashboardId={dashboardId} base={base} view={view} />;
}

// ── L'accueil : indicateurs, puis la liste, le registre ou la cohérence ─────

function PoolsHome({ dashboardId, base, view }: { dashboardId: string; base: string; view: View }) {
  const navigate = useNavigate();
  const { projectId, role } = useCurrentContext();
  const canEdit = role === "owner" || role === "admin" || role === "member";
  const { data: pools, isLoading } = usePools(projectId);
  const { data: registry } = useRegistry(projectId);
  const { data: report } = useCoherenceReport(projectId);
  const visuals = useVisuals(projectId);
  const [creating, setCreating] = useState(false);

  const go = (v: View) => navigate(v === "pools" ? base : `${base}/${v}`);
  const visible = (pools ?? []).filter((p) => !p.service_dashboard_id || p.service_dashboard_id === dashboardId);
  const scoped = (registry ?? []).filter((r) => visibleInService(r, dashboardId));
  const errors = (report ?? []).filter((i) => i.severity === "error").length;
  const warnings = (report ?? []).filter((i) => i.severity === "warning").length;

  const pooled = new Set((pools ?? []).flatMap((p) => p.agents.map((a) => a.agent_id)));
  const serviceAgents = visuals.agents.filter((a) => a.service_dashboard_id === dashboardId);
  const inPoolMode = serviceAgents.filter((a) => pooled.has(a.id)).length;
  const active = scoped.filter((r) => r.status === "active").length;
  const sources = scoped.filter((r) => r.kind === "toolset" && r.source !== "builtin").length;
  const shared = visible.filter((p) => !p.service_dashboard_id).length;

  const stats: StatisticsCardItem[] = [
    {
      key: "pools", title: "Pools", subtitle: "Ce service et le projet", icon: StackIcon,
      value: String(visible.length),
      subtext: <span className="text-muted-foreground">{shared ? `dont ${shared} ouvert${shared > 1 ? "s" : ""} à tout le projet` : "aucun ouvert à tout le projet"}</span>,
      onClick: view === "pools" ? undefined : () => go("pools"),
    },
    {
      key: "agents", title: "Agents en mode pools", subtitle: "Agents de ce service", icon: RobotIcon,
      value: String(inPoolMode),
      badge: serviceAgents.length ? { text: `${Math.round((100 * inPoolMode) / serviceAgents.length)} %`, tone: inPoolMode ? "positive" : "neutral" } : undefined,
      subtext: <span className="text-muted-foreground">sur {serviceAgents.length} — les autres restent en mode granulaire</span>,
    },
    {
      key: "registry", title: "Registre", subtitle: "Ressources atteignables", icon: PlugsConnectedIcon,
      value: active.toLocaleString("fr-FR"),
      subtext: <span className="text-muted-foreground">{plural(sources, "source connectée", "sources connectées")}</span>,
      onClick: view === "registre" ? undefined : () => go("registre"),
    },
    {
      key: "coherence", title: "Cohérence", subtitle: "Tout le projet", icon: ShieldCheckIcon,
      value: errors ? String(errors) : "OK",
      valueClassName: errors ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
      badge: warnings ? { text: plural(warnings, "avertissement"), icon: WarningIcon, tone: "neutral" } : undefined,
      subtext: <span className="text-muted-foreground">{errors ? `erreur${errors > 1 ? "s" : ""} bloquante${errors > 1 ? "s" : ""}` : "aucune erreur bloquante"}</span>,
      onClick: view === "coherence" ? undefined : () => go("coherence"),
    },
  ];

  return (
    <div className="px-14 py-8 xl:px-20">
      <PageHeader
        title="Pools"
        description="Des lots de ressources à donner à vos agents en une fois."
        actions={canEdit ? <Button size="sm" onClick={() => setCreating(true)}><PlusIcon className="h-3.5 w-3.5" /> Nouveau pool</Button> : undefined}
      />

      <StatisticsCard7 size="compact" cards={stats} columnsClassName="sm:grid-cols-2 lg:grid-cols-4" />

      <div className="mt-8">
        <Segmented<View>
          value={view}
          onChange={go}
          options={[
            { value: "pools", label: <Counted label="Pools" n={visible.length} /> },
            { value: "registre", label: <Counted label="Registre" n={scoped.length} /> },
            { value: "coherence", label: <Counted label="Cohérence" n={errors} alert /> },
          ]}
        />
      </div>

      <div className="mt-6">
        {view === "pools" && (
          isLoading ? <CardsSkeleton /> : (
            <PoolsList
              pools={visible} registry={registry ?? []} report={report ?? []} visuals={visuals}
              canEdit={canEdit} onOpen={(id) => navigate(`${base}/${id}`)} onCreate={() => setCreating(true)}
            />
          )
        )}
        {view === "registre" && <RegistryView dashboardId={dashboardId} visuals={visuals} />}
        {view === "coherence" && <CoherenceView base={base} />}
      </div>

      {creating && (
        <CreatePoolDialog
          dashboardId={dashboardId}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); navigate(`${base}/${id}`); }}
        />
      )}
    </div>
  );
}

/** Un libellé du sélecteur de vue, avec son compteur. */
function Counted({ label, n, alert }: { label: string; n: number; alert?: boolean }) {
  if (alert && !n) return <>{label}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className={cn(
        "rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
        alert ? "bg-red-500/15 text-red-600 dark:text-red-400" : "bg-muted text-muted-foreground",
      )}>
        {n.toLocaleString("fr-FR")}
      </span>
    </span>
  );
}

// ── La liste ────────────────────────────────────────────────────────────────

function PoolsList({ pools, registry, report, visuals, canEdit, onOpen, onCreate }: {
  pools: Pool[]; registry: RegistryItem[]; report: Issue[]; visuals: Visuals;
  canEdit: boolean; onOpen: (id: string) => void; onCreate: () => void;
}) {
  const byId = useMemo(() => new Map(registry.map((r) => [r.id, r])), [registry]);
  const errorsByPool = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of report) if (i.pool_id && i.severity === "error") m.set(i.pool_id, (m.get(i.pool_id) ?? 0) + 1);
    return m;
  }, [report]);

  if (pools.length === 0) {
    return (
      <EmptyState
        icon={StackIcon}
        title="Aucun pool pour l'instant"
        description="Créez un pool, remplissez-le depuis le registre, puis donnez-le à vos agents."
        action={canEdit ? <Button size="sm" onClick={onCreate}><PlusIcon className="h-3.5 w-3.5" /> Créer un pool</Button> : undefined}
      />
    );
  }

  const own = pools.filter((p) => p.service_dashboard_id);
  const shared = pools.filter((p) => !p.service_dashboard_id);
  const grid = (list: Pool[], withCreate: boolean) => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((p) => (
        <PoolCard
          key={p.id} pool={p} visuals={visuals} errors={errorsByPool.get(p.id) ?? 0}
          counts={countFamilies(p.items.map((i) => byId.get(i.registry_id)))}
          onOpen={() => onOpen(p.id)}
        />
      ))}
      {withCreate && canEdit && (
        <button
          onClick={onCreate}
          className="flex min-h-[236px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted"><PlusIcon className="h-4 w-4" /></span>
          <span className="font-medium text-foreground">Nouveau pool</span>
          <span className="max-w-[26ch] text-center text-xs">Un lot de ressources à donner à vos agents en une fois.</span>
        </button>
      )}
    </div>
  );

  // Deux familles seulement quand il y a les deux : un seul titre au-dessus
  // d'une seule grille n'apprendrait rien.
  if (!own.length || !shared.length) return grid(pools, true);
  return (
    <div className="space-y-8">
      <section>
        <SectionTitle aside={<span className="text-[11px] text-muted-foreground">{own.length}</span>}>Réservés à ce service</SectionTitle>
        {grid(own, true)}
      </section>
      <section>
        <SectionTitle aside={<span className="text-[11px] text-muted-foreground">{shared.length}</span>}>Ouverts à tout le projet</SectionTitle>
        {grid(shared, false)}
      </section>
    </div>
  );
}

function PoolCard({ pool, counts, errors, visuals, onOpen }: {
  pool: Pool; counts: Map<Family, number>; errors: number; visuals: Visuals; onOpen: () => void;
}) {
  const n = pool.items.length;
  return (
    <button onClick={onOpen} className="group h-full text-left">
      <Card className="flex h-full flex-col gap-4 p-5 transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <StackIcon weight="duotone" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight">{pool.name}</div>
            <div className="mt-1"><ScopePill pool={pool} /></div>
          </div>
          <HealthPill errors={errors} empty={n === 0} />
        </div>

        <p className={cn("line-clamp-2 min-h-[2.5rem] text-sm leading-5", pool.description ? "text-muted-foreground" : "italic text-muted-foreground/60")}>
          {pool.description || "Sans description."}
        </p>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Contenu</span>
            <span className="font-medium tabular-nums">{plural(n, "ressource")}</span>
          </div>
          <CompositionBar counts={counts} />
          {n > 0 ? <FamilyCounts counts={counts} /> : <p className="text-[11px] text-muted-foreground">Rien encore : ouvrez-le pour le remplir.</p>}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          {pool.agents.length ? (
            <span className="flex min-w-0 items-center gap-2">
              <AgentStack ids={pool.agents.map((a) => a.agent_id)} visuals={visuals} />
              <span className="truncate text-xs text-muted-foreground">{plural(pool.agents.length, "agent")}</span>
            </span>
          ) : <span className="text-xs text-muted-foreground">Aucun agent</span>}
          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
            Ouvrir <CaretRightIcon className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </button>
  );
}

function ScopePill({ pool }: { pool: Pick<Pool, "service_dashboard_id"> }) {
  return pool.service_dashboard_id
    ? <Pill tone="violet" title="Réservé aux agents de ce service"><UsersThreeIcon className="h-3 w-3" /> Ce service</Pill>
    : <Pill tone="blue" title="Attribuable à tout agent du projet"><BuildingsIcon className="h-3 w-3" /> Tout le projet</Pill>;
}

function HealthPill({ errors, empty }: { errors: number; empty?: boolean }) {
  if (errors > 0) return <Pill tone="red"><WarningOctagonIcon weight="fill" className="h-3 w-3" /> {plural(errors, "erreur")}</Pill>;
  if (empty) return <Pill>vide</Pill>;
  return <Pill tone="green"><CheckCircleIcon weight="fill" className="h-3 w-3" /> cohérent</Pill>;
}

function CreatePoolDialog({ dashboardId, onClose, onCreated }: {
  dashboardId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!workspaceId || !projectId || !name.trim() || saving) return;
    setSaving(true);
    try {
      const id = await createPool({
        workspaceId, projectId, serviceDashboardId: shared ? null : dashboardId,
        name, description, createdBy: user?.id ?? null,
      });
      queryClient.invalidateQueries({ queryKey: qk.pools(projectId) });
      onCreated(id);
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const scopes = [
    { shared: false, icon: UsersThreeIcon, label: "Ce service", hint: "Seuls ses agents le reçoivent. Il peut contenir les ressources réservées au service." },
    { shared: true, icon: BuildingsIcon, label: "Tout le projet", hint: "Attribuable à tout agent du projet. Il ne contient que des ressources partagées." },
  ];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><StackIcon weight="duotone" className="h-4 w-4" /></span>
            Nouveau pool
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Nom">
            <Input autoFocus value={name} maxLength={80} placeholder="Support — niveau 1" onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </Field>
          <Field label="Description" hint="Facultatif : ce que ce pool permet, et à qui il est destiné.">
            <Textarea rows={3} value={description} maxLength={1000} placeholder="Lecture des tickets et de la base de connaissances, sans écriture."
              onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-foreground">Portée</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {scopes.map((s) => (
                <button
                  key={s.label} type="button" onClick={() => setShared(s.shared)}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
                    shared === s.shared ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-muted/40",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <s.icon weight="duotone" className={cn("h-4 w-4", shared === s.shared ? "text-primary" : "text-muted-foreground")} />
                    {s.label}
                  </span>
                  <span className="text-[11px] leading-snug text-muted-foreground">{s.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
            <Button size="sm" disabled={!name.trim() || saving} onClick={() => void submit()}>
              {saving && <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" />} Créer le pool
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Un pool ─────────────────────────────────────────────────────────────────

function PoolEditor({ poolId, dashboardId, onBack, base }: { poolId: string; dashboardId: string; onBack: () => void; base: string }) {
  const navigate = useNavigate();
  const { projectId, role } = useCurrentContext();
  const canEdit = role === "owner" || role === "admin" || role === "member";
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const promptText = usePromptText();
  const queryClient = useQueryClient();
  const { data: pools, isLoading } = usePools(projectId);
  const { data: registry } = useRegistry(projectId);
  const { data: issues } = usePoolIssues(poolId);
  const visuals = useVisuals(projectId);
  const [picking, setPicking] = useState(false);

  const pool = (pools ?? []).find((p) => p.id === poolId) ?? null;
  const byId = useMemo(() => new Map((registry ?? []).map((r) => [r.id, r])), [registry]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.pools(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.poolIssues(poolId) });
    queryClient.invalidateQueries({ queryKey: qk.report(projectId) });
    queryClient.invalidateQueries({ queryKey: ["agent_resource_issues"] });
  };

  const crumbs = (
    <nav className="mb-5 flex items-center gap-1.5 text-sm text-muted-foreground">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground">
        <StackIcon weight="duotone" className="h-3.5 w-3.5" /> Pools
      </button>
      <CaretRightIcon className="h-3 w-3" />
      <span className="truncate text-foreground">{pool?.name ?? "…"}</span>
    </nav>
  );

  if (isLoading) {
    return (
      <div className="px-14 py-8 xl:px-20">
        {crumbs}
        <div className="space-y-6">
          <div className="space-y-2"><Skeleton className="h-7 w-64" /><Skeleton className="h-4 w-full max-w-md" /></div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>
        </div>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="px-14 py-8 xl:px-20">
        {crumbs}
        <EmptyState icon={StackIcon} title="Pool introuvable" description="Il a peut-être été supprimé."
          action={<Button size="sm" variant="outline" onClick={onBack}>Revenir aux pools</Button>} />
      </div>
    );
  }

  // Une ressource disparue de sa source n'est plus listée par le registre :
  // elle reste dans le pool, signalée, jusqu'à ce qu'on l'en retire.
  const contents = pool.items.map((i) => byId.get(i.registry_id) ?? null);
  const removedCount = contents.filter((c) => !c).length;
  const grouped = FAMILIES.map((f) => ({
    ...f,
    items: contents.filter((c): c is RegistryItem => !!c && familyOf(c) === f.key)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length);
  const assigned = new Set(pool.agents.map((a) => a.agent_id));
  const eligible = visuals.agents.filter((a) => !assigned.has(a.id) && (!pool.service_dashboard_id || a.service_dashboard_id === pool.service_dashboard_id));
  const agentOf = (id: string) => visuals.agents.find((a) => a.id === id) ?? null;
  const agentName = (id: string) => agentOf(id)?.name ?? id.slice(0, 8);
  const agentPage = (id: string) => `${base.replace(/\/pools$/, "")}/agent-config/${id}?t=connectors`;
  const errors = (issues ?? []).filter((i) => i.severity === "error").length;

  async function rename() {
    const next = await promptText({ title: "Renommer le pool", initialValue: pool!.name, confirmText: "Renommer" });
    if (!next || !next.trim() || next.trim() === pool!.name) return;
    try { await updatePool(pool!.id, { name: next.trim() }); refresh(); } catch (e) { toast.error("Renommage impossible", String((e as Error).message)); }
  }
  async function editDescription() {
    const next = await promptText({ title: "Description du pool", initialValue: pool!.description ?? "", confirmText: "Enregistrer" });
    if (next === null || next === undefined) return;
    try { await updatePool(pool!.id, { description: next.trim() || null }); refresh(); } catch (e) { toast.error("Enregistrement impossible", String((e as Error).message)); }
  }
  async function remove() {
    const n = pool!.agents.length;
    if (!(await confirm({
      title: `Supprimer « ${pool!.name} » ?`,
      description: n
        ? `${n} agent${n > 1 ? "s le perdront" : " le perdra"} — et un agent qui n'a plus aucun pool revient au mode granulaire.`
        : undefined,
      confirmText: "Supprimer",
    }))) return;
    try { await deletePool(pool!.id); refresh(); onBack(); } catch (e) { toast.error("Suppression impossible", String((e as Error).message)); }
  }
  async function dropItem(registryId: string) {
    try { await removePoolItem(pool!.id, registryId); refresh(); } catch (e) { toast.error("Retrait impossible", String((e as Error).message)); }
  }
  async function giveTo(agentId: string) {
    try { await assignPool(agentId, pool!.id, user?.id ?? null); refresh(); toast.success(`Pool donné à ${agentName(agentId)}`); }
    catch (e) { toast.error("Attribution refusée", e instanceof Error ? e.message : String(e)); }
  }
  async function takeFrom(agentId: string) {
    try { await unassignPool(agentId, pool!.id); refresh(); } catch (e) { toast.error("Retrait impossible", String((e as Error).message)); }
  }

  return (
    <div className="px-14 py-8 xl:px-20">
      {crumbs}
      <div className="flex items-start gap-4">
        <span className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <StackIcon weight="duotone" className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <PageHeader
            title={pool.name}
            description={pool.description ?? undefined}
            actions={canEdit ? (
              <>
                <Button size="sm" onClick={() => setPicking(true)}><PlusIcon className="h-3.5 w-3.5" /> Ajouter des ressources</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="outline" className="h-8 w-9" aria-label="Plus d'actions"><DotsThreeIcon weight="bold" className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52 rounded-xl">
                    <DropdownMenuItem onSelect={() => void rename()}><PencilSimpleIcon className="h-4 w-4" /> Renommer</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void editDescription()}><TextAlignLeftIcon className="h-4 w-4" /> Modifier la description</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => void remove()}><TrashIcon className="h-4 w-4" /> Supprimer le pool</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : undefined}
          />
          <div className="-mt-3 mb-8 flex flex-wrap items-center gap-1.5">
            <ScopePill pool={pool} />
            <Pill>{plural(pool.items.length, "ressource")}</Pill>
            <Pill>{plural(pool.agents.length, "agent")}</Pill>
            <HealthPill errors={errors} />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 space-y-4">
          {removedCount > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm">
              <WarningOctagonIcon weight="fill" className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{removedCount} ressource{removedCount > 1 ? "s ont" : " a"} disparu de {removedCount > 1 ? "leur" : "sa"} source.</span>
                <span className="text-muted-foreground"> La cohérence, à droite, permet de {removedCount > 1 ? "les" : "la"} retirer.</span>
              </span>
            </div>
          )}

          {pool.items.length === 0 ? (
            <EmptyState
              icon={StackIcon} title="Pool vide"
              description="Ajoutez une source entière ou certains de ses outils."
              action={canEdit ? <Button size="sm" onClick={() => setPicking(true)}><PlusIcon className="h-3.5 w-3.5" /> Ajouter des ressources</Button> : undefined}
            />
          ) : grouped.map((g) => (
            <Card key={g.key} className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-border/60 bg-muted/20 px-4 py-3">
                <FamilyTile family={g.key} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{g.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground" title={g.hint}>{g.hint}</div>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{g.items.length}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {g.items.map((r) => {
                  const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
                  return (
                    <li key={r.id} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30">
                      <ResourceIcon r={r} parent={parent} visuals={visuals} />
                      <ResourceLine r={r} parent={parent} />
                      {canEdit && (
                        <button onClick={() => void dropItem(r.id)} title="Retirer du pool" aria-label="Retirer du pool"
                          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </section>

        <aside className="space-y-4 self-start lg:sticky lg:top-6">
          <Card className="p-4">
            <SectionTitle aside={<HealthPill errors={errors} />}>Cohérence</SectionTitle>
            <IssuesList
              issues={issues ?? []}
              empty="Rien à signaler."
              onRemove={canEdit ? (id) => void dropItem(id) : undefined}
            />
          </Card>

          <Card className="p-4">
            <SectionTitle aside={canEdit && eligible.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2.5 text-xs"><PlusIcon className="h-3 w-3" /> Donner</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto rounded-xl">
                  <DropdownMenuLabel className="text-[10px] uppercase">Donner ce pool à</DropdownMenuLabel>
                  {eligible.map((a) => (
                    <DropdownMenuItem key={a.id} onSelect={() => void giveTo(a.id)}>
                      <AgentIdentity url={a.avatar_url} seed={a.name} size={22} rounded="rounded-full" interactive={false} />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : undefined}>
              <span className="flex items-center gap-1">
                Agents
                <InfoHint>Un agent qui reçoit son premier pool n'atteint plus que ses pools. Un pool en erreur ne se donne pas.</InfoHint>
              </span>
            </SectionTitle>
            {pool.agents.length ? (
              <ul className="-mx-1 space-y-0.5">
                {pool.agents.map((a) => {
                  const agent = agentOf(a.agent_id);
                  return (
                    <li key={a.agent_id} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-muted/40">
                      {agent
                        ? <AgentIdentity url={agent.avatar_url} seed={agent.name} size={28} rounded="rounded-full" interactive={false} />
                        : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted"><RobotIcon className="h-3.5 w-3.5 text-muted-foreground" /></span>}
                      <button className="min-w-0 flex-1 truncate text-left text-sm hover:underline" onClick={() => navigate(agentPage(a.agent_id))}>
                        {agentName(a.agent_id)}
                      </button>
                      {canEdit && (
                        <button onClick={() => void takeFrom(a.agent_id)} title="Retirer ce pool à l'agent" aria-label="Retirer ce pool à l'agent"
                          className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">Aucun agent n'a ce pool.</p>
            )}
          </Card>
        </aside>
      </div>

      {picking && (
        <ResourcePicker
          pool={pool}
          dashboardId={dashboardId}
          registry={registry ?? []}
          visuals={visuals}
          onClose={() => setPicking(false)}
          onAdd={async (ids) => {
            try {
              await addPoolItems(pool.id, ids, user?.id ?? null);
              refresh();
              setPicking(false);
              toast.success(`${ids.length} ressource${ids.length > 1 ? "s ajoutées" : " ajoutée"}`);
            } catch (e) {
              toast.error("Ajout refusé", e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
    </div>
  );
}

function ResourceLine({ r, parent }: { r: RegistryItem; parent?: RegistryItem }) {
  const risk = (r.kind === "tool" || r.source === "builtin") ? RISK_META[r.risk] : undefined;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{r.name}</span>
          {r.kind === "toolset" && r.source !== "builtin" && <span className="shrink-0 text-[11px] text-muted-foreground">· toute la source</span>}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {kindLabel(r)}{parent ? ` de ${parent.name}` : r.kind === "tool" ? ` (${SOURCE_LABEL[r.source]})` : ""}
          {r.description ? ` — ${r.description}` : ""}
        </div>
      </div>
      {risk && <Pill tone={risk.tone} title={risk.hint}>{risk.label}</Pill>}
      {r.status === "unavailable" && <Pill tone="amber" title="Source désactivée, déconnectée ou archivée">indisponible</Pill>}
    </div>
  );
}

// ── Le sélecteur de ressources ──────────────────────────────────────────────

function ResourcePicker({ pool, dashboardId, registry, visuals, onClose, onAdd }: {
  pool: Pool; dashboardId: string; registry: RegistryItem[]; visuals: Visuals; onClose: () => void; onAdd: (ids: string[]) => Promise<void>;
}) {
  const [family, setFamily] = useState<Family>("tools");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  void dashboardId;

  const inPool = new Set(pool.items.map((i) => i.registry_id));
  const candidates = useMemo(() => registry.filter((r) => fitsPool(r, pool)), [registry, pool]);
  const children = useMemo(() => {
    const m = new Map<string, RegistryItem[]>();
    for (const r of candidates) if (r.parent_id) m.set(r.parent_id, [...(m.get(r.parent_id) ?? []), r]);
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [candidates]);
  const perFamily = useMemo(() => {
    const m = new Map<Family, number>();
    for (const r of candidates) if (r.kind !== "tool") m.set(familyOf(r), (m.get(familyOf(r)) ?? 0) + 1);
    return m;
  }, [candidates]);
  const q = query.trim().toLowerCase();
  const matches = (r: RegistryItem) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
  // Les outils sont rangés sous leur source : on choisit la source entière, ou
  // on la déplie pour en choisir certains.
  const roots = candidates
    .filter((r) => familyOf(r) === family && r.kind !== "tool")
    .filter((r) => matches(r) || (children.get(r.id) ?? []).some(matches))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source)));
  const shown = roots.slice(0, 250);
  const meta = FAMILIES.find((f) => f.key === family)!;

  const toggle = (id: string) => setPicked((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleOpen = (id: string) => setOpen((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <Drawer
      title="Ajouter des ressources"
      subtitle={<>au pool « {pool.name} »</>}
      onClose={onClose}
      width="max-w-2xl"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {picked.size ? (
              <>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">{picked.size}</span>
                sélectionnée{picked.size > 1 ? "s" : ""}
                <button onClick={() => setPicked(new Set())} className="underline-offset-2 hover:text-foreground hover:underline">tout désélectionner</button>
              </>
            ) : "Rien de sélectionné"}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
            <Button size="sm" disabled={!picked.size || saving} onClick={async () => { setSaving(true); try { await onAdd([...picked]); } finally { setSaving(false); } }}>
              {saving && <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" />} Ajouter{picked.size ? ` (${picked.size})` : ""}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4 p-5">
        <Segmented<Family>
          size="sm"
          value={family}
          onChange={(f) => setFamily(f)}
          options={FAMILIES.map((f) => ({ value: f.key, hint: f.hint, label: <Counted label={f.label} n={perFamily.get(f.key) ?? 0} /> }))}
        />
        <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5">
          <FamilyTile family={family} />
          <p className="text-[11px] leading-snug text-muted-foreground">{meta.hint}</p>
        </div>
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Rechercher dans ${meta.label.toLowerCase()}…`} className="pl-8" />
        </div>
        {shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {q ? "Rien ne correspond à cette recherche." : family === "tools"
              ? "Connectez un serveur MCP, une app ou un outil customisé : ses outils apparaîtront ici."
              : "Rien à ajouter dans cette famille."}
          </div>
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
            {shown.map((r) => {
              const kids = (children.get(r.id) ?? []).filter((k) => !q || matches(k) || matches(r));
              const expanded = open.has(r.id) || (!!q && kids.some(matches) && !matches(r));
              const rootTaken = inPool.has(r.id);
              return (
                <li key={r.id} className={cn(picked.has(r.id) && "bg-primary/[0.04]")}>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox disabled={rootTaken} checked={rootTaken || picked.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Choisir ${r.name}`} />
                    <ResourceIcon r={r} visuals={visuals} />
                    <ResourceLine r={r} />
                    {rootTaken && <Pill tone="green"><CheckCircleIcon weight="fill" className="h-3 w-3" /> dans le pool</Pill>}
                    {kids.length > 0 && (
                      <button onClick={() => toggleOpen(r.id)}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        {kids.length} outil{kids.length > 1 ? "s" : ""}
                        <CaretDownIcon className={cn("h-3 w-3 transition-transform", !expanded && "-rotate-90")} />
                      </button>
                    )}
                  </div>
                  {expanded && kids.length > 0 && (
                    <ul className="border-t border-border/50 bg-muted/20 py-1 pl-10 pr-3">
                      {kids.map((k) => {
                        const taken = inPool.has(k.id) || rootTaken;
                        return (
                          <li key={k.id} className="flex items-center gap-3 py-1.5">
                            <Checkbox disabled={taken || picked.has(r.id)} checked={taken || picked.has(k.id) || picked.has(r.id)}
                              onCheckedChange={() => toggle(k.id)} aria-label={`Choisir ${k.name}`} />
                            <ResourceIcon r={k} parent={r} visuals={visuals} size="sm" />
                            <ResourceLine r={k} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {roots.length > shown.length && <p className="text-center text-[11px] text-muted-foreground">{roots.length - shown.length} de plus — affinez la recherche.</p>}
      </div>
    </Drawer>
  );
}

// ── Le registre ─────────────────────────────────────────────────────────────

/** Combien de sources une famille montre d'emblée dans la vue « Tout ». */
const PREVIEW = 6;

function RegistryView({ dashboardId, visuals }: { dashboardId: string; visuals: Visuals }) {
  const { workspaceId, projectId } = useCurrentContext();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: registry, isLoading } = useRegistry(projectId);
  const [family, setFamily] = useState<Family | "all">("all");
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const scoped = useMemo(() => (registry ?? []).filter((r) => visibleInService(r, dashboardId)), [registry, dashboardId]);
  const byId = useMemo(() => new Map(scoped.map((r) => [r.id, r])), [scoped]);
  const children = useMemo(() => {
    const m = new Map<string, RegistryItem[]>();
    for (const r of scoped) if (r.parent_id && byId.has(r.parent_id)) m.set(r.parent_id, [...(m.get(r.parent_id) ?? []), r]);
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [scoped, byId]);
  const q = query.trim().toLowerCase();
  const matches = (r: RegistryItem) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
  // Les sources et ressources autonomes ; un outil se montre sous sa source.
  const roots = scoped
    .filter((r) => !r.parent_id || !byId.has(r.parent_id))
    .filter((r) => matches(r) || (children.get(r.id) ?? []).some(matches))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source)));
  const perFamily = new Map<Family, RegistryItem[]>();
  for (const r of roots) perFamily.set(familyOf(r), [...(perFamily.get(familyOf(r)) ?? []), r]);
  const allCount = new Map<Family, number>();
  for (const r of scoped) allCount.set(familyOf(r), (allCount.get(familyOf(r)) ?? 0) + 1);

  async function sync() {
    if (!projectId) return;
    setSyncing(true);
    try {
      // Les actions des apps Composio d'abord : la resynchronisation les lit.
      const apps = workspaceId ? await discoverProjectApps(workspaceId, projectId) : { apps: 0, failed: 0 };
      const n = await rebuildRegistry(projectId);
      queryClient.invalidateQueries({ queryKey: qk.registry(projectId) });
      const detail = [
        `${n} ressource${n > 1 ? "s" : ""}`,
        apps.apps ? `actions de ${apps.apps} app${apps.apps > 1 ? "s" : ""} découvertes` : "",
        apps.failed ? `${apps.failed} app${apps.failed > 1 ? "s" : ""} injoignable${apps.failed > 1 ? "s" : ""} chez Composio` : "",
      ].filter(Boolean).join(" · ");
      toast.success("Registre resynchronisé", `${detail}.`);
    } catch (e) {
      toast.error("Resynchronisation impossible", e instanceof Error ? e.message : String(e));
    } finally { setSyncing(false); }
  }

  /** Une app Composio ne liste ses actions qu'à la découverte : on la lance,
   *  la connexion les met en cache, le registre les voit. */
  async function discover(r: RegistryItem) {
    const toolkit = String(r.metadata.toolkit ?? "");
    if (!workspaceId || !projectId || !toolkit) return;
    setDiscovering(r.id);
    try {
      await callEdge("composio-action", { workspace_id: workspaceId, project_id: projectId, toolkit, limit: 100, service_dashboard_id: dashboardId });
      queryClient.invalidateQueries({ queryKey: qk.registry(projectId) });
      setOpen((prev) => new Set(prev).add(r.id));
    } catch (e) {
      toast.error("Découverte impossible", e instanceof Error ? e.message : String(e));
    } finally { setDiscovering(null); }
  }

  const list = (items: RegistryItem[]) => (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border/60">
        {items.map((r) => {
          const kids = (children.get(r.id) ?? []).filter((k) => !q || matches(k) || matches(r));
          const expanded = open.has(r.id) || (!!q && kids.some(matches) && !matches(r));
          return (
            <li key={r.id}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <ResourceIcon r={r} visuals={visuals} />
                <ResourceLine r={r} />
                {r.source === "composio" && r.kind === "toolset" && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={discovering === r.id} onClick={() => void discover(r)}>
                    {discovering === r.id ? <CircleNotchIcon className="h-3 w-3 animate-spin" /> : <MagicWandIcon className="h-3 w-3" />} Découvrir ses actions
                  </Button>
                )}
                {kids.length > 0 && (
                  <button
                    onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {kids.length} outil{kids.length > 1 ? "s" : ""}
                    <CaretDownIcon className={cn("h-3 w-3 transition-transform", !expanded && "-rotate-90")} />
                  </button>
                )}
              </div>
              {expanded && kids.length > 0 && (
                <ul className="divide-y divide-border/40 border-t border-border/50 bg-muted/20">
                  {kids.map((k) => (
                    <li key={k.id} className="flex items-center gap-3 py-2 pl-[3.25rem] pr-4">
                      <ResourceIcon r={k} parent={r} visuals={visuals} size="sm" />
                      <ResourceLine r={k} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );

  if (isLoading) return <RowsSkeleton />;

  const familiesShown = FAMILIES.filter((f) => (perFamily.get(f.key) ?? []).length);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher dans le registre…" className="pl-8" />
        </div>
        <Button size="sm" variant="outline" disabled={syncing} onClick={() => void sync()}>
          <ArrowsClockwiseIcon className={cn("h-3.5 w-3.5", syncing && "animate-spin")} /> Resynchroniser
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<Family | "all">
          size="sm"
          value={family}
          onChange={setFamily}
          options={[
            { value: "all", label: <Counted label="Tout" n={scoped.length} /> },
            ...FAMILIES.map((f) => ({ value: f.key, hint: f.hint, label: <Counted label={f.label} n={allCount.get(f.key) ?? 0} /> })),
          ]}
        />
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <InfoIcon className="h-3.5 w-3.5" /> Tenu à jour seul : connecter, modifier ou retirer une source le met à jour.
        </p>
      </div>

      {roots.length === 0 ? (
        <EmptyState
          icon={PlugsConnectedIcon}
          title={q ? "Rien ne correspond" : "Rien dans le registre"}
          description={q ? "Essayez un autre mot." : "Connectez une source, puis resynchronisez."}
        />
      ) : family === "all" && !q ? (
        // Vue d'ensemble : chaque famille en tête de section, ses premières
        // sources, et de quoi ouvrir le reste.
        <div className="space-y-6">
          {familiesShown.map((f) => {
            const items = perFamily.get(f.key) ?? [];
            return (
              <section key={f.key}>
                <div className="mb-2.5 flex items-center gap-2.5">
                  <FamilyTile family={f.key} />
                  <h3 className="text-sm font-semibold">{f.label}</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">{items.length.toLocaleString("fr-FR")}</span>
                  <span className="flex-1" />
                  {items.length > PREVIEW && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setFamily(f.key)}>
                      Tout voir <ArrowRightIcon className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {list(items.slice(0, PREVIEW))}
              </section>
            );
          })}
        </div>
      ) : (
        <>
          {list((family === "all" ? roots : perFamily.get(family) ?? []).slice(0, 400))}
          {(family === "all" ? roots : perFamily.get(family) ?? []).length > 400 && (
            <p className="text-center text-[11px] text-muted-foreground">
              {(family === "all" ? roots : perFamily.get(family) ?? []).length - 400} de plus — affinez la recherche.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── La cohérence ────────────────────────────────────────────────────────────

function CoherenceView({ base }: { base: string }) {
  const navigate = useNavigate();
  const { projectId } = useCurrentContext();
  const { data: report, isLoading, refetch, isFetching } = useCoherenceReport(projectId);
  const { data: pools } = usePools(projectId);
  const visuals = useVisuals(projectId);

  if (isLoading) return <RowsSkeleton />;
  const poolName = (id: string | null) => (pools ?? []).find((p) => p.id === id)?.name;
  const agentName = (id: string | null) => visuals.agents.find((a) => a.id === id)?.name;
  const context = (i: Issue) => [
    i.pool_id && poolName(i.pool_id) ? { label: `Pool « ${poolName(i.pool_id)} »`, go: () => navigate(`${base}/${i.pool_id}`) } : null,
    i.agent_id && agentName(i.agent_id) ? { label: agentName(i.agent_id)!, go: () => navigate(`${base.replace(/\/pools$/, "")}/agent-config/${i.agent_id}?t=connectors`) } : null,
  ].filter((x): x is { label: string; go: () => void } => !!x);

  const bySeverity = (s: Issue["severity"]) => (report ?? []).filter((i) => i.severity === s);
  const groups: Array<{ severity: Issue["severity"]; title: string; hint: string }> = [
    { severity: "error", title: "Erreurs", hint: "Elles bloquent : le pool ne se donne pas, ou l'exécution refusera." },
    { severity: "warning", title: "Avertissements", hint: "Rien ne bloque, mais ce qu'ils signalent ne servira pas." },
    { severity: "info", title: "Pour information", hint: "" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1" />
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
          <ArrowsClockwiseIcon className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Revérifier
        </Button>
      </div>

      {(report ?? []).length === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          title="Tout est cohérent"
          description="Aucun problème détecté."
        />
      ) : groups.map((g) => {
        const items = bySeverity(g.severity);
        if (!items.length) return null;
        return (
          <section key={g.severity}>
            <SectionTitle aside={g.hint ? <span className="text-[11px] text-muted-foreground">{g.hint}</span> : undefined}>
              {g.title} · {items.length}
            </SectionTitle>
            <IssuesList issues={items} empty="" context={context} />
          </section>
        );
      })}
    </div>
  );
}

// ── Partagés ────────────────────────────────────────────────────────────────

const SEVERITY: Record<Issue["severity"], { icon: typeof WarningIcon; box: string; tile: string }> = {
  error: {
    icon: WarningOctagonIcon,
    box: "border-red-500/25 bg-red-500/[0.04]",
    tile: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  warning: {
    icon: WarningIcon,
    box: "border-amber-500/25 bg-amber-500/[0.04]",
    tile: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  info: {
    icon: InfoIcon,
    box: "border-border bg-muted/20",
    tile: "bg-muted text-muted-foreground",
  },
};
const ORDER: Record<Issue["severity"], number> = { error: 0, warning: 1, info: 2 };

export function IssuesList({ issues, empty, onRemove, context }: {
  issues: Issue[];
  empty: string;
  /** Retirer du pool la ressource en cause (erreur « disparue »). */
  onRemove?: (registryId: string) => void;
  /** Les liens à montrer sous un problème (le pool, l'agent…). */
  context?: (i: Issue) => Array<{ label: string; go: () => void }>;
}) {
  if (!issues.length) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] px-3.5 py-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircleIcon weight="fill" className="h-3.5 w-3.5" />
        </span>
        <p className="pt-0.5 text-[13px] leading-snug">{empty}</p>
      </div>
    );
  }
  const sorted = [...issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return (
    <ul className="space-y-2">
      {sorted.map((i, n) => {
        const S = SEVERITY[i.severity];
        const links = context?.(i) ?? [];
        const removable = !!onRemove && i.code === "item_removed" && !!i.registry_id;
        return (
          <li key={`${i.code}-${n}`} className={cn("flex gap-3 rounded-xl border px-3.5 py-3", S.box)}>
            <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", S.tile)}>
              <S.icon weight="fill" className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[13px] leading-snug">{i.message}</p>
              {(links.length > 0 || removable) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {links.map((l) => (
                    <ChipButton key={l.label} onClick={l.go}>{l.label} <ArrowRightIcon className="h-3 w-3" /></ChipButton>
                  ))}
                  {removable && (
                    <ChipButton onClick={() => onRemove!(i.registry_id!)}><XIcon className="h-3 w-3" /> Retirer du pool</ChipButton>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ChipButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-background hover:text-foreground">
      {children}
    </button>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-4 rounded-2xl border border-border/60 p-5">
          <div className="flex items-center gap-3"><Skeleton className="h-10 w-10 rounded-xl" /><Skeleton className="h-4 w-40" /></div>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
