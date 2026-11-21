import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon, CaretRightIcon, CircleNotchIcon as Loader2, PencilSimpleIcon, CpuIcon,
  FileTextIcon, PlugsConnectedIcon, FlowArrowIcon, ShieldCheckIcon,
  SlidersHorizontalIcon, ArrowSquareOutIcon, CheckIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { InternalAgent } from "@/features/internal-agents/shared";
import { agentModelValue, useAgentModelChoices } from "@/features/internal-agents/AgentHostedModel";
import { AgentModelRoutes } from "@/features/internal-agents/AgentModelRoutes";
import {
  SettingsTab,
} from "@/features/internal-agents/InternalAgentDetail";
import { InstructionsEditor } from "@/features/internal-agents/InstructionsEditor";
import { AgentAutomationsTab } from "@/features/internal-agents/AgentAutomationsTab";
import { AgentAvatarTab } from "@/features/internal-agents/AgentAvatarTab";
import { AgentPoolsPanel } from "@/features/resource-pools/AgentPoolsPanel";
import { AgentAutonomyTab } from "./AgentAutonomyTab";
import { AgentEventTriggers } from "./AgentEventTriggers";
import { AgentGoals } from "./AgentGoals";

// Les réglages d'un agent, dans le panneau de droite.
//
// La page de configuration reste la référence — tout y est, sur toute la
// largeur. Ici, on garde l'agent sous les yeux pendant qu'on lui parle : son
// identité et son modèle se règlent sur place, le reste s'ouvre en sous-vue
// dans le même panneau, avec un retour. On ne quitte jamais la conversation.

type View = "home" | "avatar" | "files" | "tools" | "automations" | "autonomy" | "advanced";

const VIEWS: Record<Exclude<View, "home">, { label: string; icon: PhosphorIcon }> = {
  avatar: { label: "Avatar", icon: PencilSimpleIcon },
  files: { label: "Instructions et fichiers", icon: FileTextIcon },
  tools: { label: "Ressources (pools)", icon: PlugsConnectedIcon },
  automations: { label: "Routines et déclencheurs", icon: FlowArrowIcon },
  autonomy: { label: "Autonomie", icon: ShieldCheckIcon },
  advanced: { label: "Réglages avancés", icon: SlidersHorizontalIcon },
};

export function AgentSettingsPanel({ agentId, dashboardId }: { agentId: string; dashboardId: string }) {
  const [view, setView] = useState<View>("home");
  // Changer d'agent revient à l'accueil : la sous-vue d'un autre agent n'a
  // pas de sens pour celui-ci.
  useEffect(() => { setView("home"); }, [agentId]);

  const { data: agent, isLoading } = useQuery({
    queryKey: ["sd_agent_full", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("*").eq("id", agentId).maybeSingle();
      return data as InternalAgent | null;
    },
  });

  if (isLoading || !agent) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (view !== "home") {
    const meta = VIEWS[view];
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-2">
          <button
            type="button" onClick={() => setView("home")}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Retour aux réglages"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <span className="truncate text-[13px] font-medium">{meta.label}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
          {view === "avatar" && <AgentAvatarTab agent={agent} />}
          {view === "files" && <InstructionsEditor agent={agent} />}
          {/* Tout ce que l'agent atteint vient de ses pools (0310). */}
          {view === "tools" && <AgentPoolsPanel agent={agent} dashboardId={dashboardId} />}
          {view === "automations" && (
            <div className="space-y-8">
              <AgentEventTriggers agent={agent} />
              <AgentGoals agent={agent} />
              <AgentAutomationsTab agent={agent} />
            </div>
          )}
          {view === "autonomy" && <AgentAutonomyTab agent={agent} />}
          {view === "advanced" && <SettingsTab agent={agent} embedded />}
        </div>
      </div>
    );
  }

  return <AgentSettingsHome agent={agent} dashboardId={dashboardId} onOpen={setView} />;
}

