import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
  PlugIcon as Plug,
  WarningIcon as AlertTriangle,
  CalendarDotsIcon as CalendarClock,
  LightningIcon as Zap,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { ConnectorDialog } from "@/features/integrations/ConnectorDialog";
import { findProvider } from "@/lib/providers";
import { connectorActionProvider } from "./connectorActionProviders";
import { AGENT_AUTOMATIONS, automationsByCategory, nextRunAt, type AgentAutomation } from "./agentAutomations";
import type { InternalAgent } from "./shared";

interface AutomationRow {
  id: string;
  key: string;
  enabled: boolean;
  mission_id: string | null;
  config: { providers?: string[] } | null;
}
interface AgentTool { id: string; kind: string; config: Record<string, any> }

const SCHEDULE_LABEL: Record<string, string> = { daily: "Quotidien", weekly: "Hebdomadaire", monthly: "Mensuel" };

export function AgentAutomationsTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [connectSlug, setConnectSlug] = useState<string | null>(null);

  const { data: automations } = useQuery({
    queryKey: ["internal_agent_automations", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_automations")
        .select("id, key, enabled, mission_id, config")
        .eq("agent_id", agent.id);
      return (data ?? []) as AutomationRow[];
    },
  });
  const { data: connectors } = useQuery({
    queryKey: ["project_connectors_for_tools", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("provider, status").eq("project_id", agent.project_id);
      return (data ?? []) as Array<{ provider: string; status: string }>;
    },
  });
  const { data: tools } = useQuery({
    queryKey: ["internal_agent_tools", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_tools").select("id, kind, config").eq("agent_id", agent.id);
      return (data ?? []) as AgentTool[];
    },
  });

  const enabledByKey = new Map((automations ?? []).map((a) => [a.key, a]));
  const connectedSet = new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider));
  const grantedProviders = new Set(
    (tools ?? []).filter((t) => t.kind === "connector_action").map((t) => String(t.config?.provider ?? "")),
  );

  const missingProviders = (a: AgentAutomation) => a.providers.filter((p) => !connectedSet.has(p));

  async function enable(a: AgentAutomation) {
    if (!user || !agent.workspace_id || !agent.project_id) return;
    setBusy(a.key);
    try {
      // 1. Grant the connector-action tools the automation needs (idempotent).
      for (const slug of a.providers) {
        if (grantedProviders.has(slug)) continue;
        const p = connectorActionProvider(slug);
        await supabase.from("internal_agent_tools").insert({
          agent_id: agent.id,
          kind: "connector_action",
          name: p ? `Use ${p.name}` : `Use ${slug}`,
          description: p?.description ?? null,
          config: { provider: slug },
          requires_approval: false,
        });
      }
      // 2. Spawn the scheduled mission the agent scheduler will run.
      const { data: mission } = await supabase
        .from("internal_agent_missions")
        .insert({
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          title: a.missionTitle,
          brief: a.missionBrief,
          expected_deliverables: [],
          priority: "normal",
          tags: ["automation", a.key],
          schedule: a.schedule,
          next_run_at: nextRunAt(a.schedule),
          status: "active",
          board_column: "backlog",
          created_by: user.id,
        })
        .select("id")
        .single();
      // 3. Record the enabled automation.
      await supabase.from("internal_agent_automations").insert({
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        project_id: agent.project_id,
        key: a.key,
        enabled: true,
        mission_id: mission?.id ?? null,
        config: { providers: a.providers },
        created_by: user.id,
      });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_automations", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
      // 4. If a required tool isn't connected, prompt to connect it now.
      const missing = missingProviders(a);
      if (missing.length) setConnectSlug(missing[0]);
    } finally {
      setBusy(null);
    }
  }

  async function disable(a: AgentAutomation) {
    const row = enabledByKey.get(a.key);
    if (!row) return;
    setBusy(a.key);
    try {
      if (row.mission_id) await supabase.from("internal_agent_missions").delete().eq("id", row.mission_id);
      await supabase.from("internal_agent_automations").delete().eq("id", row.id);
      queryClient.invalidateQueries({ queryKey: ["internal_agent_automations", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    } finally {
      setBusy(null);
    }
  }

  const activeCount = (automations ?? []).length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Automatisations</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Activez des automatisations préconçues : {agent.name} exécute la recette sur un rythme planifié en utilisant
          ses connecteurs. Activer une automatisation crée une mission planifiée et accorde les outils nécessaires.
          {activeCount > 0 && <span className="ml-1 text-foreground">{activeCount} active{activeCount > 1 ? "s" : ""}.</span>}
        </p>
      </div>

      <div className="mt-6 space-y-8">
        {automationsByCategory().map(({ category, items }) => (
          <div key={category}>
            <h3 className="mb-3 text-sm font-semibold text-foreground">{category}</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {items.map((a) => {
                const row = enabledByKey.get(a.key);
                const on = !!row;
                const missing = missingProviders(a);
                const Icon = a.icon;
                return (
                  <div
                    key={a.key}
                    className={cn(
                      "flex flex-col gap-3 rounded-xl border p-4 transition-colors",
                      on ? "border-primary/50 bg-primary/5" : "border-border bg-card/40",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                        on ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
                      )}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-foreground">{a.name}</span>
                          {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{a.description}</p>
                      </div>
                    </div>

                    {/* Required connectors + connection status */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <CalendarClock className="h-3 w-3" /> {SCHEDULE_LABEL[a.schedule]}
                      </span>
                      {a.providers.map((slug) => {
                        const p = connectorActionProvider(slug);
                        const connected = connectedSet.has(slug);
                        return (
                          <button
                            key={slug}
                            onClick={() => setConnectSlug(slug)}
                            title={connected ? `${p?.name ?? slug} · connecté` : `Connecter ${p?.name ?? slug}`}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                              connected
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400",
                            )}
                          >
                            {connected ? <Plug className="h-2.5 w-2.5" /> : <AlertTriangle className="h-2.5 w-2.5" />}
                            {p?.name ?? slug}
                          </button>
                        );
                      })}
                    </div>

                    {on && missing.length > 0 && (
                      <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          Outil non connecté : {missing.map((s) => connectorActionProvider(s)?.name ?? s).join(", ")}.
                          L'automatisation ne pourra pas s'exécuter tant que ce n'est pas connecté.
                        </span>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Zap className="h-3 w-3" /> {a.uses.length} action{a.uses.length > 1 ? "s" : ""}
                      </span>
                      <Button
                        size="sm"
                        variant={on ? "outline" : "default"}
                        disabled={busy === a.key}
                        onClick={() => (on ? disable(a) : enable(a))}
                      >
                        {busy === a.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : on ? "Désactiver" : "Activer"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <ConnectorDialog
        open={!!connectSlug}
        onOpenChange={(o) => { if (!o) setConnectSlug(null); }}
        provider={connectSlug ? findProvider(connectSlug) ?? null : null}
        workspaceId={agent.workspace_id}
        projectId={agent.project_id}
        onConnected={() => {
          setConnectSlug(null);
          queryClient.invalidateQueries({ queryKey: ["project_connectors_for_tools", agent.project_id] });
        }}
      />
    </div>
  );
}
