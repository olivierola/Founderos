import { Link } from "react-router-dom";
import { Github, Boxes, ScanLine, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const steps = [
  { icon: Boxes, title: "Create workspace", description: "Group your projects and team." },
  { icon: Github, title: "Connect GitHub", description: "Read-only access to scan your repo." },
  { icon: ScanLine, title: "Run first scan", description: "Detect stack, deps, env vars and services." },
  { icon: Sparkles, title: "Generate cockpit", description: "AI builds your admin dashboard." },
];

export function OnboardingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to FounderOS</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Four quick steps to get your SaaS cockpit ready.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <Card key={step.title}>
                <CardContent className="flex items-start gap-3 p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Step {i + 1}</div>
                    <div className="text-sm font-semibold">{step.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{step.description}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-8 flex justify-end gap-2">
          <Button variant="ghost" asChild>
            <Link to="/login">Back</Link>
          </Button>
          <Button asChild>
            <Link to="/orgs">Continue →</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
