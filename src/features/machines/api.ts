import { useQuery, useQueryClient } from "@tanstack/react-query";
import { callEdge } from "@/lib/edge";

// Le parc de machines d'un espace (migration 0304, fonction machines). Une
// machine s'attribue à une équipe ou à un agent seul ; ses agents y ont chacun
// un compte Linux. Aucun jeton ni secret ne passe par ici : l'interface sait
// seulement qu'une machine A son jeton.

export type MachineKind = "docker" | "vm" | "cloud" | "platform";

export interface MachineInfoSnapshot {
  version?: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  uptime_s?: number;
  cpus?: number;
  load?: number[];
  mem?: { total_kb: number; free_kb: number };
  disk?: { total_kb: number; free_kb: number } | null;
  apt?: boolean;
  /** Chromium et Playwright dans l'image (team-machine 0.3.0) : l'outil team_browser marche. */
  browser?: boolean;
  dry?: boolean;
  limits?: { procs_per_agent: number; file_mb: number; exec_max_s: number; job_max_h: number; jobs_per_agent: number };
}

export interface FleetMachine {
  id: string;
  workspace_id: string;
  dashboard_id: string | null;
  name: string;
  description: string | null;
  kind: MachineKind;
  url: string | null;
  status: "active" | "paused";
  allow_system_packages: boolean;
  info: MachineInfoSnapshot;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
  has_token: boolean;
  assignments: number;
  /** 0311 : créée par la plateforme (un conteneur Docker de l'hôte), sinon null. */
  managed_by?: "docker" | null;
  managed_ref?: string | null;
  provision_state?: "creating" | "ready" | "failed" | null;
  /** 0317 : le preset du catalogue choisi au départ (pour l'affichage). */
  template?: string | null;
  /** 0318 : les outils du catalogue installés dans l'image. */
  tools?: string[];
}

/** Le catalogue des outils des machines (backend/src/machines/catalog.ts). */
export interface ToolCategory { id: string; label: string; summary: string }
export interface MachineTool {
  id: string;
  category: string;
  name: string;
  summary: string;
  apt: string[];
  pip: string[];
  npm: string[];
  note?: string;
}
export interface MachinePreset {
  id: string;
  category: string;
  name: string;
  summary: string;
  tools: string[];
  cpus: number;
  memory_mb: number;
  disk_mb: number;
}
export interface MachineCatalog { categories: ToolCategory[]; tools: MachineTool[]; presets: MachinePreset[] }

/** Le compte des paquets d'un outil, « 3 apt · 2 pip ». */
export const toolCount = (t: Pick<MachineTool, "apt" | "pip" | "npm">) =>
  ([["apt", t.apt], ["pip", t.pip], ["npm", t.npm]] as const).filter(([, xs]) => xs.length).map(([k, xs]) => `${xs.length} ${k}`).join(" · ");

/** « 4 CPU · 8 Go · 16 Go de disque » */
export const presetShape = (p: Pick<MachinePreset, "cpus" | "memory_mb" | "disk_mb">) =>
  `${p.cpus} CPU · ${Math.round(p.memory_mb / 1024)} Go · ${Math.round(p.disk_mb / 1024)} Go de disque`;

export interface Assignment {
  team_id: string;
  machine_id: string | null;
  status: "active" | "paused";
  scope: "team" | "agent";
  agent_id: string | null;
  team_key: string;
  machine_path: string | null;
  last_error: string | null;
}

export interface FleetTeam { id: string; name: string; agent_ids: string[]; lead_id: string | null }
export interface FleetAgent { id: string; name: string; avatar_url: string | null; avatar_style: string | null; teams: string[] }

export interface Fleet {
  ok: boolean;
  machines: FleetMachine[];
  assignments: Assignment[];
  teams: FleetTeam[];
  agents: FleetAgent[];
  /** La création à la demande : possible ici, sinon pourquoi. */
  provisioner?: { available: boolean; reason?: string };
  catalog?: MachineCatalog;
  /** Les conteneurs des agents embarqués du service (une instance = une machine). */
  embedded?: EmbeddedMachine[];
}

/** Le conteneur d'une instance d'agent embarqué, tel qu'il se décrit à chaque battement de cœur. */
export interface EmbeddedMachine {
  id: string;
  agent_id: string;
  agent_name: string;
  name: string;
  status: "online" | "paused" | "stopped";
  container_ref: string | null;
  manifest_sha: string | null;
  version: number | null;
  info: MachineInfoSnapshot & { tools?: string[]; rss_mb?: number; node?: string; built?: boolean };
  last_seen_at: string | null;
  created_at: string;
  connectivity: "connected" | "intermittent" | "isolated";
  tools: string[];
}

