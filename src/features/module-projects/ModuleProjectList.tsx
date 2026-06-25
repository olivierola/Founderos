import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Trash2, Calendar, FolderKanban, X, ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { getModuleConfig, type ProjectTypeDef } from "@/lib/module-project-config";
import { fetchModuleProjects, createModuleProject, deleteModuleProject, type ModuleProject } from "./moduleProjectModel";
import { TemplateDrawer } from "@/features/internal-agents/TemplateDrawer";
import { instantiateTemplate } from "@/features/internal-agents/instantiateTemplate";
import type { AgentTemplate } from "@/features/internal-agents/agentTemplates";
import type { TemplateOverrides } from "@/features/internal-agents/instantiateTemplate";

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  planning: { label: "Planning", cls: "bg-zinc-500/15 text-zinc-500" },
  active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-500" },
  on_hold: { label: "On Hold", cls: "bg-amber-500/15 text-amber-500" },
  completed: { label: "Completed", cls: "bg-sky-500/15 text-sky-500" },
  archived: { label: "Archived", cls: "bg-zinc-500/15 text-zinc-400" },
};

// Agent project types that should use the template drawer
const AGENT_TEMPLATE_TYPES = new Set(["autonomous_agent", "public_agent"]);

export function ModuleProjectList() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const pathname = window.location.pathname;
  const segments = pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] ?? "" : "";
  const config = getModuleConfig(moduleSlug);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [step, setStep] = useState<"type" | "name">("type");
  const [selectedType, setSelectedType] = useState<ProjectTypeDef | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [pendingAgentType, setPendingAgentType] = useState<ProjectTypeDef | null>(null);

  const { data: projects, isLoading } = useQuery({
    queryKey: ["module_projects", projectId, moduleSlug],
    enabled: !!projectId && !!moduleSlug,
    queryFn: () => fetchModuleProjects(projectId!, moduleSlug),
  });

  function openNew() {
    setSidebarOpen(true);
    setStep("type");
    setSelectedType(null);
    setName("");
    setDescription("");
  }

  function closeSidebar() {
    setSidebarOpen(false);
    setStep("type");
    setSelectedType(null);
    setName("");
    setDescription("");
  }

  function selectType(pt: ProjectTypeDef) {
    // For agent types that use templates, open the template drawer instead
    if (moduleSlug === "agent" && AGENT_TEMPLATE_TYPES.has(pt.key)) {
      setPendingAgentType(pt);
      setTemplateDrawerOpen(true);
      setSidebarOpen(false);
      return;
    }
    setSelectedType(pt);
    setStep("name");
  }

  async function handleCreate() {
    if (!workspaceId || !projectId || !user || !selectedType || !name.trim()) return;
    setCreating(true);
    try {
      const mp = await createModuleProject({
        workspace_id: workspaceId, project_id: projectId, module_slug: moduleSlug,
        project_type: selectedType.key, name: name.trim(),
        description: description.trim() || undefined,
        color: selectedType.color, icon: selectedType.icon.displayName ?? "FolderKanban",
        created_by: user.id,
      });
      queryClient.invalidateQueries({ queryKey: ["module_projects", projectId, moduleSlug] });
      closeSidebar();
      navigate(`/app/${workspaceSlug}/${projectSlug}/${moduleSlug}/project/${mp.id}`);
    } catch (e: any) {
      alert(e?.message ?? "Failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleTemplateActivate(template: AgentTemplate, overrides: TemplateOverrides) {
    if (!workspaceId || !projectId || !user || !pendingAgentType) return;
    // 1) Create the internal agent from the template
    const agentId = await instantiateTemplate(template, { workspaceId, projectId, userId: user.id }, overrides);
    // 2) Create the module project linked to the agent
    const mp = await createModuleProject({
      workspace_id: workspaceId, project_id: projectId, module_slug: moduleSlug,
      project_type: pendingAgentType.key,
      name: overrides.name?.trim() || template.name,
      description: overrides.description?.trim() || template.tagline,
      color: overrides.accent || template.accent || pendingAgentType.color,
      icon: pendingAgentType.icon.displayName ?? "Bot",
      created_by: user.id,
    });
    // Store agent reference in metadata
    await import("./moduleProjectModel").then(({ updateModuleProject }) =>
      updateModuleProject(mp.id, { metadata: { agent_id: agentId, template_key: template.key } })
    );
    queryClient.invalidateQueries({ queryKey: ["module_projects", projectId, moduleSlug] });
    setTemplateDrawerOpen(false);
    setPendingAgentType(null);
    navigate(`/app/${workspaceSlug}/${projectSlug}/${moduleSlug}/project/${mp.id}`);
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this project?")) return;
    await deleteModuleProject(id);
    queryClient.invalidateQueries({ queryKey: ["module_projects", projectId, moduleSlug] });
  }

  function openProject(mp: ModuleProject) {
    navigate(`/app/${workspaceSlug}/${projectSlug}/${moduleSlug}/project/${mp.id}`);
  }

  if (!config) return <div className="p-6 text-sm text-muted-foreground">Module not configured for projects. (slug: {moduleSlug})</div>;

  return (
    <div className="space-y-6 px-6 py-6">
      <PageHeader
        title={config.label}
        description={`Create and manage ${config.label.toLowerCase()} projects.`}
        actions={<Button onClick={openNew}><Plus className="mr-1.5 h-4 w-4" /> New project</Button>}
      />

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (projects ?? []).length === 0 ? (
        <EmptyState icon={FolderKanban} title="No projects yet"
          description={`Create your first ${config.label.toLowerCase()} project to get started.`}
          action={<Button onClick={openNew}><Plus className="mr-1.5 h-4 w-4" /> New project</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(projects ?? []).map((mp) => {
            const typeDef = config.projectTypes.find((t) => t.key === mp.project_type);
            const Icon = typeDef?.icon ?? FolderKanban;
            const st = STATUS_BADGE[mp.status] ?? STATUS_BADGE.active;
            return (
              <div key={mp.id} onClick={() => openProject(mp)}
                className="group relative cursor-pointer rounded-xl border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md text-white" style={{ backgroundColor: mp.color }}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", st.cls)}>{st.label}</span>
                </div>
                <h3 className="mt-3 truncate font-semibold">{mp.name}</h3>
                {mp.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{mp.description}</p>}
                <div className="mt-3 flex items-center gap-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px]">{typeDef?.label ?? mp.project_type}</span>
                  {mp.due_date && (
                    <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3" /> {new Date(mp.due_date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })}</span>
                  )}
                  <button onClick={(e) => handleDelete(mp.id, e)}
                    className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Creation sidebar (right) ── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={closeSidebar}>
          <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl transition-transform" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold">
                {step === "type" ? "Choose project type" : `Create ${selectedType?.label}`}
              </h2>
              <button onClick={closeSidebar} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {step === "type" ? (
                <div className="p-4 space-y-2">
                  <p className="text-sm text-muted-foreground mb-3">Select the type of {config.label.toLowerCase()} project to create.</p>
                  {config.projectTypes.map((pt) => {
                    const Icon = pt.icon;
                    return (
                      <button key={pt.key} onClick={() => selectType(pt)}
                        className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: pt.color }}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="text-sm font-medium">{pt.label}</div>
                          <div className="text-xs text-muted-foreground">{pt.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-5 space-y-4">
                  <button onClick={() => setStep("type")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="h-3 w-3" /> Back
                  </button>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Project name</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${selectedType?.label ?? ""} project`} autoFocus />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                      placeholder="Brief description of this project…"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                  </div>
                </div>
              )}
            </div>

            {step === "name" && (
              <div className="border-t border-border px-5 py-3 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep("type")}>Back</Button>
                <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                  {creating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Create project
                </Button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* ── Agent template drawer (for autonomous/public agent types) ── */}
      <TemplateDrawer
        open={templateDrawerOpen}
        onClose={() => { setTemplateDrawerOpen(false); setPendingAgentType(null); }}
        onActivate={handleTemplateActivate}
      />
    </div>
  );
}
