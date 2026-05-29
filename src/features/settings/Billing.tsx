import { useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

const PLANS = [
  { id: "free", name: "Free", price: "0 €", desc: "1 project, 1 repo, manual scans." },
  { id: "starter", name: "Starter", price: "29 €/mo", desc: "2 projects, 3 repos, weekly scans." },
  { id: "pro", name: "Pro", price: "99 €/mo", desc: "5 projects, 15 repos, automatic scans, AI agent." },
  { id: "team", name: "Team", price: "299 €/mo", desc: "Multi-user, advanced audit log, runbooks." },
] as const;

export function SettingsBillingPage() {
  const { workspace, workspaceId } = useCurrentContext();
  const plan = (workspace as any)?.plan ?? "free";
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upgrade(targetPlan: string) {
    if (!workspaceId) return;
    setUpgrading(targetPlan);
    setError(null);
    try {
      const res = await callEdge<{ url: string }>("create-checkout", { workspace_id: workspaceId, plan: targetPlan });
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpgrading(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Your FounderOS subscription. Upgrade via Stripe Checkout."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((p) => (
          <Card key={p.id} className={plan === p.id ? "border-primary" : ""}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.name}</span>
                {plan === p.id && <Badge variant="default">current</Badge>}
              </div>
              <div className="mt-2 text-2xl font-semibold">{p.price}</div>
              <p className="mt-2 min-h-[40px] text-xs text-muted-foreground">{p.desc}</p>
              <Button
                size="sm"
                variant={plan === p.id ? "outline" : "default"}
                className="mt-3 w-full"
                onClick={() => upgrade(p.id)}
                disabled={upgrading !== null || p.id === "free" || plan === p.id}
              >
                {upgrading === p.id && <Loader2 className="h-4 w-4 animate-spin" />}
                {plan === p.id ? "Current" : p.id === "free" ? "Free tier" : "Upgrade"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Plans use Stripe Checkout. If a price ID isn't configured on the server, the upgrade returns a friendly error.
      </p>
    </div>
  );
}
