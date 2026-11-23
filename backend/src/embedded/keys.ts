// Les clés d'API des agents embarqués : une clé par conteneur (ou par usage),
// montrée une seule fois, gardée en base par son empreinte. Elle identifie
// l'agent : la passerelle (/embedded/v1) n'agit que pour lui, dans ses pools.

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const KEY_PREFIX = "fos_emb_";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Une clé neuve : la valeur (à montrer une fois), son préfixe affichable, son empreinte. */
export function newKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(30).toString("base64url")}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), hash: hashKey(key) };
}

export interface KeyOwner {
  keyId: string;
  agentId: string;
  workspaceId: string;
  label: string;
}

/** L'agent d'une clé valide (non révoquée), ou null. Note son dernier usage. */
export async function resolveKey(admin: SupabaseClient, key: string): Promise<KeyOwner | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length < KEY_PREFIX.length + 20) return null;
  const { data } = await admin.from("embedded_agent_api_keys")
    .select("id, agent_id, workspace_id, label, revoked_at").eq("key_hash", hashKey(key)).maybeSingle();
  const row = data as { id: string; agent_id: string; workspace_id: string; label: string; revoked_at: string | null } | null;
  if (!row || row.revoked_at) return null;
  void admin.from("embedded_agent_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id).then(() => {}, () => {});
  return { keyId: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, label: row.label };
}
