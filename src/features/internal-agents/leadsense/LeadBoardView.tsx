import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FireIcon as Fire, LightbulbIcon as Bulb, TargetIcon as Target } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { StatTile, compact } from "@/features/governance/aiops/StatTile";

// Le tableau LeadSense — un livrable prédéfini (kind « lead_board »).
//
// Son contenu est construit par l'outil lead_sense à partir des prospects
// réellement qualifiés ; le collaborateur n'y a écrit que le titre, la lecture et les
// recommandations. Les chiffres ne sont donc jamais rédigés par un modèle.
// Le STATUT de chaque prospect, lui, est relu en direct et modifiable ici :
// le tableau est une photo de la qualification, pas du suivi.

export interface LeadBoardDoc {
  type: "lead_board";
  title: string;
  generated_at: string;
  period_days: number;
  headline: string;
  recommendations: string[];
  criteria: Array<{ key: string; label: string; weight: number }>;
  totals: { leads: number; qualified: number; hot: number; avg_score: number | null };
  by_tier: Record<string, number>;
  by_type: Record<string, number>;
  by_source: Record<string, number>;
  by_rep: Record<string, number>;
  leads: Array<{
    id: string; name: string | null; company: string | null; role: string | null; email: string | null;
    source: string | null; type: string; score: number | null; tier: string | null; hot: boolean;
    rep: string | null; status: string; criteria: Record<string, number>; excerpt: string; created_at: string;
  }>;
}

export function tryParseLeadBoard(content: string | null | undefined): LeadBoardDoc | null {
  if (!content) return null;
  try {
    const v = JSON.parse(content) as Partial<LeadBoardDoc>;
    return v && v.type === "lead_board" && Array.isArray(v.leads) && v.totals ? (v as LeadBoardDoc) : null;
  } catch {
    return null;
  }
}

const STATUS: Array<{ value: string; label: string }> = [
  { value: "new", label: "Nouveau" },
  { value: "contacted", label: "Contacté" },
  { value: "qualified", label: "Qualifié" },
  { value: "disqualified", label: "Écarté" },
  { value: "won", label: "Gagné" },
  { value: "lost", label: "Perdu" },
];

const SOURCE_LABEL: Record<string, string> = {
  public_agent: "Collaborateur public", crm: "CRM", form: "Formulaire", email: "E-mail", agent: "Agent",
};

export function LeadBoardView({ board }: { board: LeadBoardDoc }) {
  const qc = useQueryClient();
  const [accent] = useCategorical();
  const [filter, setFilter] = useState<"all" | "hot" | "A" | "B">("all");
  const ids = useMemo(() => board.leads.map((l) => l.id), [board.leads]);

  // Le suivi vit dans la table : un prospect contacté depuis la publication
  // doit l'être aussi ici.
  const { data: live } = useQuery({
    queryKey: ["leadsense_live", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("leadsense_leads").select("id, status, rep_name").in("id", ids);
      return new Map(((data ?? []) as Array<{ id: string; status: string; rep_name: string | null }>).map((r) => [r.id, r]));
    },
  });

  async function setStatus(id: string, status: string) {
    const { error } = await supabase.from("leadsense_leads").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["leadsense_live", ids.join(",")] });
  }

  const tiers = ["A", "B", "C", "D"].map((t) => ({ tier: t, n: board.by_tier[t] ?? 0 }));
  const maxTier = Math.max(...tiers.map((t) => t.n), 1);
  const rows = board.leads.filter((l) =>
    filter === "all" ? true : filter === "hot" ? l.hot : l.tier === filter);
  const list = (m: Record<string, number>, labels?: Record<string, string>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ label: labels?.[k] ?? k, n }));

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5 px-5 py-6 sm:px-8">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Target className="h-3.5 w-3.5" /> LeadSense · {board.period_days} derniers jours ·
          publié le {new Date(board.generated_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}
        </div>
        <h1 className="text-[22px] font-semibold leading-tight">{board.title}</h1>
        <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted-foreground">{board.headline}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Demandes reçues" value={compact(board.totals.leads)} hint="toutes sources" />
        <StatTile label="Vrais prospects" value={compact(board.totals.qualified)}
          hint={board.totals.leads ? `${Math.round((board.totals.qualified / board.totals.leads) * 100)} % des demandes` : undefined} />
        <StatTile label="À rappeler tout de suite" value={compact(board.totals.hot)} alert={board.totals.hot > 0 ? "prospects chauds" : null} hint="aucun prospect chaud" />
        <StatTile label="Score moyen" value={board.totals.avg_score == null ? "—" : `${board.totals.avg_score} / 100`} hint="des vrais prospects" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-xl border border-border/60 p-4">
          <div className="mb-3 text-[12.5px] font-medium">Répartition par rang</div>
          <div className="space-y-2">
            {tiers.map((t) => (
              <div key={t.tier} className="grid grid-cols-[20px_minmax(0,1fr)_32px] items-center gap-2 text-[12px]"
                title={`Rang ${t.tier} : ${t.n} prospect${t.n > 1 ? "s" : ""}`}>
                <span className="font-semibold">{t.tier}</span>
                <div className="h-3">
                  {t.n > 0 && <div className="h-full rounded-r" style={{ width: `${(t.n / maxTier) * 100}%`, background: accent }} />}
                </div>
                <span className="text-right text-muted-foreground tabular-nums">{t.n}</span>
              </div>
            ))}
          </div>
        </section>
        <CountList title="Par source" items={list(board.by_source, SOURCE_LABEL)} />
        <CountList title="Par commercial" items={list(board.by_rep)} />
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
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <span className="text-[12.5px] font-medium">Prospects</span>
          <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {([["all", "Tous"], ["hot", "Chauds"], ["A", "Rang A"], ["B", "Rang B"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={cn("rounded-md px-2.5 py-1 text-[11.5px]", filter === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-normal">Prospect</th>
                <th className="px-2 py-2 font-normal">Demande</th>
                <th className="px-2 py-2 text-right font-normal">Score</th>
                <th className="px-2 py-2 font-normal">Critères</th>
                <th className="px-2 py-2 font-normal">Commercial</th>
                <th className="px-4 py-2 font-normal">Suivi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {rows.map((l) => {
                const cur = live?.get(l.id);
                return (
                  <tr key={l.id} className="align-top">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 font-medium">
                        {l.hot && <span className="flex items-center gap-0.5 rounded bg-foreground px-1 text-[10px] font-semibold text-background"><Fire className="h-2.5 w-2.5" weight="fill" /> chaud</span>}
                        {l.company || l.name || l.email || "Prospect"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {[l.name && l.company ? l.name : null, l.role, SOURCE_LABEL[l.source ?? ""] ?? l.source].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="max-w-[280px] px-2 py-2.5">
                      <div className="font-medium">{l.type}</div>
                      <div className="line-clamp-2 text-[11px] text-muted-foreground">{l.excerpt}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">
                      {l.score == null ? "—" : <><span className="font-semibold">{l.score}</span> <span className="text-muted-foreground">· {l.tier}</span></>}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        {board.criteria.map((c) => l.criteria[c.key] != null && (
                          <span key={c.key} title={`${c.label} : ${l.criteria[c.key]}/3`}>{c.label} <span className="text-foreground">{l.criteria[c.key]}</span>/3</span>
                        ))}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5">{cur?.rep_name ?? l.rep ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-2.5">
                      <select value={cur?.status ?? l.status} onChange={(e) => setStatus(l.id, e.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-1.5 text-[11.5px]">
                        {STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Aucun prospect dans ce filtre.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
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
