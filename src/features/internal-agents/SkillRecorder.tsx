// SkillRecorder — apprendre une compétence à un agent en la lui MONTRANT.
//
// Cette page est la moitié "voix + pilotage" de la fonctionnalité. La moitié
// "gestes" est assurée par l'un des deux capteurs, au choix de l'utilisateur :
//   - browser-recorder/ — l'extension, qui enregistre dans SES propres onglets
//     avec ses sessions vivantes (voie principale) ;
//   - skill-recorder/  — Playwright, dans un navigateur séparé (poste sans
//     extension, serveur).
// Les deux écrivent dans la même timeline (skill_recording_events), datée en ms
// depuis skill_recordings.started_at — c'est cet unique repère qui permet de
// recoller « ce que l'utilisateur dit » à « ce qu'il fait ».
//
// Répartition des rôles :
//   - l'app crée la ligne (status 'pending'), tient le micro, affiche la
//     timeline, et demande l'arrêt (status 'stopping') ;
//   - le recorder réclame la ligne, ouvre le navigateur, pousse les gestes, et
//     déclenche la synthèse à la fermeture.
// Aucun des deux ne pilote l'autre directement : le statut de la ligne est le
// seul canal, ce qui rend chaque moitié redémarrable sans casser l'autre.
//
// Route : agent/skills/record
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { signShots, toStoragePath } from "./recordingShots";
import {
  CaretLeftIcon as ChevronLeft,
  MicrophoneIcon as Mic,
  MicrophoneSlashIcon as MicOff,
  SquareIcon as Square,
  CircleNotchIcon as Loader2,
  SparkleIcon as Sparkles,
  WarningIcon as AlertTriangle,
  CursorClickIcon as MousePointerClick,
  KeyboardIcon as Keyboard,
  NavigationArrowIcon as Navigation,
  CheckSquareIcon as CheckSquare,
  UploadSimpleIcon as Upload,
  NoteIcon as StickyNote,
  ListChecksIcon as ListChecks,
  TerminalIcon as Terminal,
  RadioIcon as Radio,
  ArrowRightIcon as ArrowRight,
  FilmSlateIcon as Clapperboard,
  CaretUpDownIcon as ChevronsUpDown,
  KeyIcon as KeyRound,
  PuzzlePieceIcon as Puzzle,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { SoftField, SoftInput, SoftTextarea, SoftSelect } from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useNarration, type NarrationSegment } from "@/lib/useNarration";
import { cn } from "@/lib/utils";

type Phase = "setup" | "waiting" | "live" | "processing" | "ready" | "failed";

interface RecordingRow {
  id: string;
  status: string;
  title: string;
  started_at: string | null;
  heartbeat_at: string | null;
  captured_by: string | null;
  created_at: string;
  duration_ms: number | null;
  event_count: number;
  skill_id: string | null;
  error: string | null;
}

// Le recorder pousse un lot (donc un battement) toutes les ~1,2 s. Passé 90 s
// de silence, il n'est plus là : machine en veille, réseau coupé, processus
// tué. On le dit plutôt que de laisser tourner un chrono qui ment.
const HEARTBEAT_DEAD_MS = 90_000;

interface TimelineEvent {
  id: string;
  source: string;
  at_ms: number;
  kind: string;
  url: string | null;
  target: Record<string, unknown>;
  value: string | null;
  is_secret: boolean;
  screenshot_url: string | null;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Présence de l'extension navigateur, détectée par un aller-retour postMessage
 * avec son content script (browser-recorder/src/bridge.js).
 *
 * Une page web ne peut pas interroger une extension autrement : `chrome.runtime`
 * ne lui est pas exposé, et `externally_connectable` exigerait de connaître
 * l'identifiant de l'extension — lequel change à chaque installation en mode
 * développeur. Le pont est donc la seule voie qui marche aussi bien en dev
 * qu'en production, sur Chrome comme sur Edge, Opera ou Brave.
 */
function useRecorderExtension() {
  const [present, setPresent] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data as { __founderos_recorder_reply?: boolean; action?: string } | null;
      if (d?.__founderos_recorder_reply && (d.action === "pong" || d.action === "hello")) setPresent(true);
    };
    window.addEventListener("message", onMessage);
    // L'extension peut se charger après nous : on redemande quelques fois
    // plutôt que de conclure trop vite à son absence.
    window.postMessage({ __founderos_recorder: true, action: "ping" }, "*");
    const retries = [400, 1200, 3000].map((d) =>
      setTimeout(() => window.postMessage({ __founderos_recorder: true, action: "ping" }, "*"), d),
    );
    return () => {
      window.removeEventListener("message", onMessage);
      retries.forEach(clearTimeout);
    };
  }, []);

  /** Réveille le service worker : sans ça, il faudrait attendre son alarme. */
  const nudge = useCallback(() => {
    window.postMessage({ __founderos_recorder: true, action: "nudge" }, "*");
  }, []);

  return { present, nudge };
}

