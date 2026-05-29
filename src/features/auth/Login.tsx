import { useState, type FormEvent } from "react";
import { Navigate, Link, useNavigate } from "react-router-dom";
import { Boxes, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export function LoginPage() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authLoading && session) {
    return <Navigate to="/orgs" replace />;
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate("/orgs", { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-semibold">FounderOS</div>
            <div className="text-xs text-muted-foreground">SaaS cockpit for builders</div>
          </div>
        </div>

        <Card>
          <CardContent className="p-6">
            <h1 className="text-xl font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your repo, we generate your admin cockpit.
            </p>

            <form onSubmit={handleLogin} className="mt-6 space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="email">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@founder.dev"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="password">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting || !email || !password}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Sign in
              </Button>
            </form>

            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

            <p className="mt-6 text-center text-xs text-muted-foreground">
              No account?{" "}
              <Link to="/signup" className="text-foreground underline-offset-4 hover:underline">
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
