import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import {
  GlobeIcon, LaptopIcon, PlusIcon, MagnifyingGlassIcon, SquaresFourIcon, XIcon, CheckIcon, SlidersIcon,
} from "@phosphor-icons/react";
import { PUBLIC_AGENT_PRESETS, type PublicAgentPreset } from "@/features/agent-rag/publicAgentPresets";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SoftField, SoftInput } from "@/components/ui/soft-form";
import { callEdge } from "@/lib/edge";
import { AgentIdentity } from "@/components/AgentIdentity";
import { BrandLogo } from "@/components/BrandLogo";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AVATAR_OPTIONS, AvatarPicker } from "@/features/internal-agents/AvatarPicker";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/features/internal-agents/agentTemplates";
import { diagnoseAgentInsertError } from "@/features/internal-agents/instantiateTemplate";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "@/features/internal-agents/connectorActionProviders";
import { applyAgentDefaults, fetchServiceDashboard, DEFAULT_AGENT_DEFAULTS } from "./model";
import { CatalogCard } from "./CatalogCard";
import { Icon3D } from "@/features/internal-agents/icons3d";
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
  { key: "personal", label: "Personnel", match: ["Personnel"] },
  { key: "productivity", label: "Productivity", match: ["Assistant", "Ops", "Product", "Leadership"] },
  { key: "sales", label: "Sales & Marketing", match: ["Revenue", "Growth", "Marketing"] },
  { key: "customer", label: "Customer", match: ["Support"] },
  { key: "operations", label: "Operations", match: ["Ops", "Supply chain", "Finance", "HR", "Legal"] },
  { key: "creative", label: "Creative", match: ["Design", "Marketing"] },
  { key: "engineering", label: "Engineering", match: ["QA", "R&D", "Cybersecurity", "Data"] },
];

/** Internal agent, from scratch or from a template — or a public one, the
 *  customer-facing kind that answers from a knowledge base (0195). */
type CreateMode = "custom" | "templates" | "public";

export function CreateAgentPage({ dashboardId, workspaceId, projectId }: {
  dashboardId: string; workspaceId: string; projectId: string;
}) {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  // ?type=public lands straight on the public form — that's how the roster's
  // "Agent public" entry gets here.
  const [mode, setMode] = useState<CreateMode>(params.get("type") === "public" ? "public" : "custom");

  const MODES: { key: CreateMode; label: string; icon?: typeof SquaresFourIcon }[] = [
    { key: "custom", label: "Build Your Own" },
    { key: "templates", label: "Templates", icon: SquaresFourIcon },
    { key: "public", label: "Agent public", icon: GlobeIcon },
  ];

  return (
    <div className="min-h-full px-10 py-6">
      {/* Breadcrumb + the Build/Templates/Public switch, as in the mockup. */}
      <div className="relative flex items-center">
        <nav className="flex items-center gap-2 text-sm">
          <button onClick={() => navigate(`${base}/agents`)} className="text-muted-foreground transition-colors hover:text-foreground">Agents</button>
          <span className="text-muted-foreground">›</span>
          <span className="font-medium">Create Agent</span>
        </nav>
        <div className="absolute left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 p-1">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={cn("flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                  mode === m.key ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {m.icon && <m.icon className="h-3.5 w-3.5" />} {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === "custom" && <BuildYourOwn dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base} />}
      {mode === "templates" && <TemplateGallery dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base} />}
      {mode === "public" && <BuildPublicAgent dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base} />}
    </div>
  );
}

// ── Public agent ─────────────────────────────────────────────────────────────
// Customer-facing agents are picked from the same catalogue cards as the
// internal ones, then configured before creation — because several templates
// need something only the merchant can supply (their shop domain) and grant a
// live MCP server, which is not a decision to make blind.
function BuildPublicAgent({ dashboardId, workspaceId, projectId, base }: {
  dashboardId: string; workspaceId: string; projectId: string; base: string;
}) {
  const [configuring, setConfiguring] = useState<PublicAgentPreset | null>(null);

  return (
    <div className="mx-auto mt-8 max-w-6xl">
      <div className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">Nouvel agent public</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Il répond à vos clients depuis sa base de connaissances et s'intègre en widget sur votre
          site. Les modèles marqués « MCP » vont plus loin : ils interrogent votre boutique en
          direct, catalogue et stock compris.
        </p>
      </div>

      <PublicTemplateConfig
        preset={configuring}
        onClose={() => setConfiguring(null)}
        dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} base={base}
      />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {PUBLIC_AGENT_PRESETS.map((t) => (
          <CatalogCard
            key={t.key}
            onClick={() => setConfiguring(t)}
            glyph={<Icon3D icon={t.icon3d} px={72} />}
            name={t.label}
            // Wrench = granted tools, bolt = live servers. A knowledge-only
            // template shows the em dash rather than a misleading zero.
            tools={t.mcp ? (t.mcp.allowedTools.length || null) : null}
            extras={t.mcp ? 1 : null}
            badges={[
              { label: t.category, tone: "auth" as const, title: "Catégorie" },
              ...(t.mcp ? [{ label: "MCP", tone: "key" as const, title: "Se connecte à un serveur MCP" }] : []),
            ]}
            meta={t.seed.onboarding_enabled ? "guidé" : undefined}
            overlay={
              <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-zinc-900">
                <SlidersIcon className="h-3.5 w-3.5" /> Configurer
              </span>
            }
          />
        ))}
      </div>
    </div>
  );
}

