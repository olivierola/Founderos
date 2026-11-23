import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRightIcon, SparkleIcon, UsersThreeIcon, CubeIcon } from "@phosphor-icons/react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Button } from "@/components/ui/button";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AgentChatInput } from "@/components/ui/agent-chat-input";
import { PAGE_PAD, PAGE_SUB, PAGE_TITLE } from "@/components/PageHeader";
import { useTeams, useLiteAgents, gatherTeam } from "@/features/service-dashboards/live/teams";
import type { AgentTeam } from "@/features/service-dashboards/model";
import { TeamzDialog, type TeamzRequest } from "./TeamzFlow";
import { CountUp } from "./ui";
import {
  ARCHITECT_PROMPTS, TEAMZ_CATALOG, formatDuration, useAppLogos, useConnectedApps, useTeamsStats,
  type TeamStats, type TeamzTemplate,
} from "./api";
import "./teamz.css";

// Teamz : des équipes d'agents spécialisés, prêtes à brancher. Trois façons
// d'en avoir une — la décrire (l'architecte), l'installer (le catalogue), ou
// la demander à l'Assistant — et un seul endroit où voir ce qu'elles font
// vraiment : exécutions, livrables, échanges, temps gagné (avec sa formule).
//
// Mise en page volontairement calme : un titre, une barre pour décrire, les
// équipes en place, le catalogue. Pas de héros, pas de halo ; la couleur
// d'une équipe n'est qu'une pastille.

