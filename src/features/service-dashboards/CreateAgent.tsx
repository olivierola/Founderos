import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import {
  GlobeIcon, LaptopIcon, PlusIcon, MagnifyingGlassIcon, SquaresFourIcon, XIcon, CheckIcon, SlidersIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentIdentity } from "@/components/AgentIdentity";
import { BrandLogo } from "@/components/BrandLogo";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AVATAR_OPTIONS, AvatarPicker } from "@/features/internal-agents/AvatarPicker";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/features/internal-agents/agentTemplates";
import { explainAgentInsertError } from "@/features/internal-agents/instantiateTemplate";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "@/features/internal-agents/connectorActionProviders";
import { applyAgentDefaults, fetchServiceDashboard, DEFAULT_AGENT_DEFAULTS } from "./model";
import { CatalogCard } from "./CatalogCard";
import { TemplateConfigPanel } from "./TemplateConfigPanel";
import {
  useComposioToolkits, useConnectorStatus, toolSlugsFromTemplate, resolveNeeds,
} from "./useToolkits";

// The providers WE supply. `id` is written to internal_agents.model, which the
// runtime reads to pick the vendor (see resolveProvider, edge side).
//
// "OpenAI / GPT-4" used to sit in this list and did nothing at all: there is no
// OpenAI client in the runtime, so the value fell through to the default
// provider. Using OpenAI (or anything else) now goes through a registered
// model below, which is a real, tested connection.
const PROVIDERS: { id: string; label: string; models: { id: string; label: string }[] }[] = [
  { id: "deepseek", label: "DeepSeek", models: [{ id: "deepseek", label: "DeepSeek — raisonnement & outils" }] },
  { id: "groq", label: "Groq (Llama 3.3 70B)", models: [{ id: "groq", label: "Llama 3.3 70B — rapide" }] },
];

/** Sentinel provider id for "one of the company's own registered models". */
const OWN_MODELS = "__own__";

// Template categories, mapped onto the buckets the mockup shows.
const TEMPLATE_TABS: { key: string; label: string; match?: string[] }[] = [
  { key: "all", label: "All" },
  { key: "productivity", label: "Productivity", match: ["Assistant", "Ops", "Product"] },
  { key: "sales", label: "Sales & Marketing", match: ["Revenue", "Growth", "Marketing"] },
  { key: "operations", label: "Operations", match: ["Ops", "Supply chain", "Finance", "HR", "Legal"] },
  { key: "creative", label: "Creative", match: ["Design", "Marketing"] },
  { key: "engineering", label: "Engineering", match: ["QA", "R&D", "Cybersecurity", "Data"] },
];

export function CreateAgentPage({ dashboardId, workspaceId, projectId }: {
  dashboardId: string; workspaceId: string; projectId: string;
}) {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const [mode, setMode] = useState<"custom" | "templates">("custom");

  return (
    <div className="min-h-full px-10 py-6">
      {/* Breadcrumb + the Build/Templates switch, as in the mockup. */}
      <div className="relative flex items-center">
        <nav className="flex items-center gap-2 text-sm">
          <button onClick={() => navigate(`${base}/agents`)} className="text-muted-foreground transition-colors hover:text-foreground">Agents</button>
          <span className="text-muted-foreground">›</span>
          <span className="font-medium">Create Agent</span>
        </nav>
        <div className="absolute left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 p-1">
            <button
              onClick={() => setMode("custom")}
              className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                mode === "custom" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              Build Your Own
            </button>
            <button
              onClick={() => setMode("templates")}
              className={cn("flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                mode === "templates" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <SquaresFourIcon className="h-3.5 w-3.5" /> Templates
            </button>
          </div>
        </div>
      </div>

      {mode === "custom"
        ? <BuildYourOwn dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base} />
        : <TemplateGallery dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base} />}
    </div>
  );
}

