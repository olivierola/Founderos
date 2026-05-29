import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, FolderGit2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { renameWorkspace, renameProject } from "@/hooks/useWorkspace";

export function SettingsWorkspacePage() {
  const { workspace, workspaceId, role, projectId, project } = useCurrentContext();
  const queryClient = useQueryClient();
  const canEdit = role === "owner" || role === "admin";

  const [wsName, setWsName] = useState("");
  const [projName, setProjName] = useState("");
  const [savingWs, setSavingWs] = useState(false);
  const [savingProj, setSavingProj] = useState(false);
  const [savedWs, setSavedWs] = useState(false);
  const [savedProj, setSavedProj] = useState(false);

  useEffect(() => setWsName(workspace?.name ?? ""), [workspace?.name]);
  useEffect(() => setProjName(project?.name ?? ""), [project?.name]);

  const { data: members, isLoading } = useQuery({
    queryKey: ["workspace_members", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("workspace_members")
        .select("role, user_id, created_at")
        .eq("workspace_id", workspaceId!);
      return data ?? [];
    },
  });

  const { data: projectFull } = useQuery({
    queryKey: ["project_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("projects").select("*").eq("id", projectId!).maybeSingle();
      return data;
    },
  });

  async function saveWs() {
    if (!workspaceId || !wsName.trim()) return;
    setSavingWs(true);
    setSavedWs(false);
    try {
      await renameWorkspace(workspaceId, wsName.trim());
      await queryClient.invalidateQueries({ queryKey: ["current-context"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setSavedWs(true);
    } finally {
      setSavingWs(false);
    }
  }

  async function saveProj() {
    if (!projectId || !projName.trim()) return;
    setSavingProj(true);
    setSavedProj(false);
    try {
      await renameProject(projectId, projName.trim());
      await queryClient.invalidateQueries({ queryKey: ["current-context"] });
      await queryClient.invalidateQueries({ queryKey: ["project_settings", projectId] });
      setSavedProj(true);
    } finally {
      setSavingProj(false);
    }
  }

  return (
    <div>
      <PageHeader title="Workspace" description="Workspace and project settings." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Organisation</span>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canEdit} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Slug (read-only)</label>
              <Input value={workspace?.slug ?? ""} disabled />
            </div>
            <div className="flex items-center gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Your role</label>
                <div>
                  <Badge variant={role === "owner" ? "default" : "outline"}>{role ?? "—"}</Badge>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Plan</label>
                <div>
                  <Badge variant="secondary">{(workspace as any)?.plan ?? "free"}</Badge>
                </div>
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-3 pt-1">
                <Button
                  size="sm"
                  onClick={saveWs}
                  disabled={savingWs || !wsName.trim() || wsName.trim() === workspace?.name}
                >
                  {savingWs && <Loader2 className="h-4 w-4 animate-spin" />} Save
                </Button>
                {savedWs && <span className="text-xs text-emerald-400">Saved.</span>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Current project</span>
            </div>
            {project ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Name</label>
                  <Input value={projName} onChange={(e) => setProjName(e.target.value)} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Slug (read-only)</label>
                  <Input value={project.slug ?? ""} disabled />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Health score</label>
                  <div className="text-2xl font-semibold">{projectFull?.health_score ?? 0}/100</div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-3 pt-1">
                    <Button
                      size="sm"
                      onClick={saveProj}
                      disabled={savingProj || !projName.trim() || projName.trim() === project.name}
                    >
                      {savingProj && <Loader2 className="h-4 w-4 animate-spin" />} Save
                    </Button>
                    {savedProj && <span className="text-xs text-emerald-400">Saved.</span>}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No project loaded.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">Team members</span>
            {members && <span className="text-xs text-muted-foreground">{members.length} total</span>}
          </div>
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(members ?? []).map((m: any) => (
                <li key={m.user_id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs text-muted-foreground">{m.user_id}</span>
                  <Badge variant={m.role === "owner" ? "default" : "outline"}>{m.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