function eventIcon(kind: string) {
  const cls = "h-3.5 w-3.5 shrink-0";
  switch (kind) {
    case "narration": return <Mic className={cn(cls, "text-primary")} />;
    case "note":      return <StickyNote className={cn(cls, "text-amber-500")} />;
    case "navigate":
    case "tab_open":  return <Navigation className={cn(cls, "text-muted-foreground")} />;
    case "fill":
    case "select":    return <Keyboard className={cn(cls, "text-muted-foreground")} />;
    case "check":     return <CheckSquare className={cn(cls, "text-muted-foreground")} />;
    case "upload":    return <Upload className={cn(cls, "text-muted-foreground")} />;
    case "submit":    return <ListChecks className={cn(cls, "text-muted-foreground")} />;
    default:          return <MousePointerClick className={cn(cls, "text-muted-foreground")} />;
  }
}

/** Même vocabulaire que la synthèse côté serveur, pour que l'utilisateur relise
 *  pendant l'enregistrement exactement ce que l'agent lira après. */
function describeEvent(ev: TimelineEvent): string {
  const t = ev.target ?? {};
  const label = String(t.label ?? t.text ?? t.placeholder ?? t.name ?? "").trim();
  const role = String(t.role ?? t.tag ?? "élément");
  const where = label ? `${role} « ${label} »` : role;
  const value = ev.is_secret ? "•••••" : (ev.value ?? "");
  switch (ev.kind) {
    case "narration": return value;
    case "note":      return value;
    case "navigate":  return ev.url ?? "";
    case "tab_open":  return `Nouvel onglet — ${ev.url ?? ""}`;
    case "tab_close": return "Onglet fermé";
    case "click":     return `Clic sur ${where}`;
    case "fill":      return `Saisie « ${value} » dans ${where}`;
    case "select":    return `Choix « ${value} » dans ${where}`;
    case "check":     return `${value === "false" ? "Décoché" : "Coché"} ${where}`;
    case "press":     return `Touche ${value}`;
    case "submit":    return `Formulaire validé ${where}`;
    case "upload":    return `Fichier ${value}`;
    case "copy":      return `Copié « ${value} »`;
    case "scroll":    return "Défilement";
    default:          return `${ev.kind} ${where}`;
  }
}

