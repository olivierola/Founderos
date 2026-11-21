import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  UsersThreeIcon, ArrowClockwiseIcon, ArrowCounterClockwiseIcon, MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon, CornersOutIcon, XIcon, ChatsCircleIcon, GearSixIcon, CaretDownIcon,
  CheckIcon, PlusIcon, RocketLaunchIcon, CircleNotchIcon as Loader2, CursorClickIcon, DatabaseIcon,
  PersonSimpleWalkIcon, SignOutIcon, CubeIcon, MapTrifoldIcon, ChatsTeardropIcon, SwordIcon, ToolboxIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { ChatTab } from "@/features/internal-agents/InternalAgentDetail";
import type { InternalAgent } from "@/features/internal-agents/shared";
import { useDashboardAgents, fetchRosterActivity, type RosterActivity } from "../ServiceDashboardTabs";
import { useCollaboratorInbox } from "../CollaboratorInbox";
import { useWorkbench } from "../workbench";
import { assignAgentToTeam, newTeam } from "../model";
import { computeLayout } from "./layout";
import { useTeams } from "./teams";
import { TeamsManager } from "./TeamsManager";
import { LivePlan } from "./LivePlan";
import { avatarColor, describeAvatar } from "./figures";
import { ExchangesPanel, KIND_META, activeDebates, useA2AFeed, type ExchangeKind } from "./exchanges";
import type { AgentState, SceneAgent, SceneCommand, SkillItem } from "./LiveScene";

interface SkillActivation {
  agent_id: string;
  activated_at: string;
  skill: { id: string; name: string; category: string | null; description: string | null } | null;
}

/** La teinte d'une famille de skills — la même que dans l'armoire 3D. */
function skillColor(category: string | null): string {
  let h = 2166136261;
  const s = category || "autres";
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `hsl(${(h >>> 0) % 360}, 55%, 58%)`;
}

// Le LIVE SPACE : les agents du service dans leurs locaux, en direct.
//
// Ce n'est pas un décor : chaque personnage est un agent, chaque espace une
// équipe, et ce qu'on voit est ce qui se passe. Un agent au travail est assis,
// il tape, son écran s'allume à sa couleur. Un agent qui vous attend se lève
// à côté de son poste et fait signe. Un échec rougit l'écran. Quand un agent
// écrit à un autre (A2A), il se lève, va le voir, et sa vraie phrase s'affiche
// en bulle ; un débat les réunit en salle de réunion. On peut aussi ENTRER :
// marcher parmi eux au clavier, et parler à celui qu'on croise.

// three.js n'entre dans la page que si l'on ouvre le Live Space.
const LiveScene = lazy(() => import("./LiveScene"));

/** Des teintes d'agent posées, quand l'agent n'en a pas choisi. */
const AGENT_COLORS = ["#8b7bd8", "#5fa8d3", "#5fbf8f", "#e0a458", "#d97a8c", "#6cc0bd", "#c38fd6", "#7f9cf0"];
function colorFor(id: string, accent: string | null): string {
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) return accent;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

const STATE_META: Record<AgentState, { label: string; dot: string }> = {
  working: { label: "Au travail", dot: "bg-emerald-400" },
  waiting: { label: "Vous attend", dot: "bg-amber-400" },
  error: { label: "En échec", dot: "bg-red-500" },
  idle: { label: "Disponible", dot: "bg-zinc-400" },
};

/** Les chaises de la salle de réunion, face à face, paire par paire. */
const MEETING_PAIRS: Array<[number, number]> = [[1, 4], [0, 3], [2, 5], [6, 7]];

type SceneFailure = "webgl" | "lost" | "error";

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Le navigateur fournit-il un contexte WebGL, là, maintenant ? Sondé à neuf
 *  à chaque fois (un blocage peut se lever), le contexte rendu aussitôt. */
