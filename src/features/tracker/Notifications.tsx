import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellIcon, CheckIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatDate } from "./pickers";
import { fetchNotifications, markNotificationsRead, type PjNotification } from "./model";
import { EmptyState } from "./ui";

/**
 * La boîte de réception du suivi de travail.
 *
 * Elle ne montre QUE ce que la base a jugé notifiable (voir 0222) : un
 * changement d'état, une assignation, un commentaire — et jamais sa propre
 * action. C'est ce filtrage à la source qui fait la différence entre une
 * cloche qu'on consulte et une cloche qu'on désactive au bout d'une semaine.
 */
export function NotificationsBell({ onOpenIssue }: { onOpenIssue?: (issueId: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(true);

  const { data: items } = useQuery({
    queryKey: ["pj_notifications", unreadOnly],
    queryFn: () => fetchNotifications(unreadOnly),
    // Sans rafraîchissement, la cloche resterait figée sur l'état du chargement
    // de la page : une notification qui arrive dix minutes plus tard ne serait
    // jamais vue.
    refetchInterval: 60_000,
  });

  const { data: unread } = useQuery({
    queryKey: ["pj_notifications_unread"],
    queryFn: () => fetchNotifications(true),
    refetchInterval: 60_000,
  });

  const count = unread?.length ?? 0;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_notifications"] });
    qc.invalidateQueries({ queryKey: ["pj_notifications_unread"] });
  };

  const markAll = async () => {
    await markNotificationsRead((items ?? []).filter((n) => !n.read_at).map((n) => n.id));
    refresh();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Notifications"
          className="relative rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <BellIcon className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-9 font-medium text-primary-foreground">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex-1 text-12 font-medium">Notifications</span>
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className="text-11 text-muted-foreground hover:text-foreground"
          >
            {unreadOnly ? "Tout voir" : "Non lues"}
          </button>
          {count > 0 && (
            <button
              type="button"
              onClick={markAll}
              className="flex items-center gap-1 text-11 text-muted-foreground hover:text-foreground"
            >
              <CheckIcon className="h-3.5 w-3.5" /> Tout marquer
            </button>
          )}
        </header>

        <div className="max-h-[380px] overflow-y-auto">
          {!items?.length ? (
            // Compact, sans cadre : c'est un panneau flottant de 380 px de
            // haut, une illustration y prendrait toute la place et ferait
            // passer l'absence de notification pour un incident.
            <EmptyState
              compact
              className="border-0"
              icon={<BellIcon className="h-4 w-4" />}
              title={unreadOnly ? "Rien de nouveau" : "Aucune notification"}
              hint={unreadOnly
                ? "Tout est lu. Les nouvelles arrivées apparaîtront ici."
                : "Vous êtes prévenu quand un work item que vous suivez change d'état, reçoit un commentaire ou vous est assigné."}
            />
          ) : (
            items.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onClick={async () => {
                  if (!n.read_at) { await markNotificationsRead([n.id]); refresh(); }
                  onOpenIssue?.(n.issue_id);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  notification, onClick,
}: { notification: PjNotification; onClick: () => void }) {
  const kindLabel: Record<PjNotification["kind"], string> = {
    assigned: "Assignation",
    mentioned: "Mention",
    commented: "Commentaire",
    state: "État",
    subscribed: "Abonnement",
    approval: "À autoriser",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-muted/50",
        !notification.read_at && "bg-primary/5",
      )}
    >
      <div className="flex w-full items-center gap-2">
        {/* La pastille porte le non-lu ; le fond coloré seul ne suffirait pas
            pour qui ne distingue pas la nuance. */}
        {!notification.read_at && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
        <span className="min-w-0 flex-1 truncate text-13">{notification.title}</span>
        <span className="shrink-0 text-10 text-muted-foreground">
          {formatDate(notification.created_at)}
        </span>
      </div>
      <span className={cn(
        "text-10 uppercase tracking-wide",
        notification.kind === "approval" ? "font-medium text-amber-600" : "text-muted-foreground",
      )}>
        {kindLabel[notification.kind]}
      </span>
      {notification.body && (
        <span className="line-clamp-2 text-11 text-muted-foreground">{notification.body}</span>
      )}
    </button>
  );
}
