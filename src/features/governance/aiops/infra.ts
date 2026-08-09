// Real GPU / model-hosting infrastructure — provider connections + RunPod pods.
// Talks to the aiops-infra edge function (which holds the decrypted API keys)
// and reads the aiops_providers_public view (never the ciphertext).
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAiopsCtx } from "./db";
import type { PrivateServer } from "./data";

export type ProviderKind = "cloud_endpoint" | "runpod" | "ovh" | "aws";
export interface Provider {
  id: string; kind: ProviderKind; name: string;
  config: { base_url?: string; region?: string; service_name?: string; ovh_region?: string; uses_platform_key?: boolean };
  status: "pending" | "connected" | "error"; statusDetail: string | null;
  metadata: { models?: string[]; gpus?: RunpodGpu[]; flavors?: OvhFlavor[]; images?: OvhImage[]; ssh_keys?: OvhSshKey[] };
  hasSecret: boolean; lastTestedAt: string | null;
}
export interface RunpodGpu { id: string; name: string; memoryGb: number; hourlyUsd: number; secure: boolean; community: boolean }
export interface OvhFlavor {
  id: string; name: string; vcpus: number; ramGb: number; diskGb: number;
  memoryGb: number; regions: string[]; hourlyUsd: number;
}
export interface OvhImage { id: string; name: string; regions: string[] }
export interface OvhSshKey { id: string; name: string }

export function useProvidersDb() {
  const { workspaceId, projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["aiops_providers", projectId] });

  const q = useQuery({
    queryKey: ["aiops_providers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("aiops_providers_public")
        .select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r): Provider => ({
        id: r.id, kind: r.kind, name: r.name, config: r.config ?? {},
        status: r.status, statusDetail: r.status_detail, metadata: r.metadata ?? {},
        hasSecret: Boolean(r.has_secret), lastTestedAt: r.last_tested_at,
      }));
    },
  });

  const base = { workspace_id: workspaceId, project_id: projectId };
  return {
    providers: q.data ?? [], loading: q.isLoading, invalidate,
    connect: async (kind: ProviderKind, name: string, api_key: string, config: Record<string, unknown>, hf_token?: string) => {
      const res = await callEdge<{ provider: unknown }>("aiops-infra", { action: "provider.connect", ...base, kind, name, api_key, config, hf_token });
      invalidate();
      return res.provider;
    },
    test: async (providerId: string) => { const r = await callEdge("aiops-infra", { action: "provider.test", ...base, provider_id: providerId }); invalidate(); return r; },
    listGpus: async (providerId: string) => {
      const r = await callEdge<{ gpus?: RunpodGpu[]; flavors?: OvhFlavor[]; images?: OvhImage[]; ssh_keys?: OvhSshKey[] }>("aiops-infra", { action: "provider.list_gpus", ...base, provider_id: providerId });
      qc.invalidateQueries({ queryKey: ["aiops_providers", projectId] });
      return r;
    },
    remove: async (providerId: string) => { await supabase.from("aiops_providers").delete().eq("id", providerId); invalidate(); },
    cloudProviders: (q.data ?? []).filter((p) => p.kind === "cloud_endpoint" && p.status === "connected"),
    runpodProviders: (q.data ?? []).filter((p) => p.kind === "runpod" && p.status === "connected"),
    ovhProviders: (q.data ?? []).filter((p) => p.kind === "ovh" && p.status === "connected"),
    awsProviders: (q.data ?? []).filter((p) => p.kind === "aws" && p.status === "connected"),
  };
}