function webglWorks(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export function LiveSpaceTab({ dashboardId, dashboardName, workspaceId, projectId }: {
  dashboardId: string; dashboardName: string; workspaceId: string; projectId: string;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const wb = useWorkbench();
  const dark = useIsDark();
  const { user } = useAuth();

  // ── Ce qui se passe ──
  const { data: agentsRaw, isLoading } = useDashboardAgents(dashboardId);
  const agents = agentsRaw ?? [];
  const ids = agents.map((a) => a.id);
  // Même clé que l'onglet Agents : un seul sondage pour les deux écrans.
  const { data: activity } = useQuery({
    queryKey: ["sd_agent_activity", dashboardId, ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 20_000,
    queryFn: () => fetchRosterActivity(ids),
  });
  const { data: inbox } = useCollaboratorInbox(dashboardId);
  const waiting = new Map<string, number>();
  for (const i of inbox ?? []) {
    if (i.kind === "approval" || i.kind === "question") waiting.set(i.agent_id, (waiting.get(i.agent_id) ?? 0) + 1);
  }
  const { teams, mutate, error: teamError } = useTeams(dashboardId);

  // ── La mémoire partagée ──
  // Combien de souvenirs les agents du service ont écrits, et lesquels sont
  // tout frais : chacun envoie son auteur se brancher au silo pour l'y charger.
  const { data: memory } = useQuery({
    queryKey: ["live_memory", dashboardId, ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 20_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const [total, recent] = await Promise.all([
        supabase.from("internal_agent_memories").select("id", { count: "exact", head: true }).in("agent_id", ids),
        supabase.from("internal_agent_memories").select("id, agent_id, created_at")
          .in("agent_id", ids).gte("created_at", since).order("created_at", { ascending: false }).limit(60),
      ]);
      return {
        count: total.count ?? 0,
        recent: (recent.data ?? []) as Array<{ id: string; agent_id: string; created_at: string }>,
      };
    },
  });
  const seenMemories = useRef(new Set<string>());
  const openedAt = useRef(Date.now());
  const [storeSignals, setStoreSignals] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!memory) return;
    const fresh: string[] = [];
    for (const m of memory.recent) {
      if (seenMemories.current.has(m.id)) continue;
      seenMemories.current.add(m.id);
      // À l'ouverture, seuls les souvenirs des trois dernières minutes donnent
      // lieu à un chargement : rejouer un quart d'heure d'un coup ferait
      // défiler tout le service au silo.
      if (new Date(m.created_at).getTime() > openedAt.current - 3 * 60 * 1000) fresh.push(m.agent_id);
    }
    if (!fresh.length) return;
    setStoreSignals((prev) => {
      const next = new Map(prev);
      for (const a of fresh) next.set(a, (next.get(a) ?? 0) + 1);
      return next;
    });
  }, [memory]);
  const openMemory = () => navigate(`${base}/memory/graph`);

  // ── Les skills : l'armoire d'Utilities ──
  // Les compétences activées sur les agents du service, et qui les porte. Un
  // skill fraîchement activé envoie son agent le chercher à l'armoire.
  const { data: skillRows } = useQuery({
    queryKey: ["live_skills", dashboardId, ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data } = await supabase.from("agent_skill_activations")
        .select("agent_id, activated_at, skill:agent_skills(id, name, category, description)")
        .in("agent_id", ids);
      return (data ?? []) as unknown as SkillActivation[];
    },
  });
  const skillCatalog = useMemo(() => {
    const m = new Map<string, SkillActivation["skill"] & { holders: string[] }>();
    for (const r of skillRows ?? []) {
      if (!r.skill) continue;
      const e = m.get(r.skill.id) ?? { ...r.skill, holders: [] };
      e.holders.push(r.agent_id);
      m.set(r.skill.id, e);
    }
    return [...m.values()].sort((a, b) => (a.category ?? "~").localeCompare(b.category ?? "~") || a.name.localeCompare(b.name));
  }, [skillRows]);
  const skillList = useMemo<SkillItem[]>(() => skillCatalog.map(({ id, name, category }) => ({ id, name, category })), [skillCatalog]);
  const seenSkills = useRef<Set<string> | null>(null);
  const [skillSignals, setSkillSignals] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!skillRows) return;
    const keyOf = (r: SkillActivation) => `${r.agent_id}:${r.skill?.id ?? ""}`;
    let fresh: SkillActivation[];
    if (!seenSkills.current) {
      seenSkills.current = new Set();
      fresh = skillRows.filter((r) => new Date(r.activated_at).getTime() > openedAt.current - 3 * 60 * 1000);
    } else {
      fresh = skillRows.filter((r) => !seenSkills.current!.has(keyOf(r)));
    }
    for (const r of skillRows) seenSkills.current.add(keyOf(r));
    if (!fresh.length) return;
    setSkillSignals((prev) => {
      const next = new Map(prev);
      for (const r of fresh) next.set(r.agent_id, (next.get(r.agent_id) ?? 0) + 1);
      return next;
    });
  }, [skillRows]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const openSkills = useCallback(() => setSkillsOpen(true), []);
  const sceneSkills = useMemo(() => ({ list: skillList, onOpen: openSkills }), [skillList, openSkills]);

  // ── Les échanges entre agents (A2A), les vrais ──
  // Chaque nouveau message fait se lever son auteur, qui va voir son
  // destinataire ; sa phrase s'affiche en bulle quelques secondes.
  const { data: feed, isLoading: feedLoading } = useA2AFeed(ids);
  const seenMsgs = useRef<Set<string> | null>(null);
  const [visitSignals, setVisitSignals] = useState<Map<string, { to: string; n: number }>>(() => new Map());
  const [bubbles, setBubbles] = useState<Map<string, { text: string; kind: ExchangeKind; until: number }>>(() => new Map());
  useEffect(() => {
    if (!feed) return;
    const idSet = new Set(ids);
    let fresh = feed;
    if (!seenMsgs.current) {
      seenMsgs.current = new Set();
      fresh = feed.filter((m) => Date.now() - new Date(m.created_at).getTime() < 2 * 60 * 1000);
    } else {
      fresh = feed.filter((m) => !seenMsgs.current!.has(m.id));
    }
    for (const m of feed) seenMsgs.current.add(m.id);
    const ordered = [...fresh].filter((m) => idSet.has(m.from_agent)).reverse();
    if (!ordered.length) return;
    setVisitSignals((prev) => {
      const next = new Map(prev);
      for (const m of ordered) if (idSet.has(m.to_agent)) next.set(m.from_agent, { to: m.to_agent, n: (next.get(m.from_agent)?.n ?? 0) + 1 });
      return next;
    });
    setBubbles((prev) => {
      const next = new Map(prev);
      ordered.forEach((m, k) => {
        const text = m.content.replace(/\s+/g, " ").trim();
        next.set(m.from_agent, {
          text: text.length > 140 ? `${text.slice(0, 137)}…` : text,
          kind: (m.kind ?? "message") as ExchangeKind,
          until: Date.now() + 9000 + k * 1500,
        });
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);
  useEffect(() => {
    if (!bubbles.size) return;
    const t = window.setInterval(() => {
      setBubbles((prev) => {
        const now = Date.now();
        if (![...prev.values()].some((b) => b.until < now)) return prev;
        return new Map([...prev].filter(([, b]) => b.until >= now));
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [bubbles.size]);
  const speaking = useMemo(() => new Set(bubbles.keys()), [bubbles]);

  // Les débats en cours réunissent leurs deux agents en salle de réunion —
  // dès le lancement, avant même la première réplique.
  const [launched, setLaunched] = useState<Array<{ a: string; b: string; at: number }>>([]);
  const meetings = useMemo(() => {
    const pairs = [
      ...activeDebates(feed),
      ...launched.filter((l) => Date.now() - l.at < 150_000).map((l) => [l.a, l.b] as [string, string]),
    ];
    const out = new Map<string, number>();
    let k = 0;
    for (const [a, b] of pairs) {
      if (out.has(a) || out.has(b) || k >= MEETING_PAIRS.length) continue;
      out.set(a, MEETING_PAIRS[k][0]);
      out.set(b, MEETING_PAIRS[k][1]);
      k++;
    }
    return out;
  }, [feed, launched]);

  const stateOf = (id: string, act?: RosterActivity): AgentState =>
    (waiting.get(id) ?? 0) > 0 ? "waiting"
      : act?.live ? "working"
      : act?.lastStatus === "failed" ? "error"
      : "idle";

  const scene: SceneAgent[] = agents.map((a) => ({
    id: a.id, name: a.name, color: colorFor(a.id, a.accent_color), state: stateOf(a.id, activity?.get(a.id)),
    avatarUrl: a.avatar_url,
  }));
  const counts = { working: 0, waiting: 0, error: 0, idle: 0 } as Record<AgentState, number>;
  for (const a of scene) counts[a.state] += 1;

  // ── Les locaux ──
  const teamKey = teams.map((t) => `${t.id}:${t.name}:${t.color}:${t.agent_ids.join(",")}`).join("|");
  const layout = useMemo(
    () => computeLayout(teams.map((t) => ({ id: t.id, name: t.name, color: t.color, agentIds: t.agent_ids })), ids),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamKey, ids.join(",")],
  );
  const teamOf = new Map<string, (typeof teams)[number]>();
  for (const t of teams) for (const id of t.agent_ids) teamOf.set(id, t);

  // ── 3D, ou plan ──
  // Sans WebGL, ou si la 3D décroche, le plan 2D prend le relais — jamais un
  // écran mort. On peut aussi le choisir, et revenir à la 3D.
  const [view, setView] = useState<"3d" | "plan">(() => (webglWorks() ? "3d" : "plan"));
  const [failure, setFailure] = useState<SceneFailure | null>(() => (webglWorks() ? null : "webgl"));
  const giveUp = useCallback((r: SceneFailure) => { setFailure(r); setView("plan"); setGame(false); }, []);
  const retry3d = () => {
    if (!webglWorks()) { setFailure("webgl"); return; }
    setFailure(null);
    setView("3d");
  };

  // ── L'état de l'écran ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [exchangesOpen, setExchangesOpen] = useState(false);
  const [presetFrom, setPresetFrom] = useState<string | null>(null);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [angle, setAngle] = useState(0);
  const [command, setCommand] = useState<SceneCommand | null>(null);
  const cmd = (kind: SceneCommand["kind"]) => setCommand((c) => ({ kind, n: (c?.n ?? 0) + 1 }));

  // ── Dans l'espace ──
  const [game, setGame] = useState(false);
  const [near, setNear] = useState<string | null>(null);
  const [talkTo, setTalkTo] = useState<string | null>(null);
  const me = useMemo(() => {
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const name = (meta.full_name as string) || (meta.name as string) || user?.email?.split("@")[0] || "Vous";
    return { name, avatar: describeAvatar((meta.avatar_url as string | undefined) ?? null, name) };
  }, [user]);
  const enter = () => {
    setGame(true); setTeamsOpen(false); setExchangesOpen(false); setEditingTeamId(null); setSelectedId(null);
  };
  const leave = () => { setGame(false); setTalkTo(null); setNear(null); };
  useEffect(() => {
    if (!game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (talkTo) setTalkTo(null); else leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, talkTo]);

  const editingTeam = teams.find((t) => t.id === editingTeamId) ?? null;
  useEffect(() => { if (editingTeamId && !editingTeam) setEditingTeamId(null); }, [editingTeamId, editingTeam]);

  const labels = useRef(new Map<string, HTMLElement>());
  const setLabel = (key: string) => (el: HTMLElement | null) => {
    if (el) labels.current.set(key, el); else labels.current.delete(key);
  };

  /** Un clic sur un agent : en composition d'équipe, il entre ou sort de
   *  l'équipe ; dans l'espace, on va lui parler ; sinon, on le sélectionne. */
  const onPick = (id: string | null) => {
    if (id && editingTeam) {
      void mutate((list) => assignAgentToTeam(list, id, editingTeam.agent_ids.includes(id) ? null : editingTeam.id));
      return;
    }
    if (id && game) { setTalkTo(id); return; }
    setSelectedId(id);
  };

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const selectedScene = scene.find((a) => a.id === selectedId) ?? null;
  const talking = agents.find((a) => a.id === talkTo) ?? null;
  const nearAgent = agents.find((a) => a.id === near) ?? null;
  const recentCount = (feed ?? []).filter((m) => Date.now() - new Date(m.created_at).getTime() < 15 * 60 * 1000).length;

  if (!isLoading && agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <UsersThreeIcon className="h-6 w-6" />
        </span>
        <p className="mt-4 text-[15px] font-semibold">Les locaux sont vides</p>
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
          Déployez un premier collaborateur : il prendra son poste ici, et vous le verrez travailler en direct.
        </p>
        <button
          type="button" onClick={() => navigate(`${base}/agents/new`)}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          <RocketLaunchIcon className="h-4 w-4" /> Déployer un collaborateur
        </button>
      </div>
    );
  }

  return (
    // Un fond sombre et chaud : la maquette s'y détache comme un diorama
    // éclairé, quel que soit le thème.
    <div className="relative h-full w-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_45%,#3d3431_0%,#241f22_55%,#17151a_100%)]">
      {view === "3d" ? (
        <SceneGuard onGiveUp={giveUp}>
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-white/50" /></div>}>
            {!isLoading && (
              <LiveScene
                layout={layout}
                agents={scene}
                selectedId={selectedId}
                hoveredId={hoveredId}
                highlight={editingTeam ? { color: editingTeam.color, ids: new Set(editingTeam.agent_ids) } : null}
                onSelect={onPick}
                onHover={setHoveredId}
                angle={angle}
                command={command}
                dark={dark}
                labels={labels}
                memoryCount={memory?.count ?? 0}
                storeSignals={storeSignals}
                onOpenMemory={openMemory}
                visitSignals={visitSignals}
                speaking={speaking}
                meetings={meetings}
                game={game ? { avatar: me.avatar, talkingTo: talkTo } : null}
                onNearAgent={setNear}
                onInteract={setTalkTo}
                onFatal={giveUp}
                skills={sceneSkills}
                skillSignals={skillSignals}
              />
            )}
          </Suspense>
        </SceneGuard>
      ) : (
        <div className="absolute inset-0 px-4 pb-10 pt-16">
          <LivePlan
            layout={layout} agents={scene} selectedId={selectedId} hoveredId={hoveredId}
            onSelect={onPick} onHover={setHoveredId}
            colorOf={(a) => avatarColor(describeAvatar(a.avatarUrl, a.name))}
          />
        </div>
      )}

      {/* ── Les étiquettes, nettes au-dessus de la 3D ── */}
      {view === "3d" && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {layout.zones.filter((z) => z.side !== "open").map((z) => z.kind === "memory" ? (
            // La salle Utilities porte le compte de la mémoire partagée, et y mène.
            <div key={z.key} ref={setLabel(`zone:${z.key}`)} className="absolute left-0 top-0 flex items-center gap-1" style={{ transform: "translate3d(-9999px,0,0)" }}>
              <button
                type="button" onClick={openMemory}
                title="Ouvrir la mémoire partagée"
                className="pointer-events-auto flex items-center gap-1.5 whitespace-nowrap rounded-md bg-background/85 px-2 py-0.5 text-[11px] font-semibold tracking-tight shadow-sm ring-1 ring-primary/40 backdrop-blur-sm transition-colors hover:bg-background"
              >
                <DatabaseIcon className="h-3 w-3 text-primary" weight="fill" />
                {z.label}
                <span className="font-medium text-muted-foreground">
                  · {(memory?.count ?? 0).toLocaleString("fr-FR")} souvenir{(memory?.count ?? 0) > 1 ? "s" : ""}
                </span>
              </button>
              {/* L'armoire des skills, dans la même salle. */}
              <button
                type="button" onClick={openSkills}
                title="Ouvrir l'armoire des skills"
                className="pointer-events-auto flex items-center gap-1 whitespace-nowrap rounded-md bg-background/85 px-2 py-0.5 text-[11px] font-semibold tracking-tight shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-colors hover:bg-background"
              >
                <ToolboxIcon className="h-3 w-3 text-primary" weight="fill" />
                {skillCatalog.length} skill{skillCatalog.length > 1 ? "s" : ""}
              </button>
            </div>
          ) : (
            <div
              key={z.key} ref={setLabel(`zone:${z.key}`)}
              className="absolute left-0 top-0 whitespace-nowrap rounded-md bg-background/80 px-2 py-0.5 text-[11px] font-semibold tracking-tight shadow-sm ring-1 ring-border/60 backdrop-blur-sm"
              style={{ transform: "translate3d(-9999px,0,0)" }}
            >
              {z.label}
            </div>
          ))}
          {scene.map((a) => {
            const focus = a.id === selectedId || a.id === hoveredId || a.id === near;
            const act = activity?.get(a.id);
            const inEdit = editingTeam?.agent_ids.includes(a.id);
            const bubble = bubbles.get(a.id);
            const BIcon = bubble ? KIND_META[bubble.kind]?.icon ?? ChatsTeardropIcon : null;
            return (
              <div
                key={a.id} ref={setLabel(`agent:${a.id}`)}
                className="absolute left-0 top-0 flex flex-col items-center transition-opacity duration-150"
                style={{ transform: "translate3d(-9999px,0,0)" }}
              >
                {bubble && BIcon && (
                  // Ce que l'agent vient vraiment d'écrire à un collègue.
                  <div className="relative mb-1.5 max-w-[240px] rounded-xl bg-popover/95 px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-lg ring-1 ring-border/70 backdrop-blur-sm">
                    <BIcon className={cn("mr-1 inline h-3 w-3 -translate-y-px", KIND_META[bubble.kind]?.tone)} weight="fill" />
                    {bubble.text}
                    <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-popover/95 ring-1 ring-border/70 [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onPick(a.id)}
                  onMouseEnter={() => setHoveredId(a.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={cn(
                    "pointer-events-auto flex max-w-[220px] flex-col items-center rounded-lg px-1.5 py-0.5 text-center transition-all",
                    focus ? "bg-popover/95 shadow-md ring-1 ring-border" : "bg-background/75 ring-1 ring-border/40",
                    "backdrop-blur-sm",
                  )}
                  style={inEdit ? { boxShadow: `0 0 0 2px ${editingTeam!.color}` } : undefined}
                >
                  <span className="flex items-center gap-1 text-[10.5px] font-medium leading-tight">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_META[a.state].dot, a.state === "working" && "animate-pulse")} />
                    <span className="truncate">{a.name}</span>
                  </span>
                  {focus && (
                    <span className="mt-0.5 max-w-[200px] truncate text-[10px] leading-tight text-muted-foreground">
                      {a.state === "working" && act?.title ? act.title : STATE_META[a.state].label}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {game && (
            <div ref={setLabel("player")} className="absolute left-0 top-0" style={{ transform: "translate3d(-9999px,0,0)" }}>
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-primary-foreground shadow-md">Vous</span>
            </div>
          )}
        </div>
      )}

      {/* ── En-tête : le direct, en chiffres ── */}
      <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-start gap-2">
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border/60 bg-background/85 px-3 py-2 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            <span className="text-[13px] font-semibold tracking-tight">Live Space</span>
            <span className="hidden text-[12px] text-muted-foreground sm:inline">· {dashboardName}</span>
          </div>
          <span className="hidden h-4 w-px bg-border md:block" />
          <div className="hidden items-center gap-2.5 md:flex">
            {(["working", "waiting", "error", "idle"] as AgentState[]).map((s) => (
              counts[s] > 0 || s === "working" ? (
                <span key={s} className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                  <span className={cn("h-1.5 w-1.5 rounded-full", STATE_META[s].dot)} />
                  <span className="font-medium tabular-nums text-foreground">{counts[s]}</span>
                  {STATE_META[s].label.toLowerCase()}
                </span>
              ) : null
            ))}
          </div>
        </div>

        <div className="flex-1" />

        {game ? (
          <button
            type="button" onClick={leave}
            className="pointer-events-auto flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-background/90 px-3 text-[12.5px] font-medium shadow-sm backdrop-blur hover:bg-background"
          >
            <SignOutIcon className="h-4 w-4" /> Sortir <kbd className="rounded bg-muted px-1 text-[10px] text-muted-foreground">Échap</kbd>
          </button>
        ) : (
          <>
            {view === "3d" && (
              <button
                type="button" onClick={enter}
                className="pointer-events-auto flex h-10 items-center gap-2 rounded-xl bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground shadow-md hover:bg-primary/90"
              >
                <PersonSimpleWalkIcon className="h-4 w-4" weight="bold" /> Entrer
              </button>
            )}
            <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border/60 bg-background/85 p-1 shadow-sm backdrop-blur">
              <ToolButton
                active={teamsOpen} title="Équipes"
                onClick={() => { setTeamsOpen((v) => !v); if (teamsOpen) setEditingTeamId(null); }}
              >
                <UsersThreeIcon className="h-4 w-4" />
                <span className="hidden text-[12px] font-medium lg:inline">Équipes</span>
                {teams.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{teams.length}</span>}
              </ToolButton>
              <ToolButton active={exchangesOpen} title="Échanges entre agents" onClick={() => { setPresetFrom(null); setSkillsOpen(false); setExchangesOpen((v) => !v); }}>
                <ChatsTeardropIcon className="h-4 w-4" />
                <span className="hidden text-[12px] font-medium lg:inline">Échanges</span>
                {recentCount > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{recentCount}</span>}
              </ToolButton>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <ToolButton
                title={view === "3d" ? "Voir le plan" : "Voir en 3D"}
                onClick={() => (view === "3d" ? (setView("plan"), setFailure(null)) : retry3d())}
              >
                {view === "3d" ? <MapTrifoldIcon className="h-4 w-4" /> : <CubeIcon className="h-4 w-4" />}
              </ToolButton>
              {view === "3d" && (
                <>
                  <ToolButton title="Tourner à gauche" onClick={() => setAngle((a) => a - 1)}><ArrowCounterClockwiseIcon className="h-4 w-4" /></ToolButton>
                  <ToolButton title="Tourner à droite" onClick={() => setAngle((a) => a + 1)}><ArrowClockwiseIcon className="h-4 w-4" /></ToolButton>
                  <ToolButton title="Zoom arrière" onClick={() => cmd("zoom-out")}><MagnifyingGlassMinusIcon className="h-4 w-4" /></ToolButton>
                  <ToolButton title="Zoom avant" onClick={() => cmd("zoom-in")}><MagnifyingGlassPlusIcon className="h-4 w-4" /></ToolButton>
                  <ToolButton title="Tout voir" onClick={() => cmd("fit")}><CornersOutIcon className="h-4 w-4" /></ToolButton>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── La 3D a décroché : on le dit, sur le plan, avec de quoi réessayer ── */}
      {view === "plan" && failure && (
        <div className="absolute left-1/2 top-16 z-10 flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-xl border border-border/60 bg-popover/95 px-3.5 py-2 text-[12px] shadow-lg backdrop-blur">
          <span className="text-muted-foreground">
            {failure === "webgl"
              ? "La 3D est indisponible : le navigateur ne fournit pas WebGL (souvent bloqué après une erreur graphique — redémarrer le navigateur le rétablit). Voici le plan."
              : failure === "lost"
                ? "La carte graphique a décroché plusieurs fois : on reste sur le plan pour l'instant."
                : "La vue 3D a rencontré une erreur. Voici le plan, en attendant."}
          </span>
          <button type="button" onClick={retry3d} className="shrink-0 rounded-lg bg-muted px-2.5 py-1 font-medium hover:bg-muted/70">
            Réessayer la 3D
          </button>
        </div>
      )}

      {/* ── La composition d'équipe, à la souris ── */}
      {editingTeam && !game && (
        <div className="pointer-events-auto absolute left-1/2 top-16 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/60 bg-popover/95 py-1.5 pl-3 pr-1.5 text-[12.5px] shadow-lg backdrop-blur">
          <CursorClickIcon className="h-4 w-4 text-muted-foreground" />
          <span>
            Cliquez sur les agents pour les ajouter à{" "}
            <span className="font-semibold" style={{ color: editingTeam.color }}>{editingTeam.name}</span>, ou les en retirer.
          </span>
          <button
            type="button" onClick={() => setEditingTeamId(null)}
            className="rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium hover:bg-muted/70"
          >
            Terminer
          </button>
        </div>
      )}

      {/* ── Le tiroir des équipes ── */}
      {teamsOpen && !game && (
        <aside className="absolute bottom-3 left-3 top-16 z-10 flex w-[330px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-xl backdrop-blur-md">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <UsersThreeIcon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-[13px] font-semibold">Équipes</span>
            <button
              type="button" onClick={() => navigate(`${base}/settings/teams`)}
              title="Ouvrir dans les réglages" aria-label="Ouvrir dans les réglages"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <GearSixIcon className="h-4 w-4" />
            </button>
            <button
              type="button" onClick={() => { setTeamsOpen(false); setEditingTeamId(null); }}
              aria-label="Fermer" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <TeamsManager
              dashboard={{ id: dashboardId, name: dashboardName }}
              workspaceId={workspaceId} projectId={projectId}
              compact
              editingTeamId={editingTeamId}
              onEditTeam={setEditingTeamId}
            />
          </div>
        </aside>
      )}

      {/* ── L'armoire des skills : ce que le service sait faire, et qui le sait ── */}
      {skillsOpen && !game && (
        <aside className="absolute bottom-3 right-3 top-16 z-10 flex w-[360px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-xl backdrop-blur-md">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <ToolboxIcon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-[13px] font-semibold">Armoire des skills</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{skillCatalog.length}</span>
            <button type="button" onClick={() => setSkillsOpen(false)} aria-label="Fermer" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {!skillCatalog.length ? (
              <p className="py-6 text-center text-[12px] leading-relaxed text-muted-foreground">
                Aucun skill activé dans ce service. Les skills s'activent dans la configuration de chaque agent.
              </p>
            ) : (
              [...new Set(skillCatalog.map((s) => s.category ?? "Autres"))].map((cat) => (
                <section key={cat} className="mb-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span className="h-2 w-2 rounded-[3px]" style={{ background: skillColor(cat === "Autres" ? null : cat) }} />
                    {cat}
                  </p>
                  <ul className="space-y-1.5">
                    {skillCatalog.filter((s) => (s.category ?? "Autres") === cat).map((s) => (
                      <li key={s.id} className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2">
                        <p className="text-[12.5px] font-medium">{s.name}</p>
                        {s.description && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{s.description}</p>}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {s.holders.map((hid) => {
                            const a = agents.find((x) => x.id === hid);
                            if (!a) return null;
                            return (
                              <button
                                key={hid} type="button" title={`Les skills de ${a.name}`}
                                onClick={() => navigate(`${base}/agent-config/${hid}?t=skills`)}
                                className="flex items-center gap-1 rounded-full bg-background py-0.5 pl-0.5 pr-2 text-[11px] ring-1 ring-border/60 hover:bg-muted"
                              >
                                <AgentIdentity style={a.avatar_style ?? "orb"} url={a.avatar_url} seed={a.name} size={16} rounded="rounded-full" />
                                {a.name}
                              </button>
                            );
                          })}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </aside>
      )}

      {/* ── Les échanges : lancer un débat, suivre le fil ── */}
      {exchangesOpen && !game && !skillsOpen && (
        <ExchangesPanel
          key={presetFrom ?? "all"}
          agents={agents.map((a) => ({ id: a.id, name: a.name }))}
          feed={feed}
          loading={feedLoading}
          presetFrom={presetFrom}
          onClose={() => setExchangesOpen(false)}
          onLaunched={(a, b, kind) => { if (kind !== "idea") setLaunched((l) => [...l, { a, b, at: Date.now() }]); }}
        />
      )}

      {/* ── L'agent sélectionné ── */}
      {selected && selectedScene && !editingTeam && !game && !exchangesOpen && !skillsOpen && (
        <div className="absolute bottom-3 right-3 z-10 w-[300px] rounded-xl border border-border/60 bg-popover/95 p-3.5 shadow-xl backdrop-blur-md">
          <div className="flex items-start gap-3">
            <AgentIdentity style={selected.avatar_style ?? "orb"} url={selected.avatar_url} seed={selected.name} size={40} rounded="rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold leading-tight">{selected.name}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", STATE_META[selectedScene.state].dot)} />
                {STATE_META[selectedScene.state].label}
                {(waiting.get(selected.id) ?? 0) > 1 && ` (${waiting.get(selected.id)})`}
              </p>
            </div>
            <button type="button" onClick={() => setSelectedId(null)} aria-label="Fermer" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
            {selectedScene.state === "working" && activity?.get(selected.id)?.title
              ? <>Travaille sur <span className="text-foreground">{activity.get(selected.id)!.title}</span></>
              : selectedScene.state === "waiting" ? "Une validation ou une question vous attend dans « À valider »."
              : selectedScene.state === "error" ? ((activity?.get(selected.id)?.lastError ?? "").split("\n")[0] || "Sa dernière tâche a échoué.")
              : selected.description || "Rien en cours."}
          </p>

          <div className="mt-3 flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-[12px] transition-colors hover:bg-muted">
                  {teamOf.get(selected.id) ? (
                    <>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: teamOf.get(selected.id)!.color }} />
                      <span className="min-w-0 flex-1 truncate text-left">{teamOf.get(selected.id)!.name}</span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">Sans équipe</span>
                  )}
                  <CaretDownIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60 rounded-xl p-1.5">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">Équipe de {selected.name}</DropdownMenuLabel>
                {teams.map((t) => (
                  <DropdownMenuItem key={t.id} className="rounded-lg" onSelect={() => void mutate((list) => assignAgentToTeam(list, selected.id, t.id))}>
                    <span className="mr-2 h-2.5 w-2.5 rounded-[3px]" style={{ background: t.color }} />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    {teamOf.get(selected.id)?.id === t.id && <CheckIcon className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem className="rounded-lg" onSelect={() => void mutate((list) => assignAgentToTeam(list, selected.id, null))}>
                  <span className="mr-2 h-2.5 w-2.5 rounded-[3px] border border-border" />
                  <span className="flex-1">Sans équipe (open space)</span>
                  {!teamOf.get(selected.id) && <CheckIcon className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="rounded-lg"
                  onSelect={() => void mutate((list) => {
                    const t = newTeam(list);
                    return assignAgentToTeam([...list, t], selected.id, t.id);
                  })}
                >
                  <PlusIcon className="mr-2 h-3.5 w-3.5" /> Nouvelle équipe avec {selected.name}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <button
              type="button" onClick={() => navigate(`${base}/agent/${selected.id}`)}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <ChatsCircleIcon className="h-3.5 w-3.5" /> Parler
            </button>
            <button
              type="button" disabled={agents.length < 2}
              onClick={() => { setPresetFrom(selected.id); setExchangesOpen(true); }}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-muted/70 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
            >
              <SwordIcon className="h-3.5 w-3.5" /> Challenger
            </button>
            <button
              type="button"
              onClick={() => { wb?.openTab("agent-settings"); navigate(`${base}/agent/${selected.id}`); }}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-muted/70 text-[12px] font-medium hover:bg-muted"
            >
              <GearSixIcon className="h-3.5 w-3.5" /> Réglages
            </button>
          </div>
        </div>
      )}

      {/* ── Dans l'espace : les commandes, et l'agent à portée de voix ── */}
      {game && !talking && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
          {nearAgent && (
            <button
              type="button" onClick={() => setTalkTo(nearAgent.id)}
              className="pointer-events-auto flex items-center gap-2 rounded-full bg-popover/95 py-1.5 pl-1.5 pr-3.5 text-[12.5px] font-medium shadow-lg ring-1 ring-border backdrop-blur"
            >
              <kbd className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">E</kbd>
              Parler à {nearAgent.name}
            </button>
          )}
          <p className="rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/80 backdrop-blur">
            ZQSD ou flèches pour marcher · Maj pour courir · glisser pour tourner la vue · molette pour zoomer
          </p>
        </div>
      )}

      {/* ── La conversation : la vraie, avec l'agent ── */}
      {game && talking && (
        <aside className="absolute bottom-3 right-3 top-16 z-20 flex w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl">
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-3">
            <AgentIdentity style={talking.avatar_style ?? "orb"} url={talking.avatar_url} seed={talking.name} size={28} rounded="rounded-lg" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{talking.name}</span>
            <button type="button" onClick={() => setTalkTo(null)} aria-label="Fermer la conversation" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatTab agent={talking as unknown as InternalAgent} workspaceId={workspaceId} projectId={projectId} compact />
          </div>
        </aside>
      )}

      {teamError && (
        <p className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{teamError}</p>
      )}

      {/* ── Le mode d'emploi, discret ── */}
      {!selected && !teamsOpen && !game && (
        <p className="pointer-events-none absolute bottom-3 left-3 text-[11px] text-white/50">
          {view === "3d"
            ? "Glisser pour déplacer · molette pour zoomer · cliquer un agent pour le suivre · « Entrer » pour marcher parmi eux"
            : "Cliquer un agent pour le suivre"}
        </p>
      )}
    </div>
  );
}

function ToolButton({ title, onClick, active, children }: {
  title: string; onClick: () => void; active?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button" title={title} aria-label={title} onClick={onClick} aria-pressed={active}
      className={cn(
        "flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-1.5 transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * La garde de la vue 3D. Une erreur dans la scène n'est PAS forcément un
 * problème de WebGL : on retente deux fois (un hoquet de chargement, un
 * contexte perdu au mauvais moment), puis on rend la main — avec la vraie
 * raison : WebGL absent si le navigateur n'en fournit plus, erreur sinon.
 * Jamais d'écran mort : l'hôte bascule sur le plan 2D.
 */
class SceneGuard extends Component<{ children: ReactNode; onGiveUp: (r: SceneFailure) => void }, { attempt: number; failed: boolean }> {
  state = { attempt: 0, failed: false };
  private timer: number | undefined;
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) {
    console.error("[Live Space] la vue 3D a échoué :", error);
    const noGl = !webglWorks();
    if (noGl || this.state.attempt >= 2) {
      this.props.onGiveUp(noGl ? "webgl" : "error");
      return;
    }
    const wait = 600 * (this.state.attempt + 1);
    this.timer = window.setTimeout(() => this.setState((s) => ({ attempt: s.attempt + 1, failed: false })), wait);
  }
  componentWillUnmount() { window.clearTimeout(this.timer); }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center">
          <span className="flex items-center gap-2 rounded-full bg-background/80 px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm ring-1 ring-border/60 backdrop-blur">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reprise de la vue 3D…
          </span>
        </div>
      );
    }
    return <div key={this.state.attempt} className="h-full w-full">{this.props.children}</div>;
  }
}
