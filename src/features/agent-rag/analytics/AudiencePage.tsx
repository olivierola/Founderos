import { useMemo, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  GlobeIcon as Globe,
  UsersIcon as Users,
  ChatIcon as MessageSquare,
  TimerIcon as Timer,
  GaugeIcon as Gauge,
  SignOutIcon as LogOut,
} from "@phosphor-icons/react";
import {
  SectionCard, Empty, BarList, Donut, StatTile, chartAxis, chartTooltip,
} from "@/features/dashboard/hq/primitives";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";
import { WorldDotMap, CountryChip } from "./WorldDotMap";
import { COUNTRY_NAMES } from "./worldGrid";
import { rampAt, useSequential } from "./vizRamps";
import { CHANNEL_LABELS, DEVICE_LABELS } from "./labels";
import { fmtDuration, fmtMs, nf, pct, type AgentAnalytics } from "./useAgentAnalytics";

// Page Audience — qui vient parler à l'agent, d'où, sur quoi, et combien de
// temps ils restent.
//
// Le pays n'est PAS une géolocalisation IP : c'est l'en-tête géo du CDN quand
// il existe, sinon le fuseau horaire du navigateur. C'est écrit sous la carte,
// parce qu'une carte donne toujours plus d'autorité au chiffre qu'il n'en
// mérite.

const DAY_FMT = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" });
const DAY_LONG = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

