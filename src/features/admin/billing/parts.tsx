import { cn } from "@/lib/utils";
import { formatCredits, formatLimit, usageTone, type Entitlements } from "@/lib/billing";

/** Une jauge de quota. `limit < 0` = illimité : on n'affiche pas de barre, une
 *  barre toujours vide n'informe de rien. */
export function UsageBar({
  label, used, limit, metric, hint,
}: {
  label: string;
  used: number;
  limit: number;
  metric?: string;
  hint?: string;
}) {
  const tone = usageTone(used, limit);
  const pct = limit <= 0 ? 0 : Math.min(100, (used / limit) * 100);
  const unlimited = limit < 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span
          className={cn(
            "font-stat-number text-xs tabular-nums",
            tone === "over" ? "text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
          )}
        >
          {metric === "storage_mb" ? formatLimit(metric, used) : used.toLocaleString("fr-FR")}
          {" / "}
          {formatLimit(metric ?? "", limit)}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              tone === "over" ? "bg-destructive" : tone === "warn" ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Le bloc « crédits IA » : c'est la seule métrique qui bloque le travail des
 *  agents, elle mérite d'être lisible d'un coup d'œil. */
export function CreditsSummary({ ent }: { ent: Entitlements }) {
  const { credits, subscription } = ent;
  const tone = usageTone(credits.used, credits.included);
  const periodEnd = new Date(subscription.period_end);
  const daysLeft = Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Crédits IA restants</div>
          <div className="font-stat-number mt-1 text-3xl font-semibold tabular-nums">
            {formatCredits(credits.remaining)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCredits(credits.used)} consommés sur {formatCredits(credits.included)} inclus
            {credits.topup > 0 && ` · ${formatCredits(credits.topup)} en réserve`}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>Renouvellement dans {daysLeft} j</div>
          <div>{periodEnd.toLocaleDateString("fr-FR")}</div>
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            tone === "over" ? "bg-destructive" : tone === "warn" ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${Math.min(100, credits.percent)}%` }}
        />
      </div>

      {subscription.byo_provider_keys && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cet espace utilise ses propres clés fournisseurs : l'usage est mesuré mais pas décompté.
        </p>
      )}
      {credits.overage_used > 0 && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
          {formatCredits(credits.overage_used)} crédits en dépassement — facturés en fin de période.
        </p>
      )}
      {subscription.hard_blocked && (
        <p className="mt-2 text-xs text-destructive">
          Espace bloqué : les agents ne peuvent plus s'exécuter. Contactez le support.
        </p>
      )}
    </div>
  );
}

/**
 * L'état de l'abonnement quand il n'est pas « tout va bien ».
 *
 * Ces états viennent du webhook Stripe (migration 0200) : ils se produisent
 * pendant que personne ne regarde l'application — un prélèvement échoue la nuit,
 * une résiliation est faite au portail. Les taire, c'est laisser un client
 * découvrir la coupure au moment où son agent s'arrête.
 *
 * Rien n'est affiché sur le chemin nominal : une bannière permanente ne se lit
 * plus au bout de trois jours.
 */
export function SubscriptionNotice({
  ent, onManage, busy,
}: {
  ent: Entitlements;
  onManage?: () => void;
  busy?: boolean;
}) {
  const s = ent.subscription;
  const until = new Date(s.period_end).toLocaleDateString("fr-FR");

  const notice = s.hard_blocked
    ? {
        tone: "destructive" as const,
        title: "Espace suspendu",
        body: "Les agents ne peuvent plus s'exécuter. Régularisez le paiement ou contactez le support.",
      }
    : s.status === "past_due"
    ? {
        tone: "warn" as const,
        title: "Paiement en échec",
        body: `Votre moyen de paiement a été refusé. Sans régularisation, l'espace sera suspendu à l'issue des relances (accès maintenu jusque-là).`,
      }
    : s.cancel_at_period_end
    ? {
        tone: "warn" as const,
        title: "Abonnement résilié",
        body: `Votre offre reste active jusqu'au ${until}. Ensuite, l'espace repasse sur l'offre Découverte — vos données et vos crédits prépayés sont conservés.`,
      }
    : s.status === "paused"
    ? {
        tone: "warn" as const,
        title: "Abonnement en pause",
        body: "Les prélèvements sont suspendus. Reprenez l'abonnement pour restaurer votre allocation mensuelle.",
      }
    : null;

  if (!notice) return null;

  return (
    <div
      className={cn(
        "mb-4 rounded-lg border p-4",
        notice.tone === "destructive"
          ? "border-destructive/30 bg-destructive/5"
          : "border-amber-500/30 bg-amber-500/5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div
            className={cn(
              "text-sm font-medium",
              notice.tone === "destructive" ? "text-destructive" : "text-amber-700 dark:text-amber-500",
            )}
          >
            {notice.title}
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{notice.body}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {s.payment_action_url && (
            <a
              href={s.payment_action_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Régler la facture
            </a>
          )}
          {onManage && s.has_stripe_customer && (
            <button
              type="button"
              onClick={onManage}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Gérer l'abonnement
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Ce qu'un crédit représente concrètement — sans repère, un solde de 12 000 ne
 *  veut rien dire pour un utilisateur. */
export function CreditsExplainer({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs leading-relaxed text-muted-foreground", className)}>
      Un crédit couvre la dépense réelle chez les fournisseurs d'IA (modèles de
      langage, vectorisation, transcription). À titre de repère : une réponse
      d'agent en conversation coûte ~20 crédits, une mission complète 300 à
      800 crédits, l'indexation d'un document d'une centaine de pages ~5 crédits.
    </p>
  );
}
