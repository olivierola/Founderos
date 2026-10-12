// Outils internes (connecteurs personnalisés, migration 0267) : accès front.
//
// Le modèle (types, normalisation, modèles Argo CD / Vault / Grafana…) est le
// MÊME fichier que celui des fonctions edge : une opération se valide de la
// même façon dans l'éditeur, dans l'assistant et à l'exécution.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
export * from "../../../supabase/functions/_shared/custom-connector-model";
import type {
  AuthScheme, ConnectorOperation, ConnectorPolicy, Transport,
} from "../../../supabase/functions/_shared/custom-connector-model";

export interface CustomConnector {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  slug: string;
  template_key: string | null;
  description: string | null;
  base_url: string;
  transport: Transport;
  relay_id: string | null;
  auth_scheme: AuthScheme;
  auth_config: Record<string, unknown>;
  operations: ConnectorOperation[];
  policy: Partial<ConnectorPolicy>;
  status: "draft" | "active" | "disabled";
  setup_notes: string | null;
  created_via: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_detail: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ConnectorCredential {
  id: string;
  connector_id: string;
  label: string;
  location: "cloud" | "relay";
  relay_refs: Record<string, string>;
  hints: Record<string, string>;
  identity: string | null;
  allowed_agent_ids: string[];
  expires_at: string | null;
  token_expires_at: string | null;
  status: "active" | "revoked";
  created_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
}

export interface ConnectorRelay {
  id: string;
  name: string;
  token_hint: string | null;
  status: "active" | "revoked";
  last_seen_at: string | null;
  last_ip: string | null;
  version: string | null;
  hostname: string | null;
  reported_hosts: string[];
  reported_binaries: string[];
  created_at: string;
  revoked_at: string | null;
}

export interface ConnectorCall {
  seq: number;
  id: string;
  connector_id: string | null;
  connector_name: string | null;
  connector_version: number | null;
  credential_label: string | null;
  identity: string | null;
  operation: string | null;
  method: string | null;
  target: string | null;
  transport: string | null;
  source: string;
  agent_id: string | null;
  agent_name: string | null;
  run_id: string | null;
  actor_user_id: string | null;
  approval_id: string | null;
  decision: "allowed" | "approved" | "blocked" | "error";
  risk: string | null;
  status_code: number | null;
  duration_ms: number | null;
  response_bytes: number | null;
  redactions: number;
  error: string | null;
  created_at: string;
  hash: string;
}

const CRED_COLS =
  "id, connector_id, label, location, relay_refs, hints, identity, allowed_agent_ids, expires_at, token_expires_at, status, created_at, rotated_at, last_used_at";
const RELAY_COLS =
  "id, name, token_hint, status, last_seen_at, last_ip, version, hostname, reported_hosts, reported_binaries, created_at, revoked_at";

export const qk = {
  connectors: (projectId: string | null) => ["custom_connectors", projectId] as const,
  credentials: (projectId: string | null) => ["custom_connector_credentials", projectId] as const,
  relays: (projectId: string | null) => ["connector_relays", projectId] as const,
  calls: (workspaceId: string | null) => ["custom_connector_calls", workspaceId] as const,
};

export function useConnectors(projectId: string | null) {
  return useQuery({
    queryKey: qk.connectors(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("custom_connectors").select("*")
        .eq("project_id", projectId!).order("name");
      if (error) throw error;
      return (data ?? []) as CustomConnector[];
    },
  });
}

export function useCredentials(projectId: string | null, connectorIds: string[]) {
  return useQuery({
    queryKey: [...qk.credentials(projectId), connectorIds.join(",")],
    enabled: !!projectId && connectorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("custom_connector_credentials").select(CRED_COLS)
        .in("connector_id", connectorIds).order("created_at");
      if (error) throw error;
      return (data ?? []) as ConnectorCredential[];
    },
  });
}

export function useRelays(projectId: string | null) {
  return useQuery({
    queryKey: qk.relays(projectId),
    enabled: !!projectId,
    // Le statut « en ligne » se lit à la fraîcheur du dernier contact.
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("connector_relays").select(RELAY_COLS)
        .eq("project_id", projectId!).order("created_at");
      if (error) throw error;
      return (data ?? []) as ConnectorRelay[];
    },
  });
}

export function relayOnline(r: Pick<ConnectorRelay, "status" | "last_seen_at">): boolean {
  return r.status === "active" && !!r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 90_000;
}

/** Les appels de connector-action réservés aux owners et admins. */
export function connectorAction<T = { ok: boolean; error?: string }>(body: Record<string, unknown>) {
  return callEdge<T>("connector-action", body);
}

export interface TestOutcome {
  ok: boolean;
  decision: string;
  status?: number;
  text: string;
  operation?: string;
  duration_ms?: number;
  redactions?: number;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "jamais";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}
