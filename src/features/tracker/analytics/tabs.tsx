import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DownloadSimpleIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { ProjectLogo } from "../LogoPicker";
import { MemberAvatar, formatDate, memberName } from "../pickers";
import { downloadCsv } from "../exportIssues";
import { BarChart, ChartLegend, LollipopChart, type BarDatum, type LollipopDatum } from "./charts";
import { TextField } from "../ui";
import {
  HEALTH, type AnalyticsCycle, type AnalyticsMember, type AnalyticsModule,
  type AnalyticsRow, type Member,
} from "../model";

/**
 * Les six onglets de découpe d'Analytics.
 *
 * Ils partagent une même charpente — bandeau de chiffres, graphe, table
 * cherchable et exportable — et ne diffèrent que par ce qu'ils comptent. Cette
 * régularité n'est pas de l'économie de code : c'est ce qui fait qu'on sait
 * lire le sixième onglet après avoir vu le premier.
 */

// ── Charpente commune ───────────────────────────────────────────────────────

export function TabShell({
  title, stats, children,
}: {
  title: string;
  /**
   * Une valeur peut être un NOMBRE ou un texte déjà mis en forme.
   *
   * Les six onglets d'origine ne comptaient que des entiers, d'où le `number`
   * initial. L'onglet Agents, lui, affiche un coût, un pourcentage et une
   * durée : les forcer en entiers donnerait « 0 » pour douze centimes. Le ton
   * d'alerte ne s'applique qu'aux nombres, seul cas où « supérieur à zéro »
   * veut dire quelque chose.
   */
  stats: { label: string; value: number | string; tone?: "warn" | "danger" }[];
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="pb-3 text-18 font-semibold tracking-tight">{title}</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-12 text-muted-foreground">{s.label}</p>
              <p className={cn(
                "pt-1 text-24 font-semibold tabular-nums",
                s.tone === "warn" && typeof s.value === "number" && s.value > 0 && "text-amber-600",
                s.tone === "danger" && typeof s.value === "number" && s.value > 0 && "text-red-600",
              )}>
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </section>
      {children}
    </div>
  );
}

/**
 * La table du bas : recherche à gauche, export à droite.
 *
 * L'export porte sur les lignes FILTRÉES, comme partout ailleurs dans le
 * module : on cherche, on regarde, on exporte ce qu'on regarde.
 */
