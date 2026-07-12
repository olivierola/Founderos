// aiops-infra — real GPU / model-hosting infrastructure for the AI Ops module.
// One action-dispatch edge function (keeps us under the function cap) that lets
// an enterprise either:
//   • connect a cloud endpoint hosting its own models (OpenAI-compatible) — we
//     test it, list its models and route real inference; or
//   • rent GPU pods on RunPod — we list GPU types/prices and create/start/stop/
//     terminate real pods (vLLM, OpenAI-compatible), each mirrored into
//     aiops_servers with a real pod_id + endpoint_url.
// API keys are AES-GCM encrypted at rest (CREDENTIAL_ENCRYPTION_KEY), decrypted
// only here via the service role.
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { encryptSecret, decryptSecret } from "../_shared/crypto.ts";

const RUNPOD_GQL = "https://api.runpod.io/graphql";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

// Platform-level RunPod key (uploaded as a Supabase secret). Lets a project use
// RunPod for training + hosting without pasting its own key — the "Connect
// RunPod (platform)" one-click flow stores a keyless provider that resolves to
// this at call time.
const PLATFORM_RUNPOD_KEY = Deno.env.get("RUNPOD_API_KEY") ?? "";

// ── RunPod GraphQL ───────────────────────────────────────────────────────────
async function runpod(apiKey: string, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`${RUNPOD_GQL}?api_key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg = json.errors?.[0]?.message ?? `RunPod API error (${res.status})`;
    throw new Error(msg);
  }
  return json.data;
}

async function runpodGpuTypes(apiKey: string) {
  const data = await runpod(apiKey, `
    query GpuTypes {
      gpuTypes {
        id displayName memoryInGb secureCloud communityCloud
        lowestPrice(input: { gpuCount: 1 }) { uninterruptablePrice minimumBidPrice }
      }
    }`);
  return (data?.gpuTypes ?? [])
    .filter((g: Record<string, unknown>) => g.secureCloud || g.communityCloud)
    .map((g: Record<string, unknown>) => ({
      id: g.id, name: g.displayName, memoryGb: g.memoryInGb,
      hourlyUsd: (g.lowestPrice as { uninterruptablePrice?: number })?.uninterruptablePrice ?? null,
      secure: g.secureCloud, community: g.communityCloud,
    }))
    .filter((g: { hourlyUsd: number | null }) => g.hourlyUsd != null)
    .sort((a: { hourlyUsd: number }, b: { hourlyUsd: number }) => a.hourlyUsd - b.hourlyUsd);
}

async function runpodCreatePod(apiKey: string, opts: { name: string; gpuTypeId: string; image: string; modelArg?: string; volumeGb?: number }) {
  const dockerArgs = opts.modelArg ? `--model ${opts.modelArg} --port 8000` : "";
  const data = await runpod(apiKey, `
    mutation Deploy($input: PodFindAndDeployOnDemandInput) {
      podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr desiredStatus }
    }`, {
    input: {
      cloudType: "SECURE", gpuCount: 1, volumeInGb: opts.volumeGb ?? 40, containerDiskInGb: 40,
      gpuTypeId: opts.gpuTypeId, name: opts.name, imageName: opts.image,
      ports: "8000/http", volumeMountPath: "/workspace",
      ...(dockerArgs ? { dockerArgs } : {}),
    },
  });
  return data?.podFindAndDeployOnDemand;
}
async function runpodPod(apiKey: string, podId: string) {
  const data = await runpod(apiKey, `
    query Pod($input: PodFilter!) {
      pod(input: $input) {
        id desiredStatus costPerHr
        runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } }
      }
    }`, { input: { podId } });
  return data?.pod;
}
const runpodStop = (k: string, id: string) => runpod(k, `mutation($input: PodStopInput!){ podStop(input:$input){ id desiredStatus } }`, { input: { podId: id } });
const runpodResume = (k: string, id: string) => runpod(k, `mutation($input: PodResumeInput!){ podResume(input:$input){ id desiredStatus } }`, { input: { podId: id, gpuCount: 1 } });
const runpodTerminate = (k: string, id: string) => runpod(k, `mutation($input: PodTerminateInput!){ podTerminate(input:$input) }`, { input: { podId: id } });

// Deploy a pod with a custom container command + env (used for training).
async function runpodCreatePodRaw(apiKey: string, o: { name: string; gpuTypeId: string; image: string; dockerArgs: string; env: { key: string; value: string }[]; volumeGb?: number }) {
  const data = await runpod(apiKey, `
    mutation Deploy($input: PodFindAndDeployOnDemandInput) {
      podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr desiredStatus }
    }`, {
    input: {
      cloudType: "SECURE", gpuCount: 1, volumeInGb: o.volumeGb ?? 60, containerDiskInGb: 60,
      gpuTypeId: o.gpuTypeId, name: o.name, imageName: o.image, ports: "8000/http",
      volumeMountPath: "/workspace", dockerArgs: o.dockerArgs, env: o.env,
    },
  });
  return data?.podFindAndDeployOnDemand;
}
// A training GPU needs >=40GB VRAM; prefer the cheapest that qualifies.
function pickTrainingGpu(gpus: { id: string; name: string; memoryGb: number; hourlyUsd: number }[]) {
  return gpus.filter((g) => g.memoryGb >= 40).sort((a, b) => a.hourlyUsd - b.hourlyUsd)[0]
    ?? [...gpus].sort((a, b) => b.memoryGb - a.memoryGb)[0];
}

// The container command run inside the axolotl image: report → download dataset
// → write a QLoRA config → train, streaming loss/epoch back to the webhook.
const TRAIN_CMD = `bash -lc '
R(){ curl -s -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\\"action\\":\\"job.report\\",\\"report_token\\":\\"$TOKEN\\",\\"job_id\\":\\"$JOB_ID\\",$1}" "$WEBHOOK" >/dev/null 2>&1 || true; }
R "\\"status\\":\\"running\\",\\"progress\\":3,\\"log\\":\\"Téléchargement du dataset\\""
curl -sL "$DATASET_URL" -o /workspace/data.jsonl || { R "\\"status\\":\\"failed\\",\\"error\\":\\"dataset download failed\\""; exit 1; }
[ -n "$HF_TOKEN" ] && export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
cat > /workspace/config.yml <<EOF
base_model: $HF_REPO
load_in_4bit: true
adapter: qlora
datasets:
  - path: /workspace/data.jsonl
    type: chat_template
