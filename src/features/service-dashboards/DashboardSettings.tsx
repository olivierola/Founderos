import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import {
  SlidersIcon, SquaresFourIcon, RobotIcon, ChatsCircleIcon, WarningIcon, CheckIcon,
  CalendarDotsIcon, BrainIcon, FilesIcon, TrashIcon, FloppyDiskIcon, SparkleIcon,
  GaugeIcon, ShareNetworkIcon, EyeIcon, PlugIcon, KanbanIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AvatarPicker } from "@/features/internal-agents/AvatarPicker";
import { cn } from "@/lib/utils";
import {
  updateServiceDashboard, deleteServiceDashboard, ensureOrchestrator, fetchRooms, deleteEmptyRooms,
  COLLABORATION_POLICIES,
  type ServiceDashboard, type DashboardSettings as Settings, type DashboardTabSlug,
  type CollaborationPolicy,
} from "./model";
import { DASHBOARD_ICONS, DASHBOARD_COLORS, DashboardTile } from "./dashboardIcons";
import { THEMES } from "@/lib/themes";
import { useTheme } from "@/lib/theme-context";

// The dashboard's own settings — deliberately scoped to THIS service. Org-wide
// concerns (billing, members) stay in the Admin area; everything here changes
// only how this one dashboard looks and behaves. Connectors are dashboard-owned
// since 0177, so their nav entry is hideable like any other section.
type SectionKey = "general" | "navigation" | "assistant" | "agents" | "rooms" | "danger";

const SECTIONS: { key: SectionKey; label: string; icon: PhosphorIcon }[] = [
  { key: "general", label: "Général", icon: SlidersIcon },
  { key: "navigation", label: "Navigation", icon: SquaresFourIcon },
  { key: "assistant", label: "Assistant", icon: SparkleIcon },
  { key: "agents", label: "Agents", icon: RobotIcon },
  { key: "rooms", label: "Rooms", icon: ChatsCircleIcon },
  { key: "danger", label: "Zone de danger", icon: WarningIcon },
];

// Nav items that can be hidden (Home and Settings always stay reachable).
const HIDEABLE: { slug: DashboardTabSlug; label: string; icon: PhosphorIcon }[] = [
  { slug: "agents", label: "Agents", icon: RobotIcon },
  { slug: "projects", label: "Projets", icon: KanbanIcon },
  { slug: "schedules", label: "Schedules", icon: CalendarDotsIcon },
  { slug: "memory", label: "Workspace memory", icon: BrainIcon },
  { slug: "artifacts", label: "Artifacts", icon: FilesIcon },
  { slug: "connectors", label: "Connecteurs", icon: PlugIcon },
];

const MODELS = [
  { id: "deepseek", label: "DeepSeek", hint: "Par défaut — raisonnement + outils" },
  { id: "groq", label: "Groq (Llama 3.3 70B)", hint: "Llama 3.3 70B — rapide" },
  { id: "gpt-4", label: "GPT-4", hint: "Fallback" },
];

const SANDBOX_MODES = [
  { id: "cloud", label: "Cloud", hint: "Edge serverless — web, base, connecteurs" },
  { id: "runner", label: "Runner", hint: "+ navigateur, shell et fichiers de votre machine" },
  { id: "sandbox", label: "Sandbox", hint: "+ conteneur Linux complet" },
  { id: "hybrid", label: "Hybride", hint: "Runner et sandbox, orchestrés" },
] as const;

interface Orchestrator {
  id: string; name: string; avatar_url: string | null; persona: string | null; instructions: string | null;
  model: string | null; temperature: number | null; max_steps: number | null; max_run_cost_usd: number | null;
  swarm_enabled: boolean | null; swarm_max_concurrency: number | null;
}