function AgentSettingsHome({ agent, dashboardId, onOpen }: {
  agent: InternalAgent; dashboardId: string; onOpen: (v: View) => void;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 1600);
    return () => clearTimeout(t);
  }, [saved]);

  /** Une écriture par champ, à la sortie du champ. Les trois clés lisent le
   *  même agent sous des noms différents (fiche, page de config, onglets). */
  async function patch(field: string, values: Record<string, unknown>) {
    const { error } = await supabase.from("internal_agents")
      .update({ ...values, updated_at: new Date().toISOString() }).eq("id", agent.id);
    if (error) return;
    setSaved(field);
    queryClient.invalidateQueries({ queryKey: ["sd_agent_full", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["sd_panel_agents", dashboardId] });
  }

  const { options: modelOptions, patchFor } = useAgentModelChoices(agent.project_id);
  const modelValue = agentModelValue(agent);

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 pb-10 pt-6">
        <div className="flex justify-center">
          <button
            type="button" onClick={() => onOpen("avatar")} title="Changer l'avatar"
            className="group relative rounded-2xl"
          >
            <AgentIdentity style={agent.avatar_style ?? "orb"} url={agent.avatar_url} seed={agent.name} size={64} rounded="rounded-2xl" />
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
              <PencilSimpleIcon className="h-3 w-3" />
            </span>
          </button>
        </div>

        <div className="mt-6 space-y-4">
          <InlineField
            label="Nom" value={agent.name} saved={saved === "name"}
            onCommit={(v) => v.trim() && v.trim() !== agent.name && patch("name", { name: v.trim() })}
          />
          <InlineField
            label="Titre" value={agent.role ?? ""} placeholder="Ce que fait votre agent, en quelques mots"
            saved={saved === "role"}
            onCommit={(v) => v.trim() !== (agent.role ?? "") && patch("role", { role: v.trim() || null })}
          />
          <InlineField
            label="Description" value={agent.description ?? ""} multiline
            placeholder="À quoi il sert, pour qui, et ce qu'on peut lui demander"
            saved={saved === "description"}
            onCommit={(v) => v !== (agent.description ?? "") && patch("description", { description: v })}
          />
        </div>

        <Group label="Cerveau">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <CpuIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-[13px] font-medium">Modèle</span>
            <div className="ml-auto min-w-0 max-w-[60%]">
              <Select value={modelValue} onValueChange={(v) => patch("model", patchFor(v))}>
                <SelectTrigger className="h-8 border-0 bg-transparent px-2 text-[12px] text-muted-foreground shadow-none hover:bg-muted focus:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {modelOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-[12.5px]">{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {saved === "model" && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
          </div>
        </Group>
        <AgentModelRoutes key={`${agent.id}:${agent.hosted_provider_id ?? ""}`} agent={agent} className="mt-3" />

        <Group label="Connaissances">
          <Row view="files" onOpen={onOpen} />
        </Group>

        <Group label="Actions">
          <Row view="tools" onOpen={onOpen} />
          <Row view="automations" onOpen={onOpen} />
          <Row view="autonomy" onOpen={onOpen} />
        </Group>

        <Group label="Plus">
          <Row view="advanced" onOpen={onOpen} hint="Mémoire, usage, accès" />
          <button
            type="button"
            onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}/agent-config/${agent.id}`)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
          >
            <ArrowSquareOutIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-[13px] font-medium">Ouvrir la page de configuration</span>
          </button>
        </Group>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-1.5 px-1 text-[12px] font-medium text-muted-foreground">{label}</h3>
      <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/60">
        {children}
      </div>
    </section>
  );
}

function Row({ view, onOpen, hint }: { view: Exclude<View, "home">; onOpen: (v: View) => void; hint?: string }) {
  const meta = VIEWS[view];
  return (
    <button
      type="button" onClick={() => onOpen(view)}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <meta.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{meta.label}</span>
      {hint && <span className="shrink-0 truncate text-[12px] text-muted-foreground">{hint}</span>}
      <CaretRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Un champ qui s'enregistre à la sortie, pas à la frappe : chaque lettre
 *  tapée ne doit pas devenir une écriture en base. ⏎ valide une ligne simple,
 *  Échap annule. */
function InlineField({ label, value, placeholder, multiline, saved, onCommit }: {
  label: string; value: string; placeholder?: string; multiline?: boolean; saved?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  // Échap annule : le blur qui suit ne doit rien écrire.
  const cancelled = useRef(false);
  const cls = "w-full rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-[13.5px] outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-border focus:border-primary/50 focus:bg-card";
  const onBlur = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    onCommit(draft);
  };
  const cancel = (el: HTMLElement) => { cancelled.current = true; setDraft(value); el.blur(); };

  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground">
        {label}
        {saved && <CheckIcon className="h-3 w-3 text-emerald-500" />}
      </span>
      {multiline ? (
        <textarea
          value={draft} rows={3} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onBlur}
          onKeyDown={(e) => { if (e.key === "Escape") cancel(e.currentTarget); }}
          className={cn(cls, "resize-y leading-relaxed")}
        />
      ) : (
        <input
          value={draft} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") cancel(e.currentTarget);
          }}
          className={cls}
        />
      )}
    </label>
  );
}
