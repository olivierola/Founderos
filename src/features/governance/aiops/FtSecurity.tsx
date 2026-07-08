import { Lock, ShieldCheck, Users, ClipboardList, BadgeCheck, Check, X } from "lucide-react";
import { ShieldStarIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { useAuditEvents } from "../shared";
import { COMPLIANCE_ITEMS, timeAgo, type FtRole } from "./data";
import { useFtRolesDb, useServersDb, useFtVersionsDb, useFtEndpointsDb } from "./db";

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange} disabled={disabled}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-[hsl(var(--accent-teal))]" : "bg-muted", disabled && "cursor-not-allowed opacity-50")}
      aria-pressed={on}
    >
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

const CAPS: { key: keyof Omit<FtRole, "role" | "members">; label: string }[] = [
  { key: "canEditDatasets", label: "Modifier les datasets" },
  { key: "canTrain", label: "Lancer un entraînement" },
  { key: "canDeploy", label: "Déployer" },
  { key: "canDeleteModel", label: "Supprimer un modèle" },
];

export function GovFtSecurityPage() {
  // Real audit trail — every studio action (train, deploy, approve, toggle…)
  // writes into gov_audit_events; we show the latest entries.
  const { data: auditEvents } = useAuditEvents();
  const audit = (auditEvents ?? []).slice(0, 12);
  // Persisted RBAC.
  const { roles, flip: flipDb } = useFtRolesDb();
  // Real approval queue: production deployments awaiting a decision.
  const { servers } = useServersDb();
  const { versions } = useFtVersionsDb(servers);
  const { endpoints, approve, reject } = useFtEndpointsDb(servers, versions);
  const approvals = endpoints.filter((e) => e.status === "pending_approval");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="Chiffrement des datasets, RBAC, audit complet, validation avant déploiement et conformité RGPD / SOC 2 / ISO 27001."
      />

      {/* Chiffrement + conformité */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Lock className="h-4 w-4 text-emerald-500" />Au repos</div>
          <p className="mt-1 text-xs text-muted-foreground">Datasets & poids chiffrés <span className="font-medium text-foreground">AES-256</span></p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Lock className="h-4 w-4 text-emerald-500" />En transit</div>
          <p className="mt-1 text-xs text-muted-foreground">TLS 1.3 sur toutes les APIs et le serving</p>
        </Card>
        {COMPLIANCE_ITEMS.map((c) => (
          <Card key={c.name} className="p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BadgeCheck className={cn("h-4 w-4", c.status === "conforme" ? "text-emerald-500" : "text-amber-500")} />{c.name}
              <Pill meta={c.status === "conforme" ? { label: "Conforme", tone: "emerald" } : { label: "En cours", tone: "amber" }} className="ml-auto px-1.5 py-0 text-[10px]" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{c.note}</p>
          </Card>
        ))}
      </div>

      {/* Approbations avant déploiement */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <ShieldStarIcon weight="duotone" className="h-4 w-4 text-muted-foreground" /> Validations en attente
          <span className="text-xs font-normal text-muted-foreground">— tout déploiement en production requiert une approbation</span>
        </div>
        {approvals.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Aucune validation en attente.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {approvals.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Déployer {e.versionName} {e.version} en production</div>
                  <div className="text-[11px] text-muted-foreground">Surface : {e.surface} · traffic {e.trafficPct}% · demandé {timeAgo(e.since)}</div>
                </div>
                <Button size="sm" className="h-8" onClick={() => void approve(e)}><Check className="mr-1.5 h-3.5 w-3.5" />Approuver</Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => void reject(e)}><X className="mr-1.5 h-3.5 w-3.5" />Rejeter</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* RBAC */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> RBAC — rôles & permissions
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Rôle</th>
                <th className="px-4 py-2.5 font-medium">Membres</th>
                {CAPS.map((c) => <th key={c.key} className="px-4 py-2.5 text-center font-medium">{c.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {roles.map((r) => (
                <tr key={r.role}>
                  <td className="px-5 py-3 font-medium">{r.role}</td>
                  <td className="px-4 py-3"><span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />{r.members}</span></td>
                  {CAPS.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-center">
                      <Toggle on={r[c.key]} onChange={() => void flipDb(r, c.key)} disabled={r.role === "Admin"} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Audit trail */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <ClipboardList className="h-4 w-4 text-muted-foreground" /> Audit
        </div>
        {audit.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Aucun événement — vos actions dans le studio apparaîtront ici.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {audit.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px]">{e.action}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{e.entity_label ?? e.entity_type ?? ""}</span>
                <span className="shrink-0 text-xs">{e.actor_name ?? "système"}</span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{timeAgo(e.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