export function DashboardSettingsTab({ dashboard, workspaceId, projectId, section, onSection }: {
  dashboard: ServiceDashboard;
  workspaceId: string;
  projectId: string;
  section: SectionKey;
  onSection: (s: SectionKey) => void;
}) {
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Dashboard row (identity + settings blob) ──
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description ?? "");
  const [icon, setIcon] = useState(dashboard.icon);
  const [color, setColor] = useState(dashboard.color);
  const [settings, setSettings] = useState<Settings>(dashboard.settings);
  const [mission, setMission] = useState(dashboard.mission ?? "");
  const [collaboration, setCollaboration] = useState<CollaborationPolicy>(dashboard.collaboration);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Re-seed the form when the dashboard is switched from the sidebar.
  useEffect(() => {
    setName(dashboard.name);
    setDescription(dashboard.description ?? "");
    setIcon(dashboard.icon);
    setColor(dashboard.color);
    setSettings(dashboard.settings);
    setMission(dashboard.mission ?? "");
    setCollaboration(dashboard.collaboration);
  }, [dashboard.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));

  // ── The service's agents (assistant + the rest) ──
  const { data: agents } = useQuery({
    queryKey: ["sd_settings_agents", dashboard.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, avatar_url, persona, instructions, model, temperature, max_steps, max_run_cost_usd, swarm_enabled, swarm_max_concurrency, is_orchestrator, chat_enabled, mission_enabled")
        .eq("service_dashboard_id", dashboard.id).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false }).order("created_at", { ascending: true });
      return (data ?? []) as Array<Orchestrator & { is_orchestrator: boolean; chat_enabled: boolean; mission_enabled: boolean }>;
    },
  });
  const orchestrator = (agents ?? []).find((a) => a.is_orchestrator) ?? null;
  const others = (agents ?? []).filter((a) => !a.is_orchestrator);

  // ── Assistant form — mirrors the orchestrator row, saved with the same button ──
  const [assistant, setAssistant] = useState<Orchestrator | null>(null);
  useEffect(() => { setAssistant(orchestrator ? { ...orchestrator } : null); }, [orchestrator?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const setA = (p: Partial<Orchestrator>) => setAssistant((a) => (a ? { ...a, ...p } : a));

  // One theme per person, app-wide.
  const { theme: appTheme, setTheme } = useTheme();

  const { data: rooms } = useQuery({
    queryKey: ["service_rooms", dashboard.id],
    queryFn: () => fetchRooms(dashboard.id),
  });

  async function save() {
    setSaving(true); setError(null); setWarning(null);
    try {
      const res = await updateServiceDashboard(dashboard.id, {
        name: name.trim() || dashboard.name,
        description: description.trim() || null,
        icon, color, settings,
        mission: mission.trim() || null,
        collaboration,
      });
      if (res.ok === false) {
        setWarning("Nom, icône et couleur sont enregistrés. La description et les préférences nécessitent la migration 0158, la mission et la politique de collaboration la 0213 (supabase db push).");
      }
      if (assistant && orchestrator) {
        const { error: aErr } = await supabase.from("internal_agents").update({
          name: assistant.name.trim() || orchestrator.name,
          avatar_url: assistant.avatar_url,
          persona: assistant.persona,
          instructions: assistant.instructions,
          model: assistant.model,
          temperature: assistant.temperature,
          max_steps: clamp(assistant.max_steps ?? 8, 1, 30),
          max_run_cost_usd: Math.max(Number(assistant.max_run_cost_usd) || 0.5, 0),
          swarm_enabled: assistant.swarm_enabled ?? true,
          swarm_max_concurrency: clamp(assistant.swarm_max_concurrency ?? 6, 2, 6),
          updated_at: new Date().toISOString(),
        }).eq("id", orchestrator.id);
        if (aErr) throw new Error(aErr.message);
      }
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
      queryClient.invalidateQueries({ queryKey: ["sd_settings_agents", dashboard.id] });
      queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboard.id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally { setSaving(false); }
  }

  async function createAssistant() {
    if (!user) return;
    await ensureOrchestrator({ id: dashboard.id, name: dashboard.name }, workspaceId, projectId, user.id);
    queryClient.invalidateQueries({ queryKey: ["sd_settings_agents", dashboard.id] });
    queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboard.id] });
  }

  const dirty = useMemo(() => (
    name !== dashboard.name
    || (description || "") !== (dashboard.description ?? "")
    || icon !== dashboard.icon
    || color !== dashboard.color
    || JSON.stringify(settings) !== JSON.stringify(dashboard.settings)
    || (assistant && orchestrator ? JSON.stringify(assistant) !== JSON.stringify(orchestrator) : false)
  ), [name, description, icon, color, settings, assistant, dashboard, orchestrator]);

  const sectionLabel = SECTIONS.find((s) => s.key === section)?.label ?? "Paramètres";

  return (
    <div className="min-h-full">
      {/* Page head — big section title, Save on the right (mockup layout). */}
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-10 pb-2 pt-8">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[30px] font-semibold tracking-tight">{sectionLabel}</h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {description || `Réglages du service « ${name || dashboard.name} ».`}
          </p>
        </div>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex"><CheckIcon className="h-3.5 w-3.5" /> Enregistré</span>
        )}
        {section !== "danger" && (
          <Button size="sm" onClick={save} disabled={saving || !dirty} className="shrink-0 rounded-full">
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FloppyDiskIcon className="mr-1.5 h-3.5 w-3.5" />}
            Enregistrer
          </Button>
        )}
      </div>
      {(error || warning) && (
        <div className="mx-auto max-w-3xl px-10 pb-1 pt-2">
          <p className={cn("rounded-lg px-3 py-2 text-xs", error ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-600 dark:text-amber-400")}>
            {error ?? warning}
          </p>
        </div>
      )}

      <div className="mx-auto flex max-w-3xl gap-8 px-10 py-8">
        {/* Sections live in the sidebar panel (see ServiceDashboardShell); only
            narrow viewports, where that panel may be folded, get a switcher. */}
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex gap-1 overflow-x-auto lg:hidden">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => onSection(s.key)}
                className={cn("shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors",
                  section === s.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}
              >
                {s.label}
              </button>
            ))}
          </div>

          {section === "general" && (
            <Card title="Identité du service">
              <Field label="Nom">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Marketing" />
              </Field>
              <Field label="Description">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex. Acquisition, contenu et campagnes" />
              </Field>
              <Field label="Icône">
                <div className="flex flex-wrap gap-1.5">
                  {DASHBOARD_ICONS.map((i) => (
                    <button
                      key={i.key} type="button" title={i.label} onClick={() => setIcon(i.key)}
                      className={cn("rounded-xl p-1 transition-all", icon === i.key ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:bg-muted")}
                    >
                      <DashboardTile icon={i.key} color={color} size={30} />
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Couleur">
                <div className="flex flex-wrap gap-1.5">
                  {DASHBOARD_COLORS.map((c) => (
                    <button
                      key={c} type="button" onClick={() => setColor(c)}
                      className={cn("h-7 w-7 rounded-full transition-all", c, color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
                    />
                  ))}
                </div>
              </Field>
              <Field label="Votre thème" hint="Personnel, et appliqué à toute l'app — vos coéquipiers gardent le leur.">
                <div className="flex flex-wrap gap-2">
                  {THEMES.map((t) => (
                    <button
                      key={t.key} type="button"
                      // A switcher, not a form field: it lands right away rather
                      // than waiting for Save, and it drives the ONE theme the
                      // person has — every dashboard repaints at once.
                      onClick={() => setTheme(t.key)}
                      className={cn(
                        "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors",
                        appTheme === t.key ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:border-primary/40",
                      )}
                    >
                      <span className="h-4 w-4 shrink-0 rounded-full border border-border" style={{ background: t.swatch }} />
                      {t.label}
                    </button>
                  ))}
                </div>
              </Field>

              <div className="rounded-xl border border-border bg-card/60 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <EyeIcon className="h-3 w-3" /> Aperçu
                </div>
                <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                  <DashboardTile icon={icon} color={color} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name || "Sans nom"}</span>
                </div>
              </div>

              {/* La frontière du service (0213). Elle vit ici, dans « Général »,
                  et pas dans une page de gouvernance : c'est un choix
                  d'organisation que fait le responsable du service, pas une
                  politique d'entreprise imposée d'en haut. */}
              <Field
                label="Mission du service"
                hint="Une phrase. Elle est envoyée aux agents d'ici, et lue par ceux des autres services dans l'annuaire."
              >
                <Input
                  value={mission} onChange={(e) => setMission(e.target.value)}
                  placeholder="ex. Faire connaître le produit et générer de la demande qualifiée"
                />
              </Field>
              <Field
                label="Travail venu des autres services"
                hint="Vos agents restent libres de parler à tout le monde : ce réglage ne porte que sur le travail qu'on peut vous imposer."
              >
                <div className="space-y-1.5">
                  {COLLABORATION_POLICIES.map((p) => (
                    <button
                      key={p.id} type="button" onClick={() => setCollaboration(p.id)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
                        collaboration === p.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:border-primary/40",
                      )}
                    >
                      <span className={cn(
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        collaboration === p.id ? "bg-primary" : "bg-muted-foreground/40",
                      )} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{p.label}</span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">{p.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </Field>
            </Card>
          )}

          {section === "navigation" && (
            <>
              <Card title="Onglets visibles" desc="Home et Paramètres restent toujours accessibles.">
                <div className="space-y-1.5">
                  {HIDEABLE.map((t) => {
                    const hidden = settings.hidden_tabs.includes(t.slug);
                    return (
                      <Row
                        key={t.slug} icon={t.icon} label={t.label}
                        desc={hidden ? "Masqué dans la barre latérale" : "Visible dans la barre latérale"}
                        checked={!hidden}
                        onChange={(on) => patch({
                          hidden_tabs: on
                            ? settings.hidden_tabs.filter((s) => s !== t.slug)
                            : [...settings.hidden_tabs, t.slug],
                          // Never leave the dashboard opening on a tab it hides.
                          ...(!on && settings.landing === t.slug ? { landing: "home" as DashboardTabSlug } : {}),
                        })}
                      />
                    );
                  })}
                </div>
              </Card>
              <Card title="Ouverture">
                <Field label="Page d'accueil">
                  <Select
                    value={settings.landing}
                    onChange={(v) => patch({ landing: v as DashboardTabSlug })}
                    options={[
                      { value: "home", label: "Home" },
                      ...HIDEABLE.filter((t) => !settings.hidden_tabs.includes(t.slug)).map((t) => ({ value: t.slug, label: t.label })),
                    ]}
                  />
                </Field>
                <Row
                  icon={SquaresFourIcon} label="Barre latérale repliée par défaut"
                  desc="Pour qui n'a pas encore choisi."
                  checked={settings.sidebar_collapsed}
                  onChange={(on) => patch({ sidebar_collapsed: on })}
                />
              </Card>
            </>
          )}

          {section === "assistant" && (
            !assistant ? (
              <Card title="Assistant du service" desc="L'agent par défaut de ce dashboard.">
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-8 text-center">
                  <SparkleIcon className="h-6 w-6 text-muted-foreground/60" />
                  <p className="text-sm text-muted-foreground">Ce service n'a pas encore d'assistant.</p>
                  <Button size="sm" onClick={createAssistant}>Créer l'assistant</Button>
                </div>
              </Card>
            ) : (
              <>
                <Card title="Identité">
                  <div className="flex items-start gap-4">
                    <AgentIdentity url={assistant.avatar_url} seed={assistant.name} size={56} rounded="rounded-2xl" className="mt-0.5 border border-border" />
                    <div className="min-w-0 flex-1 space-y-3">
                      <Field label="Nom"><Input value={assistant.name} onChange={(e) => setA({ name: e.target.value })} /></Field>
                      <Field label="Avatar"><AvatarPicker value={assistant.avatar_url} onChange={(v) => setA({ avatar_url: v })} /></Field>
                    </div>
                  </div>
                </Card>
                <Card title="Comportement">
                  <Field label="Persona">
                    <Textarea rows={3} value={assistant.persona ?? ""} onChange={(e) => setA({ persona: e.target.value })}
                      placeholder={`L'assistant du service « ${dashboard.name} »…`} />
                  </Field>
                  <Field label="Instructions">
                    <Textarea rows={5} value={assistant.instructions ?? ""} onChange={(e) => setA({ instructions: e.target.value })}
                      placeholder="ex. Réponds en français. Délègue la rédaction à l'agent Contenu." />
                  </Field>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Modèle">
                      <Select value={assistant.model ?? "deepseek"} onChange={(v) => setA({ model: v })}
                        options={MODELS.map((m) => ({ value: m.id, label: m.label }))} />
                    </Field>
                    <Field label={`Température (${(assistant.temperature ?? 0.7).toFixed(1)})`}>
                      <input type="range" min={0} max={1} step={0.1} value={assistant.temperature ?? 0.7}
                        onChange={(e) => setA({ temperature: Number(e.target.value) })} className="mt-3 w-full" />
                    </Field>
                  </div>
                </Card>
                <Card title="Budget d'autonomie" icon={GaugeIcon} desc="Limites dures par run.">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Étapes max par run (1–30)">
                      <Input type="number" min={1} max={30} value={assistant.max_steps ?? 8}
                        onChange={(e) => setA({ max_steps: Number(e.target.value) })} />
                    </Field>
                    <Field label="Coût max par run (USD)">
                      <Input type="number" min={0} step={0.05} value={assistant.max_run_cost_usd ?? 0.5}
                        onChange={(e) => setA({ max_run_cost_usd: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <Row
                    icon={ShareNetworkIcon} label="Mode essaim"
                    desc="Découper une tâche en sous-agents parallèles."
                    checked={assistant.swarm_enabled ?? true}
                    onChange={(on) => setA({ swarm_enabled: on })}
                  />
                  {(assistant.swarm_enabled ?? true) && (
                    <Field label="Instances concurrentes (2–6)">
                      <Input type="number" min={2} max={6} className="max-w-[8rem]" value={assistant.swarm_max_concurrency ?? 6}
                        onChange={(e) => setA({ swarm_max_concurrency: Number(e.target.value) })} />
                    </Field>
                  )}
                </Card>
              </>
            )
          )}

          {section === "agents" && (
            <>
              <Card
                title="Valeurs par défaut des nouveaux agents"
                desc="Les agents existants ne changent pas ; un template garde son environnement et son budget."
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Modèle">
                    <Select value={settings.agent_defaults.model}
                      onChange={(v) => patch({ agent_defaults: { ...settings.agent_defaults, model: v } })}
                      options={MODELS.map((m) => ({ value: m.id, label: m.label }))} />
                  </Field>
                  <Field label="Étapes max par run">
                    <Input type="number" min={1} max={30} value={settings.agent_defaults.max_steps}
                      onChange={(e) => patch({ agent_defaults: { ...settings.agent_defaults, max_steps: Number(e.target.value) } })} />
                  </Field>
                  <Field label="Coût max par run (USD)">
                    <Input type="number" min={0} step={0.05} value={settings.agent_defaults.max_run_cost_usd}
                      onChange={(e) => patch({ agent_defaults: { ...settings.agent_defaults, max_run_cost_usd: Number(e.target.value) } })} />
                  </Field>
                </div>
                <Field label="Environnement d'exécution">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {SANDBOX_MODES.map((m) => (
                      <button
                        key={m.id} type="button"
                        onClick={() => patch({ agent_defaults: { ...settings.agent_defaults, sandbox_mode: m.id } })}
                        className={cn("rounded-xl border p-3 text-left transition-all",
                          settings.agent_defaults.sandbox_mode === m.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:border-primary/40")}
                      >
                        <div className="text-sm font-medium">{m.label}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{m.hint}</div>
                      </button>
                    ))}
                  </div>
                </Field>
                <Row
                  icon={ShareNetworkIcon} label="Mode essaim autorisé"
                  desc="Sous-agents parallèles autorisés."
                  checked={settings.agent_defaults.swarm_enabled}
                  onChange={(on) => patch({ agent_defaults: { ...settings.agent_defaults, swarm_enabled: on } })}
                />
                <Row
                  icon={CheckIcon} label="Validation humaine requise"
                  desc="Les intégrations accordées demandent une approbation."
                  checked={settings.agent_defaults.requires_approval}
                  onChange={(on) => patch({ agent_defaults: { ...settings.agent_defaults, requires_approval: on } })}
                />
              </Card>

              <Card title={`Agents du service (${others.length})`} desc="Les réglages d'un agent priment sur ces défauts.">
                {others.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    Aucun agent pour l'instant.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {others.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/service/${dashboard.id}/agent-config/${a.id}?t=settings`)}
                        className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2 text-left transition-colors hover:border-primary/40"
                      >
                        <AgentIdentity url={a.avatar_url} seed={a.name} size={28} rounded="rounded-lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.name}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {a.model ?? "deepseek"} · {a.max_steps ?? 8} étapes · {a.chat_enabled ? "chat" : "sans chat"}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}

          {section === "rooms" && (
            <>
              <Card title="Nouvelles rooms">
                <Row
                  icon={SparkleIcon} label="Ajouter l'assistant automatiquement"
                  desc="Comme participant de chaque nouvelle room."
                  checked={settings.rooms.auto_add_orchestrator}
                  onChange={(on) => patch({ rooms: { ...settings.rooms, auto_add_orchestrator: on } })}
                />
                <Field label="Répondeur par défaut" hint="Répond aux messages sans mention.">
                  <Select
                    value={settings.rooms.default_responder_agent_id ?? ""}
                    onChange={(v) => patch({ rooms: { ...settings.rooms, default_responder_agent_id: v || null } })}
                    options={[
                      { value: "", label: "L'assistant du service" },
                      ...(agents ?? []).filter((a) => !a.is_orchestrator).map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </Field>
              </Card>
              <Card title="Entretien" icon={ChatsCircleIcon} desc={`${(rooms ?? []).length} room(s) dans ce service.`}>
                <CleanupEmptyRooms dashboardId={dashboard.id} />
              </Card>
            </>
          )}

          {section === "danger" && (
            <Card title="Zone de danger" icon={WarningIcon} tone="danger">
              <DangerRow
                title="Supprimer toutes les rooms"
                desc="Les agents et leurs livrables restent."
                action="Supprimer les rooms"
                onConfirm={async () => {
                  const list = await fetchRooms(dashboard.id);
                  for (const r of list) {
                    await supabase.from("service_room_messages").delete().eq("room_id", r.id);
                    await supabase.from("service_room_agents").delete().eq("room_id", r.id);
                  }
                  await supabase.from("service_rooms").delete().eq("dashboard_id", dashboard.id);
                  queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboard.id] });
                }}
                confirmText={`Supprimer les ${(rooms ?? []).length} room(s) de ce service ? Les messages sont perdus.`}
              />
              <DangerRow
                title="Supprimer ce dashboard"
                desc="Ses agents sont dissociés, pas supprimés."
                action="Supprimer le dashboard"
                onConfirm={async () => {
                  await deleteServiceDashboard(dashboard.id);
                  queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
                  navigate(`/app/${workspaceSlug}/${projectSlug}`);
                }}
                confirmText={`Supprimer « ${dashboard.name} » ? Cette action est irréversible.`}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(Number(n) || min), min), max);
}

// ── Building blocks ───────────────────────────────────────────────────────────
function Card({ title, desc, icon: Icon, tone, children }: {
  title: string; desc?: string; icon?: PhosphorIcon; tone?: "danger"; children: React.ReactNode;
}) {
  return (
    <section className={cn("mb-4 rounded-2xl border bg-card p-5 shadow-sm", tone === "danger" ? "border-destructive/40" : "border-border")}>
      <div className="mb-4">
        <h2 className={cn("flex items-center gap-2 text-sm font-semibold", tone === "danger" && "text-destructive")}>
          {Icon && <Icon className="h-4 w-4" />} {title}
        </h2>
        {desc && <p className="mt-1 text-xs text-muted-foreground">{desc}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** A labelled switch row — the shape most settings here take. */
function Row({ icon: Icon, label, desc, checked, onChange }: {
  icon?: PhosphorIcon; label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />} {label}
        </div>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      <button
        type="button" role="switch" aria-checked={checked} aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted")}
      >
        {/* Anchored with `left`: without it the thumb starts from its static
            position, which a <button>'s default `text-align: center` puts in
            the middle of the track — so the ON state overflowed to the right. */}
        <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform", checked ? "translate-x-5" : "translate-x-0")} />
      </button>
    </div>
  );
}

function DangerRow({ title, desc, action, confirmText, onConfirm }: {
  title: string; desc: string; action: string; confirmText: string; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Button
        size="sm" variant="outline" disabled={busy}
        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={async () => {
          if (!confirm(confirmText)) return;
          setBusy(true);
          try { await onConfirm(); } finally { setBusy(false); }
        }}
      >
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <TrashIcon className="mr-1.5 h-3.5 w-3.5" />}
        {action}
      </Button>
    </div>
  );
}

function CleanupEmptyRooms({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">Nettoyer les rooms vides</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Rooms ouvertes sans aucun message.
          {done !== null && <span className="ml-1 text-foreground">{done} supprimée(s).</span>}
        </p>
      </div>
      <Button
        size="sm" variant="outline" disabled={busy} className="shrink-0"
        onClick={async () => {
          setBusy(true);
          try {
            const n = await deleteEmptyRooms(dashboardId);
            setDone(n);
            queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
          } finally { setBusy(false); }
        }}
      >
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <TrashIcon className="mr-1.5 h-3.5 w-3.5" />}
        Nettoyer
      </Button>
    </div>
  );
}

export type { SectionKey as DashboardSettingsSection };
export { SECTIONS as DASHBOARD_SETTINGS_SECTIONS };
