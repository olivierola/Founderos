import { SupportTab, type SupportSubtab } from "./support/SupportTab";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon as Check,
  CircleNotchIcon as Loader2,
  StorefrontIcon as Store,
  ArrowsClockwiseIcon as RefreshCw,
  PackageIcon as Package,
  PlugIcon as Plug,
  ShieldCheckIcon,
  SpeakerHighIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  SoftField, SoftInput, SoftSelect, SoftToggle, SoftRange, SoftCheckbox,
} from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import { GoalsStudioPage } from "@/features/agent-rag/onboarding/GoalsStudio";
import { ActivationCockpitPage } from "@/features/agent-rag/onboarding/ActivationCockpit";
import { AgentAnalytics, type Page as AnalyticsPage } from "@/features/agent-rag/analytics/AgentAnalytics";
import { WidgetStudio, type StudioTab } from "@/features/agent-rag/widget/WidgetStudio";
import { PublicAgentHome } from "./PublicAgentHome";
import { PlaygroundTab } from "./Playground";
import { KnowledgeTab } from "./Knowledge";
import { PublicSettingsTab } from "./Settings";
import { PaCard, PaNotice, PaPage, PaSegmented, PaStatus, PaHeader } from "./ui";

// This file used to BE a page (/agent/builder/:id/:tab) with its own sidebar.
// A public agent now lives in the service dashboard that owns it, exactly like
// an internal one: what is left here is the dispatch of its tabs, and the
// E-commerce and Onboarding bodies. The chrome around them belongs to the
// dashboard (PublicAgentInDashboard); the other tabs have their own files.
export type PublicAgentTab = "home" | "knowledge" | "playground" | "widget" | "analytics" | "support" | "onboarding" | "ecommerce" | "settings";

export interface Agent {
  id: string; project_id: string; name: string; description: string | null; persona: string | null;
  instructions: string | null; model: string; temperature: number;
  welcome_message: string | null; widget_config: any; public_key: string;
  enabled: boolean; onboarding_enabled: boolean; onboarding_copilot_enabled: boolean;
  onboarding_voice_enabled: boolean; onboarding_voice_model: string | null; accent_color: string | null;
  // Tool use via MCP (0201) — see the E-commerce tab.
  tool_use_enabled: boolean; max_tool_calls: number; storefront_url: string | null;
}

// Onboarding is a conditional tab — only surfaced when the agent has the
// onboarding feature toggled on (see the Settings tab). The base builder is
// otherwise identical for every public agent.
export const VALID_PUBLIC_AGENT_TABS: PublicAgentTab[] = ["home", "knowledge", "playground", "widget", "analytics", "support", "onboarding", "ecommerce", "settings"];

/** The tab bodies, dispatched by slug. Fetching the agent and drawing BOTH tab
 *  bars is the host's job — `sub` is the sub-tab it has resolved (see
 *  publicAgentSubtabs.ts), so no tab draws a navigation of its own. `onOpen`
 *  lets a tab send the user to another one (the overview's shortcuts). */
