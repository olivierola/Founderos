import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  StopIcon, TerminalWindowIcon, CircleNotchIcon as Loader2, WarningCircleIcon, GlobeIcon, BrowserIcon, PlugIcon,
  ListBulletsIcon, CpuIcon, SquaresFourIcon, CaretDownIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import {
  AUDIT_TEXT, fleetApi, formatAge, formatKb, useMachineActivity,
  type Activity, type BrowserView, type Fleet, type FleetMachine, type MachineExec, type MachineJob,
} from "./api";

/** Qui est derrière une attribution : le nom de l'équipe, ou de l'agent seul. */
export function ownerLabel(fleet: Fleet, teamId: string): string {
  if (teamId.startsWith("agent-")) {
    const a = fleet.agents.find((x) => x.id === teamId.slice(6));
    return a ? `${a.name} (seul)` : "Agent seul";
  }
  return fleet.teams.find((t) => t.id === teamId)?.name ?? "Équipe";
}

type Tab = "overview" | "terminaux" | "processus" | "navigateurs" | "services" | "journal";
const TABS: Array<{ key: Tab; label: string; icon: typeof GlobeIcon }> = [
  { key: "overview", label: "Vue d'ensemble", icon: SquaresFourIcon },
  { key: "terminaux", label: "Terminaux", icon: TerminalWindowIcon },
  { key: "processus", label: "Processus", icon: CpuIcon },
  { key: "navigateurs", label: "Navigateurs", icon: BrowserIcon },
  { key: "services", label: "Services", icon: PlugIcon },
  { key: "journal", label: "Journal", icon: ListBulletsIcon },
];

type Period = "now" | "1h" | "24h" | "7d";
const PERIODS: Array<{ key: Period; label: string; ms: number }> = [
  { key: "now", label: "En ce moment", ms: 15 * 60_000 },
  { key: "1h", label: "1 h", ms: 3600_000 },
  { key: "24h", label: "24 h", ms: 86400_000 },
  { key: "7d", label: "7 jours", ms: 7 * 86400_000 },
];

const OP_LABEL: Record<string, string> = {
  exec: "commande", fs: "fichiers", "job.start": "job lancé", "job.list": "jobs listés", "job.logs": "journal lu", "job.stop": "job arrêté",
  "apt.install": "paquets", browser: "navigateur",
};

/**
 * Tout ce qui se passe sur une machine, et ce qui s'y est passé récemment :
 * les commandes des agents (leurs « terminaux »), les processus et jobs de
 * fond, les navigateurs ouverts (avec leur écran), les services en écoute,
 * le fil des opérations et le journal. Filtrable par équipe, par agent et
 * par période ; les filtres valent pour tous les onglets.
 */
