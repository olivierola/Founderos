import { ShieldWarningIcon as ShieldWarn, LightbulbIcon as Bulb, CheckIcon as Check, ClockIcon as Clock, XIcon as X } from "@phosphor-icons/react";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { StatTile, compact } from "@/features/governance/aiops/StatTile";

// Le tableau SentinelFlow — un livrable prédéfini (kind « soc_board »).
//
// Construit par l'outil `sentinel` à partir des alertes réellement reçues et
// triées ; le collaborateur n'y a écrit que le titre, sa lecture et ses recommandations.

export interface SocBoardDoc {
  type: "soc_board";
  title: string;
  generated_at: string;
  period_days: number;
  headline: string;
  recommendations: string[];
  totals: {
    alerts: number; occurrences: number; escalated: number; open: number;
    false_positives_proven: number; closed_fp: number; closed_resolved: number;
  };
  by_priority: Record<string, number>;
  by_category: Record<string, number>;
  by_status: Record<string, number>;
  top_hosts: Record<string, number>;
  top_rules: Record<string, number>;
  escalations: Array<{
    id: string; title: string; priority: number | null; category: string | null; host: string | null;
    src_ip: string | null; user: string | null; status: string; playbook: string | null; at: string;
  }>;
  remediations: Array<{ id: string; alert_id: string; playbook: string | null; remediation: string; status: string; created_at: string }>;
}

export function tryParseSocBoard(content: string | null | undefined): SocBoardDoc | null {
  if (!content) return null;
  try {
    const v = JSON.parse(content) as Partial<SocBoardDoc>;
    return v && v.type === "soc_board" && v.totals && Array.isArray(v.escalations) ? (v as SocBoardDoc) : null;
  } catch {
    return null;
  }
}

export const PRIORITY_LABEL = ["Faible", "Moyenne", "Haute", "Critique"];
export const CATEGORY_LABEL: Record<string, string> = {
  malware: "Logiciel malveillant", phishing: "Hameçonnage", identifiants: "Identifiants", exfiltration: "Exfiltration",
  elevation: "Élévation de privilèges", laterale: "Déplacement latéral", reconnaissance: "Reconnaissance",
  vulnerabilite: "Vulnérabilité", intrusion: "Intrusion", deni_service: "Déni de service", politique: "Politique interne",
  benin: "Activité légitime",
};
export const ALERT_STATUS_LABEL: Record<string, string> = {
  new: "Nouvelle", untriaged: "Non triée", triaged: "Triée", escalated: "Escaladée", investigating: "En enquête",
  closed_fp: "Faux positif", closed_resolved: "Résolue",
};

export function SocBoardView({ board }: { board: SocBoardDoc }) {
  const [accent] = useCategorical();
  const prio = [3, 2, 1, 0].map((p) => ({ p, n: board.by_priority[String(p)] ?? 0 }));
  const maxP = Math.max(...prio.map((x) => x.n), 1);
  const list = (m: Record<string, number>, labels?: Record<string, string>) =>
    Object.entries(m).slice(0, 8).map(([k, n]) => ({ label: labels?.[k] ?? k, n }));

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5 px-5 py-6 sm:px-8">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <ShieldWarn className="h-3.5 w-3.5" /> SentinelFlow · {board.period_days} derniers jours ·
          publié le {new Date(board.generated_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}
        </div>
        <h1 className="text-[22px] font-semibold leading-tight">{board.title}</h1>
        <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted-foreground">{board.headline}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Alertes" value={compact(board.totals.alerts)} hint={`${compact(board.totals.occurrences)} occurrences`} />
        <StatTile label="Escaladées" value={compact(board.totals.escalated)} alert={board.totals.escalated > 0 ? "analyste requis" : null} hint="aucune escalade" />
        <StatTile label="Encore ouvertes" value={compact(board.totals.open)} hint="non closes" />
        <StatTile label="Faux positifs prouvés" value={compact(board.totals.false_positives_proven)} hint="critères vérifiables" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-xl border border-border/60 p-4">
          <div className="mb-3 text-[12.5px] font-medium">Par priorité</div>
          <div className="space-y-2">
            {prio.map((x) => (
              <div key={x.p} className="grid grid-cols-[64px_minmax(0,1fr)_32px] items-center gap-2 text-[12px]" title={`${PRIORITY_LABEL[x.p]} : ${x.n}`}>
                <span>{PRIORITY_LABEL[x.p]}</span>
                <div className="h-3">{x.n > 0 && <div className="h-full rounded-r" style={{ width: `${(x.n / maxP) * 100}%`, background: accent }} />}</div>
                <span className="text-right text-muted-foreground tabular-nums">{x.n}</span>
              </div>
            ))}
          </div>
        </section>
        <CountList title="Par catégorie" items={list(board.by_category, CATEGORY_LABEL)} />
        <CountList title="Hôtes les plus touchés" items={list(board.top_hosts)} />
      </div>

      {board.recommendations.length > 0 && (
        <section className="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium"><Bulb className="h-3.5 w-3.5" /> Recommandations</div>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed">
            {board.recommendations.map((r, i) => <li key={i}>{r}</li>)}
          </ol>
        </section>
      )}

      <section className="rounded-xl border border-border/60">
        <div className="border-b border-border/60 px-4 py-2.5 text-[12.5px] font-medium">Escalades et alertes critiques</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-normal">Alerte</th>
                <th className="px-2 py-2 font-normal">Priorité</th>
                <th className="px-2 py-2 font-normal">Cible</th>
                <th className="px-2 py-2 font-normal">Procédure</th>
                <th className="px-4 py-2 font-normal">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {board.escalations.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{e.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {CATEGORY_LABEL[e.category ?? ""] ?? e.category ?? "non triée"} · {new Date(e.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5">{e.priority != null ? PRIORITY_LABEL[e.priority] : "—"}</td>
                  <td className="px-2 py-2.5 text-muted-foreground">{[e.host, e.src_ip, e.user].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-2.5">{e.playbook ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{ALERT_STATUS_LABEL[e.status] ?? e.status}</td>
                </tr>
              ))}
              {board.escalations.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Aucune escalade sur la période.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {board.remediations.length > 0 && (
        <section className="rounded-xl border border-border/60">
          <div className="border-b border-border/60 px-4 py-2.5 text-[12.5px] font-medium">Remédiations proposées</div>
          <ul className="divide-y divide-border/30 text-[12px]">
            {board.remediations.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  {r.status === "pending" ? <Clock className="h-3 w-3" /> : r.status === "rejected" ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  {r.status === "pending" ? "à valider" : r.status === "rejected" ? "refusée" : r.status === "done" ? "faite" : "validée"}
                </span>
                <span className="min-w-0 flex-1">{r.remediation}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CountList({ title, items }: { title: string; items: Array<{ label: string; n: number }> }) {
  return (
    <section className="rounded-xl border border-border/60 p-4">
      <div className="mb-3 text-[12.5px] font-medium">{title}</div>
      {items.length === 0 ? <div className="text-[12px] text-muted-foreground">—</div> : (
        <ul className="space-y-1.5 text-[12px]">
          {items.map((it) => (
            <li key={it.label} className="flex items-center justify-between gap-2">
              <span className="truncate">{it.label}</span>
              <span className="text-muted-foreground tabular-nums">{it.n}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
