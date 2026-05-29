import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const token = search.get("token");
  const { session, loading } = useAuth();
  const [status, setStatus] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!token) return;
    setStatus("working");
    try {
      await callEdge("accept-invite", { token });
      setStatus("ok");
      setTimeout(() => navigate("/orgs", { replace: true }), 1500);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!loading && session && token && status === "idle") {
      accept();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session]);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card>
          <CardContent className="space-y-3 p-6 text-center">
            <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
            <div className="font-medium">Missing invitation token</div>
            <Button onClick={() => navigate("/login")}>Go to login</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6 text-center">
          {loading || status === "working" ? (
            <>
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Accepting invitation…</p>
            </>
          ) : !session ? (
            <>
              <div className="text-base font-semibold">Sign in to accept the invitation</div>
              <p className="text-sm text-muted-foreground">
                You need a FounderOS account matching the invited email.
              </p>
              <Button onClick={() => navigate(`/login?next=/accept-invite?token=${token}`)}>Sign in</Button>
            </>
          ) : status === "ok" ? (
            <>
              <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-400" />
              <div className="font-medium">Invitation accepted</div>
              <p className="text-xs text-muted-foreground">Redirecting…</p>
            </>
          ) : status === "error" ? (
            <>
              <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
              <div className="font-medium">Could not accept invitation</div>
              <p className="text-sm text-destructive">{error}</p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
