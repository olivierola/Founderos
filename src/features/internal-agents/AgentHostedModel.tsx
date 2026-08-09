// Choose which model an agent runs on: the Anduran default, one of the
// company's registered cloud/custom models (aiops_providers cloud_endpoint —
// added in AI Ops → Modèles), or a self-hosted RunPod GPU server. The choice is
// written onto the agent (hosted_provider_id / hosted_endpoint_url / hosted_model
// / hosted_server_id) and resolved at run time by internal-agent-run.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Cpu, Loader2, Check, ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

interface AiopsServer {
  id: string; name: string; gpu: string | null; endpoint_url: string | null;
  served_model: string | null; status: string;
}
interface CloudProvider {
  id: string; name: string; config: { base_url?: string } | null; status: string;
  metadata: { models?: string[] } | null;
}

export function AgentHostedModelCard({ agent, disabled }: { agent: InternalAgent; disabled?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Registered cloud/custom models (with their discovered model ids).
  const { data: providers } = useQuery({
    queryKey: ["aiops_agent_cloud_models", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_providers_public")
        .select("id, name, config, status, metadata")
        .eq("project_id", agent.project_id).eq("kind", "cloud_endpoint");
      return (data ?? []) as CloudProvider[];
    },
  });
  // Self-hosted RunPod GPU servers.
  const { data: servers } = useQuery({
    queryKey: ["aiops_hosted_servers", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_servers")
        .select("id, name, gpu, endpoint_url, served_model, status")
        .eq("project_id", agent.project_id).eq("source", "runpod")
        .not("endpoint_url", "is", null);
      return (data ?? []) as AiopsServer[];
    },
  });

  // Current selection encoded as a flat select value.
  const current = agent.hosted_provider_id
    ? `p:${agent.hosted_provider_id}:${agent.hosted_model ?? ""}`
    : agent.hosted_server_id
      ? `s:${agent.hosted_server_id}`
      : "";

  const providerById = useMemo(() => new Map((providers ?? []).map((p) => [p.id, p])), [providers]);

  async function choose(value: string) {
    setBusy(true); setErr(null);
    try {
      let patch: Record<string, unknown>;
      if (value.startsWith("p:")) {
        const [, providerId, model] = value.split(":");
        const p = providerById.get(providerId);
        patch = {
          hosted_provider_id: providerId,
          hosted_model: model || null,
          hosted_endpoint_url: p?.config?.base_url ?? null,
          hosted_server_id: null,
        };
      } else if (value.startsWith("s:")) {
        const serverId = value.slice(2);
        const s = (servers ?? []).find((x) => x.id === serverId);
        patch = {
          hosted_server_id: serverId,
          hosted_endpoint_url: s?.endpoint_url ?? null,
          hosted_model: s?.served_model ?? null,
          hosted_provider_id: null,
        };
      } else {
        patch = { hosted_provider_id: null, hosted_server_id: null, hosted_endpoint_url: null, hosted_model: null };
      }
      const { error } = await supabase.from("internal_agents").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", agent.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec"); }
    finally { setBusy(false); }
  }

  const hasCloud = (providers ?? []).some((p) => (p.metadata?.models ?? []).length > 0);
  const hasServers = (servers ?? []).length > 0;

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Modèle de l'agent</span>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Choisissez le modèle sur lequel cet agent tourne : le modèle par défaut Anduran, l'un de vos modèles enregistrés
        (API cloud ou endpoint), ou un serveur GPU auto-hébergé. Ajoutez vos modèles dans{" "}
        <Link to="../../../aiops/ops-models" className="inline-flex items-center gap-0.5 text-primary hover:underline">
          AI Ops → Modèles <ExternalLink className="h-3 w-3" />
        </Link>.
      </p>

      <select
        value={current}
        disabled={disabled || busy}
        onChange={(e) => void choose(e.target.value)}
        className="mt-3 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-50"
      >
        <option value="">Modèle par défaut (Anduran)</option>
        {hasCloud && (
          <optgroup label="Vos modèles">
            {(providers ?? []).flatMap((p) =>
              (p.metadata?.models ?? []).slice(0, 30).map((m) => (
                <option key={`p:${p.id}:${m}`} value={`p:${p.id}:${m}`}>{p.name} · {m}</option>
              )),
            )}
          </optgroup>
        )}
        {hasServers && (
          <optgroup label="Serveurs auto-hébergés (RunPod)">
            {(servers ?? []).map((s) => (
              <option key={`s:${s.id}`} value={`s:${s.id}`}>
                {s.name}{s.served_model ? ` · ${s.served_model}` : ""}{s.status !== "online" ? ` (${s.status})` : ""}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {current && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" /> Inférence routée vers {agent.hosted_model || "le modèle choisi"}
        </div>
      )}
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </div>
  );
}