/** L'état d'une machine d'agent embarqué : un battement de cœur il y a moins d'une minute = en ligne. */
export function embeddedHealth(m: Pick<EmbeddedMachine, "status" | "last_seen_at">): "online" | "paused" | "offline" | "stopped" {
  if (m.status === "stopped") return "stopped";
  const fresh = !!m.last_seen_at && Date.now() - Date.parse(m.last_seen_at) < 60_000;
  if (!fresh) return "offline";
  return m.status === "paused" ? "paused" : "online";
}

export interface Probe { reachable: boolean; error?: string; info?: MachineInfoSnapshot; latency_ms?: number; seen_at?: string }

export interface MachineProcess {
  pid: number; state: string; command: string; rss_kb: number; cpu_s: number; age_s: number;
  team_id: string; agent_id: string; user: string;
}
export interface MachineJob {
  id: string; label: string | null; command: string; pid: number; started_at: string; running: boolean;
  exit_code: number | string | null; ended_at: string | null; team_id: string; agent_id: string; user: string;
}
export interface MachineAudit {
  id: number; team_id: string; agent_id: string | null; user_id: string | null; action: string;
  folder_id: string | null; detail: Record<string, unknown>; created_at: string;
}
export interface MachineExec {
  id: number; team_id: string; agent_id: string; user: string; command: string; cwd: string; started_at: string;
  running: boolean; interrupted?: boolean; exit_code: number | null; signal: string | null; duration_ms: number | null;
  timed_out: boolean; stdout: string; stderr: string;
}
export interface MachineEvent {
  ts: string; team_id: string; agent_id: string; user: string | null; op: string; detail: string; status: number; code: string | null; ms: number;
}
export interface MachineListener { port: number; address: string; pid: number; command: string; team_id: string; agent_id: string; user: string }
export interface MachineBrowser { team_id: string; agent_id: string; user: string }
export interface BrowserView {
  ok: boolean; open: boolean; image?: string | null; idle_s?: number;
  tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
}

export interface Activity {
  ok: boolean;
  reachable: boolean;
  error: string | null;
  info: MachineInfoSnapshot | null;
  processes: MachineProcess[];
  jobs: MachineJob[];
  execs: MachineExec[];
  events: MachineEvent[];
  listeners: MachineListener[];
  browsers: MachineBrowser[];
  teams: Array<{ team_id: string; scope: "team" | "agent"; agent_id: string | null; status: string }>;
  audit: MachineAudit[];
}

export interface FileEntry { path: string; type?: "dir" | "file" | "link" | "other"; size?: number; mode?: string; owner?: string; group?: string; modified?: string; error?: string }
export interface FilesWhere { home: string | null; team_dir: string; shared: string; folders: Array<{ name: string; path: string | null }>; solo: boolean }
export interface FileList { ok: boolean; result: { path: string; entries: FileEntry[]; truncated: boolean }; where: FilesWhere }
export interface FileRead {
  ok: boolean;
  result: { path: string; size: number; base64?: string; binary?: boolean; total_lines?: number; from_line?: number; lines?: number; truncated?: boolean; content?: string };
  where: FilesWhere;
}

export const fleetKey = (dashboardId: string) => ["machines_fleet", dashboardId];

export function useFleet(dashboardId: string) {
  return useQuery({
    queryKey: fleetKey(dashboardId),
    queryFn: () => callEdge<Fleet>("machines", { action: "list", dashboard_id: dashboardId }),
    staleTime: 15_000,
    // Une machine en création : on suit son avancement jusqu'à ce qu'elle réponde.
    // Une machine en création : vite. Des machines d'agents embarqués : au rythme de leurs battements de cœur.
    refetchInterval: (q) => (q.state.data?.machines.some((m) => m.provision_state === "creating") ? 3000
      : (q.state.data?.embedded?.length ? 15_000 : false)),
    retry: false,
  });
}

/** L'activité d'une machine depuis `since` : rafraîchie toutes les 10 s tant que la page est ouverte. */
export function useMachineActivity(machineId: string | null, since: string | null = null) {
  return useQuery({
    queryKey: ["machine_activity", machineId, since],
    queryFn: () => callEdge<Activity>("machines", { action: "activity", machine_id: machineId, ...(since ? { since } : {}) }),
    placeholderData: (prev) => prev,
    enabled: !!machineId,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function useRefreshFleet(dashboardId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: fleetKey(dashboardId) }),
    qc.invalidateQueries({ queryKey: ["machine_activity"] }),
    qc.invalidateQueries({ queryKey: ["team_machine_status", dashboardId] }),
    qc.invalidateQueries({ queryKey: ["team_machine_flags", dashboardId] }),
  ]);
}

type Res = { ok: boolean; error?: string };
export interface MachineInput {
  name: string; description?: string; kind: MachineKind; url?: string; token?: string; allow_system_packages?: boolean;
}

