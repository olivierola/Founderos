import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

export interface ServiceDashboard {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  position: number;
  created_by: string | null;
  created_at: string;
  /** Per-dashboard preferences (migration 0158). Always normalised — never null. */
  settings: DashboardSettings;
}

// ── Per-dashboard settings ────────────────────────────────────────────────────
// Everything a service dashboard can configure about ITSELF (its nav, its
// assistant defaults, its rooms). Org-wide concerns (billing, members,
// connectors) stay in the Admin area — this is deliberately dashboard-scoped.
export type DashboardTabSlug = "home" | "agents" | "schedules" | "memory" | "artifacts";

export interface AgentDefaults {
  model: string;
  sandbox_mode: "cloud" | "runner" | "sandbox" | "hybrid";
  max_steps: number;
  max_run_cost_usd: number;
  swarm_enabled: boolean;
  requires_approval: boolean;
}

export interface RoomDefaults {
  /** Seed every new room with the dashboard's assistant as a participant. */
  auto_add_orchestrator: boolean;
  /** Who answers a turn that tags nobody. Null → the assistant, else 1st agent. */
  default_responder_agent_id: string | null;
}

/** Named look of the dashboard shell. "system" follows the app's light/dark. */
export type DashboardTheme =
  | "system" | "light" | "dark"
  | "purple" | "midnight" | "slate" | "forest" | "mocha" | "crimson"
  | "burnt-orange" | "sand" | "mist";

export interface DashboardSettings {
  landing: DashboardTabSlug;
  hidden_tabs: DashboardTabSlug[];
  sidebar_collapsed: boolean;
  theme: DashboardTheme;
  agent_defaults: AgentDefaults;
  rooms: RoomDefaults;
}

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  model: "deepseek",
  sandbox_mode: "cloud",
  max_steps: 8,
  max_run_cost_usd: 0.5,
  swarm_enabled: true,
  requires_approval: false,
};

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  landing: "home",
  hidden_tabs: [],
  sidebar_collapsed: false,
  theme: "system",
  agent_defaults: DEFAULT_AGENT_DEFAULTS,
  rooms: { auto_add_orchestrator: true, default_responder_agent_id: null },
};

/** Merge a raw jsonb blob onto the defaults so every consumer reads full values. */
export function normalizeSettings(raw: unknown): DashboardSettings {
  const s = (raw ?? {}) as Partial<DashboardSettings> & Record<string, unknown>;
  return {
    landing: (s.landing as DashboardTabSlug) ?? DEFAULT_DASHBOARD_SETTINGS.landing,
    hidden_tabs: Array.isArray(s.hidden_tabs) ? (s.hidden_tabs as DashboardTabSlug[]) : [],
    sidebar_collapsed: s.sidebar_collapsed === true,
    theme: (s.theme as DashboardTheme) ?? "system",
    agent_defaults: { ...DEFAULT_AGENT_DEFAULTS, ...(s.agent_defaults ?? {}) },
    rooms: { ...DEFAULT_DASHBOARD_SETTINGS.rooms, ...(s.rooms ?? {}) },
  };
}

function toDashboard(row: Record<string, unknown>): ServiceDashboard {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    icon: (row.icon as string) || "Squares",
    color: (row.color as string) || "bg-indigo-500",
    position: (row.position as number) ?? 0,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    settings: normalizeSettings(row.settings),
  };
}

export type AssetKind = "human" | "agent" | "repo" | "link" | "file" | "key" | "connector" | "note";

