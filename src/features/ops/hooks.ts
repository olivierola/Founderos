import { useParams } from "react-router-dom";

/** Build URLs scoped to the current workspace + project from URL params. */
export function useOpsUrl() {
  const { workspaceSlug, projectSlug } = useParams();
  return (path: string) => `/app/${workspaceSlug}/${projectSlug}${path}`;
}
