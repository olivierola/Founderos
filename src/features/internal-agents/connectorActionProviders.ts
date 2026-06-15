// Providers an internal agent can use as a `connector_action` tool. These slugs
// MUST match the keys of CONNECTOR_ACTIONS in
// supabase/functions/_shared/connector-actions.ts — the agent picks an action +
// params and the edge function decrypts the project credential and calls the
// official API. Metadata (name/icon/description) is reused from PROVIDERS.
import { PROVIDERS, type ProviderDef } from "@/lib/providers";

// Grouped for a readable picker. Keep slugs in sync with the backend catalog.
export const CONNECTOR_ACTION_GROUPS: { label: string; slugs: string[] }[] = [
  { label: "CRM & Support", slugs: ["hubspot", "pipedrive", "salesforce", "attio", "intercom"] },
  { label: "HR & People", slugs: ["bamboohr", "greenhouse", "deel", "factorial"] },
  { label: "Data lakes & warehouses", slugs: ["bigquery", "athena", "gcs", "azure-blob", "azure-synapse"] },
];

export const CONNECTOR_ACTION_SLUGS = CONNECTOR_ACTION_GROUPS.flatMap((g) => g.slugs);

export interface ConnectorActionProvider extends ProviderDef {
  /** True once the project has this connector configured (creds present). */
}

export function connectorActionProvider(slug: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.slug === slug);
}