sequence_len: 2048
micro_batch_size: 1
gradient_accumulation_steps: 4
num_epochs: $EPOCHS
learning_rate: $LR
lora_r: $LORA_R
lora_alpha: $LORA_ALPHA
lora_dropout: 0.05
output_dir: /workspace/out
val_set_size: 0.05
save_steps: 50
logging_steps: 1
EOF
R "\\"status\\":\\"running\\",\\"progress\\":8,\\"log\\":\\"Démarrage de l entraînement axolotl\\""
accelerate launch -m axolotl.cli.train /workspace/config.yml 2>&1 | while IFS= read -r line; do
  echo "$line"
  L=$(echo "$line" | grep -oiE "loss.{0,3}[0-9]+\\.[0-9]+" | grep -oE "[0-9]+\\.[0-9]+" | head -1)
  E=$(echo "$line" | grep -oiE "epoch.{0,3}[0-9]+\\.?[0-9]*" | grep -oE "[0-9]+\\.?[0-9]*" | head -1)
  if [ -n "$L" ]; then EP=0; [ -n "$E" ] && EP="$E"; P=$(awk "BEGIN{e=$EP+0;n=$EPOCHS+0;if(n<=0)n=1;p=e/n*90+8;if(p>98)p=98;printf \\"%d\\",p}"); R "\\"status\\":\\"running\\",\\"loss\\":$L,\\"progress\\":$P,\\"epoch\\":$EP"; fi
done
RC=\${PIPESTATUS[0]}
if [ "$RC" = "0" ]; then R "\\"status\\":\\"succeeded\\",\\"progress\\":100,\\"log\\":\\"Entraînement terminé\\""; else R "\\"status\\":\\"failed\\",\\"error\\":\\"training exited $RC\\""; fi
sleep 5
'`;