export const fleetApi = {
  create: (dashboardId: string, input: MachineInput) =>
    callEdge<Res & { machine: FleetMachine; probe: Probe }>("machines", { action: "create", dashboard_id: dashboardId, ...input }),
  update: (machineId: string, patch: Partial<Omit<MachineInput, "token">> & { token?: string | null; status?: "active" | "paused" }) =>
    callEdge<Res & { machine: FleetMachine }>("machines", { action: "update", machine_id: machineId, ...patch }),
  /** destroy (machine créée à la demande) : true emporte le conteneur, "all" aussi ses volumes. */
  remove: (machineId: string, destroy?: boolean | "all") =>
    callEdge<Res>("machines", { action: "delete", machine_id: machineId, ...(destroy ? { destroy } : {}) }),
  /** Faire créer une machine par la plateforme (0311). */
  provision: (dashboardId: string, input: { name: string; description?: string; allow_system_packages?: boolean; preset?: string; tools?: string[] }) =>
    callEdge<Res & { machine: FleetMachine; probe: Probe }>("machines", { action: "create", dashboard_id: dashboardId, provision: true, ...input }),
  probe: (machineId: string) => callEdge<Res & { probe: Probe }>("machines", { action: "probe", machine_id: machineId }),
  assign: (dashboardId: string, target: { type: "team" | "agent"; id: string }, machineId: string | null) =>
    callEdge<Res & { team_id: string; status: string; moved: boolean }>("machines", { action: "assign", dashboard_id: dashboardId, target, machine_id: machineId }),
  list: (teamId: string, agentId: string, path: string, all = false) =>
    callEdge<FileList>("machines", { action: "files", op: "list", team_id: teamId, agent_id: agentId, path, all }),
  read: (teamId: string, agentId: string, path: string, raw = false) =>
    callEdge<FileRead>("machines", { action: "files", op: "read", team_id: teamId, agent_id: agentId, path, ...(raw ? { encoding: "base64" } : {}) }),
  browserView: (machineId: string, teamId: string, agentId: string) =>
    callEdge<BrowserView>("machines", { action: "browser_view", machine_id: machineId, team_id: teamId, agent_id: agentId }),
  jobLogs: (teamId: string, agentId: string, jobId: string) =>
    callEdge<Res & { job: MachineJob & { output: string } }>("machines", { action: "job_logs", team_id: teamId, agent_id: agentId, job_id: jobId }),
  jobStop: (teamId: string, agentId: string, jobId: string) =>
    callEdge<Res>("machines", { action: "job_stop", team_id: teamId, agent_id: agentId, job_id: jobId }),
};

export const KIND_LABEL: Record<MachineKind, string> = {
  docker: "Conteneur Docker",
  vm: "Machine virtuelle",
  cloud: "Cloud",
  platform: "Plateforme",
};

export function formatKb(kb: number | null | undefined): string {
  if (kb == null) return "–";
  if (kb < 1024) return `${kb} Ko`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)} Mo`;
  return `${(kb / 1024 / 1024).toFixed(1)} Go`;
}

export function formatBytes(n: number | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} o`;
  return formatKb(Math.round(n / 1024));
}

export function formatAge(s: number | null | undefined): string {
  if (s == null) return "–";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)}`;
  return `${Math.floor(s / 86400)} j ${Math.floor((s % 86400) / 3600)} h`;
}

/** En ligne si vue dans les 5 dernières minutes et sans erreur depuis. */
export function machineHealth(
  m: Pick<FleetMachine, "status" | "last_seen_at" | "last_error" | "provision_state">,
): "creating" | "paused" | "online" | "offline" | "unknown" {
  if (m.provision_state === "creating") return "creating";
  if (m.status === "paused") return "paused";
  if (m.last_error) return "offline";
  if (!m.last_seen_at) return "unknown";
  return Date.now() - new Date(m.last_seen_at).getTime() < 5 * 60_000 ? "online" : "unknown";
}

export const HEALTH_META = {
  creating: { label: "En création", dot: "bg-sky-500 animate-pulse", text: "text-sky-600 dark:text-sky-400" },
  online: { label: "En ligne", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  offline: { label: "Injoignable", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  unknown: { label: "À vérifier", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  paused: { label: "En pause", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
} as const;

export const AUDIT_TEXT: Record<string, string> = {
  enable: "a donné la machine",
  resume: "a relancé la machine",
  move: "a changé de machine",
  pause: "a retiré la machine",
  machine_pause: "a mis la machine en pause",
  machine_resume: "a relancé la machine",
  folder_create: "a créé un dossier protégé",
  member_add: "a ajouté au dossier",
  member_remove: "a retiré du dossier",
  leave: "a quitté le dossier",
  rotate: "a renouvelé un secret",
  archive: "a archivé un dossier",
  agent_reset: "a réinitialisé une identité",
  apt_install: "a installé des paquets",
  human_read: "a lu un fichier",
  job_stop: "a arrêté un processus",
  access_refused: "accès refusé",
};