// ── Build your own ───────────────────────────────────────────────────────────
function BuildYourOwn({ dashboardId, workspaceId, projectId, base }: {
  dashboardId: string; workspaceId: string; projectId: string; base: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: board } = useQuery({
    queryKey: ["service_dashboard", dashboardId],
    queryFn: () => fetchServiceDashboard(dashboardId),
  });
  const defaults = board?.settings.agent_defaults ?? DEFAULT_AGENT_DEFAULTS;

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(AVATAR_OPTIONS[0]);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [runtime, setRuntime] = useState<"cloud" | "runner">(defaults.sandbox_mode === "runner" ? "runner" : "cloud");
  const [provider, setProvider] = useState(PROVIDERS.find((p) => p.models.some((m) => m.id === defaults.model))?.id ?? "deepseek");
  const [model, setModel] = useState(defaults.model);
  /** "<providerId>|<modelId>" when the agent runs on one of the company's own
   *  registered models rather than one of ours. */
  const [ownModel, setOwnModel] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"apps" | "skills" | null>(null);
  const [skillQuery, setSkillQuery] = useState("");

  // The company's own models (AI Ops → Modèles). Only connected endpoints that
  // actually resolved at least one model id are offerable — an endpoint with no
  // usable model would produce an agent that fails on its first call.
  const { data: ownProviders } = useQuery({
    queryKey: ["aiops_own_models", projectId],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_providers_public")
        .select("id, name, status, metadata")
        .eq("project_id", projectId).eq("kind", "cloud_endpoint");
      return (data ?? []) as Array<{ id: string; name: string; status: string; metadata: { models?: string[] } | null }>;
    },
  });
  const ownModelOptions = useMemo(
    () => (ownProviders ?? [])
      .filter((p) => p.status === "connected")
      .flatMap((p) => (p.metadata?.models ?? []).map((m) => ({ value: `${p.id}|${m}`, label: `${p.name} · ${m}` }))),
    [ownProviders],
  );

  const { data: allSkills } = useQuery({
    queryKey: ["agent_skills_all", workspaceId],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills").select("id, name, slug, description")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order("name");
      return (data ?? []) as Array<{ id: string; name: string; slug: string; description: string | null }>;
    },
  });

  async function create() {
    if (!name.trim() || !user || creating) return;
    setCreating(true); setError(null);
    try {
      // created_by must equal auth.uid() for the INSERT policy to pass — read it
      // from the live session rather than from a possibly stale context.
      const { data: authData } = await supabase.auth.getUser();
      const { data, error: insErr } = await supabase.from("internal_agents").insert({
        workspace_id: workspaceId, project_id: projectId, service_dashboard_id: dashboardId,
        name: name.trim(), description: instructions.trim().slice(0, 140) || null,
        avatar_emoji: null, avatar_url: avatar, created_by: authData.user?.id ?? user.id,
        instructions: instructions.trim() || null,
        chat_enabled: true, mission_enabled: true,
      }).select("id").single();
      if (insErr) throw new Error(explainAgentInsertError(insErr.message, !!authData.user));
      const agentId = (data as { id: string }).id;

      // Service defaults first, then this form's explicit choices.
      await applyAgentDefaults(agentId, defaults, "blank");
      // A company model is a HOSTED endpoint, not one of our providers: it is
      // stored on hosted_provider_id/hosted_model, which the runtime resolves
      // ahead of everything else (resolveAgentEndpoint). `model` still gets a
      // sane value so the run has a provider to fall back to if the endpoint
      // is later deleted.
      const own = provider === OWN_MODELS && ownModel ? ownModel.split("|") : null;
      await supabase.from("internal_agents").update({
        model: own ? defaults.model : model,
        sandbox_mode: runtime,
        hosted_provider_id: own ? own[0] : null,
        hosted_model: own ? own.slice(1).join("|") : null,
      }).eq("id", agentId);

      // Apps → connector_action tools (same shape the Connectors tab writes).
      if (apps.length) {
        await supabase.from("internal_agent_tools").insert(apps.map((slug) => {
          const p = connectorActionProvider(slug);
          return {
            agent_id: agentId, kind: "connector_action",
            name: p ? `Use ${p.name}` : `Use ${slug}`,
            description: p?.description ?? null,
            config: { provider: slug },
            // The service default lands here — this is where approval is enforced.
            requires_approval: defaults.requires_approval,
          };
        }));
      }
      // Skills → activations (same table the Skills tab toggles).
      if (skills.length) {
        await supabase.from("agent_skill_activations")
          .insert(skills.map((skill_id) => ({ agent_id: agentId, skill_id })));
      }

      queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboardId] });
      queryClient.invalidateQueries({ queryKey: ["sd_panel_agents", dashboardId] });
      navigate(`${base}/agent/${agentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally { setCreating(false); }
  }

  const skillName = (id: string) => (allSkills ?? []).find((s) => s.id === id)?.name ?? id;

  // Skill picker: selected ones always shown, the rest only once searched, so
  // a 900-skill catalogue stays navigable. Capped to keep the panel light.
  const SKILL_PICK_LIMIT = 40;
  const skillMatches = (() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return skills.length;
    return (allSkills ?? []).filter((s) =>
      `${s.name} ${s.slug} ${s.description ?? ""}`.toLowerCase().includes(q)).length;
  })();
  const shownSkills = (() => {
    const q = skillQuery.trim().toLowerCase();
    const chosen = (allSkills ?? []).filter((s) => skills.includes(s.id));
    if (!q) return chosen;
    const hits = (allSkills ?? []).filter((s) =>
      !skills.includes(s.id) &&
      `${s.name} ${s.slug} ${s.description ?? ""}`.toLowerCase().includes(q));
    return [...chosen, ...hits].slice(0, SKILL_PICK_LIMIT);
  })();

  return (
    <div className="mx-auto mt-10 w-full max-w-[740px] rounded-3xl border border-border/60 bg-card/40 p-8 shadow-sm">
      {/* Identity */}
      <div className="flex items-center gap-4">
        <button onClick={() => setAvatarOpen((v) => !v)} title="Changer l'avatar" className="rounded-2xl transition-transform hover:scale-105">
          <AgentIdentity url={avatar} seed={name || "agent"} size={60} rounded="rounded-2xl" />
        </button>
        <input
          value={name} onChange={(e) => setName(e.target.value)} autoFocus
          placeholder="Nom de l'agent"
          className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-tight placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </div>
      {avatarOpen && <div className="mt-4"><AvatarPicker value={avatar} onChange={(v) => { setAvatar(v); setAvatarOpen(false); }} /></div>}

      <div className="my-6 border-t border-border/60" />

      {/* Runtime */}
      <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 p-1">
        <RuntimeBtn icon={GlobeIcon} label="Web" active={runtime === "cloud"} onClick={() => setRuntime("cloud")} />
        <RuntimeBtn icon={LaptopIcon} label="Local" active={runtime === "runner"} onClick={() => setRuntime("runner")} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {runtime === "cloud"
          ? "Edge serverless : web, base, connecteurs."
          : "Votre runner : navigateur, shell, fichiers."}
      </p>

      {/* Provider + model — ours, or one of the company's own registered models. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SelectField
          value={provider}
          onChange={(v) => {
            setProvider(v);
            if (v === OWN_MODELS) {
              setModel(defaults.model);
              setOwnModel(ownModelOptions[0]?.value ?? "");
            } else {
              const first = PROVIDERS.find((p) => p.id === v)?.models[0];
              if (first) setModel(first.id);
              setOwnModel("");
            }
          }}
          options={[
            ...PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
            ...(ownModelOptions.length ? [{ value: OWN_MODELS, label: "Vos modèles (AI Ops)" }] : []),
          ]}
        />
        {provider === OWN_MODELS ? (
          <SelectField value={ownModel} onChange={setOwnModel} options={ownModelOptions} />
        ) : (
          <SelectField
            value={model} onChange={setModel}
            options={(PROVIDERS.find((p) => p.id === provider)?.models ?? []).map((m) => ({ value: m.id, label: m.label }))}
          />
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {provider === OWN_MODELS
          ? "L'agent appellera votre propre endpoint avec votre clé — aucune inférence ne passe par nos fournisseurs."
          : ownModelOptions.length
            ? "Vous pouvez aussi utiliser vos propres modèles (option « Vos modèles »)."
            : <>Pour utiliser vos propres modèles (API cloud ou endpoint interne), ajoutez-les dans <span className="font-medium text-foreground">AI Ops → Modèles</span>.</>}
      </p>

      {/* Apps + Skills */}
      <RowPicker
        label="Apps" onAdd={() => setPicker(picker === "apps" ? null : "apps")}
        chips={apps.map((slug) => ({
          key: slug,
          node: <><BrandLogo slug={slug} className="h-3.5 w-3.5" /> {connectorActionProvider(slug)?.name ?? slug}</>,
          onRemove: () => setApps((v) => v.filter((s) => s !== slug)),
        }))}
      />
      {picker === "apps" && (
        <PickerPanel onClose={() => setPicker(null)}>
          {CONNECTOR_ACTION_GROUPS.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{g.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {g.slugs.map((slug) => (
                  <PickChip
                    key={slug} active={apps.includes(slug)}
                    onClick={() => setApps((v) => v.includes(slug) ? v.filter((s) => s !== slug) : [...v, slug])}
                  >
                    <BrandLogo slug={slug} className="h-3.5 w-3.5" /> {connectorActionProvider(slug)?.name ?? slug}
                  </PickChip>
                ))}
              </div>
            </div>
          ))}
        </PickerPanel>
      )}

      <RowPicker
        label="Skills" onAdd={() => setPicker(picker === "skills" ? null : "skills")}
        chips={skills.map((id) => ({
          key: id, node: <>{skillName(id)}</>,
          onRemove: () => setSkills((v) => v.filter((s) => s !== id)),
        }))}
      />
      {picker === "skills" && (
        <PickerPanel onClose={() => setPicker(null)}>
          {/* The catalogue holds 900+ skills — dumping them all as chips is
              unusable, so the panel is search-driven: selected skills stay
              pinned, everything else appears as you type. */}
          <input
            value={skillQuery}
            onChange={(e) => setSkillQuery(e.target.value)}
            autoFocus
            placeholder="Rechercher un skill (nom, domaine, tag…)"
            className="mb-2 w-full rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs outline-none focus:border-primary/50"
          />
          <div className="flex flex-wrap gap-1.5">
            {(allSkills ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun skill disponible.</p>
            ) : shownSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {skillQuery ? `Aucun skill pour « ${skillQuery} ».` : "Tapez pour chercher parmi les skills disponibles."}
              </p>
            ) : (
              shownSkills.map((s) => (
                <PickChip
                  key={s.id} active={skills.includes(s.id)} title={s.description ?? undefined}
                  onClick={() => setSkills((v) => v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id])}
                >
                  {s.name}
                </PickChip>
              ))
            )}
          </div>
          {skillMatches > shownSkills.length && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {skillMatches - shownSkills.length} autres résultats — affinez la recherche.
            </p>
          )}
        </PickerPanel>
      )}

      {/* Instructions */}
      <div className="mt-6">
        <label className="mb-2 block text-sm text-muted-foreground">Instructions</label>
        <Textarea
          rows={11} value={instructions} onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should this agent do? Describe its job, tone, and any rules."
          className="resize-none rounded-2xl bg-background/60 text-sm"
        />
      </div>

      {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      <div className="mt-5 flex justify-end">
        <Button onClick={create} disabled={creating || !name.trim()} className="rounded-xl px-5">
          {creating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Create agent
        </Button>
      </div>
    </div>
  );
}

function RuntimeBtn({ icon: Icon, label, active, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors",
        active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function SelectField({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      className="h-11 w-full rounded-xl border border-border/60 bg-background/60 px-3 text-sm"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function RowPicker({ label, onAdd, chips }: {
  label: string; onAdd: () => void; chips: { key: string; node: React.ReactNode; onRemove: () => void }[];
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-border/60 pb-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <button
        onClick={onAdd} aria-label={`Ajouter · ${label}`}
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-sidebar-accent text-foreground transition-colors hover:bg-sidebar-accent/70"
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>
      {chips.map((c) => (
        <span key={c.key} className="flex items-center gap-1.5 rounded-lg bg-sidebar-accent px-2 py-1 text-xs">
          {c.node}
          <button onClick={c.onRemove} className="text-muted-foreground hover:text-foreground"><XIcon className="h-3 w-3" /></button>
        </span>
      ))}
    </div>
  );
}

function PickerPanel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-background/60 p-3">
      {children}
      <div className="mt-1 flex justify-end">
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">Fermer</button>
      </div>
    </div>
  );
}

function PickChip({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick} title={title}
      className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground")}
    >
      {children}{active && <CheckIcon className="h-3 w-3 text-primary" />}
    </button>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────
function TemplateGallery({ dashboardId, workspaceId, projectId, base }: {
  dashboardId: string; workspaceId: string; projectId: string; base: string;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("all");
  // Clicking a card opens its configuration panel rather than creating blind.
  const [configuring, setConfiguring] = useState<AgentTemplate | null>(null);
  const { data: toolkits } = useComposioToolkits();
  const { data: connStatus } = useConnectorStatus(workspaceId, projectId);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cats = TEMPLATE_TABS.find((t) => t.key === tab)?.match;
    return AGENT_TEMPLATES.filter((t) => {
      if (cats && !cats.includes(t.category)) return false;
      if (!term) return true;
      return t.name.toLowerCase().includes(term) || t.tagline.toLowerCase().includes(term);
    });
  }, [q, tab]);

  // Creation itself now happens in the config panel, once the agent has been
  // named, instructed, given its skills and had its apps connected.
  return (
    <div className="mx-auto mt-8 max-w-6xl">
      <div className="mb-7 flex flex-wrap items-center gap-4">
        <div className="flex h-10 min-w-[280px] flex-1 items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates"
            className="h-full min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {TEMPLATE_TABS.map((t) => (
            <button
              key={t.key} onClick={() => setTab(t.key)}
              className={cn("rounded-full px-3.5 py-1.5 text-sm transition-colors",
                tab === t.key ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <TemplateConfigPanel
        template={configuring}
        onClose={() => setConfiguring(null)}
        dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId}
        onCreated={(id) => navigate(`${base}/agent/${id}`)}
      />

      {list.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Aucun template ne correspond.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((t) => (
            <CatalogCard
              key={t.key}
              onClick={() => setConfiguring(t)}
              glyph={
                <span
                  className="flex h-14 w-14 items-center justify-center rounded-xl text-2xl"
                  style={{ background: `${t.accent}22`, boxShadow: `inset 0 0 0 1px ${t.accent}44` }}
                >
                  {t.emoji}
                </span>
              }
              name={t.name}
              tools={t.tools.length}
              extras={t.skillSlugs?.length ?? 0}
              badges={[
                { label: t.category, tone: "auth", title: "Catégorie" },
                { label: t.sandboxMode ?? "cloud", tone: "key", title: "Environnement d'exécution" },
              ]}
              shield={t.autonomy !== "autopilot"}
              meta={` pas`}
              tools_needed={resolveNeeds(toolSlugsFromTemplate(t), toolkits, connStatus)}
              overlay={
                <span className="flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background">
                  <SlidersIcon className="h-3.5 w-3.5" /> Configurer
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
