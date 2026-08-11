// Agent configuration, as cards inside the assistant.
//
// Three areas, and only three: the SYSTEM PROMPT (what the agent is told to do),
// its CONNECTORS (what it can act on) and its SKILLS (how it works). Everything
// else an agent row carries — model, autonomy, identity, sandbox — has a working
// default and is not what a configuration conversation is for.
//
// Each card reads the same rows the runtime reads, so a green card means the
// agent really is ready. No card writes anything: the button hands that one step
// to the assistant, which finishes it with its tools.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ScrollText, PlugZap, Sparkles, ChevronDown, ArrowRight, Check,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { ConfigurableTool } from "@/features/internal-agents/toolSetup";

/** Ready · needs a decision · works without it but can be enriched. */
type StepStatus = "ready" | "todo" | "tune";

interface SetupStep {
  key: string;
  label: string;
  icon: LucideIcon;
  status: StepStatus;
  /** What the current state actually is, in one line. */
  detail: string;
  /** The brief handed to the assistant when the user clicks Configurer. */
  prompt: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  instructions: string | null;
  service_dashboard_id: string | null;
}

interface ConnectorRow {
  provider: string;
  status: string;
  scope: string | null;
}

/** Tool kinds that ARE a connector — the rest of the toolbox isn't shown here. */
const CONNECTOR_KINDS = ["connector_action", "composio_toolkit", "vault_connector"];

/** The provider slug a connector tool points at, if any. */
function connectorSlug(t: ConfigurableTool): string {
  const cfg = t.config ?? {};
  return String(cfg.provider ?? cfg.toolkit ?? "");
}

const STATUS_LABEL: Record<StepStatus, string> = {
  ready: "Prêt",
  todo: "À configurer",
  tune: "Optionnel",
};

const STATUS_CLASS: Record<StepStatus, string> = {
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  todo: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  tune: "border-border bg-muted/60 text-muted-foreground",
};

