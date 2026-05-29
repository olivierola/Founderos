import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

const BILLING = ["stripe", "lemonsqueezy", "paddle"];
const USERS = ["supabase", "firebase", "clerk", "auth0"];
const MESSAGING = ["slack", "discord", "telegram"];

export interface ConnectorRow {
  provider: string;
  status: string;
  permissions: string;
  metadata: Record<string, unknown>;
}

/** All connectors configured for the current project. */
export function useProjectConnectors(projectId: string | null) {
  return useQuery({
    queryKey: ["project-connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status, permissions, metadata")
        .eq("project_id", projectId!);
      return (data ?? []) as ConnectorRow[];
    },
  });
}

export interface Capabilities {
  billing: ConnectorRow | null; // first connected billing provider
  users: ConnectorRow | null; // first connected user/auth source
  messaging: string[]; // connected messaging providers
  loading: boolean;
  connectors: ConnectorRow[];
}

const PROVIDER_LABELS: Record<string, string> = {
  stripe: "Stripe",
  lemonsqueezy: "Lemon Squeezy",
  paddle: "Paddle",
  supabase: "Supabase",
  firebase: "Firebase",
  clerk: "Clerk",
  auth0: "Auth0",
};

export function providerLabel(slug: string) {
  return PROVIDER_LABELS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function useCapabilities(projectId: string | null): Capabilities {
  const { data, isLoading } = useProjectConnectors(projectId);
  const connectors = data ?? [];
  const billing = connectors.find((c) => BILLING.includes(c.provider)) ?? null;
  const users = connectors.find((c) => USERS.includes(c.provider)) ?? null;
  const messaging = connectors.filter((c) => MESSAGING.includes(c.provider)).map((c) => c.provider);
  return { billing, users, messaging, loading: isLoading, connectors };
}
