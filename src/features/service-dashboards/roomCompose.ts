// What "sending a message into a room" means, in one place: the / commands the
// composer offers, the attachment upload, and the post itself. RoomView owned
// all of it; the Home tab now starts a conversation the same way (it creates the
// room first, then sends through here), so the two can't drift apart.

import {
  FileTextIcon as FileText,
  PresentationChartIcon as Presentation,
  TableIcon,
  ImageIcon,
  TextTIcon as Type,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { postRoomMessage } from "./model";

export const SLASH_COMMANDS: { key: string; label: string; icon: typeof FileText; prefill: string; color: string }[] = [
  { key: "document", label: "Document", icon: FileText, prefill: "Crée un document : ", color: "#3b82f6" },
  { key: "presentation", label: "Presentation", icon: Presentation, prefill: "Crée une présentation : ", color: "#f59e0b" },
  { key: "spreadsheet", label: "Spreadsheet", icon: TableIcon, prefill: "Crée une feuille de calcul : ", color: "#10b981" },
  { key: "image", label: "Image", icon: ImageIcon, prefill: "Génère une image : ", color: "#ec4899" },
  { key: "text", label: "Texte", icon: Type, prefill: "Note : ", color: "#8b5cf6" },
];

/** Expand a leading /Label token into the sentence it stands for. */
export function expandSlash(raw: string): string {
  const trimmed = raw.trim();
  const sc = SLASH_COMMANDS.find((c) => trimmed === `/${c.label}` || trimmed.startsWith(`/${c.label} `));
  return sc ? (sc.prefill + trimmed.slice(`/${sc.label}`.length).trimStart()).trim() : trimmed;
}

/** Upload one attachment to the room's media bucket, returning its media id. */
export async function uploadRoomMedia(
  file: File,
  ctx: { roomId: string; workspaceId: string; projectId: string; userId: string | null },
): Promise<string | null> {
  const path = `${ctx.roomId}/${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await supabase.storage.from("office-media").upload(path, file);
  if (upErr) return null;
  const { data: pub } = supabase.storage.from("office-media").getPublicUrl(path);
  const { data: media } = await supabase.from("office_media").insert({
    workspace_id: ctx.workspaceId, project_id: ctx.projectId, service_room_id: ctx.roomId,
    kind: file.type.startsWith("image/") ? "image" : "file", prompt: file.name, provider: "upload",
    status: "ready", url: pub.publicUrl, storage_path: path, created_by: ctx.userId,
  }).select("id").single();
  return (media as { id: string } | null)?.id ?? null;
}

/**
 * Post a composer submission into a room: / expansion, attachments, then the
 * message itself. With no @mention, service-room-post routes the turn to the
 * dashboard's default responder (Settings → Rooms), then the orchestrator.
 */
export async function sendToRoom(
  ctx: { roomId: string; workspaceId: string; projectId: string; userId: string | null },
  raw: string,
  mentionedIds: string[],
  files: File[],
) {
  const content = expandSlash(raw);
  let firstMediaId: string | null = null;
  for (const f of files) {
    const id = await uploadRoomMedia(f, ctx);
    if (!id) continue;
    // Only the first attachment rides with the message; the rest follow as
    // their own lines so nothing is silently dropped.
    if (!firstMediaId) firstMediaId = id;
    else await postRoomMessage(ctx.roomId, "📎 " + f.name, [], id);
  }
  await postRoomMessage(ctx.roomId, content || (firstMediaId ? "📎 Image" : ""), mentionedIds, firstMediaId ?? undefined);
}
