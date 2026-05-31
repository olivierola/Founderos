import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface PermissionsCtx {
  permissions: Set<string>;
  loading: boolean;
  can: (permission: string) => boolean;
}

const PermissionsContext = createContext<PermissionsCtx>({
  permissions: new Set(),
  loading: false,
  can: () => false,
});

/** Bootstraps the permission set for the current (user, project) pair. */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { projectId } = useCurrentContext();

  const { data, isLoading } = useQuery({
    queryKey: ["user_permissions", user?.id, projectId],
    enabled: !!user?.id && !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase.rpc("user_permissions", {
        p_user: user!.id,
        p_project: projectId!,
      });
      return new Set(((data ?? []) as { permission_key: string }[]).map((p) => p.permission_key));
    },
  });

  const value = useMemo<PermissionsCtx>(() => {
    const set = data ?? new Set<string>();
    return {
      permissions: set,
      loading: isLoading,
      can: (perm: string) => set.has(perm),
    };
  }, [data, isLoading]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
  return useContext(PermissionsContext);
}

/** Returns true if the current user has the given permission on the active project. */
export function useCan(permission: string): boolean {
  return useContext(PermissionsContext).can(permission);
}

/** Conditional rendering helper. */
export function Can({
  perm,
  children,
  fallback = null,
}: {
  perm: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const ok = useCan(perm);
  return <>{ok ? children : fallback}</>;
}