export function PublicAgentTabBody({ agent, tab, sub, workspaceId, projectId, onOpen }: {
  agent: Agent; tab: PublicAgentTab; sub?: string | null;
  workspaceId: string | null; projectId: string | null;
  onOpen?: (tab: PublicAgentTab, sub?: string) => void;
}) {
  // The onboarding tab only exists while the feature is on — a stale/direct
  // link falls back to the overview.
  const effectiveTab: PublicAgentTab = tab === "onboarding" && !agent.onboarding_enabled ? "home" : tab;
  const open = onOpen ?? (() => {});

  return (
    <div>
      {effectiveTab === "home" && <PublicAgentHome agent={agent} onOpen={open} />}
      {effectiveTab === "knowledge" && <KnowledgeTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {effectiveTab === "playground" && <PlaygroundTab agent={agent} workspaceId={workspaceId} projectId={projectId} onOpen={open} />}
      {effectiveTab === "widget" && <WidgetStudio agent={agent} tab={(sub ?? "modele") as StudioTab} />}
      {effectiveTab === "analytics" && <PublicAnalyticsTab agent={agent} page={(sub ?? "performance") as AnalyticsPage} />}
      {effectiveTab === "support" && <SupportTab agent={agent} sub={(sub ?? "queue") as SupportSubtab} />}
      {effectiveTab === "onboarding" && <OnboardingTab agent={agent} sub={(sub ?? "goals") as OnbSubtab} />}
      {effectiveTab === "ecommerce" && (
        <EcommerceTab agent={agent} sub={(sub ?? "servers") as EcomSubtab} workspaceId={workspaceId} projectId={projectId} />
      )}
      {effectiveTab === "settings" && <PublicSettingsTab agent={agent} />}
    </div>
  );
}

// --- Analytics ----------------------------------------------------------
// Les cinq pages de stats vivent dans features/agent-rag/analytics/ : ce
// fichier ne fait plus que les monter. Elles lisent la RPC d'agrégation
// `rag_agent_analytics` (migration 0217) au lieu de recompter des milliers de
// lignes dans le navigateur.
function PublicAnalyticsTab({ agent, page }: { agent: Agent; page: AnalyticsPage }) {
  return <AgentAnalytics agentId={agent.id} agentName={agent.name} page={page} />;
}

// --- Settings -----------------------------------------------------------
// --- Onboarding (conditional tab) ---------------------------------------
// Only mounted when `agent.onboarding_enabled` is on. Groups the onboarding
// agent's controls: natural-language objectives, agent-level réglages
// (co-pilot / voice / voice model + per-goal guardrails) and activation
// analytics — all scoped to THIS agent.
// Les sous-onglets sont dessinés par la coque (publicAgentSubtabs.ts).
type OnbSubtab = "goals" | "settings" | "activation";

// Deepgram Aura voices offered for the spoken onboarding guide.
const AURA_VOICES = [
  { value: "aura-asteria-en", label: "Asteria (f · en)" },
  { value: "aura-luna-en", label: "Luna (f · en)" },
  { value: "aura-stella-en", label: "Stella (f · en)" },
  { value: "aura-athena-en", label: "Athena (f · en)" },
  { value: "aura-hera-en", label: "Hera (f · en)" },
  { value: "aura-orion-en", label: "Orion (m · en)" },
  { value: "aura-arcas-en", label: "Arcas (m · en)" },
  { value: "aura-perseus-en", label: "Perseus (m · en)" },
  { value: "aura-angus-en", label: "Angus (m · en)" },
  { value: "aura-zeus-en", label: "Zeus (m · en)" },
];

function OnboardingTab({ agent, sub }: { agent: Agent; sub: OnbSubtab }) {
  return (
    <div>
      {sub === "goals" && <GoalsStudioPage agentId={agent.id} />}
      {sub === "settings" && <OnboardingSettings agent={agent} />}
      {sub === "activation" && <ActivationCockpitPage agentId={agent.id} />}
    </div>
  );
}

function OnboardingSettings({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();

  // Agent-level onboarding switches.
  const [copilot, setCopilot] = useState(agent.onboarding_copilot_enabled);
  const [voice, setVoice] = useState(agent.onboarding_voice_enabled);
  const [voiceModel, setVoiceModel] = useState(agent.onboarding_voice_model ?? "aura-asteria-en");
  const [savingAgent, setSavingAgent] = useState(false);
  const [savedAgent, setSavedAgent] = useState(false);

  async function saveAgent() {
    setSavingAgent(true); setSavedAgent(false);
    try {
      await supabase.from("rag_agents").update({
        onboarding_copilot_enabled: copilot,
        onboarding_voice_enabled: voice,
        onboarding_voice_model: voiceModel,
        updated_at: new Date().toISOString(),
      }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      // Keep the inline toggles in GoalDetailView in sync.
      queryClient.invalidateQueries({ queryKey: ["onb_agent_voice", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["onb_agent_copilot", agent.id] });
      setSavedAgent(true); setTimeout(() => setSavedAgent(false), 1500);
    } finally { setSavingAgent(false); }
  }

  // Guardrails live on a goal's `constraints` (the co-pilot brief reads them).
  const { data: goals } = useQuery({
    queryKey: ["onb_settings_goals", agent.id],
    enabled: !!agent.id,
    queryFn: async () => {
      const { data } = await supabase.from("onboarding_goals")
        .select("id, name, constraints")
        .eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as { id: string; name: string; constraints: Record<string, unknown> }[];
    },
  });

  const [goalId, setGoalId] = useState<string>("");
  const activeGoal = (goals ?? []).find((g) => g.id === goalId) ?? (goals ?? [])[0];
  useEffect(() => {
    if (!goalId && goals && goals.length > 0) setGoalId(goals[0]!.id);
  }, [goals, goalId]);

  const [tone, setTone] = useState("");
  const [noBlock, setNoBlock] = useState(false);
  const [locale, setLocale] = useState("");
  const [maxNudges, setMaxNudges] = useState<number | "">("");
  const [savingGuard, setSavingGuard] = useState(false);
  const [savedGuard, setSavedGuard] = useState(false);

  // Load the selected goal's constraints into the form.
  useEffect(() => {
    const c = (activeGoal?.constraints ?? {}) as Record<string, any>;
    setTone(typeof c.tone === "string" ? c.tone : "");
    setNoBlock(!!c.no_block);
    setLocale(typeof c.locale === "string" ? c.locale : "");
    setMaxNudges(typeof c.max_nudges_per_session === "number" ? c.max_nudges_per_session : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGoal?.id]);

  async function saveGuardrails() {
    if (!activeGoal) return;
    setSavingGuard(true); setSavedGuard(false);
    try {
      const prev = (activeGoal.constraints ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...prev, no_block: noBlock };
      if (tone.trim()) next.tone = tone.trim(); else delete next.tone;
      if (locale.trim()) next.locale = locale.trim(); else delete next.locale;
      if (maxNudges === "") delete next.max_nudges_per_session; else next.max_nudges_per_session = Number(maxNudges);
      await supabase.from("onboarding_goals").update({ constraints: next }).eq("id", activeGoal.id);
      queryClient.invalidateQueries({ queryKey: ["onb_settings_goals", agent.id] });
      setSavedGuard(true); setTimeout(() => setSavedGuard(false), 1500);
    } finally { setSavingGuard(false); }
  }

  const saveBtn = (busy: boolean, ok: boolean, onClick: () => void) => (
    <Button onClick={onClick} disabled={busy} className="rounded-full">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {ok ? "Enregistré" : "Enregistrer"}
    </Button>
  );

  return (
    <PaPage width="narrow">
      <PaHeader title="Réglages de l'onboarding" sub="Le guide et ses garde-fous" />

      <PaCard title="Guide" icon={SpeakerHighIcon} bodyClassName="space-y-3 pt-4">
        <SoftToggle label="Co-pilote agentique" checked={copilot} onChange={setCopilot} />
        <SoftToggle label="Guide parlé" checked={voice} onChange={setVoice} />
        <SoftField label="Voix de synthèse" className={cn(!voice && "opacity-50")}>
          <SoftSelect
            value={voiceModel}
            onChange={setVoiceModel}
            disabled={!voice}
            options={AURA_VOICES.map((v) => ({ value: v.value, label: v.label }))}
          />
        </SoftField>
        <div className="pt-1">{saveBtn(savingAgent, savedAgent, () => void saveAgent())}</div>
      </PaCard>

      <PaCard
        title="Garde-fous"
        sub={activeGoal ? `Objectif : ${activeGoal.name}` : "Aucun objectif"}
        icon={ShieldCheckIcon}
        actions={(goals ?? []).length > 1 ? (
          <SoftSelect
            className="max-w-[14rem]"
            align="end"
            value={goalId}
            onChange={setGoalId}
            options={(goals ?? []).map((g) => ({ value: g.id, label: g.name }))}
          />
        ) : undefined}
        bodyClassName="space-y-3 pt-4"
      >
        {!activeGoal ? (
          <p className="text-[13px] text-muted-foreground">Créez un objectif pour définir ses garde-fous.</p>
        ) : (
          <>
            <SoftField label="Ton">
              <SoftInput value={tone} onChange={(e) => setTone(e.target.value)} placeholder="chaleureux, concis…" />
            </SoftField>
            <SoftToggle label="Ne pas bloquer l'écran" checked={noBlock} onChange={setNoBlock} />
            <div className="grid grid-cols-2 gap-4">
              <SoftField label="Locale">
                <SoftInput value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="fr-FR" />
              </SoftField>
              <SoftField label="Relances max / session">
                <SoftInput type="number" min={0} value={maxNudges} onChange={(e) => setMaxNudges(e.target.value === "" ? "" : Number(e.target.value))} placeholder="3" />
              </SoftField>
            </div>
            <div className="pt-1">{saveBtn(savingGuard, savedGuard, () => void saveGuardrails())}</div>
          </>
        )}
      </PaCard>
    </PaPage>
  );
}

// --- E-commerce (MCP-backed) --------------------------------------------
// A public agent reaches a catalogue — and gets ACTIONS — through MCP servers,
// not a bespoke REST integration per platform. Shopify's Storefront MCP is the
// reference case: one unauthenticated endpoint per store
// (https://{shop}/api/mcp) exposing catalogue search and cart operations.
//
// The workspace MCP registry (mcp_servers) is shared with the internal agents;
// what this tab owns is the attach side (rag_agent_mcp_servers) and, above all,
// the per-tool allowlist — a public agent is driven by anonymous traffic, so
// "the server exposes it" is not the same as "the collaborateur may call it".
const MCP_STORE_PRESETS = [
  {
    key: "shopify",
    label: "Shopify, Storefront MCP",
    /** Per-store endpoint; only the shop domain varies. */
    url: (domain: string) => `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/mcp`,
    domainPlaceholder: "ma-boutique.myshopify.com",
    auth: "none" as const,
    help: "Endpoint public de votre boutique, aucune clé à fournir. Il expose la recherche catalogue et les opérations de panier.",
  },
  {
    key: "custom",
    label: "Autre serveur MCP",
    url: (raw: string) => raw.trim(),
    domainPlaceholder: "https://mon-serveur/mcp",
    auth: "header" as const,
    help: "Collez l'URL complète du serveur MCP (Streamable HTTP ou SSE). Ajoutez un en-tête d'authentification si le serveur en exige un.",
  },
];

interface McpServerRow {
  id: string; name: string; url: string; enabled: boolean;
  status: string | null; last_error: string | null;
  cached_tools: { name: string; description?: string }[] | null;
}
interface AttachRow { server_id: string; allowed_tools: string[] }

/** The tables and columns this tab writes to arrive with migration 0201. Until
 *  it is applied every toggle fails, and Postgres says so precisely, surfacing
 *  that beats a switch that silently refuses to move. */
function schemaMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === "42703" || e.code === "PGRST205" || e.code === "42P01"
    || /does not exist|schema cache/i.test(e.message ?? "");
}
function writeError(err: unknown): string {
  if (schemaMissing(err)) {
    return "La migration 0201 n'est pas encore appliquée sur cette base, lancez `supabase db push`, puis rechargez la page.";
  }
  const e = err as { message?: string } | null;
  return e?.message || "Échec de l'enregistrement.";
}

/** Compact switch for a list row, where a full-width SoftToggle would render as
 *  a large empty block (its label carries the width). */
function MiniSwitch({ checked, onChange, title }: {
  checked: boolean; onChange: (v: boolean) => void; title?: string;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border hover:bg-muted-foreground/30",
      )}
    >
      <span className={cn(
        "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
        checked && "translate-x-4",
      )} />
    </button>
  );
}

// Les sous-onglets sont dessinés par la coque (publicAgentSubtabs.ts).
type EcomSubtab = "servers" | "tools" | "activity";

function EcommerceTab({ agent, sub, workspaceId }: {
  agent: Agent; sub: EcomSubtab; workspaceId: string | null; projectId: string | null;
}) {

  const { data: servers, refetch: refetchServers } = useQuery({
    queryKey: ["pa_mcp_servers", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("mcp_servers").select("id, name, url, enabled, status, last_error, cached_tools")
        .eq("workspace_id", workspaceId!).order("created_at");
      return (data ?? []) as McpServerRow[];
    },
  });

  const { data: attached, refetch: refetchAttached, error: attachError } = useQuery({
    queryKey: ["pa_mcp_attached", agent.id],
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rag_agent_mcp_servers").select("server_id, allowed_tools").eq("agent_id", agent.id);
      if (error) throw error;
      return (data ?? []) as AttachRow[];
    },
  });

  const refetchAll = () => { refetchServers(); refetchAttached(); };

  // Without the migration nothing on this tab can save. Say so once, at the top,
  // instead of letting three sets of controls fail quietly.
  const needsMigration = schemaMissing(attachError);

  // Attaching a server is only two thirds of the job: tool use must be on AND at
  // least one tool ticked. Miss either and the agent silently stays a plain RAG
  // answerer — it will say "je n'ai pas d'information sur les produits" with
  // full confidence, which reads like a bug rather than a missing switch.
  const grantedCount = (attached ?? []).reduce((n, a) => n + (a.allowed_tools?.length ?? 0), 0);
  const inertReason = !needsMigration && (attached ?? []).length > 0
    ? (!agent.tool_use_enabled
        ? "« Autoriser ce collaborateur à appeler des outils » est désactivé (onglet Boutique)."
        : grantedCount === 0
          ? "Aucun outil n'est coché (onglet Outils), une liste vide n'autorise rien."
          : null)
    : null;

  const titles: Record<EcomSubtab, { title: string; sub: string }> = {
    servers: { title: "Boutique", sub: "Les serveurs MCP qui donnent un catalogue et des actions à l'agent" },
    tools: { title: "Outils autorisés", sub: "Rien n'est permis par défaut" },
    activity: { title: "Activité", sub: "Les 50 derniers appels d'outils" },
  };

  return (
    <PaPage width="narrow">
      <PaHeader title={titles[sub].title} sub={titles[sub].sub} />
      {needsMigration && (
        <PaNotice tone="warn" title="Schéma manquant">
          Les tables de cet onglet n'existent pas encore sur cette base. Appliquez la migration{" "}
          <code className="font-mono">0201_public_agent_mcp.sql</code>, puis rechargez la page.
        </PaNotice>
      )}
      {inertReason && (
        <PaNotice tone="warn" title="Serveur connecté, mais l'agent n'appellera aucun outil">
          {inertReason} En attendant, il répond seulement depuis sa base de connaissances.
        </PaNotice>
      )}
      {sub === "servers" && (
        <McpStoreServers
          agent={agent} workspaceId={workspaceId}
          servers={servers ?? []} attached={attached ?? []} onChanged={refetchAll}
        />
      )}
      {sub === "tools" && (
        <McpToolGrants
          agent={agent} servers={servers ?? []} attached={attached ?? []} onChanged={refetchAll}
        />
      )}
      {sub === "activity" && <McpToolActivity agent={agent} />}
    </PaPage>
  );
}

function McpStoreServers({ agent, workspaceId, servers, attached, onChanged }: {
  agent: Agent; workspaceId: string | null;
  servers: McpServerRow[]; attached: AttachRow[]; onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [presetKey, setPresetKey] = useState("shopify");
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const preset = MCP_STORE_PRESETS.find((p) => p.key === presetKey)!;
  const attachedIds = new Set(attached.map((a) => a.server_id));

  // Create the server in the workspace registry, discover its tools, attach it.
  async function connect() {
    if (!workspaceId || !input.trim()) return;
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const url = preset.url(input);
      if (!/^https?:\/\//i.test(url)) throw new Error("L'URL doit être absolue (http/https).");

      const headers = presetKey === "custom" && authHeader.trim()
        ? { Authorization: authHeader.trim() }
        : {};

      // Validate before persisting — an unreachable endpoint should not leave a
      // broken server sitting in the registry.
      const test = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", {
        action: "test", url, headers, transport: "http",
      });
      if (!test.ok) throw new Error(test.error || "Le serveur MCP n'a pas répondu.");

      const { data: created, error: insErr } = await supabase
        .from("mcp_servers")
        .insert({
          workspace_id: workspaceId,
          name: name.trim() || defaultName(presetKey, input),
          url, headers, transport: "http",
          auth_mode: Object.keys(headers).length ? "header" : preset.auth,
        })
        .select("id").single();
      if (insErr) throw new Error(insErr.message);

      // Cache the tool list on the row so rag-chat doesn't re-handshake per message.
      await callEdge("mcp-gateway", { action: "discover", server_id: created.id }).catch(() => {});
      const { error: attErr } = await supabase.from("rag_agent_mcp_servers")
        .upsert({ agent_id: agent.id, server_id: created.id, allowed_tools: [] }, { onConflict: "agent_id,server_id" });
      // The server is registered either way; failing to attach it is what would
      // otherwise leave a server visible in the list that nothing can enable.
      if (attErr) throw attErr;

      setInput(""); setName(""); setAuthHeader("");
      setOkMsg(`${test.count ?? 0} outil(s) détecté(s). Choisissez ceux que le collaborateur peut utiliser dans l'onglet Outils.`);
      onChanged();
    } catch (e) {
      setError(writeError(e));
    } finally { setBusy(false); }
  }

  async function toggleAttach(server: McpServerRow, on: boolean) {
    setError(null);
    const { error: err } = on
      ? await supabase.from("rag_agent_mcp_servers")
          .upsert({ agent_id: agent.id, server_id: server.id, allowed_tools: [] }, { onConflict: "agent_id,server_id" })
      : await supabase.from("rag_agent_mcp_servers")
          .delete().eq("agent_id", agent.id).eq("server_id", server.id);
    if (err) { setError(writeError(err)); return; }
    onChanged();
  }

  async function rediscover(server: McpServerRow) {
    setBusy(true);
    try { await callEdge("mcp-gateway", { action: "discover", server_id: server.id }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); onChanged(); }
  }

  async function saveAgent(patch: Record<string, unknown>) {
    setError(null);
    const { error: err } = await supabase.from("rag_agents").update(patch).eq("id", agent.id);
    if (err) { setError(writeError(err)); return; }
    queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
  }

  return (
    <div className="space-y-5">
      {error && <PaNotice tone="error">{error}</PaNotice>}

      <PaCard title="Connecter une boutique" icon={Plug} bodyClassName="space-y-4 pt-4">
        <PaSegmented
          value={presetKey}
          onChange={(v) => { setPresetKey(v); setInput(""); setError(null); setOkMsg(null); }}
          options={MCP_STORE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
        />
        <SoftField label={presetKey === "shopify" ? "Domaine de la boutique" : "URL du serveur MCP"}>
          <SoftInput value={input} placeholder={preset.domainPlaceholder} onChange={(e) => setInput(e.target.value)} />
        </SoftField>
        {presetKey === "shopify" && input.trim() && (
          <p className="font-mono text-[12px] text-muted-foreground">→ {preset.url(input)}</p>
        )}
        <SoftField label="Nom (facultatif)">
          <SoftInput value={name} placeholder={defaultName(presetKey, input)} onChange={(e) => setName(e.target.value)} />
        </SoftField>
        {presetKey === "custom" && (
          <SoftField label="En-tête d'authentification (facultatif)">
            <SoftInput value={authHeader} placeholder="Bearer sk_…" autoComplete="off" onChange={(e) => setAuthHeader(e.target.value)} />
          </SoftField>
        )}
        <p className="text-[12px] leading-relaxed text-muted-foreground">{preset.help}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void connect()} disabled={busy || !input.trim()} className="rounded-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            Tester et connecter
          </Button>
          {okMsg && <span className="text-[13px] text-emerald-600 dark:text-emerald-400">{okMsg}</span>}
        </div>
      </PaCard>

      <PaCard
        title="Serveurs MCP de l'espace"
        sub="Partagés avec les collaborateurs internes ; l'interrupteur attache à cet agent seulement"
        icon={Store}
        bodyClassName="pt-3"
      >
        {servers.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">Aucun serveur enregistré pour le moment.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {servers.map((s) => {
              const on = attachedIds.has(s.id);
              const toolCount = (s.cached_tools ?? []).length;
              return (
                <li key={s.id} className="flex items-start gap-3.5 py-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
                    <Store className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{s.name}</span>
                      <PaStatus tone={s.status === "ok" ? "ok" : s.status === "error" ? "error" : "idle"}>
                        {s.status === "ok" ? `${toolCount} outil${toolCount > 1 ? "s" : ""}` : s.status === "error" ? "Erreur" : "Jamais testé"}
                      </PaStatus>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.url}</div>
                    {s.last_error && <div className="mt-1 line-clamp-2 text-[12px] text-red-600 dark:text-red-400">{s.last_error}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      title="Redécouvrir les outils"
                      onClick={() => void rediscover(s)} disabled={busy}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <MiniSwitch
                      checked={on} onChange={(v) => void toggleAttach(s, v)}
                      title={on ? "Détacher de cet agent" : "Attacher à cet agent"}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PaCard>

      <PaCard title="Utilisation des outils" icon={WrenchIcon} bodyClassName="space-y-4 pt-4">
        <SoftToggle
          label="Autoriser cet agent à appeler des outils"
          checked={agent.tool_use_enabled}
          onChange={(v) => void saveAgent({ tool_use_enabled: v })}
        />
        <SoftField label={`Appels d'outils max par message · ${agent.max_tool_calls ?? 4}`}>
          <SoftRange
            min={1} max={10} step={1}
            value={agent.max_tool_calls ?? 4}
            onChange={(e) => void saveAgent({ max_tool_calls: Number(e.target.value) })}
            className="mt-2.5"
          />
        </SoftField>
        <SoftField label="URL de la vitrine (si les liens produits pointent ailleurs)">
          <SoftInput
            placeholder="https://boutique.mondomaine.com"
            defaultValue={agent.storefront_url ?? ""}
            onBlur={(e) => void saveAgent({ storefront_url: e.target.value || null })}
          />
        </SoftField>
      </PaCard>
    </div>
  );
}

function defaultName(presetKey: string, input: string) {
  if (presetKey === "shopify") {
    const d = input.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return d ? `Shopify · ${d}` : "Shopify Storefront";
  }
  return "Serveur MCP";
}

function McpToolGrants({ agent, servers, attached, onChanged }: {
  agent: Agent; servers: McpServerRow[]; attached: AttachRow[]; onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const rows = attached
    .map((a) => ({ attach: a, server: byId.get(a.server_id) }))
    .filter((r): r is { attach: AttachRow; server: McpServerRow } => !!r.server);

  async function setAllowed(serverId: string, tools: string[]) {
    setError(null);
    const { error: err } = await supabase.from("rag_agent_mcp_servers")
      .update({ allowed_tools: tools }).eq("agent_id", agent.id).eq("server_id", serverId);
    if (err) { setError(writeError(err)); return; }
    onChanged();
  }

  if (rows.length === 0) {
    return (
      <PaCard>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Plug className="h-5 w-5" /></span>
          <div className="text-[14px] font-medium">Aucun serveur attaché</div>
          <p className="text-[13px] text-muted-foreground">Connectez une boutique dans l'onglet Boutique pour voir ses outils.</p>
        </div>
      </PaCard>
    );
  }

  return (
    <div className="space-y-5">
      {error && <PaNotice tone="error">{error}</PaNotice>}
      {rows.map(({ attach, server }) => {
        const tools = server.cached_tools ?? [];
        const allowed = new Set(attach.allowed_tools ?? []);
        return (
          <PaCard
            key={server.id}
            title={server.name}
            sub={`${allowed.size} autorisé${allowed.size > 1 ? "s" : ""} sur ${tools.length}`}
            icon={Store}
            actions={
              <div className="flex gap-1.5">
                <button
                  onClick={() => void setAllowed(server.id, tools.map((t) => t.name))}
                  className="rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Tout
                </button>
                <button
                  onClick={() => void setAllowed(server.id, [])}
                  className="rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Aucun
                </button>
              </div>
            }
            bodyClassName="pt-3"
          >
            {tools.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Aucun outil en cache, lancez une redécouverte depuis l'onglet Boutique.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {tools.map((t) => (
                  <li key={t.name} className="py-2.5">
                    <SoftCheckbox
                      checked={allowed.has(t.name)}
                      onChange={(on) => {
                        const next = new Set(allowed);
                        if (on) next.add(t.name); else next.delete(t.name);
                        void setAllowed(server.id, [...next]);
                      }}
                      label={<span className="font-mono text-[12px] font-medium">{t.name}</span>}
                      hint={t.description}
                    />
                  </li>
                ))}
              </ul>
            )}
          </PaCard>
        );
      })}
    </div>
  );
}

