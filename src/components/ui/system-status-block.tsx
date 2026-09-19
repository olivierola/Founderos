import { useState } from "react";
import {
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
  WarningIcon as AlertTriangle,
  CheckCircleIcon as CheckCircle,
  CircleIcon as Circle,
  XCircleIcon as XCircle,
} from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SystemStatus = "operational" | "degraded" | "down" | "unknown";

export interface StatusService {
  name: string;
  status: SystemStatus;
  /** Chronological, oldest → newest. 1 = healthy, 0 = incident. */
  uptime?: number[];
  /** Right-aligned note on the row — a rate, a date, a volume. */
  note?: string;
}

export interface StatusIncident {
  service: string;
  /** Already formatted — this component never guesses a locale. */
  date: string;
  desc: string;
}

export interface SystemStatusBlockProps {
  title?: string;
  services: StatusService[];
  incidents?: StatusIncident[];
  /** Shown when `services` is empty — silence is not a status. */
  emptyLabel?: string;
  historyLabel?: string;
  hideLabel?: string;
  incidentsTitle?: string;
  statusLabels?: Partial<Record<SystemStatus, string>>;
  defaultOpen?: boolean;
  className?: string;
}

const DEFAULT_STATUS_LABELS: Record<SystemStatus, string> = {
  operational: "Opérationnel",
  degraded: "Dégradé",
  down: "En panne",
  unknown: "Inconnu",
};

const STATUS_ICON: Record<SystemStatus, { Icon: typeof CheckCircle; className: string }> = {
  operational: { Icon: CheckCircle, className: "text-emerald-500" },
  degraded: { Icon: AlertTriangle, className: "text-amber-500" },
  down: { Icon: XCircle, className: "text-rose-500" },
  unknown: { Icon: Circle, className: "text-muted-foreground" },
};

function UptimeBar({ history, okLabel, koLabel }: {
  history: number[]; okLabel: string; koLabel: string;
}) {
  if (history.length === 0) return null;
  return (
    <div className="mt-1 flex gap-0.5" role="img" aria-label={`${history.filter(Boolean).length}/${history.length} ${okLabel}`}>
      {history.map((v, i) => (
        <div
          key={i}
          className={cn("h-6 w-1 rounded-sm", v ? "bg-emerald-400/70" : "bg-rose-500")}
          title={v ? okLabel : koLabel}
        />
      ))}
    </div>
  );
}

export function SystemStatusBlock({
  title = "État du système",
  services,
  incidents = [],
  emptyLabel = "Rien à surveiller pour l'instant.",
  historyLabel = "Historique",
  hideLabel = "Masquer",
  incidentsTitle = "Historique des incidents",
  statusLabels,
  defaultOpen = false,
  className,
}: SystemStatusBlockProps) {
  const [showIncidents, setShowIncidents] = useState(defaultOpen);
  const labels = { ...DEFAULT_STATUS_LABELS, ...statusLabels };

  return (
    <Card className={cn("w-full", className)}>
      <CardContent className="flex flex-col gap-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold">{title}</span>
          {incidents.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowIncidents((v) => !v)}
              aria-expanded={showIncidents}
            >
              {showIncidents ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              <span className="ml-1.5 text-xs">
                {showIncidents ? hideLabel : `${historyLabel} (${incidents.length})`}
              </span>
            </Button>
          )}
        </div>

        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {services.map((svc) => {
              const { Icon, className: iconClass } = STATUS_ICON[svc.status];
              return (
                <div key={svc.name} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Icon className={cn("h-4 w-4 shrink-0", iconClass)} aria-hidden="true" />
                    <span className="truncate text-sm font-medium">{svc.name}</span>
                    <span className="text-xs text-muted-foreground">{labels[svc.status]}</span>
                    {svc.note && (
                      <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {svc.note}
                      </span>
                    )}
                  </div>
                  <UptimeBar
                    history={svc.uptime ?? []}
                    okLabel={labels.operational}
                    koLabel={labels.down}
                  />
                </div>
              );
            })}
          </div>
        )}

        {showIncidents && incidents.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg bg-accent p-4">
            <span className="mb-1 text-sm font-semibold">{incidentsTitle}</span>
            {incidents.map((inc, i) => (
              <div
                key={i}
                className="flex flex-col gap-0.5 border-b border-muted-foreground/10 pb-2 last:border-b-0 last:pb-0"
              >
                <span className="text-xs font-medium">
                  {inc.service} — {inc.date}
                </span>
                <span className="text-xs text-muted-foreground">{inc.desc}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default SystemStatusBlock;
