// Public stats page of a public agent — /stats/:publicKey.
//
// Opt-in (widget_config.public_stats), aggregates only: the RPC
// public_agent_stats (migration 0253) enforces both, this page only draws what
// it returns. It is proof for the customer's visitors that the agent answers,
// and — through the footer — a showcase for the product.
//
// Chart: ONE series (conversations per day), so no legend box — the title
// names it; categorical slot 1 of the validated palette (vizPalette.ts); thin
// bars with rounded data-ends, recessive grid, hover tooltip with the resolved
// count, and a table view for readers who don't read charts.
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ChatsCircleIcon as Chats,
  CheckCircleIcon as CheckCircle,
  LightningIcon as Lightning,
  StarIcon as Star,
  CircleNotchIcon as Loader,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";

interface Stats {
  enabled: boolean;
  agent?: { name: string; description: string | null; accent_color: string | null };
  days?: number;
  totals?: {
    conversations: number; resolved: number; escalated: number; with_outcome: number;
    rated: number; avg_rating: number | null; median_first_ms: number | null; messages: number;
  };
  all_time_conversations?: number;
  daily?: Array<{ day: string; conversations: number; resolved: number }>;
}

const nf = new Intl.NumberFormat("fr-FR");
const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(iso));

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: ms < 10_000 ? 1 : 0 })} s`;
}

function Tile({ icon: Icon, label, value, hint }: {
  icon: typeof Chats; label: string; value: string; hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-4 w-4" /> {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function PublicAgentStatsPage() {
  const { publicKey = "" } = useParams();
  const [showTable, setShowTable] = useState(false);
  const series = useCategorical()[0];

  const { data, isLoading } = useQuery({
    queryKey: ["public_agent_stats", publicKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("public_agent_stats", { p_public_key: publicKey, p_days: 30 });
      if (error) throw error;
      return data as Stats;
    },
    staleTime: 5 * 60_000,
  });

  const daily = useMemo(() => (data?.daily ?? []).map((d) => ({ ...d, label: dayLabel(d.day) })), [data]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!data?.enabled || !data.totals || !data.agent) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-6 text-center">
        <p className="text-sm font-medium">Statistiques non publiées</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Le propriétaire de cet agent n'a pas rendu ses statistiques publiques, ou le lien est incorrect.
        </p>
      </div>
    );
  }

  const t = data.totals;
  const resolutionRate = t.with_outcome > 0 ? Math.round((t.resolved / t.with_outcome) * 100) : null;
  const cta = `/?ref=stats&agent=${encodeURIComponent(publicKey)}&utm_source=public_stats&utm_medium=footer`;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <header>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Statistiques publiques · {data.days} derniers jours</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{data.agent.name}</h1>
          {data.agent.description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{data.agent.description}</p>}
        </header>

        <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile icon={Chats} label="Conversations" value={nf.format(t.conversations)}
            hint={`${nf.format(data.all_time_conversations ?? 0)} depuis le lancement`} />
          <Tile icon={CheckCircle} label="Taux de résolution" value={resolutionRate == null ? "—" : `${resolutionRate} %`}
            hint={`${nf.format(t.resolved)} résolues sans humain`} />
          <Tile icon={Lightning} label="Première réponse" value={fmtLatency(t.median_first_ms)} hint="Médiane" />
          <Tile icon={Star} label="Note moyenne" value={t.avg_rating == null ? "—" : `${Number(t.avg_rating).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / 5`}
            hint={t.rated ? `${nf.format(t.rated)} avis` : "Pas encore d'avis"} />
        </section>

        <section className="mt-6 rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Conversations par jour</h2>
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {showTable ? "Voir le graphique" : "Voir le tableau"}
            </button>
          </div>

          {showTable ? (
            <div className="mt-4 max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-1.5 font-medium">Jour</th><th className="py-1.5 text-right font-medium">Conversations</th><th className="py-1.5 text-right font-medium">Résolues</th></tr>
                </thead>
                <tbody>
                  {daily.slice().reverse().map((d) => (
                    <tr key={d.day} className="border-t border-border/50">
                      <td className="py-1.5">{d.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{nf.format(d.conversations)}</td>
                      <td className="py-1.5 text-right tabular-nums">{nf.format(d.resolved)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={2}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload as { label: string; conversations: number; resolved: number };
                      return (
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                          <div className="font-medium text-foreground">{p.label}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-2 w-2 rounded-full" style={{ background: series }} />
                            <span className="text-foreground tabular-nums">{nf.format(p.conversations)}</span> conversations
                          </div>
                          <div className="mt-0.5 text-muted-foreground"><span className="text-foreground tabular-nums">{nf.format(p.resolved)}</span> résolues</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="conversations" fill={series} radius={[4, 4, 0, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <footer className={cn("mt-10 flex flex-col items-center gap-2 text-center")}>
          <p className="text-xs text-muted-foreground">Chiffres agrégés, mis à jour en continu. Aucune conversation n'est publiée.</p>
          <a href={cta} className="rounded-full border border-border px-4 py-2 text-xs font-medium transition-colors hover:bg-muted">
            Propulsé par <strong>Anduran</strong> — créez votre agent
          </a>
        </footer>
      </main>
    </div>
  );
}
