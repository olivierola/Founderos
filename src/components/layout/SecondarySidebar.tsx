import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  PlusIcon as Plus,
  KanbanIcon as FolderKanban,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PuzzlePieceIcon, PlugsConnectedIcon, RobotIcon } from "@phosphor-icons/react";
import { findModule, itemsInGroup, moduleGroups, type SubNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { navIcon, navItem, navSection } from "./navStyles";
import { ChatConversationsItem } from "./ChatConversationsItem";
import { AccordionNavItem } from "./AccordionNavItem";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// La grammaire des tableaux de service (navStyles) : posée sur le fond, sans
// cadre ni filet, la ligne active en voile violet.
const linkClass = ({ isActive }: { isActive: boolean }) => navItem(isActive);

/** Le contenu d'un lien de la barre : son icône (pleine quand il est actif) et
 *  son libellé. */
function linkBody(icon: SubNavItem["icon"] | undefined, label: ReactNode) {
  const Icon = icon;
  return ({ isActive }: { isActive: boolean }) => (
    <>
      {Icon && <Icon weight={isActive ? "fill" : "regular"} className={navIcon(isActive)} />}
      <span className="truncate">{label}</span>
    </>
  );
}

/** La colonne de la barre secondaire : posée sur le fond, titrée comme
 *  l'en-tête d'un panneau de service. */
function SidebarColumn({ title, children, footer }: { title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col">
      <div className="flex h-10 shrink-0 items-center px-4 pt-1">
        <div className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-foreground">{title}</div>
      </div>
      <nav className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</nav>
      {footer}
    </aside>
  );
}

export function SecondarySidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();

  // Match the module from the exact path segment: /app/:ws/:proj/<module>/<sub>
  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  // AI HQ is a single full-width dashboard — no second sidebar.
  if (moduleSlug === "hq") return null;

  // AI Workforce module → show hired agents in sidebar. /agent/builder/* is a
  // bare redirect now, so it gets no sidebar of its own.
  // AI Ops (hidden from the module nav) lives inside AI Workforce: the models
  // and servers agents run on are configured there.
  if ((moduleSlug === "agent" && segments[appIdx + 4] !== "builder") || moduleSlug === "aiops") {
    return <AgentWorkforceSidebar base={base} />;
  }
  if (moduleSlug === "agent" && segments[appIdx + 4] === "builder") return null;

  // (The internal-agent detail sidebar lived here — removed with the pages it
  // navigated: /agent/internal/:id now redirects to the service dashboard. The
  // public-agent builder sidebar followed in 0195: its tabs are drawn by the
  // service dashboard that now hosts them.)

  // Vibe Code → onglets + persisted chat sessions.
  if (moduleSlug === "vibe-code") {
    return <VibeCodeSidebar base={base} pathname={location.pathname} search={location.search} />;
  }

  // Un module inconnu (ou éteint, comme le CRM) n'a pas de barre secondaire.
  const module = moduleSlug ? findModule(moduleSlug) : undefined;

  // Group children by parent slug. Top-level items = those without a parent.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, SubNavItem[]>();
    if (!module) return m;
    module.subItems.forEach((s) => {
      if (s.parent) {
        const arr = m.get(s.parent) ?? [];
        arr.push(s);
        m.set(s.parent, arr);
      }
    });
    return m;
  }, [module]);

  if (!module) return null;

  // ── Groups-as-tabs mode (SaaS Analytics): the sidebar lists groups; each
  // group links to its first item, and a horizontal SubTabBar (rendered by the
  // page chrome) shows the items within the active group. ──
  if (module.groupsAsTabs) {
    const groups = moduleGroups(module);
    // Single-group module (the split AI-control modules): the tabs live in the
    // Topbar (SubTabBar), so a left rail listing one group is redundant — hide it.
    if (groups.length <= 1) return null;
    const activeSlug = segments[appIdx + 4];
    const activeGroup = groups.find((g) =>
      itemsInGroup(module, g).some((it) => it.slug === activeSlug),
    );
    return (
      <SidebarColumn title={module.label}>
        <div className="space-y-0.5">
          {groups.map((g) => {
            const items = itemsInGroup(module, g);
            const first = items[0];
            if (!first) return null;
            const isActive = g === activeGroup;
            return (
              <NavLink key={g} to={`${base}/${module.slug}/${first.slug}`} className={navItem(isActive, "justify-between")}>
                <span className="min-w-0 truncate">{g}</span>
                {items.length > 1 && (
                  <span className="ml-2 shrink-0 text-[12px] tabular-nums text-muted-foreground">{items.length}</span>
                )}
              </NavLink>
            );
          })}
        </div>
      </SidebarColumn>
    );
  }

  const topLevel = module.subItems.filter((s) => !s.parent);

  return (
    <SidebarColumn title={module.label}>
      <div className="space-y-0.5">
        {topLevel.map((sub, i) => {
          const to = `${base}/${module.slug}/${sub.slug}`;
          const prevGroup = i > 0 ? topLevel[i - 1].group : undefined;
          const showDivider = sub.group && sub.group !== prevGroup;
          const kids = childrenByParent.get(sub.slug);

          const node = (() => {
            if ((module.slug === "ai" || module.slug === "agent") && sub.slug === "chat") {
              return <ChatConversationsItem key={sub.slug} to={to} label={sub.label} />;
            }
            if (kids && kids.length > 0) {
              return (
                <AccordionNavItem
                  key={sub.slug}
                  parentTo={to}
                  parentLabel={sub.label}
                  items={kids}
                  childBase={`${base}/${module.slug}/`}
                />
              );
            }
            return (
              <NavLink key={sub.slug} to={to} className={linkClass}>
                {linkBody(sub.icon, sub.label)}
              </NavLink>
            );
          })();

          if (!showDivider) return node;
          return (
            <div key={sub.slug + "-grouped"}>
              <div className={navSection(i === 0)}>{sub.group}</div>
              {node}
            </div>
          );
        })}
      </div>
    </SidebarColumn>
  );
}