/** RunPod pod lifecycle + status polling, and real cloud inference. */
export function useInfraActions() {
  const { workspaceId, projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const base = { workspace_id: workspaceId, project_id: projectId };
  const refreshServers = useCallback(() => qc.invalidateQueries({ queryKey: ["aiops", "aiops_servers", projectId] }), [qc, projectId]);
  const refreshJobs = useCallback(() => qc.invalidateQueries({ queryKey: ["aiops", "aiops_ft_jobs", projectId] }), [qc, projectId]);
  return {
    // Real fine-tuning on a RunPod pod (axolotl QLoRA); pod streams progress back.
    launchJob: async (jobId: string, providerId: string) => { const r = await callEdge("aiops-infra", { action: "job.launch", ...base, job_id: jobId, provider_id: providerId }); refreshJobs(); return r; },
    syncJob: async (jobId: string) => { const r = await callEdge("aiops-infra", { action: "job.sync", ...base, job_id: jobId }); refreshJobs(); return r; },
    cancelJob: async (jobId: string) => { await callEdge("aiops-infra", { action: "job.cancel", ...base, job_id: jobId }); refreshJobs(); },
    rent: async (opts: {
      providerId: string; kind: ProviderKind;
      gpuTypeId?: string; gpuLabel?: string;
      flavorId?: string; flavorLabel?: string; flavorHourlyUsd?: number;
      imageId?: string; region?: string; sshKeyId?: string;
      modelArg?: string; name?: string; gpuCount?: number; cloudType?: "secure" | "community";
      quantization?: string; maxModelLen?: number; vllmArgs?: string;
    }) => {
      const r = await callEdge("aiops-infra", {
        action: "server.rent", ...base, provider_id: opts.providerId, kind: opts.kind,
        gpu_type_id: opts.gpuTypeId, gpu_label: opts.gpuLabel,
        flavor_id: opts.flavorId, flavor_label: opts.flavorLabel, flavor_hourly_usd: opts.flavorHourlyUsd,
        image_id: opts.imageId, region: opts.region, ssh_key_id: opts.sshKeyId,
        model_arg: opts.modelArg, name: opts.name,
        gpu_count: opts.gpuCount ?? 1, cloud_type: opts.cloudType ?? "secure",
        quantization: opts.quantization ?? null, max_model_len: opts.maxModelLen ?? null,
        vllm_args: opts.vllmArgs ?? "",
      });
      refreshServers();
      return r;
    },
    sync: async (serverId: string) => { const r = await callEdge("aiops-infra", { action: "server.sync", ...base, server_id: serverId }); refreshServers(); return r; },
    stop: async (serverId: string) => { await callEdge("aiops-infra", { action: "server.stop", ...base, server_id: serverId }); refreshServers(); },
    start: async (serverId: string) => { await callEdge("aiops-infra", { action: "server.start", ...base, server_id: serverId }); refreshServers(); },
    terminate: async (serverId: string) => { await callEdge("aiops-infra", { action: "server.terminate", ...base, server_id: serverId }); refreshServers(); },
    // Persist real billing: finalise elapsed running time into the cost ledger.
    reconcileCosts: async (serverId?: string) => {
      const r = await callEdge("aiops-infra", { action: "cost.reconcile", ...base, server_id: serverId });
      qc.invalidateQueries({ queryKey: ["aiops_cost_ledger", projectId] });
      refreshServers();
      return r;
    },
    // providerId → connected cloud endpoint; serverId → rented vLLM pod (the
    // pod serves one model, so `model` is optional and defaults server-side).
    chat: (opts: { providerId?: string; serverId?: string; model?: string; messages: { role: string; content: string }[]; temperature?: number; topP?: number; maxTokens?: number }) =>
      callEdge<{ content: string; ms: number; tokensIn: number; tokensOut: number }>("aiops-infra", {
        action: "inference.chat", ...base, provider_id: opts.providerId, server_id: opts.serverId, model: opts.model,
        messages: opts.messages, temperature: opts.temperature, top_p: opts.topP, max_tokens: opts.maxTokens,
      }),
  };
}

/**
 * Persist real billing segments every minute while paid servers are running.
 * The ledger rows then stream back through realtime; the live estimate on the
 * costs page covers the sub-minute gap.
 */
export function useCostReconciler(servers: PrivateServer[]) {
  const { workspaceId, projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const busy = useRef(false);
  const hasPaid = servers.some((s) => s.hourlyUsd > 0 && (s.status === "online" || s.status === "degraded") && !!s.runningSince);

  useEffect(() => {
    if (!hasPaid || !workspaceId || !projectId) return;
    const run = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        await callEdge("aiops-infra", { action: "cost.reconcile", workspace_id: workspaceId, project_id: projectId });
        qc.invalidateQueries({ queryKey: ["aiops_cost_ledger", projectId] });
        qc.invalidateQueries({ queryKey: ["aiops", "aiops_servers", projectId] });
      } catch { /* edge offline — the live estimate still covers the gap */ } finally { busy.current = false; }
    };
    void run();
    const t = setInterval(run, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPaid, workspaceId, projectId, qc]);
}
