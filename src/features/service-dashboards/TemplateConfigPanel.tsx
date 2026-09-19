import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
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
import { findMcpCatalogEntry } from "@/features/internal-agents/mcpCatalog";
import { Icon3D } from "@/features/internal-agents/icons3d";
import { instantiateTemplate } from "@/features/internal-agents/instantiateTemplate";
import {
  ComposioConnectDialog, synthToolkit, type ComposioToolkit,
} from "@/features/integrations/ComposioCatalog";
import { applyAgentDefaults, fetchServiceDashboard, DEFAULT_AGENT_DEFAULTS } from "./model";
import { useComposioToolkits, useConnectorStatus, toolSlugsFromTemplate, resolveNeeds } from "./useToolkits";
import { cadenceFromCron, firstOccurrenceLocal, toAlignment, type Cadenced } from "./scheduleCadence";

const DOW_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** "Chaque lundi à 08:00" — the cadence in the words the Schedules tab uses. */
function describeCadence(c: Cadenced): string {
  const hhmm = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  switch (c.cadence) {
    case "hourly": return `Toutes les heures à :${String(c.minute).padStart(2, "0")}`;
    case "daily": return `Chaque jour à ${hhmm}`;
    case "weekly": return `Chaque ${DOW_FR[c.dow]} à ${hhmm}`;
    case "monthly": return `Le ${c.dom} de chaque mois à ${hhmm}`;
  }
}

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
  const [soul, setSoul] = useState("");
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  // The template's suggested recurring job. Pre-ticked for personal agents,
  // where the schedule IS the value (morning briefing, weekly budget) and
  // "enable it later" is a step nobody takes. Business templates keep it
  // opt-in: a recurring run spends credits the team didn't choose to spend.
  const [scheduleOn, setScheduleOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ComposioToolkit | null>(null);
  // A role's full stack runs to ~20 apps. Show what is connected plus a handful
  // to pick from, and keep the tail one click away.
  const [allApps, setAllApps] = useState(false);

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

  // Skill picker: selected skills stay visible, the rest surface on search —
  // the catalogue is 900+ entries. Capped so the panel stays light.
  const shownSkills = (() => {
    const q = skillQuery.trim().toLowerCase();
    const chosen = (allSkills ?? []).filter((s) => skillSlugs.includes(s.slug));
    if (!q) return chosen;
    const hits = (allSkills ?? []).filter((s) =>
      !skillSlugs.includes(s.slug) &&
      `${s.name} ${s.slug} ${s.description ?? ""}`.toLowerCase().includes(q));
    return [...chosen, ...hits].slice(0, 40);
  })();

  // Re-seed whenever another template is opened.
  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setDescription(template.tagline);
    setAvatar(templateAvatar(template));
    setInstructions(template.instructions);
    setSoul(template.soul);
    setSkillSlugs(template.skillSlugs ?? []);
    setScheduleOn(template.category === "Personnel" && !!template.suggestedSchedule && !!cadenceFromCron(template.suggestedSchedule.cron));
    setAllApps(false);
    setError(null);
  }, [template?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!template) return null;

  const needs = resolveNeeds(toolSlugsFromTemplate(template), toolkits, connStatus);
  const linked = needs.filter((n) => n.connected).length;

  // resolveNeeds puts the connected ones first, so the head of the list is
  // always the project's real stack rather than an arbitrary slice.
  const shownNeeds = allApps ? needs : needs.slice(0, Math.max(6, linked + 4));

  const suggested = template.suggestedSchedule ?? null;
  const cadence = suggested ? cadenceFromCron(suggested.cron) : null;

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
        { name, description, avatar: avatar ?? undefined, instructions, soul },
      );
      await applyAgentDefaults(id, board?.settings.agent_defaults ?? DEFAULT_AGENT_DEFAULTS, "template");
      // Same row the Schedules tab writes, so the job shows up there and can be
      // edited or paused like any other. Best-effort: the agent already exists,
      // and failing the whole creation over its schedule would be worse.
      if (scheduleOn && suggested && cadence) {
        const occ = firstOccurrenceLocal(cadence);
        const { error: schedErr } = await supabase.from("internal_agent_missions").insert({
          agent_id: id,
          workspace_id: workspaceId,
          project_id: projectId,
          title: suggested.label,
          brief: suggested.prompt,
          schedule: cadence.cadence,
          next_run_at: occ.toISOString(),
          ...toAlignment(cadence, occ),
          status: "active",
          board_column: "todo",
          created_by: user.id,
        });
        if (schedErr) console.warn("Planification non créée:", schedErr.message);
        queryClient.invalidateQueries({ queryKey: ["sd_schedules", dashboardId] });
      }
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
          <Icon3D icon={template.icon3d} px={34} className="shrink-0 opacity-90" />
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
            <div className="mb-1 flex items-center gap-2">
              <h3 className="text-sm font-semibold">Applications</h3>
              {needs.length > 0 && (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {linked} / {needs.length} connectées
                </span>
              )}
            </div>
            {needs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucune application externe requise.</p>
            ) : (
              <>
              {/* These are alternatives, not prerequisites: a company runs one
                  CRM out of five. Saying so stops the list reading as a wall of
                  missing dependencies. */}
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                Les outils du métier. Connectez ceux que vous utilisez — les autres restent
                simplement inactifs.
              </p>
              <div className="space-y-1.5">
                {shownNeeds.map((n) => {
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
              {needs.length > shownNeeds.length && (
                <button
                  type="button"
                  onClick={() => setAllApps(true)}
                  className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Voir les {needs.length - shownNeeds.length} autres applications
                </button>
              )}
              </>
            )}
          </section>

          {suggested && cadence && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Travail récurrent</h3>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                <input
                  type="checkbox"
                  checked={scheduleOn}
                  onChange={(e) => setScheduleOn(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{suggested.label}</span>
                  <span className="block text-xs text-muted-foreground">{describeCadence(cadence)} · modifiable ensuite dans Planifications</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">« {suggested.prompt} »</span>
                </span>
              </label>
            </section>
          )}

          <McpSuggestions template={template} />

          <section>
            <h3 className="mb-2 text-sm font-semibold">Skills</h3>
            {/* Search-driven: the catalogue holds 900+ skills, so only the
                selected ones and the current matches are rendered. */}
            <input
              value={skillQuery}
              onChange={(e) => setSkillQuery(e.target.value)}
              placeholder="Rechercher un skill…"
              className="mb-2 w-full rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs outline-none focus:border-primary/50"
            />
            <div className="flex flex-wrap gap-1.5">
              {(allSkills ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucun skill dans la bibliothèque.</p>
              ) : shownSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {skillQuery ? `Aucun skill pour « ${skillQuery} ».` : "Tapez pour chercher parmi les skills disponibles."}
                </p>
              ) : shownSkills.map((s) => {
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
            <p className="mb-1.5 text-xs text-muted-foreground">Ce qu'il fait : sa procédure et ses règles absolues.</p>
            <Textarea
              rows={12}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="resize-none rounded-2xl bg-background/60 text-sm"
            />
          </section>

          {/* L'âme est modifiable ICI, avant la création : c'est le moment où on
              adapte le caractère d'un template à sa maison (le ton d'un support
              n'est pas le même chez un cabinet d'avocats et chez un jeu vidéo).
              Après, ça se retravaille dans l'onglet Fichiers de l'agent. */}
          <section>
            <label className="mb-1.5 block text-sm font-semibold">Âme</label>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Qui il est : sa voix, ce à quoi il tient, ce qu'il refuse. Court — c'est du caractère, pas une procédure.
            </p>
            <Textarea
              rows={6}
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
              className="resize-none rounded-2xl bg-background/60 text-sm"
            />
          </section>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-5 py-4">
          {linked === 0 && needs.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Aucune application connectée : l'agent se crée, mais restera limité à ses outils internes.
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

/**
 * Which remote MCP servers this template is worth attaching to. They are not
 * provisioned here on purpose: an MCP server is a workspace-level resource
 * shared by every agent, so the template can only point at it. Entries the
 * catalogue knows to be local-only are shown as such rather than hidden —
 * knowing a server exists but can't run in the cloud is useful information.
 */
function McpSuggestions({ template }: { template: AgentTemplate }) {
  const names = template.mcpServers ?? [];
  if (names.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">Serveurs MCP conseillés</h3>
        <span className="text-[11px] text-muted-foreground">à ajouter depuis AI Workforce → MCP</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => {
          const entry = findMcpCatalogEntry(n);
          const ready = !!entry?.url;
          return (
            <span
              key={n}
              title={entry?.note ?? (ready ? "Endpoint distant officiel — connexion en un clic." : "URL de votre instance à renseigner.")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs",
                ready ? "border-border/60 text-foreground" : "border-dashed border-border/60 text-muted-foreground",
              )}
            >
              {n}
              {entry?.local && (
                <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">local</span>
              )}
            </span>
          );
        })}
      </div>
      {/* Three states, and the difference decides whether it is usable at all. */}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Trait plein : endpoint officiel, connexion en un clic. Pointillés : URL de votre instance à
        renseigner. <span className="rounded bg-muted px-1">local</span> : serveur stdio, joignable
        seulement en auto-hébergé — pas depuis le runtime cloud.
      </p>
    </section>
  );
}
