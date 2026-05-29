import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export interface CurrentContext {
  workspace: { id: string; name: string; slug: string; plan?: string } | null;
  workspaceId: string | null;
  project: { id: string; name: string; slug: string } | null;
  projectId: string | null;
  role: string | null;
  loading: boolean;
  notFound: boolean;
}

/**
 * Resolves the active organisation (workspace) + project from the URL params
 * `:workspaceSlug` / `:projectSlug`. This is the single source of truth used
 * by every cockpit page so they reflect the chosen project — not workspaces[0].
 */
export function useCurrentContext(): CurrentContext {
  const { user } = useAuth();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  const projectSlug = params.projectSlug;

  const query = useQuery({
    queryKey: ["current-context", user?.id, workspaceSlug, projectSlug],
    enabled: !!user && !!workspaceSlug && !!projectSlug,
    queryFn: async () => {
      // Resolve workspace by slug, ensuring the user is a member (RLS already enforces this).
      const { data: ws } = await supabase
        .from("workspaces")
        .select("id, name, slug, plan")
        .eq("slug", workspaceSlug!)
        .maybeSingle();
      if (!ws) return { workspace: null, project: null, role: null };

      const { data: membership } = await supabase
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", ws.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (!membership) return { workspace: null, project: null, role: null };

      const { data: project } = await supabase
        .from("projects")
        .select("id, name, slug")
        .eq("workspace_id", ws.id)
        .eq("slug", projectSlug!)
        .maybeSingle();

      return { workspace: ws, project: project ?? null, role: membership.role };
    },
  });

  return {
    workspace: query.data?.workspace ?? null,
    workspaceId: query.data?.workspace?.id ?? null,
    project: query.data?.project ?? null,
    projectId: query.data?.project?.id ?? null,
    role: query.data?.role ?? null,
    loading: query.isLoading,
    notFound: !query.isLoading && (!query.data?.workspace || !query.data?.project),
  };
}