export function SkillRecorderPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const { workspaceId, projectId } = useCurrentContext();
  const skillsHome = `/app/${workspaceSlug}/${projectSlug}/agent/skills`;

  const [phase, setPhase] = useState<Phase>("setup");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [agentId, setAgentId] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now());
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  // Compteurs de séquence LOCAUX, un par source. L'unicité en base porte sur
  // (recording_id, source, seq) : deux producteurs ne se marchent pas dessus,
  // et un renvoi après coupure réseau ne duplique rien.
  //
  // Ils sont RECHARGÉS depuis la base à l'entrée en enregistrement (voir plus
  // bas) : un rechargement de page en cours de démonstration les remettrait à
  // zéro, et chaque phrase suivante partirait en collision d'unicité —
  // c'est-à-dire en silence, ce qui est le pire cas possible ici.
  const narrationSeq = useRef(0);
  const noteSeq = useRef(0);

  const { data: agents } = useQuery({
    queryKey: ["internal_agents_for_recorder", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name").eq("workspace_id", workspaceId!).order("name").limit(100);
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  // La ligne d'enregistrement est la machine à états : l'UI ne fait que la
  // suivre, jamais l'anticiper.
  const { data: recording } = useQuery({
    queryKey: ["skill_recording", recordingId],
    enabled: !!recordingId,
    refetchInterval: phase === "ready" || phase === "failed" ? false : 1500,
    queryFn: async () => {
      const { data } = await supabase.from("skill_recordings")
        .select("id, status, title, created_at, started_at, heartbeat_at, captured_by, duration_ms, event_count, skill_id, error")
        .eq("id", recordingId!).maybeSingle();
      return (data ?? null) as RecordingRow | null;
    },
  });

  const { data: events } = useQuery({
    queryKey: ["skill_recording_events", recordingId],
    enabled: !!recordingId && (phase === "live" || phase === "processing" || phase === "ready" || phase === "failed"),
    refetchInterval: phase === "live" ? 1800 : false,
    queryFn: async () => {
      const { data } = await supabase.from("skill_recording_events")
        .select("id, source, at_ms, kind, url, target, value, is_secret, screenshot_url")
        .eq("recording_id", recordingId!).order("at_ms").limit(600);
      return (data ?? []) as TimelineEvent[];
    },
  });

  const originMs = useMemo(
    () => (recording?.started_at ? Date.parse(recording.started_at) : null),
    [recording?.started_at],
  );

  /** Reprend les compteurs là où la base les a laissés (cas du rechargement). */
  const resumeSeqCounters = useCallback(async (id: string) => {
    const next = async (source: string) => {
      const { data } = await supabase.from("skill_recording_events")
        .select("seq").eq("recording_id", id).eq("source", source)
        .order("seq", { ascending: false }).limit(1).maybeSingle();
      return ((data as { seq: number } | null)?.seq ?? -1) + 1;
    };
    [narrationSeq.current, noteSeq.current] = await Promise.all([next("narration"), next("user")]);
  }, []);

  // Chaque segment final part directement en base : la timeline reste vraie même
  // si l'onglet est fermé en cours de route.
  const onSegment = useCallback(async (seg: NarrationSegment) => {
    if (!recordingId) return;
    const { error } = await supabase.from("skill_recording_events").insert({
      recording_id: recordingId,
      source: "narration",
      seq: narrationSeq.current++,
      at_ms: seg.atMs,
      kind: "narration",
      value: seg.text,
      duration_ms: seg.durationMs,
    });
    // Une collision de séquence (deux onglets ouverts sur la même démo) ne doit
    // pas coûter la phrase : on repositionne le compteur et on réessaie.
    if (error) {
      await resumeSeqCounters(recordingId);
      await supabase.from("skill_recording_events").insert({
        recording_id: recordingId,
        source: "narration",
        seq: narrationSeq.current++,
        at_ms: seg.atMs,
        kind: "narration",
        value: seg.text,
        duration_ms: seg.durationMs,
      });
    }
  }, [recordingId, resumeSeqCounters]);

  const narration = useNarration({ originMs, onSegment });
  const extension = useRecorderExtension();

  const [justPaired, setJustPaired] = useState(false);
  const { nudge } = extension;
  // L'appairage vient d'aboutir : le service worker doit aller chercher son
  // jeton et réclamer tout de suite, plutôt qu'au prochain battement d'alarme.
  const onPaired = useCallback(() => {
    setJustPaired(true);
    nudge();
    setTimeout(nudge, 1500);
  }, [nudge]);

  // Choix du capteur. `null` = pas encore décidé par l'utilisateur : on suit
  // alors la détection, qui est le bon réflexe dans 99 % des cas.
  const [captureChoice, setCaptureChoice] = useState<"extension" | "playwright" | null>(null);
  const captureMode: "extension" | "playwright" | "any" =
    captureChoice ?? (extension.present ? "extension" : "any");
  const { start: startMic, stop: stopMic, recording: micOn } = narration;

  // Chrono.
  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Transitions de phase, pilotées par le statut serveur.
  const status = recording?.status;
  useEffect(() => {
    if (!status) return;
    if (status === "recording" && phase === "waiting") {
      setPhase("live");
      if (recordingId) void resumeSeqCounters(recordingId);
      // Le micro s'ouvre tout seul : l'intérêt de la fonctionnalité est la
      // narration, et l'oublier ruine l'enregistrement.
      void startMic();
      return;
    }
    if (status === "processing" && (phase === "live" || phase === "waiting")) {
      stopMic();
      setPhase("processing");
      return;
    }
    if (status === "ready") { stopMic(); setPhase("ready"); return; }
    if (status === "failed" || status === "cancelled") { stopMic(); setPhase("failed"); }
  }, [status, phase, startMic, stopMic, recordingId, resumeSeqCounters]);

  async function startRecording() {
    if (!workspaceId || !title.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      const { data, error } = await supabase.from("skill_recordings").insert({
        workspace_id: workspaceId,
        project_id: projectId,
        agent_id: agentId || null,
        title: title.trim(),
        goal: goal.trim() || null,
        start_url: startUrl.trim() || null,
        status: "pending",
        // Qui doit filmer. Quand l'extension répond, elle est le bon choix par
        // défaut (les onglets réels de l'utilisateur, ses sessions). Sinon on
        // laisse 'any' plutôt que d'imposer Playwright : la détection peut être
        // un faux négatif (extension installée mais onglet chargé avant elle),
        // et bloquer le capteur présent serait pire que de le laisser venir.
        capture_mode: captureMode,
      }).select("id").single();
      if (error) { setFormError(error.message); return; }
      narrationSeq.current = 0;
      noteSeq.current = 0;
      setRecordingId((data as { id: string }).id);
      setStopRequested(false);
      setWaitingSince(Date.now());
      setPhase("waiting");
      // L'extension dort entre deux battements d'alarme (30 s). Ce coup de coude
      // la fait réclamer tout de suite : sans lui, presser « Démarrer » donnerait
      // l'impression que rien ne se passe.
      extension.nudge();
    } finally {
      setBusy(false);
    }
  }

  /** Reprend la même demande à zéro : l'ancienne est périmée côté serveur. */
  async function restartRequest() {
    if (!recordingId) return;
    await supabase.from("skill_recordings").update({ status: "cancelled" }).eq("id", recordingId);
    setRecordingId(null);
    await startRecording();
  }

  async function stopRecording() {
    if (!recordingId) return;
    stopMic();
    setStopRequested(true);
    // On demande l'arrêt ; c'est le recorder qui referme le navigateur et
    // déclenche la synthèse, pour qu'aucun geste en vol ne soit perdu. Il peut
    // donc s'écouler une ou deux secondes avant que la phase change.
    await supabase.from("skill_recordings").update({ status: "stopping" }).eq("id", recordingId);
  }

  async function cancelRecording() {
    if (!recordingId) return;
    stopMic();
    await supabase.from("skill_recordings").update({ status: "cancelled" }).eq("id", recordingId);
    setPhase("failed");
  }

  // Forcer la synthèse — le recorder n'est plus là pour la déclencher, ou elle a
  // échoué. La trace, elle, est intacte en base : c'est tout ce dont on a besoin.
  async function forceSynthesis() {
    if (!recordingId || !workspaceId || !projectId) return;
    setBusy(true);
    setFormError(null);
    try {
      stopMic();
      const { data, error } = await supabase.functions.invoke("test-run-orchestrate", {
        body: {
          action: "synthesize_recording",
          workspace_id: workspaceId,
          project_id: projectId,
          recording_id: recordingId,
        },
      });
      if (error) {
        // functions.invoke remplace un 4xx par « non-2xx status code » et laisse
        // la vraie réponse dans error.context — or c'est justement là que se
        // trouve la seule phrase utile pour l'utilisateur.
        const ctx = (error as { context?: unknown }).context;
        const body = ctx instanceof Response ? await ctx.json().catch(() => null) : null;
        setFormError((body as { error?: string } | null)?.error ?? error.message);
        return;
      }
      const message = (data as { error?: string } | null)?.error;
      if (message) { setFormError(message); return; }
      setPhase("processing");
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const text = note.trim();
    if (!text || !recordingId || originMs == null) return;
    setNote("");
    await supabase.from("skill_recording_events").insert({
      recording_id: recordingId,
      source: "user",
      seq: noteSeq.current++,
      at_ms: Math.max(0, Date.now() - originMs),
      kind: "note",
      value: text,
    });
  }

  const elapsed = originMs != null ? now - originMs : 0;
  const gestureCount = (events ?? []).filter((e) => e.source === "browser").length;
  const spokenCount = (events ?? []).filter((e) => e.source === "narration").length;
  // Au-delà de ~15 s sans réclamation, le recorder local n'est probablement pas
  // lancé — on le dit, plutôt que de laisser tourner un spinner.
  const recorderLikelyOffline = phase === "waiting" && waitingSince != null && now - waitingSince > 15000;
  // Le serveur refuse de servir une demande en attente vieille de plus de 15 min
  // (rec_claim, migration 0204) : passé ce délai, aucun capteur ne la prendra
  // plus jamais. Laisser tourner le spinner serait mentir.
  const staleRequest = phase === "waiting"
    && recording?.created_at != null
    && now - Date.parse(recording.created_at) > 15 * 60_000;

  const recorderLost = phase === "live"
    && recording?.heartbeat_at != null
    && now - Date.parse(recording.heartbeat_at) > HEARTBEAT_DEAD_MS;

  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Barre supérieure */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-1.5 text-sm">
          <button onClick={() => navigate(skillsHome)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" /> Skills
          </button>
          <span className="text-muted-foreground/50">/</span>
          <span className="font-medium text-foreground">Enregistrer une démonstration</span>
        </div>
        {phase === "live" && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              {mmss(elapsed)}
            </span>
            <Button size="sm" variant="outline" onClick={cancelRecording}>Annuler</Button>
            {/* L'arrêt n'est pas instantané : le recorder doit voir la demande,
                pousser son dernier lot et refermer le navigateur. */}
            <Button size="sm" onClick={stopRecording} disabled={stopRequested}>
              {stopRequested
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Fermeture du navigateur…</>
                : <><Square className="mr-1.5 h-3.5 w-3.5" /> Arrêter et créer la skill</>}
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ── Réglages ─────────────────────────────────────────────────────── */}
        {phase === "setup" && (
          <div className="mx-auto max-w-2xl px-6 py-10">
            <div className="mb-8 flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-primary/10 p-2.5"><Clapperboard className="h-5 w-5 text-primary" /></div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Montrez, l'agent apprend</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Un navigateur s'ouvre et enregistre vos gestes pendant que vous expliquez à voix haute
                  ce que vous faites. Vos mots sont recollés aux actions qu'ils décrivent, et l'ensemble
                  devient une skill réutilisable.
                </p>
              </div>
            </div>

            <div className="space-y-5">
              <SoftField label="Que montrez-vous ?">
                <SoftInput
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Créer un devis dans le CRM"
                  autoFocus
                />
              </SoftField>

              <SoftField label="Objectif (ce que l'agent devra savoir refaire)">
                <SoftTextarea
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={3}
                  placeholder="À partir d'une demande client, produire un devis chiffré et l'envoyer pour validation."
                />
              </SoftField>

              <SoftField label="URL de départ">
                <SoftInput
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://app.mon-crm.com/devis"
                />
              </SoftField>

              <SoftField label="Activer la skill sur un agent (facultatif)">
                <SoftSelect
                  value={agentId}
                  options={(agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
                  onChange={setAgentId}
                  placeholder="Aucun agent"
                />
              </SoftField>

              {/* Le choix du capteur n'apparaît QUE s'il est réel : proposer
                  « extension ou Playwright » à quelqu'un qui n'a ni l'un ni
                  l'autre installé serait une question sans réponse. */}
              {extension.present && (
                <SoftField label="Où enregistrer">
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { key: "extension" as const, title: "Mes onglets", hint: "Extension — sessions déjà ouvertes" },
                      { key: "playwright" as const, title: "Navigateur séparé", hint: "Playwright — profil dédié" },
                    ]).map((opt) => {
                      const active = captureMode === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setCaptureChoice(opt.key)}
                          className={cn(
                            "rounded-xl px-3.5 py-3 text-left transition-colors",
                            active ? "bg-primary/10 ring-2 ring-primary/30" : "bg-muted/50 hover:bg-muted",
                          )}
                        >
                          <div className={cn("text-sm font-medium", active && "text-primary")}>{opt.title}</div>
                          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{opt.hint}</div>
                        </button>
                      );
                    })}
                  </div>
                </SoftField>
              )}

              <div className="rounded-xl bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
                <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
                  <Mic className="h-3.5 w-3.5" /> Commentez pendant que vous faites
                </div>
                C'est la narration qui porte le <em>pourquoi</em> — les règles métier, les cas particuliers,
                ce qu'il ne faut surtout pas faire. Les gestes seuls ne donnent que le <em>comment</em>.
                <br /><br />
                Les mots de passe, numéros de carte, IBAN et clés d'API sont masqués avant même de quitter
                votre machine : ils deviennent des variables de la skill.
              </div>

              {formError && (
                <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {formError}
                </div>
              )}

              <Button onClick={startRecording} disabled={busy || !title.trim()} className="w-full">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radio className="mr-2 h-4 w-4" />}
                Démarrer l'enregistrement
              </Button>
            </div>
          </div>
        )}

        {/* ── En attente du recorder local ─────────────────────────────────── */}
        {phase === "waiting" && (
          <div className="mx-auto max-w-2xl px-6 py-16 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
            <h2 className="mt-4 text-base font-medium">En attente du recorder…</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Le navigateur d'enregistrement va s'ouvrir sur votre machine.
            </p>

            {staleRequest && (
              <div className="mt-8 text-left"><StaleNotice onRestart={restartRequest} busy={busy} /></div>
            )}

            {/* Le conseil doit porter sur le capteur ATTENDU. Dire « extension
                détectée » à quelqu'un qui a demandé Playwright l'enverrait
                chercher au mauvais endroit. */}
            {recorderLikelyOffline && captureMode === "playwright" && (
              <div className="mt-8 rounded-xl border border-border bg-card p-5 text-left">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Terminal className="h-4 w-4 text-muted-foreground" /> Le recorder Playwright ne répond pas
                </div>
                <pre className="overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300">
{`cd skill-recorder
npm install
cp .env.example .env   # SUPABASE_URL uniquement
npm start`}
                </pre>
              </div>
            )}

            {/* L'extension est installée : la seule chose qui puisse manquer
                est l'appairage. Inutile de proposer d'installer autre chose.
                Une fois appairée, ce conseil devient faux — on le retire. */}
            {recorderLikelyOffline && captureMode !== "playwright" && extension.present && (
              <div className="mt-8 space-y-4 text-left">
                {!justPaired && (
                  <div className="rounded-xl border border-border bg-card p-5">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                      <Puzzle className="h-4 w-4 text-muted-foreground" /> Extension détectée, mais silencieuse
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Elle n'est probablement pas encore appairée à ce workspace. Ouvrez-la depuis la barre
                      d'outils du navigateur : elle affiche un code à saisir ci-dessous.
                    </p>
                  </div>
                )}
                <PairingBox onPaired={onPaired} />
              </div>
            )}

            {recorderLikelyOffline && captureMode !== "playwright" && !extension.present && (
              <div className="mt-8 space-y-4 text-left">
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <Puzzle className="h-4 w-4 text-muted-foreground" /> Installez l'extension
                  </div>
                  <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                    Elle enregistre dans <strong>vos</strong> onglets, avec vos sessions déjà ouvertes.
                    Fonctionne sur Chrome, Edge, Opera, Brave et Vivaldi.
                  </p>
                  <pre className="overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300">
{`1.  ${"chrome"}://extensions  →  Mode développeur
2.  « Charger l'extension non empaquetée »
3.  choisir le dossier  browser-recorder/`}
                  </pre>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Puis ouvrez-la, renseignez l'URL du projet, et saisissez ici le code affiché.
                  </p>
                </div>
                <PairingBox onPaired={onPaired} />
                <details className="px-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Ou utiliser le recorder Playwright (navigateur séparé)
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300">
{`cd skill-recorder
npm install
cp .env.example .env   # SUPABASE_URL uniquement
npm start`}
                  </pre>
                </details>
              </div>
            )}

            <Button variant="outline" size="sm" className="mt-6" onClick={cancelRecording}>Annuler</Button>
          </div>
        )}

        {/* ── Enregistrement en cours ──────────────────────────────────────── */}
        {phase === "live" && (
          <div className="mx-auto grid max-w-5xl gap-6 px-6 py-6 lg:grid-cols-[1fr_300px]">
            <div className="min-w-0">
              {recorderLost && (
                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" /> Le recorder ne répond plus
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Plus aucun geste ne remonte depuis {mmss(now - Date.parse(recording!.heartbeat_at!))}.
                    Ce qui a déjà été capturé est en sécurité — vous pouvez en faire une skill dès maintenant.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={forceSynthesis} disabled={busy}>
                      {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                      Créer la skill avec ce qui est enregistré
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelRecording}>Abandonner</Button>
                  </div>
                </div>
              )}
              <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
                <span>{gestureCount} geste{gestureCount > 1 ? "s" : ""}</span>
                <span>·</span>
                <span>{spokenCount} phrase{spokenCount > 1 ? "s" : ""}</span>
                {/* Lever le doute : deux capteurs peuvent être installés, il
                    faut pouvoir lire lequel filme. */}
                {recording?.captured_by && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      {recording.captured_by === "extension"
                        ? <><Puzzle className="h-3 w-3" /> vos onglets</>
                        : <><Terminal className="h-3 w-3" /> navigateur séparé</>}
                    </span>
                  </>
                )}
              </div>
              <Timeline events={events ?? []} />
            </div>

            <aside className="space-y-4">
              <div className="rounded-xl border border-border bg-card p-4">
                <button
                  onClick={narration.toggle}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    micOn ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                  {micOn ? "Micro actif" : narration.connecting ? "Connexion…" : "Micro coupé"}
                </button>

                {micOn && (
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-100"
                      style={{ width: `${Math.round(narration.level * 100)}%` }}
                    />
                  </div>
                )}
                {narration.interim && (
                  <p className="mt-3 text-xs italic leading-relaxed text-muted-foreground">« {narration.interim} »</p>
                )}
                {narration.error && (
                  <p className="mt-3 text-xs text-destructive">{narration.error}</p>
                )}
              </div>

              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <StickyNote className="h-3.5 w-3.5" /> Ajouter une précision
                </div>
                <SoftTextarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void addNote(); }}
                  rows={3}
                  placeholder="Ce qui se dit mal à voix haute : une référence, un identifiant exact…"
                />
                <Button size="sm" variant="outline" className="mt-2 w-full" onClick={addNote} disabled={!note.trim()}>
                  Ajouter à la timeline
                </Button>
              </div>

              <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
                Travaillez dans la fenêtre ouverte par le recorder — c'est la seule qui est observée.
                Fermer cette fenêtre arrête aussi l'enregistrement.
              </p>
            </aside>
          </div>
        )}

        {/* ── Synthèse ─────────────────────────────────────────────────────── */}
        {phase === "processing" && (
          <div className="mx-auto max-w-2xl px-6 py-16 text-center">
            <Sparkles className="mx-auto h-6 w-6 animate-pulse text-primary" />
            <h2 className="mt-4 text-base font-medium">Traduction de votre démonstration en skill…</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {recording?.event_count ?? 0} événements analysés — gestes et narration recollés dans l'ordre.
            </p>
          </div>
        )}

        {/* ── Terminé ──────────────────────────────────────────────────────── */}
        {phase === "ready" && (
          <div className="mx-auto max-w-2xl px-6 py-16 text-center">
            <div className="mx-auto w-fit rounded-2xl bg-primary/10 p-3"><Sparkles className="h-6 w-6 text-primary" /></div>
            <h2 className="mt-4 text-lg font-semibold">Skill créée</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {mmss(recording?.duration_ms ?? 0)} de démonstration · {recording?.event_count ?? 0} événements
              {agentId ? " · activée sur l'agent choisi" : ""}
            </p>
            <div className="mt-6 flex justify-center gap-2">
              <Button variant="outline" onClick={() => navigate(skillsHome)}>Bibliothèque</Button>
              {recording?.skill_id && (
                <Button onClick={() => navigate(`${skillsHome}/${recording.skill_id}/edit`)}>
                  Ouvrir la skill <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <details className="mt-10 text-left">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                <ChevronsUpDown className="mr-1 inline h-3 w-3" /> Revoir la démonstration
              </summary>
              <div className="mt-3"><Timeline events={events ?? []} /></div>
            </details>
          </div>
        )}

        {/* ── Échec / annulation ───────────────────────────────────────────── */}
        {phase === "failed" && (
          <div className="mx-auto max-w-2xl px-6 py-16 text-center">
            <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
            <h2 className="mt-4 text-base font-medium">
              {recording?.status === "cancelled" ? "Enregistrement annulé" : "La skill n'a pas pu être créée"}
            </h2>
            {recording?.error && <p className="mt-2 text-sm text-muted-foreground">{recording.error}</p>}
            {formError && <p className="mt-2 text-sm text-destructive">{formError}</p>}
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => navigate(skillsHome)}>Bibliothèque</Button>
              {/* La trace survit à l'échec de la synthèse : une panne de LLM ne
                  doit pas coûter la démonstration. */}
              {recording?.status === "failed" && (recording?.event_count ?? 0) > 0 && (
                <Button variant="outline" onClick={forceSynthesis} disabled={busy}>
                  {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                  Relancer la synthèse
                </Button>
              )}
              <Button onClick={() => { setRecordingId(null); setPhase("setup"); }}>Recommencer</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Une demande restée trop longtemps sans preneur ne sera plus servie : il faut
 *  la relancer, pas attendre davantage. */
function StaleNotice({ onRestart, busy }: { onRestart: () => void; busy: boolean }) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" /> Cette demande a expiré
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Une demande en attente n'est servie que pendant 15 minutes — au-delà, aucun capteur ne la
        prendra. Relancez-la : vos réglages sont conservés.
      </p>
      <Button size="sm" onClick={onRestart} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Radio className="mr-1.5 h-3.5 w-3.5" />}
        Relancer l'enregistrement
      </Button>
    </div>
  );
}

/**
 * Appairage d'un recorder. Au premier lancement, le recorder affiche un code à
 * 8 caractères ; le saisir ici — depuis une session authentifiée — est ce qui
 * donne à l'appareil son identité et sa portée.
 *
 * C'est l'inverse d'un secret qu'on copie : le code ne vaut rien seul, il
 * expire en 10 minutes, et l'utilisateur ne manipule jamais le vrai jeton.
 */
function PairingBox({ onPaired }: { onPaired?: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");

  async function submit() {
    if (!code.trim() || !workspaceId || !projectId) return;
    setState("busy");
    setError(null);
    try {
      const { data, error: err } = await supabase.functions.invoke("test-run-orchestrate", {
        body: { action: "pair_recorder", workspace_id: workspaceId, project_id: projectId, code: code.trim() },
      });
      if (err) {
        const ctx = (err as { context?: unknown }).context;
        const body = ctx instanceof Response ? await ctx.json().catch(() => null) : null;
        setError((body as { error?: string } | null)?.error ?? err.message);
        setState("idle");
        return;
      }
      setDeviceName((data as { device?: { name?: string } } | null)?.device?.name ?? "cet appareil");
      setState("done");
      onPaired?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Sparkles className="h-4 w-4" /> {deviceName} est appairé
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Il va réclamer l'enregistrement dans quelques secondes. Vous n'aurez plus à refaire cette étape.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-muted-foreground" /> Premier lancement ?
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Le recorder affiche un code d'appairage dans le terminal. Saisissez-le ici une seule fois —
        il n'y a aucun jeton à copier.
      </p>
      <div className="flex gap-2">
        <SoftInput
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder="XXXX-XXXX"
          maxLength={9}
          className="font-mono tracking-[0.2em]"
        />
        <Button onClick={submit} disabled={state === "busy" || code.trim().length < 8}>
          {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Appairer"}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Timeline fusionnée — les phrases prononcées sont visuellement distinctes des
 *  gestes, parce que c'est exactement la distinction que fait la synthèse. */
function Timeline({ events }: { events: TimelineEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [events.length]);

  // FOS-04 — le bucket `skill-recordings` était public : ces captures filment
  // l'écran de l'opérateur pendant qu'il manipule ses vrais outils, et
  // n'importe qui pouvait les lire. Il est privé depuis la migration 0241, donc
  // chaque vignette doit être signée avant d'être affichée. Signature par lot,
  // mise en cache dans recordingShots : une timeline en compte des dizaines.
  const [shots, setShots] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const stored = events.map((e) => e.screenshot_url).filter(Boolean);
    if (stored.length === 0) return;
    signShots(stored).then((m) => { if (!cancelled) setShots(m); });
    return () => { cancelled = true; };
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        En attente des premiers gestes…
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {events.map((ev) => {
        const spoken = ev.source === "narration";
        const isNote = ev.kind === "note";
        return (
          <div
            key={ev.id}
            className={cn(
              "flex items-start gap-2.5 rounded-lg px-3 py-2 text-xs",
              spoken && "bg-primary/5",
              isNote && "bg-amber-500/5",
            )}
          >
            <span className="w-9 shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {mmss(ev.at_ms)}
            </span>
            <span className="pt-0.5">{eventIcon(ev.kind)}</span>
            <span className={cn("min-w-0 flex-1 break-words leading-relaxed", spoken && "italic text-foreground")}>
              {spoken ? `« ${describeEvent(ev)} »` : describeEvent(ev)}
            </span>
            {(() => {
              // Rien tant que la signature n'est pas revenue — et rien non plus
              // si elle a été refusée (vignette d'un autre workspace).
              const path = toStoragePath(ev.screenshot_url);
              const signed = path ? shots.get(path) : null;
              if (!signed) return null;
              return (
                <a href={signed} target="_blank" rel="noreferrer" className="shrink-0">
                  <img src={signed} alt="" className="h-8 w-14 rounded border border-border object-cover" />
                </a>
              );
            })()}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
