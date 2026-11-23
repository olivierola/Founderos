import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon, PlusIcon, SquaresFourIcon, CircleNotchIcon as Loader2, SparkleIcon } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useAssistant } from "@/lib/assistant-context";
import { useToast } from "@/components/ToastProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { PAGE_PAD, PAGE_TITLE } from "@/components/PageHeader";
import { formatRelative } from "@/features/tracker/pickers";
import { useLiteAgents } from "@/features/service-dashboards/live/teams";
import {
  applyParameters, createDashboard, DASHBOARD_TEMPLATES, fetchAgentDashboards, fetchDashboards, REFRESH_LABEL, refreshDashboard, statusOf,
  type AgentDashboard, type DashboardParameter, type DashboardWidget,
} from "./api";
import { KIND_ICON } from "./DashboardPage";
import { fmtNumber, STATUS_META } from "./widgets";

/**
 * Les dashboards d'un service : ceux qui vivent, puis les modèles pour en
 * créer d'autres (ceux du catalogue et ceux que l'équipe a enregistrés).
 * Avec `agent`, la même page ne montre que ceux que ce collaborateur remplit
 * (sa carte « Dashboards », sur son tableau de bord).
 */
export function DashboardsPage({ serviceId, workspaceId, projectId, sbase, agent }: {
  serviceId: string; workspaceId: string; projectId: string; sbase: string;
  agent?: { id: string; name: string } | null;
}) {
  const navigate = useNavigate();
  const assistant = useAssistant();
  const { data: dashboards, isLoading: loadingService } = useQuery({
    queryKey: ["agent_dashboards", serviceId],
    queryFn: () => fetchDashboards(serviceId),
  });
  const { data: ofAgent, isLoading: loadingAgent } = useQuery({
    queryKey: ["agent_dashboards_of", agent?.id],
    enabled: !!agent,
    queryFn: () => fetchAgentDashboards(agent!.id),
  });
  const isLoading = agent ? loadingAgent : loadingService;
  const { data: agents } = useLiteAgents(serviceId);
  const live = agent ? (ofAgent ?? []) : (dashboards ?? []).filter((d) => !d.is_template);
  const saved = (dashboards ?? []).filter((d) => d.is_template);
  const ids = live.map((d) => d.id);
  // Un aperçu par carte : les premiers KPI de chaque dashboard, en une requête.
  const { data: previews } = useQuery({
    queryKey: ["agent_dashboard_previews", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("agent_dashboard_widgets")
        .select("id, dashboard_id, kind, title, config, data, layout").in("dashboard_id", ids).in("kind", ["kpi", "gauge"]);
      const m = new Map<string, DashboardWidget[]>();
      for (const w of (data ?? []) as DashboardWidget[]) m.set(w.dashboard_id, [...(m.get(w.dashboard_id) ?? []), w]);
      for (const [k, v] of m) m.set(k, v.sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0)).slice(0, 3));
      return m;
    },
  });
  const [creating, setCreating] = useState<{ templateKey?: string; fromId?: string } | null>(null);
  // `?new=1` (le bouton « Nouveau dashboard » de la barre) ouvre la création.
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    if (search.get("new") !== "1") return;
    setCreating({});
    const next = new URLSearchParams(search); next.delete("new"); setSearch(next, { replace: true });
  }, [search, setSearch]);

  return (
    <div className="min-h-full">
      <div className={PAGE_PAD}>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {agent && (
            <button onClick={() => navigate(`${sbase}/agent/${agent.id}`)} title={`Tableau de bord de ${agent.name}`}
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <ArrowLeftIcon className="h-4 w-4" />
            </button>
          )}
          <h1 className={PAGE_TITLE}>{agent ? `Dashboards de ${agent.name}` : "Dashboards"}</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="rounded-md" onClick={() => assistant.ask({ prompt: agent ? `Crée un dashboard rempli par ${agent.name} pour ` : "Crée-moi un dashboard pour ", newChat: true, agent: null })}>
              <SparkleIcon weight="duotone" className="mr-1.5 h-4 w-4" /> Demander à l'assistant
            </Button>
            <Button className="rounded-md" onClick={() => setCreating({})}>
              <PlusIcon className="mr-1.5 h-4 w-4" /> Nouveau dashboard
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : live.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center">
            <SquaresFourIcon className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-[14px] font-medium">{agent ? `${agent.name} ne remplit encore aucun dashboard` : "Aucun dashboard dans ce service"}</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
              Composez des KPI, courbes, tableaux et alertes, dites à un collaborateur comment remplir chacun : il le tient à jour.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {live.map((d) => (
              <DashboardCard key={d.id} d={d} agent={(agents ?? []).find((a) => a.id === d.agent_id) ?? null}
                preview={previews?.get(d.id) ?? []} onOpen={() => navigate(`${sbase}/dashboards/${d.id}`)} />
            ))}
          </div>
        )}

        <h2 className="mb-4 mt-12 text-[19px] font-semibold tracking-tight">Modèles</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {saved.map((t) => (
            <TemplateCard key={t.id} category="Enregistré" name={t.name} tagline={t.description ?? t.usage_context ?? ""}
              kinds={[]} onUse={() => setCreating({ fromId: t.id })} onOpen={() => navigate(`${sbase}/dashboards/${t.id}`)} />
          ))}
          {DASHBOARD_TEMPLATES.map((t) => (
            <TemplateCard key={t.key} category={t.category} name={t.name.replace(/\s*\{\{.*?\}\}/g, "")} tagline={t.tagline}
              kinds={t.widgets.map((w) => w.kind)} onUse={() => setCreating({ templateKey: t.key })} />
          ))}
        </div>
      </div>

      <CreateDialog open={!!creating} onClose={() => setCreating(null)} preset={creating ?? {}} defaultAgentId={agent?.id ?? null}
        saved={saved} agents={agents ?? []} scope={{ workspaceId, projectId, serviceId }}
        onCreated={(id) => { setCreating(null); navigate(`${sbase}/dashboards/${id}`); }} />
    </div>
  );
}