function useAgentSetupSteps(agentId: string) {
  const { data, isPending } = useQuery({
    queryKey: ["assistant_agent_setup", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const [agentRes, toolsRes, skillsRes] = await Promise.all([
        supabase
          .from("internal_agents")
          .select("id, name, role, instructions, service_dashboard_id, project_id")
          .eq("id", agentId)
          .maybeSingle(),
        supabase.from("internal_agent_tools").select("id, kind, name, config, enabled").eq("agent_id", agentId),
        supabase.from("agent_skill_activations").select("skill_id").eq("agent_id", agentId),
      ]);
      const agent = agentRes.data as (AgentRow & { project_id: string | null }) | null;

      // Connections the agent can actually use: its dashboard's, plus the
      // workspace-wide (project-scoped) ones. Personal connections are opt-in
      // per call, so they don't count as "the agent is connected".
      let connectors: ConnectorRow[] = [];
      if (agent?.project_id) {
        const { data } = await supabase
          .from("connectors")
          .select("provider, status, scope, service_dashboard_id")
          .eq("project_id", agent.project_id);
        connectors = ((data ?? []) as Array<ConnectorRow & { service_dashboard_id: string | null }>)
          .filter((c) => c.scope !== "personal"
            && (!c.service_dashboard_id || c.service_dashboard_id === agent.service_dashboard_id))
          .map(({ provider, status, scope }) => ({ provider, status, scope }));
      }

      return {
        agent,
        tools: (toolsRes.data ?? []) as ConfigurableTool[],
        skills: (skillsRes.data ?? []).length,
        connectors,
      };
    },
  });

  const steps = useMemo<SetupStep[]>(() => {
    if (!data?.agent) return [];
    const { agent, tools, skills, connectors } = data;
    const named = `« ${agent.name} » (agent_id: ${agent.id})`;
    const brief = (what: string) =>
      `Configurons ${what} de l'agent ${named}. Appelle get_agent_setup, montre-moi l'état actuel, puis propose-moi du concret une question à la fois et applique après mon accord.`;

    const instructions = (agent.instructions ?? "").trim();

    const connectorTools = tools.filter((t) => t.enabled !== false && CONNECTOR_KINDS.includes(t.kind));
    const live = new Set(connectors.filter((c) => c.status === "connected").map((c) => c.provider));
    const unset = connectorTools.filter((t) => !connectorSlug(t));
    const disconnected = connectorTools.filter((t) => connectorSlug(t) && !live.has(connectorSlug(t)));
    const working = connectorTools.filter((t) => live.has(connectorSlug(t)));

    const connectorDetail = connectorTools.length === 0
      ? "Aucun connecteur — l'agent n'agit dans aucun outil externe."
      : [
        working.length ? working.map((t) => connectorSlug(t)).join(", ") : null,
        unset.length ? `${unset.length} sans service choisi` : null,
        disconnected.length ? `${disconnected.length} non connecté${disconnected.length > 1 ? "s" : ""}` : null,
      ].filter(Boolean).join(" · ");

    return [
      {
        key: "instructions",
        label: "Prompt système",
        icon: ScrollText,
        status: instructions.length >= 80 ? "ready" : "todo",
        detail: instructions.length
          ? `${instructions.length} caractères d'instructions`
          : "Aucune instruction — l'agent improvise.",
        prompt: brief("le prompt système (instructions)"),
      },
      {
        key: "connectors",
        label: "Connecteurs",
        icon: PlugZap,
        status: connectorTools.length === 0 ? "tune" : (unset.length || disconnected.length) ? "todo" : "ready",
        detail: connectorDetail,
        prompt: connectorTools.length === 0
          ? `Configurons les connecteurs de l'agent ${named}. Appelle get_agent_setup pour voir les connexions réellement disponibles dans ce projet, et propose-moi celles qui ont du sens pour son rôle${agent.role ? ` (${agent.role})` : ""} — une question à la fois, puis rattache celles que je choisis.`
          : `Configurons les connecteurs de l'agent ${named}. À régler : ${[
            ...unset.map((t) => `${t.name} — aucun service choisi`),
            ...disconnected.map((t) => `${connectorSlug(t)} — non connecté dans ce projet`),
          ].join(" ; ") || "rien de bloquant, propose-moi ce qui manquerait pour son rôle"}. Appelle get_agent_setup pour les connexions réellement disponibles.`,
      },
      {
        key: "skills",
        label: "Skills",
        icon: Sparkles,
        status: skills > 0 ? "ready" : "tune",
        detail: skills > 0
          ? `${skills} skill${skills > 1 ? "s" : ""} active${skills > 1 ? "s" : ""}`
          : "Aucune skill — le catalogue peut lui donner des méthodes de travail.",
        prompt: `Configurons les skills de l'agent ${named}. Appelle get_agent_setup puis search_agent_skills avec des mots-clés tirés de son rôle, propose-moi 3 à 5 skills pertinentes avec ce qu'elles apportent, et active celles que je choisis.`,
      },
    ];
  }, [data]);

  return { steps, agentName: data?.agent?.name ?? null, isPending };
}

export function AgentSetupDeck({
  agentId, onConfigure, onDismiss, busy,
}: {
  agentId: string;
  onConfigure: (prompt: string) => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const { steps, agentName, isPending } = useAgentSetupSteps(agentId);
  const [open, setOpen] = useState(true);
  if (isPending || steps.length === 0) return null;

  const ready = steps.filter((s) => s.status === "ready").length;
  const blocking = steps.filter((s) => s.status === "todo").length;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-foreground">Configuration · {agentName}</span>
            <span className="block text-[11px] text-muted-foreground">
              {ready}/{steps.length} prêts{blocking ? ` · ${blocking} à configurer` : ""}
            </span>
          </span>
        </button>
        <button onClick={onDismiss} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">
          Masquer
        </button>
      </div>

      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {steps.map((s) => (
            <div key={s.key} className="rounded-lg border border-border bg-background/60 p-2.5">
              <div className="flex items-start gap-2">
                <span className={cn(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  s.status === "todo" ? "bg-amber-500/10 text-amber-500" : "bg-muted text-muted-foreground",
                )}>
                  <s.icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">{s.label}</span>
                    <span className={cn(
                      "shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                      STATUS_CLASS[s.status],
                    )}>
                      {s.status === "ready" && <Check className="mr-0.5 inline h-2.5 w-2.5" />}
                      {STATUS_LABEL[s.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{s.detail}</p>
                </div>
              </div>
              <button
                onClick={() => onConfigure(s.prompt)}
                disabled={busy}
                className="group mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-secondary disabled:opacity-50"
              >
                Configurer
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
