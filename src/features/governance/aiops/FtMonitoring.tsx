import { BellRing, MessagesSquare, Mail, Smartphone, Activity } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { useAlertRulesDb } from "./db";

export function GovFtMonitoringPage() {
  const { rules, toggle } = useAlertRulesDb();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Surveillance continue des modèles en production : trafic, qualité, dérives — avec alertes Slack, email et SMS."
      />

      {/* Real production telemetry only — appears once a fine-tuned model is
          deployed and emitting inference metrics. No sample data. */}
      <EmptyState
        icon={Activity}
        title="Aucune télémétrie de production"
        description="Déployez une version affinée et branchez ses métriques d'inférence pour voir ici le trafic, la qualité et les dérives en temps réel."
      />

      {/* Alert rules — real config (persisted). */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <BellRing className="h-4 w-4 text-muted-foreground" /> Règles d'alerte
        </div>
        {rules.length === 0 ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">Aucune règle d'alerte configurée.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {rules.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1 font-medium">{a.rule}</span>
                <button onClick={() => toggle(a, "slack")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.slack ? "text-foreground" : "text-muted-foreground/40 line-through")}><MessagesSquare className="h-3.5 w-3.5" />Slack</button>
                <button onClick={() => toggle(a, "email")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.email ? "text-foreground" : "text-muted-foreground/40 line-through")}><Mail className="h-3.5 w-3.5" />Email</button>
                <button onClick={() => toggle(a, "sms")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.sms ? "text-foreground" : "text-muted-foreground/40 line-through")}><Smartphone className="h-3.5 w-3.5" />SMS</button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