export function MachineActivity({ machine, fleet, dashboardId: _d, base }: { machine: FleetMachine; fleet: Fleet; dashboardId: string; base: string }) {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("t"))?.key ?? "overview") as Tab;
  const period = (PERIODS.find((p) => p.key === params.get("p"))?.key ?? "24h") as Period;
  const team = params.get("team") ?? "";
  const agent = params.get("agent") ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  // `since` arrondi à la minute : la clé de cache ne change pas à chaque rendu.
  const since = useMemo(() => {
    const ms = PERIODS.find((p) => p.key === period)!.ms;
    return new Date(Math.floor((Date.now() - ms) / 60_000) * 60_000).toISOString();
  }, [period]);
  const { data, isLoading, error, dataUpdatedAt, isFetching } = useMachineActivity(machine.id, since);
  const navigate = useNavigate();

  const agentOf = (id: string | null) => fleet.agents.find((a) => a.id === id);
  // Les équipes et agents de CETTE machine, pour les filtres.
  const owners = useMemo(() => (data?.teams ?? []).map((t) => ({ id: t.team_id, label: ownerLabel(fleet, t.team_id) })), [data, fleet]);
  const agentsHere = useMemo(() => {
    const ids = new Set<string>();
    for (const t of data?.teams ?? []) {
      if (t.scope === "agent" && t.agent_id) ids.add(t.agent_id);
      else fleet.teams.find((x) => x.id === t.team_id)?.agent_ids.forEach((id) => ids.add(id));
    }
    return [...ids].map((id) => agentOf(id)).filter(Boolean) as Fleet["agents"];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, fleet]);

  const keep = <T extends { team_id: string; agent_id: string | null }>(x: T) => (!team || x.team_id === team) && (!agent || x.agent_id === agent);
  const f = useMemo(() => {
    if (!data) return null;
    return {
      execs: (data.execs ?? []).filter(keep),
      events: (data.events ?? []).filter(keep),
      jobs: data.jobs.filter(keep),
      processes: data.processes.filter(keep),
      listeners: (data.listeners ?? []).filter(keep),
      browsers: (data.browsers ?? []).filter(keep),
      audit: data.audit.filter((r) => (!team || r.team_id === team) && (!agent || r.agent_id === agent)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, team, agent]);

  if (isLoading && !data) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error && !data) return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error instanceof Error ? error.message : String(error)}</p>;
  if (!data || !f) return null;
  const info = data.info ?? machine.info ?? {};
  const count: Record<Tab, number | null> = {
    overview: null, terminaux: f.execs.length, processus: f.processes.length + f.jobs.filter((j) => j.running).length,
    navigateurs: f.browsers.length, services: f.listeners.length, journal: f.events.length + f.audit.length,
  };

  return (
    <div className="space-y-4">
      {!data.reachable && (
        <p className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-700 dark:text-red-400">
          <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0" /> Machine injoignable : {data.error ?? "pas de réponse"}
        </p>
      )}

      {/* Filtres : valent pour tous les onglets. */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect value={team} onChange={(v) => set("team", v)} all="Toutes les équipes" options={owners.map((o) => ({ value: o.id, label: o.label }))} />
        <FilterSelect value={agent} onChange={(v) => set("agent", v)} all="Tous les agents" options={agentsHere.map((a) => ({ value: a.id, label: a.name }))} />
        <div className="flex rounded-md bg-muted/60 p-0.5">
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => set("p", p.key === "24h" ? "" : p.key)}
              className={cn("rounded px-2.5 py-1 text-[12.5px] transition-colors", period === p.key ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          {dataUpdatedAt ? `mis à jour ${formatRelative(new Date(dataUpdatedAt).toISOString())}` : ""}
        </span>
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-border scrollbar-hide">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => set("t", t.key === "overview" ? "" : t.key)}
            className={cn("-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors",
              tab === t.key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <t.icon className="h-4 w-4" /> {t.label}
            {count[t.key] != null && count[t.key]! > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{count[t.key]}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview data={data} f={f} info={info} fleet={fleet} onTab={(t) => set("t", t)} onAgent={(id) => set("agent", id)} />}
      {tab === "terminaux" && <Terminals execs={f.execs} fleet={fleet} />}
      {tab === "processus" && <Processes f={f} fleet={fleet} dry={!!info.dry} />}
      {tab === "navigateurs" && <Browsers machine={machine} f={f} fleet={fleet} />}
      {tab === "services" && <Services listeners={f.listeners} fleet={fleet} />}
      {tab === "journal" && <Journal f={f} fleet={fleet} />}

      {data.teams.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          Personne ne travaille encore sur cette machine.{" "}
          <button className="font-medium text-primary hover:underline" onClick={() => navigate(`${base}/machines/attributions`)}>L'attribuer</button>
        </p>
      )}
    </div>
  );
}

type Filtered = {
  execs: Activity["execs"]; events: Activity["events"]; jobs: Activity["jobs"]; processes: Activity["processes"];
  listeners: Activity["listeners"]; browsers: Activity["browsers"]; audit: Activity["audit"];
};

function FilterSelect({ value, onChange, all, options }: { value: string; onChange: (v: string) => void; all: string; options: Array<{ value: string; label: string }> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-border bg-card px-2.5 text-[13px] text-foreground outline-none focus:border-primary">
      <option value="">{all}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Vue d'ensemble ───────────────────────────────────────────────────────────

function Overview({ data, f, info, fleet, onTab, onAgent }: {
  data: Activity; f: Filtered; info: NonNullable<Activity["info"]>; fleet: Fleet; onTab: (t: Tab) => void; onAgent: (id: string) => void;
}) {
  // Qui fait quoi en ce moment : une carte par agent actif.
  const busy = new Map<string, { execs: number; jobs: number; procs: number; browser: boolean; ports: number[]; team: string; last: string | null }>();
  const touch = (agentId: string, teamId: string) => {
    if (!busy.has(agentId)) busy.set(agentId, { execs: 0, jobs: 0, procs: 0, browser: false, ports: [], team: teamId, last: null });
    return busy.get(agentId)!;
  };
  f.execs.filter((e) => e.running).forEach((e) => { touch(e.agent_id, e.team_id).execs++; });
  f.jobs.filter((j) => j.running).forEach((j) => { touch(j.agent_id, j.team_id).jobs++; });
  f.processes.forEach((p) => { touch(p.agent_id, p.team_id).procs++; });
  f.browsers.forEach((b) => { touch(b.agent_id, b.team_id).browser = true; });
  f.listeners.forEach((l) => { touch(l.agent_id, l.team_id).ports.push(l.port); });
  for (const [id, v] of busy) v.last = f.events.find((e) => e.agent_id === id)?.ts ?? null;
  const failed = f.execs.filter((e) => !e.running && (e.exit_code ?? 0) !== 0).length;
  const agentOf = (id: string) => fleet.agents.find((a) => a.id === id);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr))]">
        <Stat label="Charge" value={info.load ? String(info.load[0]) : "–"} sub={info.load ? `${info.cpus ?? "?"} cœurs · 15 min ${info.load[2]}` : "–"} />
        <Stat label="Mémoire" value={info.mem ? formatKb(info.mem.total_kb - info.mem.free_kb) : "–"} sub={info.mem ? `sur ${formatKb(info.mem.total_kb)}` : "–"} />
        <Stat label="Agents actifs" value={String(busy.size)} sub={`${f.processes.length} processus`} onClick={() => onTab("processus")} />
        <Stat label="Commandes" value={String(f.execs.length)} sub={failed ? `${failed} en échec` : "sur la période"} tone={failed ? "warn" : undefined} onClick={() => onTab("terminaux")} />
        <Stat label="Navigateurs ouverts" value={String(f.browsers.length)} sub="un par agent" onClick={() => onTab("navigateurs")} />
        <Stat label="Services" value={String(f.listeners.length)} sub={f.listeners.length ? `ports ${f.listeners.slice(0, 3).map((l) => l.port).join(", ")}` : "aucun port ouvert"} onClick={() => onTab("services")} />
      </div>

      <section className="rounded-xl border border-border bg-card">
        <SectionHead title="Au travail maintenant" sub="Ce que chaque agent a d'ouvert sur la machine" />
        {busy.size === 0 ? <Empty text="Aucun agent n'a de processus, de navigateur ou de service ouvert." /> : (
          <ul className="grid gap-px bg-border/60 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
            {[...busy.entries()].map(([id, v]) => {
              const a = agentOf(id);
              return (
                <li key={id} className="bg-card">
                  <button onClick={() => onAgent(id)} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40">
                    <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? id} size={30} interactive={false} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{a?.name ?? "Agent"}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{ownerLabel(fleet, v.team)}{v.last ? ` · actif ${formatRelative(v.last)}` : ""}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {v.execs > 0 && <Chip tone="green">{v.execs} commande{v.execs > 1 ? "s" : ""} en cours</Chip>}
                        {v.jobs > 0 && <Chip tone="green">{v.jobs} job{v.jobs > 1 ? "s" : ""}</Chip>}
                        {v.browser && <Chip tone="violet">navigateur ouvert</Chip>}
                        {v.ports.map((p) => <Chip key={p}>:{p}</Chip>)}
                        {v.procs > 0 && <Chip>{v.procs} processus</Chip>}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        <section className="rounded-xl border border-border bg-card">
          <SectionHead title="Dernières commandes" sub="Les terminaux des agents" action={{ label: "Tout voir", onClick: () => onTab("terminaux") }} />
          {f.execs.length === 0 ? <Empty text="Aucune commande sur la période." /> : (
            <ul className="divide-y divide-border/60">{f.execs.slice(0, 6).map((e) => <ExecRow key={e.id} e={e} fleet={fleet} compact />)}</ul>
          )}
        </section>
        <section className="rounded-xl border border-border bg-card">
          <SectionHead title="Dernières opérations" sub="Fichiers, navigateur, jobs" action={{ label: "Tout voir", onClick: () => onTab("journal") }} />
          {f.events.length === 0 ? <Empty text="Rien sur la période." /> : (
            <ul className="divide-y divide-border/60">{f.events.filter((e) => e.op !== "exec").slice(0, 8).map((e, i) => <EventRow key={`${e.ts}${i}`} e={e} fleet={fleet} />)}</ul>
          )}
        </section>
      </div>
      {data.teams.length > 0 && info.uptime_s != null && (
        <p className="text-[12px] text-muted-foreground">Machine allumée depuis {formatAge(info.uptime_s)}. L'historique garde les 1 000 dernières commandes et 4 000 opérations.</p>
      )}
    </div>
  );
}

// ── Terminaux ────────────────────────────────────────────────────────────────

function Terminals({ execs, fleet }: { execs: MachineExec[]; fleet: Fleet }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [q, setQ] = useState("");
  const list = execs.filter((e) => (!onlyFailed || (!e.running && (e.exit_code ?? 0) !== 0)) && (!q || e.command.toLowerCase().includes(q.toLowerCase())));
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher une commande"
          className="h-8 min-w-[200px] flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus:border-primary" />
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" /> en échec seulement
        </label>
      </div>
      {list.length === 0 ? <Empty text="Aucune commande ne correspond." /> : (
        <ul className="divide-y divide-border/60">{list.map((e) => <ExecRow key={e.id} e={e} fleet={fleet} />)}</ul>
      )}
    </section>
  );
}

function ExecRow({ e, fleet, compact }: { e: MachineExec; fleet: Fleet; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const a = fleet.agents.find((x) => x.id === e.agent_id);
  const ok = !e.running && (e.exit_code ?? 0) === 0 && !e.timed_out;
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40">
        {open ? <CaretDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <CaretRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? e.user} size={20} interactive={false} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{e.command}</span>
        {!compact && <span className="hidden max-w-[120px] shrink-0 truncate text-[12px] text-muted-foreground md:block">{a?.name ?? e.user}</span>}
        <span className={cn("status-mono shrink-0 rounded px-1.5 py-0.5",
          e.running ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : ok ? "bg-muted text-muted-foreground" : "bg-red-500/10 text-red-700 dark:text-red-400")}>
          {e.running ? "running" : e.interrupted ? "interrompue" : e.timed_out ? "timeout" : `exit ${e.exit_code ?? e.signal ?? "?"}`}
        </span>
        {!compact && <span className="hidden w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground sm:block">{e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(1)} s` : ""}</span>}
        <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{formatRelative(e.started_at)}</span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-100 scrollbar-hide">
            <span className="text-emerald-400">{e.user}</span><span className="text-zinc-500">:</span><span className="text-sky-400">{e.cwd}</span><span className="text-zinc-500">$ </span>{e.command}
            {"\n"}{e.running ? <span className="text-zinc-500">… en cours</span> : e.stdout || (e.stderr ? "" : <span className="text-zinc-500">(pas de sortie)</span>)}
            {e.stderr && <span className="text-red-400">{e.stdout ? "\n" : ""}{e.stderr}</span>}
          </pre>
          <p className="mt-1 text-[11.5px] text-muted-foreground">La fin de la sortie seulement (4 000 caractères au plus).</p>
        </div>
      )}
    </li>
  );
}

// ── Processus ────────────────────────────────────────────────────────────────

function Processes({ f, fleet, dry }: { f: Filtered; fleet: Fleet; dry: boolean }) {
  const [logsOf, setLogsOf] = useState<MachineJob | null>(null);
  const agentOf = (id: string | null) => fleet.agents.find((a) => a.id === id);
  // Par agent : ce que chacun consomme.
  const byAgent = new Map<string, { cpu: number; rss: number; n: number }>();
  for (const p of f.processes) {
    const v = byAgent.get(p.agent_id) ?? { cpu: 0, rss: 0, n: 0 };
    v.cpu += p.cpu_s; v.rss += p.rss_kb; v.n++;
    byAgent.set(p.agent_id, v);
  }
  return (
    <div className="space-y-5">
      {byAgent.size > 0 && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]">
          {[...byAgent.entries()].sort((a, b) => b[1].rss - a[1].rss).map(([id, v]) => {
            const a = agentOf(id);
            return (
              <div key={id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? id} size={26} interactive={false} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">{a?.name ?? "Agent"}</div>
                  <div className="text-[11.5px] tabular-nums text-muted-foreground">{v.n} processus · {formatKb(v.rss)} · {v.cpu.toFixed(0)} s CPU</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card">
        <SectionHead title="Processus de fond" sub="Serveurs, entraînements, watchers lancés par les agents" />
        {f.jobs.length === 0 ? <Empty text="Aucun processus de fond." /> : (
          <ul className="divide-y divide-border/60">
            {f.jobs.map((j) => {
              const a = agentOf(j.agent_id);
              return (
                <li key={`${j.agent_id}:${j.id}`} className="flex items-center gap-3 px-4 py-2.5">
                  <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? j.user} size={22} interactive={false} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{j.label || j.command}</div>
                    <div className="truncate text-[11.5px] text-muted-foreground">
                      {a?.name ?? j.user} · {ownerLabel(fleet, j.team_id)}{j.label && <span className="ml-1.5 font-mono">{j.command}</span>}
                    </div>
                  </div>
                  <span className={cn("status-mono shrink-0 rounded px-1.5 py-0.5",
                    j.running ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : j.exit_code === 0 ? "bg-muted text-muted-foreground" : "bg-red-500/10 text-red-700 dark:text-red-400")}>
                    {j.running ? "running" : `exit ${j.exit_code ?? "?"}`}
                  </span>
                  <span className="hidden shrink-0 whitespace-nowrap text-right text-[12px] text-muted-foreground sm:block">{formatRelative(j.started_at)}</span>
                  <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 px-2 text-[12.5px]" onClick={() => setLogsOf(j)}>
                    <TerminalWindowIcon className="h-3.5 w-3.5" /> Journal
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <SectionHead title="Processus" sub="Tout ce qui tourne sous le compte d'un agent, le plus gourmand d'abord" />
        {f.processes.length === 0 ? (
          <Empty text={dry ? "Machine en mode test (dry) : pas de processus réels." : "Aucun processus d'agent en cours."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead>
                <tr className="border-b border-border/60 text-left text-[11.5px] text-muted-foreground">
                  <th className="px-4 py-2 font-normal">PID</th>
                  <th className="px-2 py-2 font-normal">Agent</th>
                  <th className="px-2 py-2 font-normal">Commande</th>
                  <th className="px-2 py-2 text-right font-normal">CPU</th>
                  <th className="px-2 py-2 text-right font-normal">Mémoire</th>
                  <th className="px-4 py-2 text-right font-normal">Âge</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {f.processes.map((p) => (
                  <tr key={p.pid}>
                    <td className="px-4 py-1.5 font-mono tabular-nums text-muted-foreground">{p.pid}</td>
                    <td className="max-w-[140px] truncate px-2 py-1.5">{agentOf(p.agent_id)?.name ?? p.user}</td>
                    <td className="max-w-[420px] truncate px-2 py-1.5 font-mono text-[12px]" title={p.command}>
                      {/chrom(e|ium)|headless_shell/i.test(p.command) && <BrowserIcon className="mr-1 inline h-3.5 w-3.5 text-violet-500" />}{p.command}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{p.cpu_s} s</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatKb(p.rss_kb)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAge(p.age_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <JobLogsDialog job={logsOf} onClose={() => setLogsOf(null)} fleet={fleet} />
    </div>
  );
}

// ── Navigateurs ──────────────────────────────────────────────────────────────

function Browsers({ machine, f, fleet }: { machine: FleetMachine; f: Filtered; fleet: Fleet }) {
  const recent = f.events.filter((e) => e.op === "browser");
  return (
    <div className="space-y-5">
      {f.browsers.length === 0 ? (
        <div className="rounded-xl border border-border bg-card"><Empty text="Aucun navigateur ouvert en ce moment. Un agent l'ouvre avec team_browser ; il se ferme après 10 minutes sans action." /></div>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr))]">
          {f.browsers.map((b) => <LiveBrowser key={`${b.team_id}:${b.agent_id}`} machineId={machine.id} b={b} fleet={fleet} />)}
        </div>
      )}
      <section className="rounded-xl border border-border bg-card">
        <SectionHead title="Navigation récente" sub="Les pages ouvertes et les actions des agents sur la période" />
        {recent.length === 0 ? <Empty text="Aucune navigation sur la période." /> : (
          <ul className="divide-y divide-border/60">{recent.map((e, i) => <EventRow key={`${e.ts}${i}`} e={e} fleet={fleet} />)}</ul>
        )}
      </section>
    </div>
  );
}

function LiveBrowser({ machineId, b, fleet }: { machineId: string; b: { team_id: string; agent_id: string; user: string }; fleet: Fleet }) {
  const [view, setView] = useState<BrowserView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const a = fleet.agents.find((x) => x.id === b.agent_id);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const v = await fleetApi.browserView(machineId, b.team_id, b.agent_id);
        if (alive) { setView(v); setErr(null); }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // L'écran se rafraîchit toutes les 5 s tant que la carte est affichée.
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, [machineId, b.team_id, b.agent_id]);
  const active = view?.tabs?.find((t) => t.active);
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2">
        <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? b.user} size={22} interactive={false} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{a?.name ?? b.user}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{active?.url ?? "…"}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> en direct
        </span>
      </div>
      <div className="relative aspect-[16/10] bg-muted/40">
        {view?.image ? (
          <img src={`data:image/jpeg;base64,${view.image}`} alt={active?.title ?? "page"} className="h-full w-full object-cover object-top" />
        ) : (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
            {err ? err : view && !view.open ? "Navigateur fermé" : <Loader2 className="h-5 w-5 animate-spin" />}
          </div>
        )}
      </div>
      {view?.tabs && view.tabs.length > 0 && (
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {view.tabs.map((t) => (
            <li key={t.index} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <GlobeIcon className={cn("h-3.5 w-3.5 shrink-0", t.active ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("min-w-0 flex-1 truncate", t.active && "font-medium")}>{t.title || "(sans titre)"}</span>
              <span className="max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">{t.url}</span>
            </li>
          ))}
        </ul>
      )}
      {view?.idle_s != null && <p className="px-3 py-1.5 text-[11px] text-muted-foreground">Dernière action de l'agent il y a {formatAge(view.idle_s)}</p>}
    </article>
  );
}

// ── Services ─────────────────────────────────────────────────────────────────

function Services({ listeners, fleet }: { listeners: Activity["listeners"]; fleet: Fleet }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <SectionHead title="Services en écoute" sub="Les serveurs que les agents ont lancés, joignables depuis la machine (http://localhost:port)" />
      {listeners.length === 0 ? <Empty text="Aucun port ouvert par un agent." /> : (
        <ul className="divide-y divide-border/60">
          {listeners.map((l) => {
            const a = fleet.agents.find((x) => x.id === l.agent_id);
            return (
              <li key={`${l.pid}:${l.port}`} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-16 shrink-0 font-mono text-[14px] font-medium tabular-nums">:{l.port}</span>
                <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? l.user} size={20} interactive={false} />
                <span className="w-28 shrink-0 truncate text-[12.5px]">{a?.name ?? l.user}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground" title={l.command}>{l.command}</span>
                <Chip>{l.address === "localhost" ? "local" : l.address === "toutes" ? "toutes interfaces" : l.address}</Chip>
                <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">pid {l.pid}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────

function Journal({ f, fleet }: { f: Filtered; fleet: Fleet }) {
  const [onlyErrors, setOnlyErrors] = useState(false);
  type Line = { ts: string; kind: "op"; e: Activity["events"][number] } | { ts: string; kind: "audit"; r: Activity["audit"][number] };
  const lines: Line[] = [
    ...f.events.map((e) => ({ ts: e.ts, kind: "op" as const, e })),
    ...f.audit.map((r) => ({ ts: r.created_at, kind: "audit" as const, r })),
  ].filter((l) => !onlyErrors || (l.kind === "op" && l.e.status >= 400) || (l.kind === "audit" && l.r.action === "access_refused"))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold tracking-tight">Journal</h2>
          <p className="text-[12px] text-muted-foreground">Chaque opération des agents, et les actions des humains et de la plateforme</p>
        </div>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" /> erreurs seulement
        </label>
      </div>
      {lines.length === 0 ? <Empty text="Rien sur la période." /> : (
        <ul className="divide-y divide-border/60">
          {lines.slice(0, 400).map((l, i) => l.kind === "op"
            ? <EventRow key={`o${i}`} e={l.e} fleet={fleet} />
            : <AuditRow key={`a${l.r.id}`} r={l.r} fleet={fleet} />)}
        </ul>
      )}
    </section>
  );
}

function EventRow({ e, fleet }: { e: Activity["events"][number]; fleet: Fleet }) {
  const a = fleet.agents.find((x) => x.id === e.agent_id);
  const failed = e.status >= 400;
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
      <span className="w-28 shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{formatRelative(e.ts)}</span>
      <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? e.user ?? "?"} size={18} interactive={false} />
      <span className="w-24 shrink-0 truncate">{a?.name ?? e.user}</span>
      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px]", e.op === "browser" ? "bg-violet-500/10 text-violet-700 dark:text-violet-400" : "bg-muted text-muted-foreground")}>
        {OP_LABEL[e.op] ?? e.op}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={e.detail}>{e.detail}</span>
      {failed && <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-700 dark:text-red-400">{e.code ?? e.status}</span>}
      <span className="hidden w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground sm:block">{e.ms} ms</span>
    </li>
  );
}

function AuditRow({ r, fleet }: { r: Activity["audit"][number]; fleet: Fleet }) {
  const a = fleet.agents.find((x) => x.id === r.agent_id);
  const d = r.detail ?? {};
  const extra = typeof d.path === "string" ? d.path : typeof d.machine === "string" ? String(d.machine) : Array.isArray(d.packages) ? (d.packages as string[]).join(", ") : "";
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
      <span className="w-28 shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{formatRelative(r.created_at)}</span>
      <span className="min-w-0 flex-1 truncate">
        <b className="font-medium">{r.user_id ? "Un humain" : a?.name ?? "La plateforme"}</b>{" "}
        {AUDIT_TEXT[r.action] ?? r.action}
        {r.user_id && a ? <> par les yeux de <b className="font-medium">{a.name}</b></> : null}
        {extra ? <span className="ml-1.5 font-mono text-[12px] text-muted-foreground">{extra}</span> : null}
      </span>
      <span className="hidden shrink-0 text-[11.5px] text-muted-foreground md:block">{ownerLabel(fleet, r.team_id)}</span>
    </li>
  );
}

// ── Morceaux ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, tone, onClick }: { label: string; value: string; sub: string; tone?: "warn"; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={cn("rounded-xl border border-border bg-card p-4 text-left", onClick && "transition-colors hover:border-primary/40")}>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="mt-2 text-[22px] font-semibold leading-none tracking-tight tabular-nums">{value}</div>
      <div className={cn("mt-1.5 truncate text-[12px]", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{sub}</div>
    </Tag>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "green" | "violet" }) {
  return (
    <span className={cn("rounded-md px-1.5 py-0.5 text-[11px]",
      tone === "green" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : tone === "violet" ? "bg-violet-500/10 text-violet-700 dark:text-violet-400" : "bg-muted text-muted-foreground")}>
      {children}
    </span>
  );
}

function SectionHead({ title, sub, action }: { title: string; sub: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-end gap-3 border-b border-border/60 px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
        <p className="text-[12px] text-muted-foreground">{sub}</p>
      </div>
      {action && <button onClick={action.onClick} className="shrink-0 text-[12px] font-medium text-primary hover:underline">{action.label}</button>}
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{text}</p>;

function JobLogsDialog({ job, onClose, fleet }: { job: MachineJob | null; onClose: () => void; fleet: Fleet }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = job ? `${job.agent_id}:${job.id}` : null;

  const load = async () => {
    if (!job) return;
    setLoading(true);
    try {
      const r = await fleetApi.jobLogs(job.team_id, job.agent_id, job.id);
      setOutput(r.job.output || "(journal vide)");
    } catch (e) {
      setOutput(`Journal illisible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOutput(null); if (job) void load(); }, [key]);

  const stop = async () => {
    if (!job) return;
    if (!(await confirm({ title: "Arrêter ce processus ?", description: job.command, confirmText: "Arrêter" }))) return;
    try {
      await fleetApi.jobStop(job.team_id, job.agent_id, job.id);
      toast.success("Processus arrêté");
      onClose();
    } catch (e) {
      toast.error("Arrêt impossible", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={!!job} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{job?.label || job?.command}</DialogTitle>
          <DialogDescription className="truncate font-mono text-[12px]">
            {job ? `${fleet.agents.find((a) => a.id === job.agent_id)?.name ?? job.user} · pid ${job.pid} · ${job.running ? "en cours" : `terminé (${job.exit_code ?? "?"})`}` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-100 scrollbar-hide">
          {loading && !output ? "Lecture du journal…" : output}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>Rafraîchir</Button>
          {job?.running && (
            <Button variant="destructive" size="sm" onClick={stop}><StopIcon className="mr-1.5 h-3.5 w-3.5" /> Arrêter</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
