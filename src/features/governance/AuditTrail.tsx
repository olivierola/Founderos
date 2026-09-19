import { useMemo, useState } from "react";
import {
  ClockCounterClockwiseIcon as History,
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldAlert,
  ScrollIcon as ScrollText,
  ClipboardTextIcon as ClipboardCheck,
  GitPullRequestIcon as GitPullRequestArrow,
  SirenIcon as Siren,
  DatabaseIcon as Database,
  DotIcon as Dot,
} from "@phosphor-icons/react";
import type { Icon as LucideIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { useAuditEvents, type AuditEvent } from "./shared";
import { Select } from "./ui";

// entity_type → icon
const ENTITY_ICON: Record<string, LucideIcon> = {
  system: ShieldCheck, risk: ShieldAlert, policy: ScrollText, control: ClipboardCheck,
  approval: GitPullRequestArrow, incident: Siren, data_asset: Database,
};

// action verb → readable French label (fallback to the raw verb).
const VERB_LABEL: Record<string, string> = {
  created: "a créé", updated: "a modifié", deleted: "a supprimé",
  approved: "a approuvé", rejected: "a rejeté", changes_requested: "a demandé des modifications sur",
  requested: "a demandé la validation de", reported: "a signalé", published: "a publié",
  acknowledged: "a accusé lecture de",
};

function describe(e: AuditEvent): string {
  const verb = e.action.split(".")[1] ?? e.action;
  return VERB_LABEL[verb] ?? e.action;
}

export function GovAuditPage() {
  const { data: events, isLoading } = useAuditEvents();
  const [type, setType] = useState<string>("all");

  const visible = useMemo(
    () => (events ?? []).filter((e) => type === "all" || e.entity_type === type),
    [events, type],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Journal d'audit"
        description="Trace chronologique des actions de gouvernance : décisions, publications, changements de statut." />

      <Select value={type} onChange={(e) => setType(e.target.value)} className="h-10 w-auto">
        <option value="all">Tous les objets</option>
        <option value="system">Systèmes</option>
        <option value="risk">Risques</option>
        <option value="policy">Politiques</option>
        <option value="control">Contrôles</option>
        <option value="approval">Validations</option>
        <option value="incident">Incidents</option>
        <option value="data_asset">Données</option>
      </Select>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : visible.length === 0 ? (
        <EmptyState icon={History} title="Aucun évènement" description="Les actions de gouvernance apparaîtront ici au fur et à mesure." />
      ) : (
        <ol className="relative space-y-1 border-l pl-6">
          {visible.map((e) => {
            const Icon = (e.entity_type && ENTITY_ICON[e.entity_type]) || Dot;
            return (
              <li key={e.id} className="relative py-2">
                <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <span className="font-medium">{e.actor_name ?? "Système"}</span>
                  <span className="text-muted-foreground">{describe(e)}</span>
                  {e.entity_label && <span className="font-medium">« {e.entity_label} »</span>}
                </div>
                <time className="text-[11px] text-muted-foreground">
                  {new Date(e.created_at).toLocaleString("fr-FR")}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
