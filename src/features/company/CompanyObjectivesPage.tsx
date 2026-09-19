// Objectifs — l'arbre de ce que l'entreprise cherche à accomplir.
//
// C'est la moitié manquante du contexte : le profil dit ce QU'EST l'entreprise,
// les objectifs disent ce qu'elle DOIT accomplir. Un agent qui a les deux peut
// arbitrer tout seul entre deux façons de faire ; avec le profil seul, il fait
// bien un travail dont personne n'a demandé la priorité.
//
// L'arbre est la forme, pas une liste : c'est lui qui porte le « pourquoi ».
// Un agent à qui on demande de publier trois articles peut remonter jusqu'à
// « 100 nouveaux clients ce trimestre » et comprendre ce qui compte vraiment —
// c'est exactement ce que fait l'outil company_objectives(action="why").
//
// La mesure est délibérément facultative. Forcer une métrique à la création
// produit des cibles inventées ; un objectif sans chiffre reste utile comme
// cadre, il ne compte simplement dans aucun avancement, et l'écran le dit.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TargetIcon as Target,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  CaretRightIcon as ChevronRight,
  RobotIcon as Bot,
  BuildingsIcon as Building2,
  RadioButtonIcon as CircleDot,
  CircleNotchIcon as Loader2,
  PencilSimpleIcon as Pencil,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import {
  OBJECTIVE_STATUS_LABEL, deleteObjective, fetchObjectives, objectiveProgress, objectiveTree,
  upsertObjective, type CompanyObjective, type ObjectiveStatus,
} from "./model";

const STATUS_TONE: Record<ObjectiveStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-primary/10 text-primary",
  at_risk: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  abandoned: "bg-muted text-muted-foreground line-through",
};

type Draft = Partial<CompanyObjective> & { title: string };