export interface DashboardAsset {
  id: string;
  dashboard_id: string;
  kind: AssetKind;
  label: string;
  value: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const ASSET_KINDS: { kind: AssetKind; label: string; icon: string; placeholder: string; hasValue: boolean }[] = [
  { kind: "human", label: "Personne", icon: "User", placeholder: "email ou nom", hasValue: true },
  { kind: "agent", label: "Agent", icon: "Bot", placeholder: "nom de l'agent", hasValue: false },
  { kind: "repo", label: "Dépôt GitHub", icon: "Github", placeholder: "owner/repo", hasValue: true },
  { kind: "link", label: "Lien", icon: "Link", placeholder: "https://…", hasValue: true },
  { kind: "file", label: "Fichier", icon: "FileText", placeholder: "URL du fichier", hasValue: true },
  { kind: "key", label: "Clé / secret", icon: "KeyRound", placeholder: "référence (jamais la valeur brute)", hasValue: true },
  { kind: "connector", label: "Outil connecté", icon: "Plug", placeholder: "provider (slack, gmail…)", hasValue: true },
  { kind: "note", label: "Note", icon: "StickyNote", placeholder: "texte libre", hasValue: true },
];

// select("*") on purpose: the settings columns (0158) may not be pushed yet, and
// naming them explicitly would make the whole query — and the dashboard — fail.
export async function fetchServiceDashboards(projectId: string): Promise<ServiceDashboard[]> {
  const { data } = await supabase
    .from("service_dashboards")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(toDashboard);
}

export async function fetchServiceDashboard(id: string): Promise<ServiceDashboard | null> {
  const { data } = await supabase.from("service_dashboards").select("*").eq("id", id).maybeSingle();
  return data ? toDashboard(data as Record<string, unknown>) : null;
}

export async function createServiceDashboard(
  workspaceId: string, projectId: string, userId: string | null,
  input: { name: string; icon?: string; color?: string },
): Promise<ServiceDashboard | null> {
  const { data, error } = await supabase
    .from("service_dashboards")
    .insert({
      workspace_id: workspaceId, project_id: projectId, created_by: userId,
      name: input.name.trim(), icon: input.icon ?? "Squares", color: input.color ?? "bg-indigo-500",
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data ? toDashboard(data as Record<string, unknown>) : null;
}

/**
 * Save a dashboard patch. `description` / `settings` only exist once migration
 * 0158 is pushed, so a schema error retries with the legacy columns alone and
 * reports it — the identity fields still save on a stale database.
 */
export interface UpdateDashboardInput {
  name?: string;
  description?: string | null;
  icon?: string;
  color?: string;
  settings?: DashboardSettings;
}
export async function updateServiceDashboard(
  id: string, patch: UpdateDashboardInput,
): Promise<{ ok: boolean }> {
  const stamped = { ...patch, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("service_dashboards").update(stamped).eq("id", id);
  if (!error) return { ok: true };
  const missingColumn = /column|schema cache/i.test(error.message);
  if (!missingColumn) throw new Error(error.message);
  const legacy: Record<string, unknown> = { updated_at: stamped.updated_at };
  if (patch.name !== undefined) legacy.name = patch.name;
  if (patch.icon !== undefined) legacy.icon = patch.icon;
  if (patch.color !== undefined) legacy.color = patch.color;
  const retry = await supabase.from("service_dashboards").update(legacy).eq("id", id);
  if (retry.error) throw new Error(retry.error.message);
  // Saved, but only the legacy columns — the caller warns about migration 0158.
  return { ok: false };
}
// ── Personal theme (migration 0162) ──────────────────────────────────────────
// The skin is a comfort setting, so it is stored per user, not on the shared
// dashboard row. `settings.theme` remains the service's default for anyone who
// has never picked one.

export async function fetchUserDashboardTheme(dashboardId: string): Promise<DashboardTheme | null> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from("user_dashboard_prefs")
    .select("theme")
    .eq("user_id", uid).eq("dashboard_id", dashboardId)
    .maybeSingle();
  return ((data as { theme: string | null } | null)?.theme as DashboardTheme) ?? null;
}

export async function setUserDashboardTheme(dashboardId: string, theme: DashboardTheme) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return;
  const { error } = await supabase
    .from("user_dashboard_prefs")
    .upsert(
      { user_id: uid, dashboard_id: dashboardId, theme, updated_at: new Date().toISOString() },
      { onConflict: "user_id,dashboard_id" },
    );
  if (error) throw new Error(error.message);
}

export async function deleteServiceDashboard(id: string) {
  await supabase.from("service_dashboards").delete().eq("id", id);
}

// The dashboard's default orchestrator agent — so you can chat without first
// creating an agent. Created lazily on first use; it can build the workspace
// (create agents, schedule work) via its tools.
export async function ensureOrchestrator(
  dashboard: { id: string; name: string }, workspaceId: string, projectId: string, userId: string | null,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("internal_agents").select("id")
    .eq("service_dashboard_id", dashboard.id).eq("is_orchestrator", true).eq("is_archived", false)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await supabase.from("internal_agents").insert({
    workspace_id: workspaceId, project_id: projectId, service_dashboard_id: dashboard.id,
    is_orchestrator: true, name: "Assistant",
    persona: `L'assistant du service « ${dashboard.name} » — il répond, coordonne, crée des agents et planifie le travail à la demande.`,
    chat_enabled: true, mission_enabled: true, created_by: userId,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Stamp a freshly created agent with the dashboard's defaults (Settings →
 * Agents). Best-effort, like instantiateTemplate: a stale PostgREST schema
 * cache must never break agent creation.
 *
 * `scope: "template"` only applies the service-wide preferences a template has
 * no opinion about — a template's own execution world and step budget are part
 * of what makes it work, so they win.
 */
export async function applyAgentDefaults(
  agentId: string, d: AgentDefaults, scope: "blank" | "template",
) {
  const upd: Record<string, unknown> = {
    model: d.model,
    max_run_cost_usd: d.max_run_cost_usd,
    swarm_enabled: d.swarm_enabled,
  };
  if (scope === "blank") {
    upd.sandbox_mode = d.sandbox_mode;
    upd.max_steps = d.max_steps;
  }
  // `requires_approval` is NOT set here: it is a per-tool column
  // (internal_agent_tools), not an agent one — naming it made PostgREST reject
  // the whole update, silently dropping the other defaults with it. The
  // service's approval default is applied to the tools granted at creation.
  const { error } = await supabase.from("internal_agents").update(upd).eq("id", agentId);
  if (error) console.warn("Agent defaults not applied:", error.message);
}

export async function fetchAssets(dashboardId: string): Promise<DashboardAsset[]> {
  const { data } = await supabase
    .from("service_dashboard_assets")
    .select("id, dashboard_id, kind, label, value, metadata, created_at")
    .eq("dashboard_id", dashboardId)
    .order("created_at", { ascending: false });
  return (data ?? []) as DashboardAsset[];
}

export async function addAsset(
  workspaceId: string, projectId: string, dashboardId: string, userId: string | null,
  input: { kind: AssetKind; label: string; value?: string | null; metadata?: Record<string, unknown> },
) {
  const { error } = await supabase.from("service_dashboard_assets").insert({
    workspace_id: workspaceId, project_id: projectId, dashboard_id: dashboardId, created_by: userId,
    kind: input.kind, label: input.label.trim(), value: input.value?.trim() || null, metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
}
export async function deleteAsset(id: string) {
  await supabase.from("service_dashboard_assets").delete().eq("id", id);
}

// ── Multi-agent rooms ─────────────────────────────────────────────────────────
export interface Room { id: string; title: string; created_at: string; updated_at: string }
export interface RoomMessage {
  id: string;
  author_kind: "user" | "agent" | "system";
  user_id: string | null;
  agent_id: string | null;
  content: string;
  ui_blocks: Array<Record<string, unknown>> | null;
  status: "thinking" | "done" | "failed";
  /** Turn run — set when the agent fanned out parallel sub-agents this turn. */
  run_id: string | null;
  created_at: string;
}

export async function fetchRooms(dashboardId: string): Promise<Room[]> {
  const { data } = await supabase.from("service_rooms")
    .select("id, title, created_at, updated_at").eq("dashboard_id", dashboardId)
    .order("updated_at", { ascending: false }).limit(30);
  return (data ?? []) as Room[];
}

// Create a room and seed it with the dashboard's orchestrator as a participant,
// so you can talk immediately without adding an agent.
export async function createRoom(
  dashboard: { id: string; name: string }, workspaceId: string, projectId: string, userId: string | null, title: string,
): Promise<string | null> {
  const { data, error } = await supabase.from("service_rooms")
    .insert({ dashboard_id: dashboard.id, workspace_id: workspaceId, project_id: projectId, created_by: userId, title: title.trim().slice(0, 80) || "Nouvelle room" })
    .select("id").single();
  if (error) throw new Error(error.message);
  const roomId = (data as { id: string } | null)?.id ?? null;
  if (roomId) {
    // Settings (0158) can switch the auto-seed off — a service that always tags
    // a specific agent doesn't want the assistant in every room.
    const board = await fetchServiceDashboard(dashboard.id);
    const seed = board?.settings.rooms.auto_add_orchestrator ?? true;
    const preferred = board?.settings.rooms.default_responder_agent_id ?? null;
    if (seed) {
      const orch = await ensureOrchestrator(dashboard, workspaceId, projectId, userId);
      if (orch) await supabase.from("service_room_agents").insert({ room_id: roomId, agent_id: orch }).then(() => {}, () => {});
    }
    // The configured default responder must be in the room to be able to answer.
    if (preferred) await addRoomAgent(roomId, preferred);
  }
  return roomId;
}

/** Rooms of a dashboard that never got a message — offered as a cleanup action. */
export async function deleteEmptyRooms(dashboardId: string): Promise<number> {
  const rooms = await fetchRooms(dashboardId);
  let removed = 0;
  for (const r of rooms) {
    const { count } = await supabase
      .from("service_room_messages").select("id", { count: "exact", head: true })
      .eq("room_id", r.id).eq("author_kind", "user");
    if ((count ?? 0) === 0) { await deleteRoom(r.id); removed += 1; }
  }
  return removed;
}

export async function renameRoom(roomId: string, title: string) {
  await supabase.from("service_rooms").update({ title: title.trim().slice(0, 80) || "Sans titre" }).eq("id", roomId);
}
export async function deleteRoom(roomId: string) {
  // Messages/agents reference the room; remove them first (in case no cascade).
  await supabase.from("service_room_messages").delete().eq("room_id", roomId).then(() => {}, () => {});
  await supabase.from("service_room_agents").delete().eq("room_id", roomId).then(() => {}, () => {});
  await supabase.from("service_rooms").delete().eq("id", roomId);
}

export async function fetchRoomMessages(roomId: string): Promise<RoomMessage[]> {
  const { data } = await supabase.from("service_room_messages")
    .select("id, author_kind, user_id, agent_id, content, ui_blocks, status, run_id, created_at")
    .eq("room_id", roomId).order("created_at", { ascending: true }).limit(200);
  return (data ?? []) as RoomMessage[];
}

export async function fetchRoomParticipants(roomId: string): Promise<string[]> {
  const { data } = await supabase.from("service_room_agents").select("agent_id").eq("room_id", roomId);
  return (data ?? []).map((r: { agent_id: string }) => r.agent_id);
}
export async function addRoomAgent(roomId: string, agentId: string) {
  await supabase.from("service_room_agents").insert({ room_id: roomId, agent_id: agentId }).then(() => {}, () => {});
}
export async function removeRoomAgent(roomId: string, agentId: string) {
  await supabase.from("service_room_agents").delete().eq("room_id", roomId).eq("agent_id", agentId);
}

export async function postRoomMessage(
  roomId: string, content: string, mentionAgentIds: string[], attachmentMediaId?: string,
) {
  await callEdge("service-room-post", {
    room_id: roomId, content, mention_agent_ids: mentionAgentIds,
    attachment_media_id: attachmentMediaId ?? null,
  });
}
