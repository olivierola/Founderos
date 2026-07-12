// Lets an agent run on a self-hosted RunPod model instead of the default
// provider. Lists the project's online RunPod GPU servers (aiops_servers) and
// writes the chosen endpoint onto the agent (hosted_endpoint_url / hosted_model /
// hosted_server_id) — read at run time by internal-agent-run.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Server, Loader2, Check, ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

interface AiopsServer {
  id: string; name: string; gpu: string | null; endpoint_url: string | null;
  served_model: string | null; status: string; source: string;
}

export function AgentHostedModelCard({ agent, disabled }: { agent: InternalAgent; disabled?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: servers, isLoading } = useQuery({
    queryKey: ["aiops_hosted_servers", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_servers")
        .select("id, name, gpu, endpoint_url, served_model, status, source")
        .eq("project_id", agent.project_id).eq("source", "runpod")
        .not("endpoint_url", "is", null);
      return (data ?? []) as AiopsServer[];
    },
  });

  const current = agent.hosted_server_id ?? "";

  async function choose(serverId: string) {
    setBusy(true); setErr(null);
    try {
      const patch = serverId
        ? (() => {
            const s = (servers ?? []).find((x) => x.id === serverId);
            return { hosted_server_id: serverId, hosted_endpoint_url: s?.endpoint_url ?? null, hosted_model: s?.served_model ?? null };
          })()
        : { hosted_server_id: null, hosted_endpoint_url: null, hosted_model: null };
      const { error } = await supabase.from("internal_agents").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", agent.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-violet-500" />
        <span className="text-sm font-medium">Modèle hébergé (RunPod)</span>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Faites tourner cet agent sur l'un de vos modèles auto-hébergés sur GPU (endpoint vLLM OpenAI-compatible),
        au lieu du fournisseur par défaut. Les serveurs se créent dans AI Ops → Fournisseurs → « Louer un GPU ».
      </p>

      {isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Chargement des serveurs…</p>
      ) : (servers ?? []).length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Aucun serveur GPU RunPod déployé pour ce projet.{" "}
          <Link to="../../../governance/aiops" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            Ouvrir AI Ops <ExternalLink className="h-3 w-3" />
          </Link>
        </p>
      ) : (
        <select
          value={current}
          disabled={disabled || busy}
          onChange={(e) => void choose(e.target.value)}
          className="mt-3 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-50"
        >
          <option value="">Défaut (DeepSeek / Groq)</option>
          {(servers ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.served_model ? ` · ${s.served_model}` : ""}{s.gpu ? ` · ${s.gpu}` : ""}
              {s.status !== "online" ? ` (${s.status})` : ""}
            </option>
          ))}
        </select>
      )}

      {current && agent.hosted_endpoint_url && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" /> Inférence routée vers {agent.hosted_model || "le modèle hébergé"}
        </div>
      )}
      {err && <p className={cn("mt-2 text-xs text-red-500")}>{err}</p>}
    </div>
  );
}