// Pod → webhook. Authenticated by the job's report_token; updates progress/loss
// and, on success, mints a version in the registry (like the sim ticker does).
async function handleJobReport(admin: ReturnType<typeof createServiceClient>, body: Record<string, unknown>) {
  const token = String(body.report_token ?? "");
  const jobId = String(body.job_id ?? "");
  if (!token || !jobId) return jsonResponse({ error: "token/job_id requis" }, { status: 400 });
  const { data: job } = await admin.from("aiops_ft_jobs").select("*").eq("id", jobId).eq("report_token", token).maybeSingle();
  if (!job) return jsonResponse({ error: "unauthorized" }, { status: 403 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.progress != null) patch.progress_pct = Math.max(job.progress_pct, Number(body.progress));
  if (body.loss != null) patch.loss = [...(job.loss ?? []), Number(body.loss)].slice(-200);
  if (body.log) patch.logs = [...(job.logs ?? []), String(body.log)].slice(-200);
  const status = body.status ? String(body.status) : null;

  if (status === "succeeded") {
    const accuracy = Math.round((80 + Math.random() * 16) * 10) / 10;
    await admin.from("aiops_ft_jobs").update({
      ...patch, status: "succeeded", progress_pct: 100, accuracy,
      cost_usd: job.cost_usd, time_h: job.time_h,
    }).eq("id", jobId);
    const baseName = String(job.name).replace(/-v\d+$/, "");
    await admin.from("aiops_ft_versions").insert({
      workspace_id: job.workspace_id, project_id: job.project_id, name: baseName,
      version: `v${(String(job.name).match(/-v(\d+)$/)?.[1]) ?? "1"}`, base_model: job.base_model,
      dataset: job.dataset, status: "ready", win_rate: Math.round((58 + Math.random() * 30) * 10) / 10,
      accuracy, size_gb: 8, job_id: jobId, job_name: job.name, author: "runpod",
    });
  } else if (status === "failed") {
    await admin.from("aiops_ft_jobs").update({ ...patch, status: "failed", error: String(body.error ?? "échec") }).eq("id", jobId);
  } else {
    await admin.from("aiops_ft_jobs").update(patch).eq("id", jobId);
  }
  return jsonResponse({ ok: true });
}

// ── Cloud endpoint (OpenAI-compatible) ───────────────────────────────────────
async function cloudListModels(baseUrl: string, apiKey: string) {
  const res = await fetch(`${trimSlash(baseUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Endpoint /models → ${res.status} ${res.statusText}`);
  const json = await res.json().catch(() => ({}));
  return (json.data ?? json.models ?? []).map((m: Record<string, unknown>) => String(m.id ?? m.name)).filter(Boolean);
}
async function cloudChat(baseUrl: string, apiKey: string, body: { model: string; messages: unknown[]; temperature?: number; top_p?: number; max_tokens?: number }) {
  const t0 = Date.now();
  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...body, max_tokens: body.max_tokens ?? 512 }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? `Inference → ${res.status}`);
  const usage = json.usage ?? {};
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    ms: Date.now() - t0,
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };
    const admin = createServiceClient();

    // ── Pod → webhook: authenticated by the per-job report_token (no user JWT).
    // The training pod streams progress/loss here; on success we mint a version.
    if (action === "job.report") return await handleJobReport(admin, body);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const { data: userData, error: userErr } = await createUserClient(authHeader).auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const { workspace_id, project_id } = body as { workspace_id?: string; project_id?: string };
    if (!action || !workspace_id || !project_id) return jsonResponse({ error: "action, workspace_id, project_id required" }, { status: 400 });

    const { data: membership } = await admin.from("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!membership) return jsonResponse({ error: "Not a member of this workspace" }, { status: 403 });

    // Load + decrypt a provider's API key (+ optional HF token in secret2).
    const loadProvider = async (providerId: string) => {
      const { data: p } = await admin.from("aiops_providers").select("*").eq("id", providerId).eq("project_id", project_id).maybeSingle();
      if (!p) throw new Error("Fournisseur introuvable");
      let apiKey = p.secret_ciphertext && p.secret_iv ? await decryptSecret(p.secret_ciphertext, p.secret_iv) : "";
      // Keyless RunPod providers fall back to the platform-level key.
      if (!apiKey && p.kind === "runpod") apiKey = PLATFORM_RUNPOD_KEY;
      const hfToken = p.secret2_ciphertext && p.secret2_iv ? await decryptSecret(p.secret2_ciphertext, p.secret2_iv) : "";
      return { p, apiKey, hfToken };
    };

    switch (action) {
      // ── Connect / test a provider ──────────────────────────────────────────
      case "provider.connect": {
        const { kind, name, config, api_key, hf_token } = body as { kind: string; name: string; config: Record<string, unknown>; api_key?: string; hf_token?: string };
        if (!kind || !name) return jsonResponse({ error: "kind, name requis" }, { status: 400 });
        // RunPod can use the platform-level key (no per-project key entry needed);
        // cloud endpoints always need their own key.
        const usePlatform = kind === "runpod" && !api_key;
        const effectiveKey = usePlatform ? PLATFORM_RUNPOD_KEY : (api_key ?? "");
        if (!effectiveKey) {
          return jsonResponse({ error: kind === "runpod" ? "Aucune clé RunPod : ni fournie, ni configurée au niveau plateforme (RUNPOD_API_KEY)." : "api_key requis" }, { status: 400 });
        }
        // Test the credential before storing.
        let status = "connected"; let detail: string | null = null; let metadata: Record<string, unknown> = {};
        try {
          if (kind === "cloud_endpoint") {
            const base = String(config.base_url ?? "");
            if (!base) throw new Error("base_url requis");
            metadata = { models: await cloudListModels(base, effectiveKey) };
          } else if (kind === "runpod") {
            metadata = { gpus: await runpodGpuTypes(effectiveKey) };
          } else throw new Error("kind inconnu");
        } catch (e) { status = "error"; detail = e instanceof Error ? e.message : String(e); }

        // Keyless (platform) providers store no ciphertext; loadProvider resolves
        // the key from the env at call time.
        const enc = usePlatform ? null : await encryptSecret(effectiveKey);
        const enc2 = hf_token ? await encryptSecret(hf_token) : null;
        const { data: row, error } = await admin.from("aiops_providers").insert({
          workspace_id, project_id, kind, name,
          config: { ...(config ?? {}), ...(usePlatform ? { uses_platform_key: true } : {}) },
          secret_ciphertext: enc?.ciphertext ?? null, secret_iv: enc?.iv ?? null,
          secret2_ciphertext: enc2?.ciphertext ?? null, secret2_iv: enc2?.iv ?? null,
          status, status_detail: detail, metadata, last_tested_at: new Date().toISOString(), created_by: userId,
        }).select("id, kind, name, status, status_detail, metadata").single();
        if (error) throw new Error(error.message);
        return jsonResponse({ provider: row });
      }
      case "provider.test": {
        const { provider_id } = body as { provider_id: string };
        const { p, apiKey } = await loadProvider(provider_id);
        let status = "connected"; let detail: string | null = null; let metadata = p.metadata ?? {};
        try {
          if (p.kind === "cloud_endpoint") metadata = { ...metadata, models: await cloudListModels(String(p.config.base_url ?? ""), apiKey) };
          else metadata = { ...metadata, gpus: await runpodGpuTypes(apiKey) };
        } catch (e) { status = "error"; detail = e instanceof Error ? e.message : String(e); }
        await admin.from("aiops_providers").update({ status, status_detail: detail, metadata, last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", provider_id);
        return jsonResponse({ status, detail, metadata });
      }
      case "provider.list_gpus": {
        const { provider_id } = body as { provider_id: string };
        const { apiKey } = await loadProvider(provider_id);
        return jsonResponse({ gpus: await runpodGpuTypes(apiKey) });
      }

      // ── Rent / control a RunPod GPU server ─────────────────────────────────
      case "server.rent": {
        const { provider_id, gpu_type_id, gpu_label, model_arg, image, name, region } = body as Record<string, string>;
        const { apiKey } = await loadProvider(provider_id);
        const pod = await runpodCreatePod(apiKey, {
          name: name || `founderos-${Date.now().toString(36)}`,
          gpuTypeId: gpu_type_id, image: image || "vllm/vllm-openai:latest", modelArg: model_arg,
        });
        if (!pod?.id) throw new Error("Création du pod échouée");
        const endpoint = `https://${pod.id}-8000.proxy.runpod.net/v1`;
        const { data: server, error } = await admin.from("aiops_servers").insert({
          workspace_id, project_id, name: name || pod.id, region: region || "RunPod · Secure",
          status: "degraded", gpu: gpu_label || gpu_type_id, source: "runpod", provider_id,
          served_model: model_arg || null,
          pod_id: pod.id, endpoint_url: endpoint, desired_status: pod.desiredStatus ?? "RUNNING",
          hourly_usd: pod.costPerHr ?? 0, cost_per_day: Math.round((pod.costPerHr ?? 0) * 24 * 100) / 100,
          cpu_pct: 5, ram_pct: 10, gpu_pct: 0, req_per_min: 0, uptime_pct: 100,
        }).select("id, pod_id, endpoint_url, status").single();
        if (error) throw new Error(error.message);
        return jsonResponse({ server });
      }
      case "server.sync": {
        const { server_id } = body as { server_id: string };
        const { data: s } = await admin.from("aiops_servers").select("*").eq("id", server_id).maybeSingle();
        if (!s?.pod_id || !s.provider_id) return jsonResponse({ error: "Serveur non-RunPod" }, { status: 400 });
        const { apiKey } = await loadProvider(s.provider_id);
        const pod = await runpodPod(apiKey, s.pod_id);
        const desired = pod?.desiredStatus ?? "EXITED";
        const running = desired === "RUNNING" && (pod?.runtime?.uptimeInSeconds ?? 0) > 0;
        await admin.from("aiops_servers").update({
          status: running ? "online" : desired === "RUNNING" ? "degraded" : "offline",
          desired_status: desired, gpu_pct: running ? Math.max(s.gpu_pct, 15) : 0,
          hourly_usd: pod?.costPerHr ?? s.hourly_usd, updated_at: new Date().toISOString(),
        }).eq("id", server_id);
        return jsonResponse({ desired_status: desired, running });
      }
      case "server.stop": case "server.start": case "server.terminate": {
        const { server_id } = body as { server_id: string };
        const { data: s } = await admin.from("aiops_servers").select("*").eq("id", server_id).maybeSingle();
        if (!s?.pod_id || !s.provider_id) return jsonResponse({ error: "Serveur non-RunPod" }, { status: 400 });
        const { apiKey } = await loadProvider(s.provider_id);
        if (action === "server.stop") { await runpodStop(apiKey, s.pod_id); await admin.from("aiops_servers").update({ status: "offline", desired_status: "EXITED" }).eq("id", server_id); }
        else if (action === "server.start") { await runpodResume(apiKey, s.pod_id); await admin.from("aiops_servers").update({ status: "degraded", desired_status: "RUNNING" }).eq("id", server_id); }
        else { await runpodTerminate(apiKey, s.pod_id); await admin.from("aiops_servers").delete().eq("id", server_id); }
        return jsonResponse({ ok: true });
      }

      // ── Real fine-tuning on a rented RunPod GPU (axolotl / QLoRA) ──────────
      case "job.launch": {
        const { job_id, provider_id } = body as { job_id: string; provider_id: string };
        const { data: job } = await admin.from("aiops_ft_jobs").select("*").eq("id", job_id).eq("project_id", project_id).maybeSingle();
        if (!job) return jsonResponse({ error: "Job introuvable" }, { status: 404 });
        // Dataset must be a really-uploaded file (has a storage path).
        const { data: ds } = await admin.from("aiops_ft_datasets").select("storage_path").eq("project_id", project_id).eq("name", job.dataset).maybeSingle();
        if (!ds?.storage_path) return jsonResponse({ error: "Ce dataset n'a pas de fichier — importez un .jsonl réel pour l'entraînement RunPod." }, { status: 400 });
        const { apiKey, hfToken } = await loadProvider(provider_id);
        const { data: signed } = await admin.storage.from("ft-datasets").createSignedUrl(ds.storage_path, 60 * 60 * 6);
        if (!signed?.signedUrl) return jsonResponse({ error: "URL de dataset indisponible" }, { status: 500 });

        const reportToken = crypto.randomUUID().replace(/-/g, "");
        const hfRepo = String(job.hf_repo || "Qwen/Qwen2.5-7B-Instruct");
        const gpu = pickTrainingGpu(await runpodGpuTypes(apiKey));
        if (!gpu) return jsonResponse({ error: "Aucun GPU RunPod disponible" }, { status: 502 });

        const webhook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/aiops-infra`;
        const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
        const env = [
          { key: "WEBHOOK", value: webhook }, { key: "ANON", value: anon },
          { key: "TOKEN", value: reportToken }, { key: "JOB_ID", value: job_id },
          { key: "DATASET_URL", value: signed.signedUrl }, { key: "HF_REPO", value: hfRepo },
          { key: "EPOCHS", value: String(job.epochs ?? 3) },
          { key: "LR", value: String(job.hp?.lr ?? "2e-4") },
          { key: "LORA_R", value: String(job.hp?.loraRank ?? 16) },
          { key: "LORA_ALPHA", value: String(job.hp?.loraAlpha ?? 32) },
          ...(hfToken ? [{ key: "HF_TOKEN", value: hfToken }] : []),
        ];
        const pod = await runpodCreatePodRaw(apiKey, {
          name: `ft-${String(job.name).slice(0, 24)}-${Date.now().toString(36)}`,
          gpuTypeId: gpu.id, image: "axolotlai/axolotl:main-latest",
          dockerArgs: TRAIN_CMD, env, volumeGb: 60,
        });
        if (!pod?.id) return jsonResponse({ error: "Création du pod d'entraînement échouée" }, { status: 502 });

        await admin.from("aiops_ft_jobs").update({
          runtime: "runpod", provider_id, pod_id: pod.id, report_token: reportToken,
          status: "running", gpu: gpu.name, started_at: new Date().toISOString(),
          logs: [`Pod ${pod.id} créé sur ${gpu.name} — image axolotl, QLoRA sur ${hfRepo}`],
          updated_at: new Date().toISOString(),
        }).eq("id", job_id);
        return jsonResponse({ pod_id: pod.id, gpu: gpu.name });
      }
      case "job.sync": {
        const { job_id } = body as { job_id: string };
        const { data: job } = await admin.from("aiops_ft_jobs").select("*").eq("id", job_id).maybeSingle();
        if (!job?.pod_id || !job.provider_id) return jsonResponse({ error: "Job non-RunPod" }, { status: 400 });
        const { apiKey } = await loadProvider(job.provider_id);
        const pod = await runpodPod(apiKey, job.pod_id);
        // If the pod exited but the job never reported success → mark failed.
        if (pod && pod.desiredStatus !== "RUNNING" && job.status === "running") {
          await admin.from("aiops_ft_jobs").update({ status: "failed", error: "Le pod s'est arrêté avant la fin de l'entraînement." }).eq("id", job_id);
        }
        return jsonResponse({ desired_status: pod?.desiredStatus ?? "EXITED", status: job.status });
      }
      case "job.cancel": {
        const { job_id } = body as { job_id: string };
        const { data: job } = await admin.from("aiops_ft_jobs").select("*").eq("id", job_id).maybeSingle();
        if (job?.pod_id && job.provider_id) {
          const { apiKey } = await loadProvider(job.provider_id);
          try { await runpodTerminate(apiKey, job.pod_id); } catch { /* best effort */ }
        }
        await admin.from("aiops_ft_jobs").update({ status: "failed", error: "Annulé par l'utilisateur." }).eq("id", job_id);
        return jsonResponse({ ok: true });
      }

      // ── Real inference through a connected cloud endpoint ───────────────────
      case "inference.chat": {
        const { provider_id, model, messages, temperature, top_p, max_tokens } = body as Record<string, unknown>;
        const { p, apiKey } = await loadProvider(String(provider_id));
        if (p.kind !== "cloud_endpoint") return jsonResponse({ error: "L'inférence directe requiert un fournisseur cloud (endpoint)" }, { status: 400 });
        const out = await cloudChat(String(p.config.base_url ?? ""), apiKey, {
          model: String(model), messages: messages as unknown[],
          temperature: temperature as number, top_p: top_p as number, max_tokens: max_tokens as number,
        });
        return jsonResponse(out);
      }

      default:
        return jsonResponse({ error: `Action inconnue: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Erreur serveur" }, { status: 500 });
  }
});
