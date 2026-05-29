// Helper: fetch and decrypt a connector credential by (workspace_id, project_id, provider).
// Returns the parsed JSON payload of fields (e.g. { secret_key: "rk_live_..." } for Stripe).

import { createServiceClient } from "./supabase-admin.ts";
import { decryptSecret } from "./crypto.ts";

export interface ConnectorRow {
  id: string;
  workspace_id: string;
  project_id: string;
  provider: string;
  status: string;
  permissions: string;
  metadata: Record<string, unknown>;
}

export async function getConnectorCredential(
  workspaceId: string,
  projectId: string,
  provider: string,
): Promise<{ connector: ConnectorRow; payload: Record<string, string> }> {
  const admin = createServiceClient();
  const { data: connector } = await admin
    .from("connectors")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .eq("provider", provider)
    .maybeSingle();
  if (!connector) throw new Error(`Connector ${provider} not found`);

  const { data: cred } = await admin
    .from("encrypted_credentials")
    .select("encrypted_payload, iv")
    .eq("connector_id", connector.id)
    .maybeSingle();
  if (!cred) throw new Error(`Credential for ${provider} not found`);

  const plaintext = await decryptSecret(cred.encrypted_payload, cred.iv);
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    // Legacy entries (connect-github wrote raw token before connect-provider).
    payload = { token: plaintext };
  }
  return { connector: connector as ConnectorRow, payload };
}
