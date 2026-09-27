import { WarningIcon as Warning } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Une tuile d'indicateur des écrans ContextIQ / AgentPilot.
 *
 * La valeur reste à l'encre du texte, en chiffres proportionnels. Un état
 * d'alerte se lit par une icône ET un libellé, jamais par la seule couleur du
 * chiffre : un lecteur daltonien, une impression ou un mode contraste forcé
 * doivent voir la même chose.
 */
export function StatTile({ label, value, hint, alert }: {
  label: string;
  value: string;
  hint?: string;
  /** Libellé court de l'alerte (« à traiter »), affiché avec l'icône. */
  alert?: string | null;
}) {
  return (
    <Card>
      <CardContent className="p-3.5">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="mt-1 text-[20px] font-semibold">{value}</div>
        {alert ? (
          <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-amber-700 dark:text-amber-300">
            <Warning className="h-3 w-3 shrink-0" weight="fill" /> {alert}
          </div>
        ) : hint ? (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground/80">{hint}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 1 284 · 12,9 k — compact au-delà de dix mille. */
export const compact = (n: number): string =>
  n >= 10_000
    ? `${(n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k`
    : n.toLocaleString("fr-FR");