function ObjectiveDialog({
  open, onOpenChange, initial, parents, services, agents, onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: Draft | null;
  parents: CompanyObjective[];
  services: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; service_dashboard_id: string | null }>;
  onSave: (d: Draft) => Promise<void>;
}) {
  const [d, setD] = useState<Draft>(initial ?? { title: "" });
  const [saving, setSaving] = useState(false);
  // Remonter l'état quand on rouvre sur un autre objectif.
  const key = initial?.id ?? "new";
  const [seen, setSeen] = useState(key);
  if (seen !== key) { setSeen(key); setD(initial ?? { title: "" }); }

  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  // Un agent responsable qui n'appartient pas au service porteur est presque
  // toujours une erreur de saisie — on restreint la liste plutôt que de la
  // signaler après coup.
  const eligibleAgents = d.owner_dashboard_id
    ? agents.filter((a) => a.service_dashboard_id === d.owner_dashboard_id)
    : agents;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Modifier l'objectif" : "Nouvel objectif"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Objectif</label>
            <Input
              value={d.title ?? ""} autoFocus
              placeholder="100 nouveaux clients ce trimestre"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Précisions</label>
            <Textarea
              rows={2} value={d.detail ?? ""}
              placeholder="Ce que ça veut dire concrètement, ce qui est hors périmètre…"
              onChange={(e) => set({ detail: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Découle de</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={d.parent_id ?? ""}
              onChange={(e) => set({ parent_id: e.target.value || null })}
            >
              <option value="">— Objectif d'entreprise (racine)</option>
              {parents.filter((p) => p.id !== d.id).map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Rattacher un objectif à un objectif plus large, c'est ce qui permet à un agent de remonter le « pourquoi » d'une demande.
            </p>
          </div>

          <div className="rounded-lg border border-border/70 p-3">
            <p className="mb-3 text-xs font-medium text-muted-foreground">
              Mesure — facultative. Sans métrique, l'objectif reste un cadre mais ne compte dans aucun avancement.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Métrique</label>
                <Input value={d.metric ?? ""} placeholder="Nouveaux clients" onChange={(e) => set({ metric: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Unité</label>
                <Input value={d.unit ?? ""} placeholder="clients" onChange={(e) => set({ unit: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Point de départ</label>
                <Input
                  type="number" value={d.baseline_value ?? ""}
                  onChange={(e) => set({ baseline_value: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Cible</label>
                <Input
                  type="number" value={d.target_value ?? ""}
                  onChange={(e) => set({ target_value: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Valeur actuelle</label>
                <Input
                  type="number" value={d.current_value ?? ""}
                  onChange={(e) => set({ current_value: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Sens</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={d.direction ?? "increase"}
                  onChange={(e) => set({ direction: e.target.value as CompanyObjective["direction"] })}
                >
                  <option value="increase">Faire monter</option>
                  <option value="decrease">Faire baisser</option>
                  <option value="maintain">Maintenir</option>
                </select>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Service porteur</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={d.owner_dashboard_id ?? ""}
                onChange={(e) => set({ owner_dashboard_id: e.target.value || null, owner_agent_id: null })}
              >
                <option value="">— Toute l'entreprise</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Agent responsable</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={d.owner_agent_id ?? ""}
                onChange={(e) => set({ owner_agent_id: e.target.value || null })}
              >
                <option value="">— Personne en particulier</option>
                {eligibleAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Échéance</label>
              <Input
                type="date" value={d.period_end ?? ""}
                onChange={(e) => set({ period_end: e.target.value || null })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">État</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={d.status ?? "active"}
                onChange={(e) => set({ status: e.target.value as ObjectiveStatus })}
              >
                {(Object.keys(OBJECTIVE_STATUS_LABEL) as ObjectiveStatus[]).map((s) => (
                  <option key={s} value={s}>{OBJECTIVE_STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Priorité</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={String(d.priority ?? 3)}
                onChange={(e) => set({ priority: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 1 ? " (max)" : ""}</option>)}
              </select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button
            disabled={!d.title?.trim() || saving}
            onClick={async () => {
              setSaving(true);
              try { await onSave(d); onOpenChange(false); } finally { setSaving(false); }
            }}
          >
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyObjectivesPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CompanyObjective | null>(null);

  const { data: objectives, isLoading } = useQuery({
    queryKey: ["company_objectives", projectId],
    enabled: !!projectId,
    queryFn: () => fetchObjectives(projectId!),
  });

  const { data: services } = useQuery({
    queryKey: ["company_services", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("service_dashboards").select("id, name")
        .eq("project_id", projectId!).order("position");
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const { data: agents } = useQuery({
    queryKey: ["company_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, service_dashboard_id")
        .eq("project_id", projectId!).eq("is_archived", false).order("name");
      return (data ?? []) as Array<{ id: string; name: string; service_dashboard_id: string | null }>;
    },
  });

  const rows = useMemo(() => objectiveTree(objectives ?? []), [objectives]);
  // Combien d'objectifs partiraient avec celui qu'on s'apprête à supprimer —
  // la cascade compte toute la descendance, pas seulement les enfants directs.
  const childCount = useMemo(() => {
    if (!pendingDelete || !objectives) return 0;
    const kids = new Set([pendingDelete.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of objectives) {
        if (o.parent_id && kids.has(o.parent_id) && !kids.has(o.id)) { kids.add(o.id); grew = true; }
      }
    }
    return kids.size - 1;
  }, [pendingDelete, objectives]);
  const serviceName = (id: string | null) => services?.find((s) => s.id === id)?.name ?? null;
  const agentName = (id: string | null) => agents?.find((a) => a.id === id)?.name ?? null;

  const save = async (d: Draft) => {
    if (!projectId || !workspaceId) return;
    await upsertObjective({
      ...d,
      workspace_id: workspaceId, project_id: projectId,
      title: d.title.trim(),
      ...(d.id ? {} : { created_by: user?.id ?? null }),
      // Une valeur saisie à la main est une mesure comme une autre : elle est
      // datée et attribuée, sinon on ne sait plus si le chiffre vient d'un
      // humain ou d'un agent.
      ...(d.current_value != null ? { measured_at: new Date().toISOString(), measured_by: "user" as const } : {}),
    });
    await qc.invalidateQueries({ queryKey: ["company_objectives", projectId] });
  };

  const remove = async (id: string) => {
    await deleteObjective(id);
    await qc.invalidateQueries({ queryKey: ["company_objectives", projectId] });
  };

  const openNew = (parentId?: string | null) => {
    setEditing({ title: "", parent_id: parentId ?? null, status: "active", priority: 3, direction: "increase" });
    setDialogOpen(true);
  };

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Objectifs"
        description="Ce que l'entreprise cherche à accomplir. Chaque agent voit ceux qui le concernent, et peut remonter la chaîne au-dessus."
        actions={<Button onClick={() => openNew(null)}><Plus className="mr-1.5 h-4 w-4" />Objectif</Button>}
      />

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Target}
          title="Aucun objectif défini"
          description="Sans objectif, vos agents exécutent des demandes sans savoir ce qu'elles servent — et ne peuvent rien arbitrer seuls. Commencez par le plus large : ce que l'entreprise veut atteindre ce trimestre."
          action={<Button onClick={() => openNew(null)}><Plus className="mr-1.5 h-4 w-4" />Premier objectif</Button>}
        />
      ) : (
        <div className="space-y-1.5">
          {rows.map(({ o, depth }) => {
            const pct = objectiveProgress(o);
            const svc = serviceName(o.owner_dashboard_id);
            const agt = agentName(o.owner_agent_id);
            return (
              <Card
                key={o.id}
                className={cn("group p-3 transition-colors hover:border-border", depth > 0 && "border-l-2 border-l-primary/25")}
                style={{ marginLeft: depth * 20 }}
              >
                <div className="flex items-start gap-3">
                  {depth > 0 && <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{o.title}</span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_TONE[o.status])}>
                        {OBJECTIVE_STATUS_LABEL[o.status]}
                      </span>
                      {o.priority <= 2 && <Badge variant="outline" className="text-[10px]">P{o.priority}</Badge>}
                    </div>

                    {o.detail && <p className="mt-0.5 text-xs text-muted-foreground">{o.detail}</p>}

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {o.metric && (
                        <span className="tabular-nums">
                          {o.metric} : <span className="font-medium text-foreground">{o.current_value ?? "—"}</span>
                          {" / "}{o.target_value ?? "—"}{o.unit ? ` ${o.unit}` : ""}
                        </span>
                      )}
                      {o.period_end && <span>échéance {o.period_end}</span>}
                      {svc && <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" />{svc}</span>}
                      {agt && <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" />{agt}</span>}
                      {o.measured_at && (
                        <span className="inline-flex items-center gap-1">
                          <CircleDot className="h-3 w-3" />
                          mesuré par {o.measured_by === "agent" ? "un agent" : "un humain"} le {o.measured_at.slice(0, 10)}
                        </span>
                      )}
                      {!o.metric && <span className="italic">non mesuré — ne compte dans aucun avancement</span>}
                    </div>

                    {pct != null && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full rounded-full", pct >= 100 ? "bg-emerald-500" : o.status === "at_risk" ? "bg-amber-500" : "bg-primary")}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{pct} %</span>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Sous-objectif" onClick={() => openNew(o.id)}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Modifier" onClick={() => { setEditing(o); setDialogOpen(true); }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Supprimer"
                      onClick={() => setPendingDelete(o)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ObjectiveDialog
        open={dialogOpen} onOpenChange={setDialogOpen} initial={editing}
        parents={objectives ?? []} services={services ?? []} agents={agents ?? []}
        onSave={save}
      />

      {/* La suppression cascade sur les sous-objectifs (0212). On le dit, avec
          le compte : un arbre qui s'efface en silence est la seule chose qu'on
          ne pardonne pas à un tableau de bord. */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(v) => { if (!v) setPendingDelete(null); }}
        title={`Supprimer « ${pendingDelete?.title ?? ""} » ?`}
        description={
          childCount > 0
            ? `Cet objectif porte ${childCount} sous-objectif${childCount > 1 ? "s" : ""} : ${childCount > 1 ? "ils seront supprimés" : "il sera supprimé"} aussi.`
            : "Les agents qui le portaient ne le verront plus dans leur contexte."
        }
        confirmText="Supprimer"
        onConfirm={async () => {
          if (pendingDelete) await remove(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