function DashboardCard({ d, agent, preview, onOpen }: {
  d: AgentDashboard; agent: { name: string; avatar_url: string | null } | null; preview: DashboardWidget[]; onOpen: () => void;
}) {
  return (
    <button onClick={onOpen} className="flex flex-col rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-foreground/20">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{applyParameters(d.name, d.parameters)}</div>
          <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{d.description ?? REFRESH_LABEL[d.refresh]}</div>
        </div>
        {agent && <AgentIdentity url={agent.avatar_url} seed={agent.name} size={28} rounded="rounded-lg" interactive={false} />}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {preview.length ? preview.map((w) => {
          const v = (w.data ?? null) as { value?: number | string; unit?: string; status?: "ok" | "warn" | "critical" } | null;
          const st = v ? statusOf(typeof v.value === "number" ? v.value : null, w.config, v.status) : undefined;
          return (
            <div key={w.id} className="min-w-0 rounded-xl bg-muted/50 px-3 py-2">
              <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                {st && st !== "ok" && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_META[st].dot)} />}
                {applyParameters(w.title, d.parameters)}
              </div>
              <div className="mt-0.5 truncate text-[17px] font-semibold">
                {v?.value == null ? "–" : typeof v.value === "number" ? fmtNumber(v.value, w.config) : v.value}
                {v?.value != null && (v.unit ?? w.config?.unit) ? <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">{v.unit ?? w.config?.unit}</span> : null}
              </div>
            </div>
          );
        }) : <div className="col-span-3 rounded-xl bg-muted/50 px-3 py-3 text-[12px] text-muted-foreground">Pas encore d'indicateur</div>}
      </div>
      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{agent ? agent.name : "Aucun collaborateur"}</span>
        <span>·</span>
        <span>{d.last_filled_at ? `rempli ${formatRelative(d.last_filled_at)}` : "jamais rempli"}</span>
        <span className="ml-auto">{REFRESH_LABEL[d.refresh]}</span>
      </div>
    </button>
  );
}