// ── Agent workforce sidebar ─────────────────────────────────────────────────
// The AI Workforce module splits into two parts: internal agents (private team
// workers) and public agents (customer-facing — SAV, e-commerce, onboarding).
// Both parts live in this one sidebar as labelled sections.


function AgentWorkforceSidebar({ base }: { base: string }) {
  const navigate = useNavigate();
  const location = useLocation();

  const segs = location.pathname.split("/").filter(Boolean);
  const agentSeg = (() => {
    const idx = segs.indexOf("agent");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();
  const onRoster = agentSeg === "agents" || agentSeg === "public-agents";
  const onSkills = agentSeg === "skills";
  const onMcp = agentSeg === "mcp";
  const aiopsSub = (() => {
    const idx = segs.indexOf("aiops");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();
  const aiops = findModule("aiops");

  // No agent is configured here any more — internal ones (0133) and public ones
  // (0195) both live in their service dashboard. This module keeps the roster
  // (a directory of the whole workforce) and what it shares: skills, MCP
  // servers. Les collections de connaissances vivent dans le RAG des Sources,
  // côté service.
  const row = (active: boolean, Icon: SubNavItem["icon"] | undefined, label: string, to: string) => (
    <button key={to} onClick={() => navigate(to)} className={navItem(active)}>
      {Icon && <Icon weight={active ? "fill" : "regular"} className={navIcon(active)} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <SidebarColumn title="AI Workforce">
      {/* ── The roster (internal + public, opened in their dashboard) ── */}
      <SectionLabel first>Main-d'œuvre</SectionLabel>
      <div className="space-y-0.5">
        {row(onRoster, RobotIcon, "Collaborateurs", `${base}/agent/agents`)}
      </div>

      {/* ── Skills (custom + catalogue) ── */}
      <SectionLabel>Compétences</SectionLabel>
      <div className="space-y-0.5">
        {row(onSkills, PuzzlePieceIcon, "Skills", `${base}/agent/skills`)}
        {row(onMcp, PlugsConnectedIcon, "MCP Servers", `${base}/agent/mcp`)}
      </div>

      {/* ── AI Ops: models, servers, deployment the agents run on ── */}
      {aiops && (
        <>
          <SectionLabel>AI Ops</SectionLabel>
          <div className="space-y-0.5">
            {aiops.subItems.map((sub) => row(aiopsSub === sub.slug, sub.icon, sub.label, `${base}/aiops/${sub.slug}`))}
          </div>
        </>
      )}
    </SidebarColumn>
  );
}

// ── Vibe Code sidebar — module onglets + persisted chat sessions ─────────────
interface VibeSession { id: string; title: string; updated_at: string }
interface VibeProject { id: string; name: string; repository_id: string }

function VibeCodeSidebar({ base, pathname, search }: { base: string; pathname: string; search: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mod = findModule("vibe-code");
  const segs = pathname.split("/").filter(Boolean);
  const activeSub = segs[segs.indexOf("vibe-code") + 1];
  const params = new URLSearchParams(search);
  const activeSession = params.get("session");
  const activeProject = params.get("project");
  const [creating, setCreating] = useState(false);

  const { data: vibeProjects } = useQuery({
    queryKey: ["vibe_projects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.from("vibe_projects").select("id, name, repository_id")
        .eq("project_id", projectId!).order("updated_at", { ascending: false });
      return (data ?? []) as VibeProject[];
    },
  });

  // Inside a project → only its sessions; otherwise the project-less ones.
  const { data: sessions } = useQuery({
    queryKey: ["vibe_sessions", projectId, activeProject],
    enabled: !!projectId,
    refetchInterval: 8000,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      let q = supabase.from("vibe_sessions").select("id, title, updated_at").eq("project_id", projectId!);
      q = activeProject ? q.eq("vibe_project_id", activeProject) : q.is("vibe_project_id", null);
      const { data } = await q.order("updated_at", { ascending: false }).limit(50);
      return (data ?? []) as VibeSession[];
    },
  });

  const chatHref = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (activeProject) p.set("project", activeProject);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const qs = p.toString();
    return `${base}/vibe-code/chat${qs ? `?${qs}` : ""}`;
  };

  return (
    <SidebarColumn title="Vibe Code">
      <div className="space-y-0.5">
        {(mod?.subItems ?? []).map((s) => (
          <NavLink key={s.slug} to={`${base}/vibe-code/${s.slug}`} className={linkClass}>
            {linkBody(s.icon, s.label)}
          </NavLink>
        ))}
      </div>

      {/* Projects — each is bound to one repo; its sessions inherit that repo. */}
      <div className={cn(navSection(), "flex items-center justify-between")}>
        <span>Projets</span>
        <button onClick={() => setCreating(true)} title="Nouveau projet" className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-0.5">
        <button onClick={() => navigate(`${base}/vibe-code/chat`)} className={navItem(!activeProject)}>
          <span className="min-w-0 flex-1 truncate">Sans projet</span>
        </button>
        {(vibeProjects ?? []).map((p) => (
          <button key={p.id} onClick={() => navigate(`${base}/vibe-code/chat?project=${p.id}`)} className={navItem(activeProject === p.id)}>
            <FolderKanban className={navIcon(activeProject === p.id)} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
          </button>
        ))}
      </div>

      <div className={navSection()}>Sessions</div>
      <div className="space-y-0.5">
        <button
          onClick={() => navigate(chatHref({}))}
          className={navItem(activeSub === "chat" && !activeSession, activeSub === "chat" && !activeSession ? "" : "text-primary hover:text-primary")}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" /> Nouvelle session
        </button>
        {(sessions ?? []).length === 0 ? (
          <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Aucune session.</p>
        ) : (sessions ?? []).map((s) => (
          <button key={s.id} onClick={() => navigate(chatHref({ session: s.id }))} className={navItem(activeSession === s.id && activeSub === "chat")}>
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
          </button>
        ))}
      </div>

      {creating && (
        <NewVibeProjectDialog
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["vibe_projects", projectId] });
            navigate(`${base}/vibe-code/chat?project=${id}`);
          }}
        />
      )}
    </SidebarColumn>
  );
}