export function DataTable<T>({
  rows, columns, filename, search, onSearch, empty, onRowClick, activeRow,
}: {
  rows: T[];
  columns: { key: string; label: string; align?: "right"; render: (row: T) => React.ReactNode;
    value: (row: T) => string | number }[];
  filename: string;
  search: string;
  onSearch: (v: string) => void;
  empty: string;
  /** Rend la LIGNE ENTIÈRE cliquable. Sans lui, la table reste inerte : c'est
   *  ce qui distingue un tableau qu'on lit d'un tableau qu'on explore. */
  onRowClick?: (row: T) => void;
  /** La ligne dont le panneau est ouvert, marquée pour qu'on sache d'où il
   *  vient — un panneau latéral sans origine visible se lit comme un écran de
   *  plus, et on perd le fil en le refermant. */
  activeRow?: (row: T) => boolean;
}) {
  const exportCsv = () => {
    const header = columns.map((c) => c.label).join(";");
    const body = rows.map((r) =>
      columns.map((c) => {
        const v = String(c.value(r));
        return /[",;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(";"));
    downloadCsv(filename, [header, ...body].join("\r\n"));
  };

  return (
    <section>
      <div className="flex items-center gap-2 pb-3">
        <div className="relative w-72 max-w-full">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <TextField
            value={search} onChange={(e) => onSearch(e.target.value)}
            placeholder="Rechercher" className="h-8 pl-8 text-12"
          />
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={exportCsv}
          disabled={!rows.length}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <DownloadSimpleIcon className="h-4 w-4" /> Exporter en CSV
        </button>
      </div>

      {!rows.length ? (
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-8 text-center text-12 text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-13">
            <thead>
              <tr className="border-b border-border text-11 text-muted-foreground">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={cn("pb-2.5 font-medium", c.align === "right" ? "text-right" : "text-left")}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={cn(
                    "border-b border-border/40 last:border-0 hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                    activeRow?.(r) && "bg-primary/8 hover:bg-primary/8",
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn("py-2.5", c.align === "right" && "text-right tabular-nums")}
                    >
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Le nom d'un projet avec son emoji : le même rendu partout, pour qu'un projet
 *  se reconnaisse d'un onglet à l'autre. */
export function ProjectCell({
  name, logo,
}: { name: string; logo: Record<string, unknown> | null | undefined }) {
  return (
    <span className="flex items-center gap-2">
      <ProjectLogo logo={logo} size={14} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function LeadCell({ userId, members }: { userId: string | null; members: Member[] }) {
  const member = members.find((m) => m.user_id === userId);
  if (!member) return <span className="text-12 text-muted-foreground">Non assigné</span>;
  return (
    <span className="flex items-center gap-1.5">
      <MemberAvatar member={member} /> <span className="truncate">{memberName(member)}</span>
    </span>
  );
}

// ── Projets ─────────────────────────────────────────────────────────────────

export function ProjectsTab({ rows }: { rows: AnalyticsRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = rows.filter((r) =>
    !search.trim() || r.project_name.toLowerCase().includes(search.toLowerCase()));

  const byHealth: BarDatum[] = HEALTH.map((h) => ({
    label: h.label,
    value: rows.filter((r) => r.health === h.key).length,
    color: h.color,
  }));
  // Les projets sans santé déclarée sont une catégorie à part entière : les
  // omettre laisserait croire que tout le monde s'est prononcé.
  byHealth.push({
    label: "Non renseignée",
    value: rows.filter((r) => !r.health).length,
    color: "#6b7180",
  });

  return (
    <TabShell
      title="Projets"
      stats={[
        { label: "Total", value: rows.length },
        { label: "On track", value: rows.filter((r) => r.health === "on_track").length },
        { label: "At risk", value: rows.filter((r) => r.health === "at_risk").length, tone: "warn" },
        { label: "Off track", value: rows.filter((r) => r.health === "off_track").length, tone: "danger" },
      ]}
    >
      <section>
        <h3 className="pb-3 text-14 font-medium">Projets par santé</h3>
        <BarChart data={byHealth} yLabel="Nb de projets" xLabel="Santé" />
      </section>

      <DataTable
        rows={filtered}
        filename="analytics-projets"
        search={search} onSearch={setSearch}
        empty="Aucun projet ne correspond."
        columns={[
          {
            key: "name", label: "Nom",
            render: (r) => <ProjectCell name={r.project_name} logo={r.logo_props} />,
            value: (r) => r.project_name,
          },
          {
            key: "progress", label: "Avancement", align: "right",
            render: (r) => `${r.issues ? Math.round((r.completed / r.issues) * 100) : 0}%`,
            value: (r) => (r.issues ? Math.round((r.completed / r.issues) * 100) : 0),
          },
          { key: "members", label: "Membres", align: "right", render: (r) => r.members, value: (r) => r.members },
          { key: "epics", label: "Epics", align: "right", render: (r) => r.epics, value: (r) => r.epics },
          { key: "issues", label: "Work items", align: "right", render: (r) => r.issues, value: (r) => r.issues },
          { key: "cycles", label: "Cycles", align: "right", render: (r) => r.cycles, value: (r) => r.cycles },
          { key: "modules", label: "Modules", align: "right", render: (r) => r.modules, value: (r) => r.modules },
          { key: "pages", label: "Pages", align: "right", render: (r) => r.pages, value: (r) => r.pages },
          { key: "views", label: "Vues", align: "right", render: (r) => r.views, value: (r) => r.views },
          { key: "intake", label: "Intake", align: "right", render: (r) => r.intake, value: (r) => r.intake },
        ]}
      />
    </TabShell>
  );
}

// ── Cycles ──────────────────────────────────────────────────────────────────

const CYCLE_PHASES: { key: AnalyticsCycle["phase"]; label: string; color: string }[] = [
  { key: "current", label: "En cours", color: "#eda100" },
  { key: "upcoming", label: "À venir", color: "#4b7fd6" },
  { key: "completed", label: "Terminé", color: "#3e9b4f" },
  { key: "draft", label: "Brouillon", color: "#8b8f99" },
];

export function CyclesTab({
  cycles, members,
}: { cycles: AnalyticsCycle[]; members: Member[] }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 8;

  const filtered = cycles.filter((c) =>
    !search.trim() || c.name.toLowerCase().includes(search.toLowerCase()));

  const shown = filtered.slice(page * perPage, (page + 1) * perPage);
  const points: LollipopDatum[] = shown.map((c) => ({
    label: c.name,
    value: c.percent,
    color: CYCLE_PHASES.find((p) => p.key === c.phase)?.color ?? "#8b8f99",
  }));

  return (
    <TabShell
      title="Cycles"
      stats={[
        { label: "Total", value: cycles.length },
        { label: "En cours", value: cycles.filter((c) => c.phase === "current").length },
        { label: "À venir", value: cycles.filter((c) => c.phase === "upcoming").length },
        { label: "Terminés", value: cycles.filter((c) => c.phase === "completed").length },
      ]}
    >
      <section>
        <Paginated
          title="Avancement des cycles"
          page={page} perPage={perPage} total={filtered.length} onPage={setPage}
        />
        <LollipopChart data={points} yLabel="Avancement %" />
        <ChartLegend items={CYCLE_PHASES} />
      </section>

      <DataTable
        rows={filtered}
        filename="analytics-cycles"
        search={search} onSearch={setSearch}
        empty="Aucun cycle ne correspond."
        columns={[
          { key: "name", label: "Cycle", render: (c) => c.name, value: (c) => c.name },
          {
            key: "lead", label: "Responsable",
            render: (c) => <LeadCell userId={c.lead_id} members={members} />,
            value: (c) => memberName(members.find((m) => m.user_id === c.lead_id)),
          },
          {
            key: "project", label: "Projet",
            render: (c) => <ProjectCell name={c.project_name} logo={c.project_logo} />,
            value: (c) => c.project_name,
          },
          { key: "start", label: "Début", render: (c) => formatDate(c.start_date), value: (c) => c.start_date ?? "" },
          { key: "end", label: "Fin", render: (c) => formatDate(c.end_date), value: (c) => c.end_date ?? "" },
          { key: "percent", label: "Avancement", align: "right", render: (c) => `${c.percent}%`, value: (c) => c.percent },
        ]}
      />
    </TabShell>
  );
}

// ── Modules ─────────────────────────────────────────────────────────────────

const MODULE_STATUSES: { key: AnalyticsModule["status"]; label: string; color: string }[] = [
  { key: "backlog", label: "Backlog", color: "#8b8f99" },
  { key: "planned", label: "Planifié", color: "#4b7fd6" },
  { key: "in-progress", label: "En cours", color: "#eda100" },
  { key: "paused", label: "En pause", color: "#8c8fa4" },
  { key: "completed", label: "Terminé", color: "#3e9b4f" },
  { key: "cancelled", label: "Annulé", color: "#e34948" },
];

export function ModulesTab({
  modules, members,
}: { modules: AnalyticsModule[]; members: Member[] }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 8;

  const filtered = modules.filter((m) =>
    !search.trim() || m.name.toLowerCase().includes(search.toLowerCase()));

  const shown = filtered.slice(page * perPage, (page + 1) * perPage);
  const points: LollipopDatum[] = shown.map((m) => ({
    label: m.name,
    value: m.percent,
    color: MODULE_STATUSES.find((s) => s.key === m.status)?.color ?? "#8b8f99",
  }));

  return (
    <TabShell
      title="Modules"
      stats={[
        { label: "Total", value: modules.length },
        { label: "Terminés", value: modules.filter((m) => m.status === "completed").length },
        { label: "En cours", value: modules.filter((m) => m.status === "in-progress").length },
        { label: "Planifiés", value: modules.filter((m) => m.status === "planned").length },
      ]}
    >
      <section>
        <Paginated
          title="Avancement des modules"
          page={page} perPage={perPage} total={filtered.length} onPage={setPage}
        />
        <LollipopChart data={points} yLabel="Avancement %" />
        <ChartLegend items={MODULE_STATUSES} />
      </section>

      <DataTable
        rows={filtered}
        filename="analytics-modules"
        search={search} onSearch={setSearch}
        empty="Aucun module ne correspond."
        columns={[
          { key: "name", label: "Module", render: (m) => m.name, value: (m) => m.name },
          {
            key: "lead", label: "Responsable",
            render: (m) => <LeadCell userId={m.lead_id} members={members} />,
            value: (m) => memberName(members.find((x) => x.user_id === m.lead_id)),
          },
          {
            key: "project", label: "Projet",
            render: (m) => <ProjectCell name={m.project_name} logo={m.project_logo} />,
            value: (m) => m.project_name,
          },
          { key: "start", label: "Début", render: (m) => formatDate(m.start_date), value: (m) => m.start_date ?? "" },
          { key: "end", label: "Échéance", render: (m) => formatDate(m.target_date), value: (m) => m.target_date ?? "" },
          { key: "percent", label: "Avancement", align: "right", render: (m) => `${m.percent}%`, value: (m) => m.percent },
        ]}
      />
    </TabShell>
  );
}

// ── Membres ─────────────────────────────────────────────────────────────────

export function MembersTab({
  rows, members,
}: { rows: AnalyticsMember[]; members: Member[] }) {
  const [search, setSearch] = useState("");

  const named = useMemo(() => rows.map((r) => ({
    ...r,
    name: r.user_id ? memberName(members.find((m) => m.user_id === r.user_id)) : "Non assigné",
  })), [rows, members]);

  const filtered = named.filter((r) =>
    !search.trim() || r.name.toLowerCase().includes(search.toLowerCase()));

  const chart: BarDatum[] = named.slice(0, 8).map((r, i) => ({
    label: r.name.split(" ")[0],
    value: r.assigned,
    color: r.user_id ? "#4b7fd6" : "#8b8f99",
  }));

  return (
    <TabShell
      title="Membres"
      stats={[
        { label: "Personnes", value: named.filter((r) => r.user_id).length },
        { label: "Work items assignés", value: named.filter((r) => r.user_id).reduce((n, r) => n + r.assigned, 0) },
        { label: "Non assignés", value: named.find((r) => !r.user_id)?.assigned ?? 0, tone: "warn" },
        { label: "En retard", value: named.reduce((n, r) => n + r.overdue, 0), tone: "warn" },
      ]}
    >
      <section>
        <h3 className="pb-3 text-14 font-medium">Charge par personne</h3>
        <BarChart data={chart} yLabel="Work items" xLabel="Personne" />
      </section>

      <DataTable
        rows={filtered}
        filename="analytics-membres"
        search={search} onSearch={setSearch}
        empty="Aucun membre ne correspond."
        columns={[
          {
            key: "name", label: "Personne",
            render: (r) => (
              <span className="flex items-center gap-2">
                {r.user_id
                  ? <MemberAvatar member={members.find((m) => m.user_id === r.user_id)} />
                  : <span className="h-5 w-5 rounded-full bg-muted" />}
                <span className={cn(!r.user_id && "italic text-muted-foreground")}>{r.name}</span>
              </span>
            ),
            value: (r) => r.name,
          },
          { key: "assigned", label: "Assignés", align: "right", render: (r) => r.assigned, value: (r) => r.assigned },
          { key: "completed", label: "Terminés", align: "right", render: (r) => r.completed, value: (r) => r.completed },
          {
            key: "overdue", label: "En retard", align: "right",
            render: (r) => (
              <span className={cn(r.overdue > 0 && "text-amber-600")}>{r.overdue}</span>
            ),
            value: (r) => r.overdue,
          },
        ]}
      />
    </TabShell>
  );
}

// ── Work items / Intake ─────────────────────────────────────────────────────

export function IssuesTab({ rows, intake }: { rows: AnalyticsRow[]; intake?: boolean }) {
  const [search, setSearch] = useState("");

  const filtered = rows.filter((r) =>
    !search.trim() || r.project_name.toLowerCase().includes(search.toLowerCase()));

  const chart: BarDatum[] = rows.slice(0, 8).map((r) => ({
    label: r.identifier,
    value: intake ? r.intake : r.issues,
    color: "#4b7fd6",
  }));

  const total = rows.reduce((n, r) => n + (intake ? r.intake : r.issues), 0);
  const completed = rows.reduce((n, r) => n + r.completed, 0);
  const overdue = rows.reduce((n, r) => n + r.overdue, 0);

  return (
    <TabShell
      title={intake ? "Intake" : "Work items"}
      stats={intake ? [
        { label: "Demandes", value: total },
        { label: "Projets avec intake", value: rows.filter((r) => r.intake > 0).length },
      ] : [
        { label: "Total", value: total },
        { label: "Terminés", value: completed },
        { label: "Restants", value: Math.max(0, total - completed) },
        { label: "En retard", value: overdue, tone: "warn" },
      ]}
    >
      <section>
        <h3 className="pb-3 text-14 font-medium">
          {intake ? "Demandes par projet" : "Work items par projet"}
        </h3>
        <BarChart data={chart} yLabel={intake ? "Demandes" : "Work items"} xLabel="Projet" />
      </section>

      <DataTable
        rows={filtered}
        filename={intake ? "analytics-intake" : "analytics-work-items"}
        search={search} onSearch={setSearch}
        empty="Aucun projet ne correspond."
        columns={intake ? [
          {
            key: "name", label: "Projet",
            render: (r) => <ProjectCell name={r.project_name} logo={r.logo_props} />,
            value: (r) => r.project_name,
          },
          { key: "intake", label: "Demandes", align: "right", render: (r) => r.intake, value: (r) => r.intake },
        ] : [
          {
            key: "name", label: "Projet",
            render: (r) => <ProjectCell name={r.project_name} logo={r.logo_props} />,
            value: (r) => r.project_name,
          },
          { key: "issues", label: "Total", align: "right", render: (r) => r.issues, value: (r) => r.issues },
          { key: "completed", label: "Terminés", align: "right", render: (r) => r.completed, value: (r) => r.completed },
          {
            key: "overdue", label: "En retard", align: "right",
            render: (r) => <span className={cn(r.overdue > 0 && "text-amber-600")}>{r.overdue}</span>,
            value: (r) => r.overdue,
          },
          {
            key: "percent", label: "Avancement", align: "right",
            render: (r) => `${r.issues ? Math.round((r.completed / r.issues) * 100) : 0}%`,
            value: (r) => (r.issues ? Math.round((r.completed / r.issues) * 100) : 0),
          },
        ]}
      />
    </TabShell>
  );
}

/** Le titre d'un graphe paginé. La pagination porte sur le GRAPHE seul : au-delà
 *  d'une dizaine de points, les étiquettes se chevauchent et la lecture devient
 *  impossible, alors que la table en dessous supporte très bien la longueur. */
function Paginated({
  title, page, perPage, total, onPage,
}: {
  title: string; page: number; perPage: number; total: number;
  onPage: (p: number) => void;
}) {
  const from = total ? page * perPage + 1 : 0;
  const to = Math.min(total, (page + 1) * perPage);
  const last = Math.max(0, Math.ceil(total / perPage) - 1);

  return (
    <div className="flex items-center gap-2 pb-3">
      <h3 className="text-14 font-medium">{title}</h3>
      <div className="flex-1" />
      <span className="text-11 tabular-nums text-muted-foreground">
        {from}–{to} sur {total}
      </span>
      <button
        type="button" disabled={page === 0} onClick={() => onPage(page - 1)}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground disabled:opacity-40 hover:bg-muted"
      >
        ←
      </button>
      <button
        type="button" disabled={page >= last} onClick={() => onPage(page + 1)}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground disabled:opacity-40 hover:bg-muted"
      >
        →
      </button>
    </div>
  );
}