function TemplateCard({ category, name, tagline, kinds, onUse, onOpen }: {
  category: string; name: string; tagline: string; kinds: string[]; onUse: () => void; onOpen?: () => void;
}) {
  const unique = [...new Set(kinds)].slice(0, 6) as Array<keyof typeof KIND_ICON>;
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{category}</div>
      <div className="mt-1 text-[14px] font-semibold">{name}</div>
      <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{tagline}</p>
      {unique.length > 0 && (
        <div className="mt-3 flex gap-1.5 text-muted-foreground">
          {unique.map((k) => { const Icon = KIND_ICON[k]; return <Icon key={k} className="h-3.5 w-3.5" />; })}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="outline" className="rounded-md" onClick={onUse}>Utiliser</Button>
        {onOpen && <Button size="sm" variant="ghost" className="rounded-md" onClick={onOpen}>Modifier</Button>}
      </div>
    </div>
  );
}

function CreateDialog({ open, onClose, preset, saved, agents, scope, onCreated, defaultAgentId }: {
  open: boolean; onClose: () => void; preset: { templateKey?: string; fromId?: string };
  defaultAgentId?: string | null;
  saved: AgentDashboard[]; agents: Array<{ id: string; name: string }>;
  scope: { workspaceId: string; projectId: string; serviceId: string };
  onCreated: (id: string) => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const initial = preset.fromId ? `saved:${preset.fromId}` : preset.templateKey ? `tpl:${preset.templateKey}` : "blank";
  const [source, setSource] = useState(initial);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "none");
  const [values, setValues] = useState<Record<string, string>>({});
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastPreset, setLastPreset] = useState(initial);
  if (open && initial !== lastPreset) { setLastPreset(initial); setSource(initial); setName(""); setValues({}); }

  const tpl = source.startsWith("tpl:") ? DASHBOARD_TEMPLATES.find((t) => t.key === source.slice(4)) : undefined;
  const savedTpl = source.startsWith("saved:") ? saved.find((s) => s.id === source.slice(6)) : undefined;
  const params: DashboardParameter[] = useMemo(() => tpl?.parameters ?? savedTpl?.parameters ?? [], [tpl, savedTpl]);
  const defaultName = (tpl?.name ?? savedTpl?.name.replace(/\s*\(modèle\)$/, "") ?? "");

  const create = async () => {
    setBusy(true);
    try {
      const filled = params.map((p) => ({ ...p, value: values[p.key] ?? p.value ?? "" }));
      const id = await createDashboard({ ...scope, userId: user?.id ?? null }, {
        name: applyParameters(name.trim() || defaultName || "Nouveau dashboard", filled),
        templateKey: tpl?.key ?? null, fromDashboardId: savedTpl?.id ?? null,
        agentId: agentId === "none" ? null : agentId, parameters: filled,
      });
      if (savedTpl) {
        await supabase.from("agent_dashboards").update({ description: savedTpl.description, usage_context: savedTpl.usage_context }).eq("id", id);
      }
      await qc.invalidateQueries({ queryKey: ["agent_dashboards", scope.serviceId] });
      if (runNow && agentId !== "none" && (tpl || savedTpl)) {
        const { data } = await supabase.from("agent_dashboards").select("*").eq("id", id).single();
        if (data) await refreshDashboard(data as AgentDashboard, user?.id ?? null).catch(() => {});
      }
      onCreated(id);
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg overflow-x-hidden scrollbar-hide">
        <DialogHeader><DialogTitle>Nouveau dashboard</DialogTitle></DialogHeader>
        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-1.5 text-[12px] font-medium">Départ</div>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Vide</SelectItem>
                {saved.map((s) => <SelectItem key={s.id} value={`saved:${s.id}`}>{s.name}</SelectItem>)}
                {DASHBOARD_TEMPLATES.map((t) => <SelectItem key={t.key} value={`tpl:${t.key}`}>{t.category} · {t.name.replace(/\s*\{\{.*?\}\}/g, "")}</SelectItem>)}
              </SelectContent>
            </Select>
            {tpl && <p className="mt-1.5 text-[12px] text-muted-foreground">{tpl.tagline} {tpl.widgets.length} composants, instructions comprises.</p>}
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium">Nom</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName || "Santé de la production"} />
          </div>
          {params.map((p) => (
            <div key={p.key}>
              <div className="mb-1.5 text-[12px] font-medium">{p.label || p.key}</div>
              <Input value={values[p.key] ?? p.value ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} placeholder={`Valeur de {{${p.key}}}`} />
            </div>
          ))}
          <div>
            <div className="mb-1.5 text-[12px] font-medium">Rempli par</div>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Choisir plus tard</SelectItem>
                {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {agentId !== "none" && (tpl || savedTpl) && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} /> Le remplir tout de suite
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={() => void create()} disabled={busy}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Créer</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