/** Create a Vibe project: a name + the single repo it works on. */
function NewVibeProjectDialog({
  workspaceId, projectId, onClose, onCreated,
}: {
  workspaceId?: string | null; projectId?: string | null;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [repoId, setRepoId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: repos } = useQuery({
    queryKey: ["repositories", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.from("repositories").select("id, full_name")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });
  const list = repos ?? [];
  const chosen = repoId || list[0]?.id || "";

  async function create() {
    if (!workspaceId || !projectId || !name.trim() || !chosen) return;
    setSaving(true); setError(null);
    try {
      const { supabase } = await import("@/lib/supabase");
      const { data, error } = await supabase.from("vibe_projects")
        .insert({ workspace_id: workspaceId, project_id: projectId, name: name.trim(), repository_id: chosen })
        .select("id").single();
      if (error) throw error;
      onCreated(data.id as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau projet Vibe Code</DialogTitle>
          <DialogDescription>Un projet est lié à un seul dépôt, toutes ses discussions auront ce dépôt pour contexte.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Nom</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Refonte du checkout" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Dépôt</span>
            {list.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun dépôt connecté, connectez-en un dans le module Dépôts.</p>
            ) : (
              <select value={chosen} onChange={(e) => setRepoId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                {list.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </select>
            )}
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={create} disabled={saving || !name.trim() || !chosen}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ children, first }: { children: ReactNode; first?: boolean }) {
  return <div className={navSection(first)}>{children}</div>;
}

function SidebarSpinner() {
  return <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
}
