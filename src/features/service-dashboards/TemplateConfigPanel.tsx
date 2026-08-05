import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { XIcon, CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AgentIdentity } from "@/components/AgentIdentity";
import { BrandLogo } from "@/components/BrandLogo";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AvatarPicker } from "@/features/internal-agents/AvatarPicker";
import { templateAvatar, type AgentTemplate } from "@/features/internal-agents/agentTemplates";
import { instantiateTemplate } from "@/features/internal-agents/instantiateTemplate";
import {
  ComposioConnectDialog, synthToolkit, type ComposioToolkit,
} from "@/features/integrations/ComposioCatalog";
import { applyAgentDefaults, fetchServiceDashboard, DEFAULT_AGENT_DEFAULTS } from "./model";
import { useComposioToolkits, useConnectorStatus, toolSlugsFromTemplate, resolveNeeds } from "./useToolkits";

/**
 * A template is a starting point, not a finished agent. Before it lands you
 * name it, write its instructions, tick its skills and — the part that decides
 * whether it works at all — connect the apps it needs, via Composio.
 */
export function TemplateConfigPanel({
  template, onClose, dashboardId, workspaceId, projectId, onCreated,
}: {
  template: AgentTemplate | null;
  onClose: () => void;
  dashboardId: string;
  workspaceId: string;
  projectId: string;
  onCreated: (agentId: string) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: toolkits } = useComposioToolkits();
  const { data: connStatus, refetch: refetchStatus } = useConnectorStatus(workspaceId, projectId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ComposioToolkit | null>(null);

  const { data: board } = useQuery({
    queryKey: ["service_dashboard", dashboardId],
    queryFn: () => fetchServiceDashboard(dashboardId),
  });
  const { data: allSkills } = useQuery({
    queryKey: ["agent_skills_all", workspaceId],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills").select("id, name, slug, description")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order("name");
      return (data ?? []) as Array<{ id: string; name: string; slug: string; description: string | null }>;
    },
  });

  // Re-seed whenever another template is opened.
  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setDescription(template.tagline);
    setAvatar(templateAvatar(template));
    setInstructions(template.instructions);
    setSkillSlugs(template.skillSlugs ?? []);
    setError(null);
  }, [template?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!template) return null;

  const needs = resolveNeeds(toolSlugsFromTemplate(template), toolkits, connStatus);
  const missing = needs.filter((n) => !n.connected).length;

  async function create() {
    if (!template || !user || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Skills travel on the template object, so a trimmed copy makes
      // instantiateTemplate activate exactly what was ticked here.
      const id = await instantiateTemplate(
        { ...template, skillSlugs },
        { workspaceId, projectId, userId: user.id, serviceDashboardId: dashboardId },
        { name, description, avatar: avatar ?? undefined, instructions },
      );
      await applyAgentDefaults(id, board?.settings.agent_defaults ?? DEFAULT_AGENT_DEFAULTS, "template");
      queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboardId] });
      queryClient.invalidateQueries({ queryKey: ["sd_panel_agents", dashboardId] });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <aside className="fixed bottom-3 right-3 top-3 z-[70] flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <button onClick={() => setAvatarOpen((v) => !v)} title="Changer l'avatar" className="rounded-xl transition-transform hover:scale-105">
            <AgentIdentity url={avatar} seed={name || template.key} size={44} rounded="rounded-xl" />
          </button>
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-transparent text-[19px] font-semibold tracking-tight focus:outline-none"
            />
            <div className="text-xs text-muted-foreground">{template.category} · {template.max_steps} pas</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {avatarOpen && <AvatarPicker value={avatar} onChange={(v) => { setAvatar(v); setAvatarOpen(false); }} />}

          <section>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </section>

          {/* Apps — what actually decides whether this agent can do its job. */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold">Applications</h3>
              {missing > 0 && (
                <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {missing} à connecter
                </span>
              )}
            </div>
            {needs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucune application externe requise.</p>
            ) : (
              <div className="space-y-1.5">
                {needs.map((n) => {
                  const tk = (toolkits ?? []).find((x) => x.slug === n.slug);
                  return (
                    <div key={n.slug} className="flex items-center gap-3 rounded-xl border border-border p-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        {n.logo
                          ? <img src={n.logo} alt="" className="h-4 w-4 object-contain" />
                          : <BrandLogo slug={n.slug} className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{n.name}</span>
                      {n.connected ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-500">
                          <CheckIcon className="h-3.5 w-3.5" /> Connecté
                        </span>
                      ) : (
                        <Button
                          size="sm" variant="outline" className="rounded-full"
                          onClick={() => setConnecting(tk ?? synthToolkit(n.slug, n.name, null))}
                        >
                          Connecter
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">Skills</h3>
            <div className="flex flex-wrap gap-1.5">
              {(allSkills ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucun skill dans la bibliothèque.</p>
              ) : (allSkills ?? []).map((s) => {
                const on = skillSlugs.includes(s.slug);
                return (
                  <button
                    key={s.id}
                    type="button"
                    title={s.description ?? undefined}
                    onClick={() => setSkillSlugs((v) => (on ? v.filter((x) => x !== s.slug) : [...v, s.slug]))}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors",
                      on ? "border-primary bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.name}{on && <CheckIcon className="h-3 w-3 text-primary" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <label className="mb-1.5 block text-sm font-semibold">Instructions</label>
            <Textarea
              rows={12}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="resize-none rounded-2xl bg-background/60 text-sm"
            />
          </section>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-5 py-4">
          {missing > 0 && (
            <span className="text-xs text-muted-foreground">
              L'agent se crée quand même — il restera bloqué sur les apps non connectées.
            </span>
          )}
          <Button onClick={create} disabled={busy || !name.trim()} className="ml-auto rounded-xl">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Add agent
          </Button>
        </footer>
      </aside>

      <ComposioConnectDialog
        toolkit={connecting}
        workspaceId={workspaceId}
        projectId={projectId}
        onOpenChange={(open) => !open && setConnecting(null)}
        onConnected={() => { setConnecting(null); refetchStatus(); }}
      />
    </>
  );
}
