import React from "react";
import { AlertOctagon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface State {
  error: Error | null;
}

// Lazy-import to avoid bundling edge call paths in error boundary teardown.
async function reportToBackend(err: Error) {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/report-error`;
    // Find current workspace_id from URL: /app/<ws>/<proj>/...
    const m = location.pathname.match(/^\/app\/([^/]+)\/([^/]+)/);
    if (!m) return;
    const { supabase } = await import("@/lib/supabase");
    const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", m[1]).maybeSingle();
    if (!ws) return;
    const { data: proj } = await supabase
      .from("projects")
      .select("id")
      .eq("workspace_id", ws.id)
      .eq("slug", m[2])
      .maybeSingle();
    if (!proj) return;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        workspace_id: ws.id,
        project_id: proj.id,
        message: err.message,
        stack: err.stack,
        url: location.href,
        user_agent: navigator.userAgent,
        level: "error",
        source: "react-error-boundary",
      }),
    });
  } catch {
    /* swallow */
  }
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    reportToBackend(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-3 p-6 text-center">
            <AlertOctagon className="mx-auto h-6 w-6 text-destructive" />
            <div className="font-medium">Something went wrong</div>
            <p className="break-all text-xs text-muted-foreground">{this.state.error.message}</p>
            <Button onClick={() => location.reload()}>
              <RefreshCw className="h-4 w-4" /> Reload
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}
