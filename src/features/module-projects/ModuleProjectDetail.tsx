import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Trash2, ChevronDown, ChevronRight, Clock, Bot, UserPlus, X,
  FolderKanban, Boxes, StickyNote, ListChecks, ExternalLink, Package,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { getModuleConfig, getProjectType } from "@/lib/module-project-config";
import { fetchModuleProject, updateModuleProject, deleteModuleProject, type ModuleProject } from "./moduleProjectModel";
import { AssetsTab, ASSET_BY_TYPE, type ProjectAsset } from "./tabs/AssetsTab";
import { AgentsTab } from "./tabs/AgentsTab";
import { ArtifactsTab } from "./tabs/ArtifactsTab";
import { TimelineTab } from "./tabs/TimelineTab";
import { TasksTab } from "./tabs/TasksTab";
import { NotesTab } from "./tabs/NotesTab";

const STATUS_OPTIONS: Array<{ value: ModuleProject["status"]; label: string }> = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

// Universal tabs — same for every project type.
const TABS = [
  { key: "assets", label: "Assets", icon: Boxes },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "artifacts", label: "Artifacts", icon: Package },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "notes", label: "Notes", icon: StickyNote },
];

const FULLBLEED_TABS = new Set(["assets"]);

export function ModuleProjectDetail() {
  const { workspaceSlug, projectSlug, moduleProjectId, tabSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pathname = window.location.pathname;
  const segments = pathname.split("/").filter(Boolean);
  const projectIdx = segments.indexOf("project");
  const moduleSlug = projectIdx > 0 ? segments[projectIdx - 1] : "";

  const { data: mp, isLoading } = useQuery({
    queryKey: ["module_project", moduleProjectId],
    enabled: !!moduleProjectId,
    queryFn: () => fetchModuleProject(moduleProjectId!),
  });

  const config = getModuleConfig(moduleSlug);
  const typeDef = mp ? getProjectType(moduleSlug, mp.project_type) : undefined;
  const activeTab = tabSlug || "assets";

  function setTab(key: string) {
    navigate(`/app/${workspaceSlug}/${projectSlug}/${moduleSlug}/project/${moduleProjectId}/${key}`, { replace: true });
  }

  async function handleStatusChange(status: ModuleProject["status"]) {
    if (!mp) return;
    await updateModuleProject(mp.id, { status });
    queryClient.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  async function handleDelete() {
    if (!mp || !confirm("Delete this project?")) return;
    await deleteModuleProject(mp.id);
    queryClient.invalidateQueries({ queryKey: ["module_projects"] });
    navigate(`/app/${workspaceSlug}/${projectSlug}/${moduleSlug}`);
  }

  if (isLoading || !mp) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const TypeIcon = typeDef?.icon ?? FolderKanban;
  const assignedAgents: string[] = (mp.metadata as any)?.assigned_agents ?? [];
  const artifactCount: number = ((mp.metadata as any)?.artifacts ?? []).length;
  const taskCount: number = ((mp.metadata as any)?.tasks ?? []).filter((t: any) => !t.done).length;
  const assetCount: number = ((mp.metadata as any)?.assets ?? []).length;

  return (
    <div className="flex h-full w-full">
      <div className="flex min-h-0 flex-1">
        {/* ── Left sidebar ── */}
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-card">
          <div className="flex flex-col items-center gap-2 border-b border-border px-4 py-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl text-white" style={{ backgroundColor: mp.color }}>
              <TypeIcon className="h-7 w-7" />
            </div>
            <h2 className="text-center text-sm font-semibold">{mp.name}</h2>
            <Badge variant="outline" className="text-[10px]" style={{ borderColor: mp.color, color: mp.color }}>
              {typeDef?.label ?? mp.project_type}
            </Badge>
          </div>

          <div className="flex-1 px-4 py-3 space-y-4">
            <SidebarGroup label="Project" defaultOpen>
              <SidebarRow label="Status">
                <select value={mp.status} onChange={(e) => handleStatusChange(e.target.value as ModuleProject["status"])}
                  className="rounded border-none bg-transparent text-sm font-medium focus:outline-none focus:ring-0">
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </SidebarRow>
              {mp.description && (
                <SidebarRow label="Description">
                  <p className="text-xs text-muted-foreground">{mp.description}</p>
                </SidebarRow>
              )}
            </SidebarGroup>

            {/* Quick stats */}
            <SidebarGroup label="Overview" defaultOpen>
              <SidebarRow label="Assets"><span className="text-xs font-medium">{assetCount}</span></SidebarRow>
              <SidebarRow label="Agents"><span className="text-xs font-medium">{assignedAgents.length}</span></SidebarRow>
              <SidebarRow label="Artifacts"><span className="text-xs font-medium">{artifactCount}</span></SidebarRow>
              <SidebarRow label="Open tasks"><span className="text-xs font-medium">{taskCount}</span></SidebarRow>
            </SidebarGroup>

            <SidebarGroup label="Dates">
              <SidebarRow label="Start">
                <input type="date" value={mp.start_date ?? ""} className="bg-transparent text-xs text-muted-foreground"
                  onChange={async (e) => { await updateModuleProject(mp.id, { start_date: e.target.value || null } as any); queryClient.invalidateQueries({ queryKey: ["module_project", mp.id] }); }} />
              </SidebarRow>
              <SidebarRow label="Due">
                <input type="date" value={mp.due_date ?? ""} className="bg-transparent text-xs text-muted-foreground"
                  onChange={async (e) => { await updateModuleProject(mp.id, { due_date: e.target.value || null } as any); queryClient.invalidateQueries({ queryKey: ["module_project", mp.id] }); }} />
              </SidebarRow>
            </SidebarGroup>

            <SidebarGroup label="System">
              <SidebarRow label="Created">{fmtDate(mp.created_at)}</SidebarRow>
              <SidebarRow label="Updated">{fmtDate(mp.updated_at)}</SidebarRow>
            </SidebarGroup>
          </div>

          <div className="border-t border-border px-4 py-3">
            <button onClick={handleDelete} className="flex items-center gap-1.5 text-xs text-destructive hover:underline">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        </aside>

        {/* ── Right: tabs ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-5">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={cn("flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
                    active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className={cn("min-h-0 flex-1", FULLBLEED_TABS.has(activeTab) ? "" : "overflow-y-auto px-6 lg:px-10")}>
            <TabContent tabKey={activeTab} moduleProject={mp} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab content ─────────────────────────────────────────────────────────────

function TabContent({ tabKey, moduleProject }: { tabKey: string; moduleProject: ModuleProject }) {
  switch (tabKey) {
    case "assets": return <AssetsTab moduleProject={moduleProject} />;
    case "agents": return <AgentsTab moduleProject={moduleProject} />;
    case "artifacts": return <ArtifactsTab moduleProject={moduleProject} />;
    case "timeline": return <TimelineTab moduleProject={moduleProject} />;
    case "tasks": return <TasksTab moduleProject={moduleProject} />;
    case "notes": return <NotesTab moduleProject={moduleProject} />;
    default: return null;
  }
}

// ── Sidebar helpers ─────────────────────────────────────────────────────────

function SidebarGroup({ label, defaultOpen = true, children }: { label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="mb-1 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && <div className="space-y-1 pl-1">{children}</div>}
    </div>
  );
}

function SidebarRow({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-xs">{children ?? <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
