import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PlayCircle,
  Loader2,
  Clock,
  MousePointerClick,
  AlertTriangle,
  Monitor,
  Smartphone,
  Tablet,
  FileStack,
  Film,
} from "lucide-react";
import rrwebPlayer from "rrweb-player";
import type { eventWithTime } from "@rrweb/types";
import "rrweb-player/dist/style.css";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface ReplaySession {
  id: string;
  client_session_id: string;
  user_email: string | null;
  customer_external_id: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  country: string | null;
  entry_url: string | null;
  started_at: string;
  last_activity_at: string;
  duration_ms: number;
  event_count: number;
  page_count: number;
  rage_click_count: number;
  error_count: number;
}

// rrweb eventWithTime — kept loose; the player validates the shape.
type RrwebEvent = { type: number; timestamp: number; data?: unknown };

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}m ${rest.toString().padStart(2, "0")}s`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function DeviceIcon({ device }: { device: string | null }) {
  if (device === "mobile") return <Smartphone className="h-3.5 w-3.5" />;
  if (device === "tablet") return <Tablet className="h-3.5 w-3.5" />;
  return <Monitor className="h-3.5 w-3.5" />;
}

export function SessionReplayPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["session_replay_sessions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("session_replay_sessions")
        .select("*")
        .eq("project_id", projectId!)
        .order("started_at", { ascending: false })
        .limit(100);
      return (data ?? []) as ReplaySession[];
    },
  });

  // Auto-select the first session once the list loads.
  useEffect(() => {
    if (!selectedId && sessions && sessions.length > 0) {
      setSelectedId(sessions[0].id);
    }
  }, [sessions, selectedId]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title="Session Replay"
        description="Replay real user sessions reconstructed from DOM snapshots — spot rage clicks, errors and drop-offs."
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState
          icon={Film}
          title="No recorded sessions yet"
          description="Install the recorder SDK on your app — it ships rrweb events to the ingest-session-replay endpoint. Sessions appear here automatically."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
          {/* ===== Session list ===== */}
          <div className="space-y-2 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                  s.id === selectedId
                    ? "border-[hsl(var(--primary-soft))] bg-secondary/50"
                    : "border-border hover:bg-secondary/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {s.user_email ?? s.customer_external_id ?? "Anonymous visitor"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(s.started_at)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <DeviceIcon device={s.device} /> {s.browser ?? s.device ?? "—"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {formatDuration(s.duration_ms)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <FileStack className="h-3.5 w-3.5" /> {s.page_count}
                  </span>
                </div>
                {(s.rage_click_count > 0 || s.error_count > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.rage_click_count > 0 && (
                      <Badge variant="outline" className="border-amber-500/40 text-amber-400">
                        <MousePointerClick className="mr-1 h-3 w-3" />
                        {s.rage_click_count} rage
                      </Badge>
                    )}
                    {s.error_count > 0 && (
                      <Badge variant="outline" className="border-destructive/40 text-destructive">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        {s.error_count} error{s.error_count > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* ===== Player ===== */}
          <div>
            {selected ? (
              <ReplayPlayer
                key={selected.id}
                session={selected}
                workspaceId={workspaceId}
                projectId={projectId}
              />
            ) : (
              <Card>
                <CardContent className="p-10">
                  <EmptyState icon={PlayCircle} title="Select a session to replay" />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface PlayerProps {
  session: ReplaySession;
  workspaceId: string | null;
  projectId: string | null;
}

function ReplayPlayer({ session, workspaceId, projectId }: PlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<rrwebPlayer | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["session_replay_events", session.id],
    enabled: !!workspaceId && !!projectId,
    queryFn: () =>
      callEdge<{ session: ReplaySession; events: RrwebEvent[] }>("get-session-replay", {
        workspace_id: workspaceId,
        project_id: projectId,
        session_id: session.id,
      }),
  });

  const events = useMemo(() => data?.events ?? [], [data]);
  // rrweb needs at least 2 events (a full snapshot + something to play).
  const playable = events.length >= 2;

  useEffect(() => {
    if (!mountRef.current || !playable) return;
    // Tear down any previous instance before mounting a new one.
    mountRef.current.innerHTML = "";
    playerRef.current = new rrwebPlayer({
      target: mountRef.current,
      props: {
        events: events as unknown as eventWithTime[],
        autoPlay: false,
        showController: true,
        // Fit the player to the container width; rrweb scales the canvas.
        width: mountRef.current.clientWidth,
      },
    });
    return () => {
      if (mountRef.current) mountRef.current.innerHTML = "";
      playerRef.current = null;
    };
  }, [events, playable]);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        {/* Session meta strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">
            {session.user_email ?? session.customer_external_id ?? "Anonymous visitor"}
          </span>
          <span className="inline-flex items-center gap-1">
            <DeviceIcon device={session.device} /> {session.os ?? "—"} · {session.browser ?? "—"}
          </span>
          {session.entry_url && (
            <span className="max-w-xs truncate font-mono">{session.entry_url}</span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {formatDuration(session.duration_ms)}
          </span>
        </div>

        {isLoading ? (
          <div className="flex h-[420px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Could not load this replay"
            description={error instanceof Error ? error.message : String(error)}
          />
        ) : !playable ? (
          <EmptyState
            icon={Film}
            title="Not enough data to replay"
            description="This session was too short to reconstruct — it carries fewer than two recorded events."
          />
        ) : (
          // rrweb-player mounts its own DOM (canvas + controller) here.
          <div ref={mountRef} className="overflow-hidden rounded-md border border-border" />
        )}
      </CardContent>
    </Card>
  );
}