/** Turn a shop domain into the Storefront MCP endpoint. */
function shopifyMcpUrl(domain: string): string {
  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return "https://" + host + "/api/mcp";
}

/**
 * Configure-then-create panel for a public template. Creating first and asking
 * afterwards would leave a half-provisioned agent behind every time the store
 * turns out to be unreachable.
 */
function PublicTemplateConfig({ preset, onClose, dashboardId, workspaceId, projectId, base }: {
  preset: PublicAgentPreset | null;
  onClose: () => void;
  dashboardId: string; workspaceId: string; projectId: string; base: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever a different card is opened.
  const activeKey = preset?.key ?? "";
  const [seenKey, setSeenKey] = useState("");
  if (activeKey !== seenKey) {
    setSeenKey(activeKey);
    setName(preset?.defaultName ?? "");
    setEndpoint("");
    setError(null);
    setStep(null);
  }

  if (!preset) return null;
  const mcp = preset.mcp;
  const resolvedUrl = !mcp
    ? ""
    : mcp.kind === "shopify"
      ? (endpoint.trim() ? shopifyMcpUrl(endpoint) : "")
      : endpoint.trim();

  async function create() {
    if (!preset || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      // 1. Validate the MCP endpoint BEFORE creating anything, so a typo in the
      //    shop domain doesn't leave a dangling agent behind.
      let serverId: string | null = null;
      if (mcp) {
        if (!resolvedUrl || !/^https?:\/\//i.test(resolvedUrl)) {
          throw new Error("Renseignez un endpoint MCP valide (http/https).");
        }
        setStep("Test du serveur MCP…");
        const test = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", {
          action: "test", url: resolvedUrl, headers: {}, transport: "http",
        });
        if (!test.ok) throw new Error(test.error || "Le serveur MCP n'a pas répondu.");

        setStep("Enregistrement du serveur…");
        const host = endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

        // Reuse the workspace's existing server for this endpoint. mcp_servers
        // is unique on (workspace_id, name), so a second agent pointed at the
        // same shop would otherwise collide and fail outright — and one row per
        // store is what we want anyway: rediscovering its tools once updates
        // every agent attached to it.
        const { data: existing } = await supabase
          .from("mcp_servers").select("id")
          .eq("workspace_id", workspaceId).eq("url", resolvedUrl).limit(1);

        if (existing && existing.length > 0) {
          serverId = existing[0].id;
        } else {
          const { data: srv, error: srvErr } = await supabase
            .from("mcp_servers")
            .insert({
              workspace_id: workspaceId,
              name: mcp.name.replace("{domain}", host),
              url: resolvedUrl, headers: {}, transport: "http", auth_mode: "none",
            })
            .select("id").single();
          if (srvErr) throw new Error(srvErr.message);
          serverId = srv.id;
        }
        // Cache the tool list so rag-chat never re-handshakes per message.
        await callEdge("mcp-gateway", { action: "discover", server_id: serverId }).catch(() => {});
      }

      setStep("Création de l'agent…");
      const { seed } = preset;
      const { data, error: err } = await supabase
        .from("rag_agents")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          service_dashboard_id: dashboardId,
          created_by: user?.id ?? null,
          name: name.trim(),
          description: seed.description || null,
          persona: seed.persona || null,
          instructions: seed.instructions || null,
          welcome_message: seed.welcome_message,
          onboarding_enabled: seed.onboarding_enabled,
          widget_config: seed.widget_config,
          accent_color: preset.accent,
          tool_use_enabled: seed.tool_use_enabled,
          max_tool_calls: seed.max_tool_calls,
        })
        .select("id").single();
      if (err) throw new Error(err.message);

      // 2. Attach the server with the template's grant. The runtime intersects
      //    it with the tools actually discovered, so a stale name is inert
      //    rather than broken.
      if (serverId && data) {
        setStep("Attribution des outils…");
        const { error: attErr } = await supabase.from("rag_agent_mcp_servers").insert({
          agent_id: data.id, server_id: serverId, allowed_tools: mcp?.allowedTools ?? [],
        });
        if (attErr) throw new Error(attErr.message);
      }

      queryClient.invalidateQueries({ queryKey: ["sd_public_agents", dashboardId] });
      queryClient.invalidateQueries({ queryKey: ["sd_panel_public_agents", dashboardId] });
      queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
      // An MCP template lands on its E-commerce tab (its tools are the point);
      // a knowledge-only one lands on Knowledge, where it has to be fed first.
      if (data) navigate(base + "/public/" + data.id + "?t=" + (mcp ? "ecommerce" : "knowledge"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <Icon3D icon={preset.icon3d} px={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{preset.label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{preset.tagline}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <SoftField label="Nom de l'agent">
            <SoftInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={preset.defaultName}
            />
          </SoftField>

          {mcp && (
            <>
              <SoftField label={mcp.domainLabel ?? "Endpoint MCP"}>
                <SoftInput
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={mcp.domainPlaceholder}
                />
              </SoftField>
              {resolvedUrl && <p className="font-mono text-xs text-muted-foreground">→ {resolvedUrl}</p>}

              <div className="rounded-xl bg-muted/50 p-3.5">
                <div className="text-xs font-medium">Outils accordés à la création</div>
                {mcp.allowedTools.length === 0 ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Aucun : les outils de ce serveur sont découverts à la connexion, vous les
                    cocherez ensuite dans l'onglet E-commerce.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {mcp.allowedTools.map((t) => (
                      <span key={t} className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[11px]">{t}</span>
                    ))}
                  </div>
                )}
                {mcp.note && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{mcp.note}</p>}
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            {step && <span className="mr-auto text-xs text-muted-foreground">{step}</span>}
            <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
            <Button onClick={create} disabled={busy || !name.trim() || (!!mcp && !resolvedUrl)}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlusIcon className="mr-1.5 h-4 w-4" />}
              Créer l'agent
            </Button>
          </div>
        </div>
      </div>
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
  const [soul, setSoul] = useState("");
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
      if (insErr) throw new Error(await diagnoseAgentInsertError(insErr, workspaceId));
      const agentId = (data as { id: string }).id;

      // L'âme part dans un update séparé, pas dans l'insert : la colonne date de
      // 0210, et un cache PostgREST en retard ferait échouer toute la création
      // au lieu de coûter un caractère à réécrire.
      if (soul.trim()) {
        const { error: soulErr } = await supabase.from("internal_agents")
          .update({ soul: soul.trim() }).eq("id", agentId);
        if (soulErr) console.warn("Âme non enregistrée:", soulErr.message);
      }

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

      {/* Les deux fichiers qu'on écrit à la main. Le troisième — les préférences
          — n'est pas ici : il se remplit tout seul, à mesure que l'agent
          travaille avec vous. Le pré-remplir reviendrait à inventer des
          habitudes que personne n'a exprimées. */}
      <div className="mt-6">
        <label className="mb-2 block text-sm text-muted-foreground">Instructions</label>
        <Textarea
          rows={11} value={instructions} onChange={(e) => setInstructions(e.target.value)}
          placeholder="Que fait cet agent ? Sa procédure de travail, étape par étape, et ses règles absolues."
          className="resize-none rounded-2xl bg-background/60 text-sm"
        />
      </div>

      <div className="mt-6">
        <label className="mb-2 block text-sm text-muted-foreground">Âme</label>
        <Textarea
          rows={5} value={soul} onChange={(e) => setSoul(e.target.value)}
          placeholder="Qui il est : sa voix, ce à quoi il tient, ce qu'il refuse même quand on insiste. Trois lignes suffisent — c'est du caractère, pas une procédure."
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
              glyph={<Icon3D icon={t.icon3d} px={72} />}
              name={t.name}
              tools={t.tools.length}
              extras={t.skillSlugs?.length ?? 0}
              badges={[
                { label: t.category, tone: "auth", title: "Catégorie" },
                { label: t.sandboxMode ?? "cloud", tone: "key", title: "Environnement d'exécution" },
              ]}
              shield={t.autonomy !== "autopilot"}
              meta={`${t.max_steps} pas`}
              tools_needed={resolveNeeds(toolSlugsFromTemplate(t), toolkits, connStatus)}
              overlay={
                <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-zinc-900">
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