export function TeamzTab({ dashboardId, dashboardName }: { dashboardId: string; dashboardName: string }) {
  const { teams } = useTeams(dashboardId);
  const { data: agents } = useLiteAgents(dashboardId);
  const { data: stats } = useTeamsStats(teams);
  const [request, setRequest] = useState<TeamzRequest | null>(null);
  const [category, setCategory] = useState<string>("Toutes");

  const totals = useMemo(() => {
    let minutes = 0, runs = 0, exchanges = 0;
    for (const t of teams) {
      const s = stats?.get(t.id);
      if (!s) continue;
      minutes += s.saved.minutes;
      runs += s.runs;
      for (const n of s.exchanges.values()) exchanges += n;
    }
    return { minutes, runs, exchanges };
  }, [teams, stats]);

  const categories = ["Toutes", ...new Set(TEAMZ_CATALOG.map((t) => t.category))];
  const catalog = TEAMZ_CATALOG.filter((t) => category === "Toutes" || t.category === category);

  return (
    <div className={cn("tz-accent", PAGE_PAD)}>
      <header className="max-w-2xl">
        <h1 className={PAGE_TITLE}>Équipes</h1>
        <p className={PAGE_SUB}>
          Des équipes d'agents prêtes à travailler. Décrivez la vôtre ou installez-en une.
        </p>
      </header>

      <ArchitectBar onDesign={(brief) => setRequest({ kind: "architect", brief })} />

      {teams.length > 0 && (
        <section className="mt-12">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <SectionTitle title="Vos équipes" />
            <div className="flex items-center gap-6 text-[12.5px] text-muted-foreground">
              <Figure label="gagnées · 30 j" hint="Exécutions réussies × minutes par exécution de chaque équipe + 15 min par livrable. Une estimation, affichée comme telle.">
                ≈ <CountUp value={Math.round(totals.minutes / 60)} /> h
              </Figure>
              <Figure label="exécutions · 30 j"><CountUp value={totals.runs} /></Figure>
              <Figure label="échanges · 7 j"><CountUp value={totals.exchanges} /></Figure>
            </div>
          </div>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
            {teams.map((t) => (
              <InstalledTeam key={t.id} team={t} stats={stats?.get(t.id)} agents={agents ?? []} dashboardId={dashboardId} dashboardName={dashboardName} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SectionTitle title="Catalogue" />
          <div className="flex flex-wrap gap-1">
            {categories.map((c) => (
              <button
                key={c} type="button" onClick={() => setCategory(c)}
                className={cn("rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                  category === c ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
          {catalog.map((t) => <TeamzCard key={t.key} template={t} dashboardId={dashboardId} onOpen={() => setRequest({ kind: "template", template: t })} />)}
        </div>
      </section>

      <TeamzDialog request={request} dashboardId={dashboardId} dashboardName={dashboardName} onClose={() => setRequest(null)} />
    </div>
  );
}

export function ArchitectBar({ onDesign }: { onDesign: (brief: string) => void }) {
  const [brief, setBrief] = useState("");
  const ready = brief.trim().length >= 12;
  // Le champ des agents (dictée, pièces jointes, longs collages en pastilles) :
  // concevoir une équipe, c'est lui écrire.
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <SparkleIcon weight="fill" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium">Concevoir une équipe sur mesure</div>
          <div className="text-[12.5px] text-muted-foreground">Dites ce qu'elle doit faire, avec quels outils et à quel rythme. Les rôles, les consignes et le flux sont proposés pour validation.</div>
        </div>
      </div>
      <AgentChatInput
        value={brief}
        onChange={setBrief}
        onSubmit={(message) => { if (message.trim().length >= 12) onDesign(message.trim()); }}
        disabled={!ready}
        placeholder="Ex. une équipe qui répond aux tickets Intercom en moins d'une heure et me fait un point chaque vendredi"
        className="max-w-none"
      />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {ARCHITECT_PROMPTS.slice(0, 3).map((p) => (
          <button
            key={p} type="button" onClick={() => setBrief(p)} title={p}
            className="max-w-[280px] truncate rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Un chiffre discret, à droite d'un titre de section. */
export function Figure({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <span title={hint} className="flex items-baseline gap-1.5">
      <span className="text-[15px] font-semibold tabular-nums text-foreground">{children}</span>
      {label}
    </span>
  );
}

export function SectionTitle({ title }: { title: string }) {
  return <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>;
}

/** Une Teamz du catalogue : ce qu'elle fait, qui la compose, avec quoi elle
 *  travaille. Le détail (rôles, prompts, flux) s'ouvre au clic. */
export function TeamzCard({ template: t, dashboardId, onOpen }: { template: TeamzTemplate; dashboardId: string; onOpen: () => void }) {
  const logos = useAppLogos();
  const { projectId } = useCurrentContext();
  const connected = useConnectedApps(projectId, dashboardId);
  return (
    <button type="button" onClick={onOpen} className="tz-card group flex flex-col p-4 text-left">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-[17px]">{t.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.accent }} />
            <span className="truncate text-[14.5px] font-semibold tracking-tight">{t.name}</span>
          </div>
          <div className="text-[11.5px] text-muted-foreground">{t.category} · {t.members.length} rôles</div>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{t.tagline}</p>
      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
        <div className="flex items-center">
          {t.members.map((m) => (
            <span key={m.key} className="-ml-1.5 rounded-full bg-card ring-2 ring-card first:ml-0" title={`${m.name}, ${m.role}`}>
              <AgentIdentity seed={m.name} size={22} interactive={false} />
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {t.plugs.slice(0, 4).map((p) => {
            const logo = logos.get(p.slug)?.logo;
            const on = connected.has(p.slug);
            return logo ? (
              <img key={p.slug} src={logo} alt={p.name} title={`${p.name}${on ? " · branché" : ""}`} className={cn("h-4 w-4 rounded object-contain", !on && "opacity-60 grayscale")} loading="lazy" />
            ) : (
              <span key={p.slug} title={p.name} className={cn("grid h-4 w-4 place-items-center rounded bg-muted text-[9px] font-semibold uppercase", on ? "text-foreground" : "text-muted-foreground")}>{p.name.slice(0, 1)}</span>
            );
          })}
          <ArrowRightIcon className="ml-1.5 h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
        </div>
      </div>
    </button>
  );
}

function InstalledTeam({ team, stats, agents, dashboardId, dashboardName }: {
  team: AgentTeam; stats: TeamStats | undefined;
  agents: Array<{ id: string; name: string; avatar_url: string | null; accent_color: string | null }>;
  dashboardId: string; dashboardName: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const base = location.pathname.replace(/\/teamz.*$/, "");
  const byId = new Map(agents.map((a) => [a.id, a]));
  const members = team.agent_ids.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  const edges = (team.links ?? []).map((l) => ({ ...l, count: stats?.exchanges.get(`${l.from}>${l.to}`) ?? 0 }));
  // Une équipe faite à la main n'a pas de flux déclaré : on montre qui l'anime.
  const shownEdges = edges.length ? edges : team.lead_id
    ? members.filter((m) => m.id !== team.lead_id).map((m) => ({ from: team.lead_id!, to: m.id, kind: "consult", count: stats?.exchanges.get(`${team.lead_id}>${m.id}`) ?? 0 }))
    : [];
  const live = stats?.live.size ?? 0;
  const [busy, setBusy] = useState(false);
  const gather = async () => {
    if (!workspaceId || !projectId) return;
    setBusy(true);
    try {
      const roomId = await gatherTeam(team, { id: dashboardId, name: dashboardName }, workspaceId, projectId, user?.id ?? null);
      if (roomId) navigate(`${base}/room/${roomId}`);
    } finally { setBusy(false); }
  };
  const exchanges = [...(stats?.exchanges.values() ?? [])].reduce((a, b) => a + b, 0);
  void shownEdges;
  // Même gabarit que les cartes du catalogue : pastille, nom, ligne de contexte,
  // deux lignes de description, puis les membres et les gestes en pied.
  return (
    <div className="tz-card flex flex-col p-4" data-live={live > 0} style={{ ["--tz-accent" as string]: team.color }}>
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[15px] font-semibold text-white" style={{ background: team.color }}>
          {team.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold tracking-tight">{team.name}</div>
          <div className="text-[11.5px] text-muted-foreground">
            {members.length} membre{members.length > 1 ? "s" : ""}{live > 0 ? ` · ${live} au travail` : ""}
          </div>
        </div>
        <span className="shrink-0 text-[12px] text-muted-foreground" title={stats ? `${stats.saved.formula} (30 jours)` : undefined}>
          <b className="font-semibold tabular-nums text-foreground">≈ {formatDuration(stats?.saved.minutes ?? 0)}</b>
        </span>
      </div>
      <p className="mt-3 line-clamp-2 min-h-[2.6em] text-[13px] leading-relaxed text-muted-foreground">
        {team.focus || "Aucun objectif écrit pour cette équipe."}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 whitespace-nowrap text-[12px] text-muted-foreground">
        <span><b className="font-semibold tabular-nums text-foreground">{stats?.runs ?? 0}</b> exécutions</span>
        <span><b className="font-semibold tabular-nums text-foreground">{stats?.deliverables ?? 0}</b> livrables</span>
        <span><b className="font-semibold tabular-nums text-foreground">{exchanges}</b> échanges</span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="flex min-w-0 items-center">
          {members.slice(0, 6).map((m) => (
            <span key={m.id} className="-ml-1.5 rounded-full bg-card ring-2 ring-card first:ml-0" title={m.id === team.lead_id ? `${m.name}, anime l'équipe` : m.name}>
              <AgentIdentity url={m.avatar_url} seed={m.name} size={22} interactive={false} />
            </span>
          ))}
          {members.length > 6 && <span className="ml-1.5 text-[11.5px] text-muted-foreground">+{members.length - 6}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" disabled={busy || !members.length} onClick={gather} title="Ouvrir une room avec toute l'équipe">
            <UsersThreeIcon className="h-3.5 w-3.5" /> Réunir
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" onClick={() => navigate(`${base}/live`)} title="Voir l'équipe dans l'espace 3D">
            <CubeIcon className="h-3.5 w-3.5" /> Live
          </Button>
        </div>
      </div>
    </div>
  );
}
