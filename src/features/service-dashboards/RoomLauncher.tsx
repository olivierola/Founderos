import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ChatInput } from "@/components/ui/chat-input";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { addRoomAgent, createRoom } from "./model";
import { SLASH_COMMANDS, expandSlash, sendToRoom } from "./roomCompose";

/**
 * Le composeur qui fait naître une room.
 *
 * Il vivait dans `HomeTab`, où il était le seul chemin pour démarrer une
 * conversation. Le module de suivi ayant pris la place d'accueil, sa page Home
 * en avait besoin aussi — et la recopier aurait produit deux moteurs à tenir
 * d'accord. C'est exactement le défaut qui vient de se payer sur la liste des
 * sections de projet : deux endroits qui disent la même chose finissent par
 * diverger, et le second oublie ce que le premier a appris.
 *
 * Le geste : on écrit, et la conversation existe. Une room est créée, titrée
 * d'après ce qu'on a écrit, les agents mentionnés y sont ajoutés, le message
 * part — et SEULEMENT ENSUITE on ouvre la room. L'ordre compte : ouvrir
 * d'abord ferait rapporter un échec d'envoi dans une room vide, où l'on ne
 * saurait ni ce qui a échoué ni comment le reprendre.
 *
 * Le tour de l'agent, lui, tourne côté serveur en tâche de fond. Ce que l'on
 * attend ici est un aller-retour court, pas la réponse.
 */

export interface RoomLauncherAgent {
  id: string;
  name: string;
  accent_color?: string | null;
}

/** Ce qui n'a pas pu partir, gardé pour être réessayé. */
interface PendingSend {
  roomId: string | null;
  raw: string;
  files: File[];
  mentionedIds: string[];
}

export function useRoomLauncher({
  dashboardId, dashboardName, workspaceId, projectId,
}: {
  dashboardId: string; dashboardName: string;
  workspaceId: string; projectId: string;
}) {
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);

  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  async function start(
    raw: string, files: File[], mentionedIds: string[], reuseRoomId?: string | null,
  ) {
    if ((!raw.trim() && files.length === 0) || starting || !user) return;
    setStarting(true);
    setError(null);
    let roomId = reuseRoomId ?? null;
    try {
      if (!roomId) {
        const title = expandSlash(raw).split("\n")[0]!.slice(0, 60)
          || (files[0]?.name ?? "Nouvelle room");
        roomId = await createRoom(
          { id: dashboardId, name: dashboardName }, workspaceId, projectId, user.id, title,
        );
        qc.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
      }
      if (!roomId) throw new Error("La room n'a pas pu être créée.");

      // Un agent mentionné doit être DANS la room pour pouvoir y répondre.
      for (const id of mentionedIds) await addRoomAgent(roomId, id);

      await sendToRoom({ roomId, workspaceId, projectId, userId: user.id }, raw, mentionedIds, files);
      qc.invalidateQueries({ queryKey: ["service_room_messages", roomId] });
      setPending(null);
      navigate(`${base}/room/${roomId}`);
    } catch (e) {
      // Le composeur se vide à l'envoi : ce qui était écrit est retenu ici, et
      // la reprise réutilise la room déjà créée plutôt que d'en laisser une
      // vide derrière elle.
      setPending({ roomId, raw, files, mentionedIds });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return {
    start,
    starting,
    error,
    pending,
    retry: () => {
      if (pending) void start(pending.raw, pending.files, pending.mentionedIds, pending.roomId);
    },
  };
}

export function RoomLauncher({
  dashboardId, dashboardName, workspaceId, projectId, agents,
  placeholder = "Demandez quelque chose à votre équipe…",
  hint = "Une nouvelle room est créée pour cette conversation.",
  className,
}: {
  dashboardId: string; dashboardName: string;
  workspaceId: string; projectId: string;
  agents: RoomLauncherAgent[];
  placeholder?: string;
  hint?: string;
  className?: string;
}) {
  const launcher = useRoomLauncher({ dashboardId, dashboardName, workspaceId, projectId });

  return (
    <div className={className}>
      <ChatInput
        busy={launcher.starting}
        placeholder={placeholder}
        mentionAgents={agents.map((a) => ({
          id: a.id, name: a.name, accentColor: a.accent_color ?? null,
        }))}
        slashCommands={SLASH_COMMANDS.map((c) => ({
          key: c.key, label: c.label, color: c.color, icon: c.icon,
        }))}
        onSendMessage={(msg, files, mentionedIds) => { void launcher.start(msg, files, mentionedIds); }}
      />

      <p className="mt-2 px-1 text-xs text-muted-foreground">
        {launcher.starting ? "Création de la room…" : hint}
      </p>

      {launcher.error && (
        <div className={cn("mt-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs")}>
          <div className="text-destructive">Envoi impossible : {launcher.error}</div>
          {launcher.pending && (
            <div className="mt-1.5 flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={launcher.pending.raw}
              >
                « {launcher.pending.raw} »
              </span>
              <button
                type="button"
                onClick={launcher.retry}
                className="shrink-0 font-medium text-foreground underline"
              >
                Réessayer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
