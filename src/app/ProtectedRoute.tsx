import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { Skeleton, PageSkeleton } from "@/components/ui/skeleton";

interface ProtectedRouteProps {
  children: ReactNode;
}

// Shown while the session is being resolved — a shell skeleton (sidebar +
// content) instead of a bare "Loading…" so the app feels instant.
function AppLoadingSkeleton() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <div className="hidden w-64 shrink-0 flex-col gap-2 border-r border-border/50 p-4 md:flex">
        <Skeleton className="h-9 w-full rounded-lg" />
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}
        </div>
        <div className="mt-auto"><Skeleton className="h-11 w-full rounded-xl" /></div>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden p-6 sm:p-8">
        <PageSkeleton />
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <AppLoadingSkeleton />;

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Legacy bookmark guard: /app/default/default was the old placeholder.
  // Send those to the org picker so the user re-selects a real project.
  if (/^\/app\/default\/default(\/|$)/.test(location.pathname)) {
    return <Navigate to="/orgs" replace />;
  }

  return <>{children}</>;
}
