import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";

interface ProtectedRouteProps {
  children: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

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