export function AudiencePage({ data }: { data: AgentAnalytics }) {
  const t = data.totals;
  const cat = useCategorical();
  const seq = useSequential();
  const greys = useContextGreys();
  const [hoverCountry, setHoverCountry] = useState<string | null>(null);

  const series = useMemo(
    () => data.daily.map((d) => ({
      day: d.day,
      short: DAY_FMT.format(new Date(d.day)),
      long: DAY_LONG.format(new Date(d.day)),
      conversations: d.conversations,
      visitors: d.visitors,
    })),
    [data.daily],
  );

  const bounce = pct(t.single_turn, t.total);
  const maxVisitors = Math.max(1, ...data.countries.map((c) => c.visitors));

  return (
    <div className="space-y-4">
      {/* ── Bandeau : colonne de mesures + courbe, comme un rapport d'audience ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)]">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <StatTile compact label="Visiteurs uniques" value={nf.format(t.visitors)} icon={Users} accent={cat[0]}
            sub={`sur ${data.days} jours`} />
          <StatTile compact label="Conversations" value={nf.format(t.total)} icon={MessageSquare} accent={cat[1]}
            sub={`${nf.format(t.messages)} messages échangés`} />
          <StatTile compact label="Taux de rebond" value={bounce == null ? "—" : `${bounce}%`} icon={LogOut} accent={cat[5]}
            sub="une seule question, sans suite" />
          <StatTile compact label="Durée moyenne" value={fmtDuration(t.avg_duration_s)} icon={Timer} accent={cat[6]}
            sub="de la 1re à la dernière réponse" />
          <StatTile compact label="1re réponse" value={fmtMs(t.avg_first_ms)} icon={Gauge} accent={cat[4]}
            sub="attente moyenne du visiteur" />
        </div>

        <SectionCard
          title="Évolution sur la période"
          subtitle="Conversations ouvertes et visiteurs uniques, par jour"
          className="min-h-[320px]"
        >
          {series.length === 0 ? (
            <Empty label="Aucune activité sur la période." />
          ) : (
            <>
              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="aud-conv" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={cat[0]} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={cat[0]} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="short" {...chartAxis} minTickGap={24} />
                    {/* Un seul axe : visiteurs et conversations se comptent dans
                        la même unité (des sessions), le second axe serait une
                        illusion d'optique. */}
                    <YAxis {...chartAxis} width={44} allowDecimals={false} />
                    <Tooltip
                      {...chartTooltip}
                      labelFormatter={(_v, p) => (p?.[0]?.payload as { long?: string })?.long ?? ""}
                      formatter={(v, name) => [nf.format(Number(v ?? 0)), name === "conversations" ? "Conversations" : "Visiteurs"]}
                    />
                    <Area type="monotone" dataKey="conversations" stroke={cat[0]} strokeWidth={2}
                      fill="url(#aud-conv)" dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="visitors" stroke={cat[1]} strokeWidth={2}
                      fill="none" dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: cat[0] }} />
                  Conversations<span className="font-medium tabular-nums text-foreground">{nf.format(t.total)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: cat[1] }} />
                  Visiteurs uniques<span className="font-medium tabular-nums text-foreground">{nf.format(t.visitors)}</span>
                </span>
              </div>
            </>
          )}
        </SectionCard>
      </div>

      {/* ── Carte + classement pays ── */}
      <SectionCard
        title="D'où viennent les visiteurs"
        subtitle="En-tête géographique du CDN quand il existe, sinon fuseau horaire du navigateur — une approximation, jamais une géolocalisation d'IP."
        icon={<Globe className="h-3.5 w-3.5" />}
      >
        {data.countries.length === 0 ? (
          <Empty label="Aucune provenance connue sur la période." />
        ) : (
          <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="overflow-x-auto">
              <WorldDotMap
                data={data.countries}
                height={300}
                hovered={hoverCountry}
                onHover={setHoverCountry}
              />
            </div>
            <ul className="space-y-2.5">
              {data.countries.slice(0, 8).map((c) => {
                const share = Math.round((c.visitors / maxVisitors) * 100);
                const color = rampAt(seq, c.visitors / maxVisitors);
                const on = hoverCountry === c.code;
                return (
                  <li
                    key={c.code}
                    onMouseEnter={() => setHoverCountry(c.code)}
                    onMouseLeave={() => setHoverCountry(null)}
                    className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors ${on ? "bg-muted/60" : ""}`}
                  >
                    <CountryChip code={c.code} color={color} />
                    <span className="min-w-0 flex-1 truncate text-xs">{COUNTRY_NAMES[c.code] ?? c.code}</span>
                    <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full" style={{ background: greys.empty }}>
                      <span className="block h-full rounded-full" style={{ width: `${share}%`, background: color }} />
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                      {nf.format(c.visitors)} vis.
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SectionCard>

      {/* ── Contexte de la visite ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Appareils" subtitle="Conversations par type d'écran">
          <Donut
            unit="conversations"
            total={data.devices.reduce((s, d) => s + d.n, 0)}
            slices={data.devices.map((d) => ({ label: DEVICE_LABELS[d.device] ?? d.device, value: d.n }))}
          />
        </SectionCard>

        <SectionCard title="Canaux" subtitle="Widget public, playground interne, API">
          <BarList
            labelWidth="w-28"
            emptyLabel="Aucun canal actif."
            rows={data.channels.map((c, i) => ({
              key: c.channel,
              label: CHANNEL_LABELS[c.channel] ?? c.channel,
              value: c.n,
              color: cat[Math.min(i, cat.length - 1)],
              caption: `${nf.format(c.n)} conv.`,
            }))}
          />
        </SectionCard>

        <SectionCard title="Sites hôtes" subtitle="Domaines où le widget est posé">
          <BarList
            labelWidth="w-36"
            emptyLabel="Aucun site hôte enregistré."
            rows={data.referrers.map((r) => ({
              key: r.referrer,
              label: r.referrer.replace(/^https?:\/\//, ""),
              value: r.n,
              color: seq[2],
              caption: nf.format(r.n),
            }))}
          />
        </SectionCard>
      </div>

      <SectionCard title="Pages qui déclenchent le plus de conversations" subtitle="URL nettoyée de ses paramètres — rien de ce qui suit le « ? » n'est conservé">
        <BarList
          labelWidth="w-72"
          emptyLabel="Aucune page enregistrée sur la période."
          rows={data.pages.map((p) => ({
            key: p.page,
            label: p.page.replace(/^https?:\/\//, ""),
            value: p.n,
            color: seq[3],
            caption: `${nf.format(p.n)} conv.`,
          }))}
        />
      </SectionCard>
    </div>
  );
}