function McpToolActivity({ agent }: { agent: Agent }) {
  const { data: calls } = useQuery({
    queryKey: ["pa_tool_calls", agent.id],
    refetchInterval: 10000,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agent_tool_calls")
        .select("id, tool_name, args, ok, error, duration_ms, visitor_id, created_at")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(50);
      return (data ?? []) as {
        id: string; tool_name: string; args: Record<string, unknown>; ok: boolean;
        error: string | null; duration_ms: number | null; visitor_id: string | null; created_at: string;
      }[];
    },
  });

  if ((calls ?? []).length === 0) {
    return (
      <PaCard>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Package className="h-5 w-5" /></span>
          <div className="text-[14px] font-medium">Aucun appel d'outil</div>
          <p className="text-[13px] text-muted-foreground">Les appels faits pour vos visiteurs apparaîtront ici.</p>
        </div>
      </PaCard>
    );
  }

  return (
    <PaCard bodyClassName="pt-2">
      <ul className="divide-y divide-border/70">
        {(calls ?? []).map((c) => (
          <li key={c.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-medium">{c.tool_name}</span>
              <PaStatus tone={c.ok ? "ok" : "error"}>{c.ok ? "OK" : "Échec"}</PaStatus>
              {c.duration_ms != null && <span className="text-[12px] text-muted-foreground">{c.duration_ms} ms</span>}
              <span className="ml-auto text-[12px] text-muted-foreground">{formatRelative(c.created_at)}</span>
            </div>
            {c.error && <div className="mt-1 line-clamp-2 text-[12px] text-red-600 dark:text-red-400">{c.error}</div>}
            {c.args && Object.keys(c.args).length > 0 && (
              <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(c.args)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </PaCard>
  );
}
