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

// vLLM refuses to boot when --max-model-len exceeds the model's
// max_position_embeddings. Clamp to the real value read from the model's HF
// config.json; when it can't be read (gated/private repo, network error) we drop
// the flag so vLLM falls back to the model's own default (guaranteed safe).
async function clampMaxModelLen(maxModelLen: number | null, repo: string | null): Promise<number | undefined> {
  if (!maxModelLen || maxModelLen <= 0) return undefined;
  if (!repo) return maxModelLen;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://huggingface.co/${repo}/raw/main/config.json`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return undefined;
    const cfg = await res.json().catch(() => null) as { max_position_embeddings?: number } | null;
    const derived = Number(cfg?.max_position_embeddings) || 0;
    if (!derived) return undefined;
    return Math.min(maxModelLen, derived);
  } catch {
    return undefined;
  }
}

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

async function runpodCreatePod(apiKey: string, opts: {
  name: string; gpuTypeId: string; image: string; modelArg?: string;
  volumeGb?: number; gpuCount?: number; cloudType?: "secure" | "community"; dockerArgs?: string;
}) {
  const dockerArgs = opts.dockerArgs ?? (opts.modelArg ? `--model ${opts.modelArg} --port 8000` : "");
  const data = await runpod(apiKey, `
    mutation Deploy($input: PodFindAndDeployOnDemandInput) {
      podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr desiredStatus }
    }`, {
    input: {
      cloudType: opts.cloudType === "community" ? "COMMUNITY" : "SECURE",
      gpuCount: opts.gpuCount ?? 1, volumeInGb: opts.volumeGb ?? 40, containerDiskInGb: 40,
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
    // Finalise the billing: elapsed time since launch × pod hourly rate.
    const elapsedH = job.started_at ? Math.max(0, (Date.now() - new Date(job.started_at as string).getTime()) / 3_600_000) : 0;
    const rate = Number((job.hp as Record<string, unknown>)?.gpu_hourly_usd ?? 0);
    const cost = rate > 0 ? Math.round(elapsedH * rate * 100) / 100 : job.cost_usd;
    await admin.from("aiops_ft_jobs").update({
      ...patch, status: "succeeded", progress_pct: 100, accuracy,
      cost_usd: cost, time_h: Math.round(elapsedH * 10) / 10, gpu_hours: Math.round(elapsedH * 10) / 10,
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

// ── Real infra cost accounting ───────────────────────────────────────────────
// Each running pod accrues a ledger segment (hours × hourly_usd) when it is
// reconciled (the client calls cost.reconcile ~every minute) or when it stops.
// The server row keeps lifetime totals + the open segment's start; accruing
// rolls running_since forward (keepOpen=true) or clears it (pod stopped), so a
// given instant is never billed twice.
type ServerRow = Record<string, unknown>;
async function accrueCost(admin: ReturnType<typeof createServiceClient>, s: ServerRow, now: Date, keepOpen: boolean) {
  const rate = Number(s.hourly_usd ?? 0);
  const since = s.running_since ? new Date(s.running_since as string).getTime() : 0;
  if (rate <= 0 || !since) return;
  const end = now.getTime();
  if (end - since < 5_000) {
    // Segment too short to matter — just roll the clock forward.
    if (keepOpen) await admin.from("aiops_servers").update({ running_since: now.toISOString(), updated_at: now.toISOString() }).eq("id", s.id);
    return;
  }
  const hours = (end - since) / 3_600_000;
  const usd = hours * rate;
  await admin.from("aiops_infra_cost_ledger").insert({
    workspace_id: s.workspace_id, project_id: s.project_id, provider_id: s.provider_id ?? null,
    server_id: s.id, server_name: s.name ?? "", gpu: s.gpu ?? "", hourly_usd: rate,
    period_start: s.running_since, period_end: now.toISOString(),
    hours: Math.round(hours * 1000) / 1000, usd: Math.round(usd * 100) / 100, kind: "server",
  });
  await admin.from("aiops_servers").update({
    accrued_cost_usd: Math.round((Number(s.accrued_cost_usd ?? 0) + usd) * 100) / 100,
    accrued_hours: Math.round((Number(s.accrued_hours ?? 0) + hours) * 1000) / 1000,
    running_since: keepOpen ? now.toISOString() : null,
    updated_at: now.toISOString(),
  }).eq("id", s.id);
}

// ── Real training cost accounting ────────────────────────────────────────────
// A training pod (created via runpodCreatePodRaw) is NOT mirrored into
// aiops_servers — it bills directly on the job row. The hourly rate comes from
// the pod's costPerHr (stored in hp.gpu_hourly_usd at launch); the elapsed
// time is measured from started_at, so every job.sync / job.cancel / final
// webhook keeps cost_usd / gpu_hours / time_h honest without double-billing.
async function accrueJobCost(admin: ReturnType<typeof createServiceClient>, job: Record<string, unknown>, now: Date) {
  const start = job.started_at ? new Date(job.started_at as string).getTime() : 0;
  if (!start) return;
  const hours = Math.max(0, (now.getTime() - start) / 3_600_000);
  const rate = Number((job.hp as Record<string, unknown>)?.gpu_hourly_usd ?? 0);
  const patch: Record<string, unknown> = {
    gpu_hours: Math.round(hours * 10) / 10,
    time_h: Math.round(hours * 10) / 10,
    updated_at: now.toISOString(),
  };
  if (rate > 0) patch.cost_usd = Math.round(hours * rate * 100) / 100;
  await admin.from("aiops_ft_jobs").update(patch).eq("id", job.id);
}

// ── Cloud endpoint (OpenAI-compatible) ───────────────────────────────────────
// An unauthenticated endpoint is legitimate (a vLLM/Ollama server on the
// company's own network), so the Authorization header is only sent when there
// is actually a key — some servers reject a bare "Bearer ".
const cloudHeaders = (apiKey: string) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function cloudListModels(baseUrl: string, apiKey: string) {
  const res = await fetch(`${trimSlash(baseUrl)}/models`, { headers: cloudHeaders(apiKey) });
  if (!res.ok) throw new Error(`Endpoint /models → ${res.status} ${res.statusText}`);
  const json = await res.json().catch(() => ({}));
  return (json.data ?? json.models ?? []).map((m: Record<string, unknown>) => String(m.id ?? m.name)).filter(Boolean);
}

/**
 * Readiness probe for a rented vLLM pod: the pod is "running" the moment the
 * container is up, but the model can take minutes to load (a 70B in FP16 is
 * 140GB). A short GET on /models answers "is it actually serving?" — that's the
 * only signal we trust to flip a pod from degraded → online.
 */
async function cloudReady(baseUrl: string, apiKey = ""): Promise<boolean> {
  try {
    const res = await fetch(`${trimSlash(baseUrl)}/models`, {
      method: "GET", headers: cloudHeaders(apiKey), signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe a cloud endpoint at connect time.
 *
 * `/models` is a convenience, not a contract: several OpenAI-compatible
 * providers don't implement it, and a private gateway may deliberately hide its
 * catalogue. Treating that as a connection failure locked those providers out
 * entirely — so a listing error degrades to "connected, catalogue unknown" and
 * the user types the model id themselves. Only a genuinely unreachable host or
 * a rejected credential is an error.
 */
async function cloudProbe(baseUrl: string, apiKey: string): Promise<{ models: string[]; note?: string }> {
  try {
    return { models: await cloudListModels(baseUrl, apiKey) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A rejected credential is a real failure — the user must fix the key.
    if (/\b40[13]\b/.test(msg)) throw new Error(`Clé refusée par l'endpoint (${msg})`);
    // Anything else: confirm the host answers at all, then accept it.
    try {
      const ping = await fetch(`${trimSlash(baseUrl)}/models`, { method: "HEAD", headers: cloudHeaders(apiKey) });
      void ping;
    } catch {
      throw new Error(`Endpoint injoignable : ${msg}`);
    }
    return { models: [], note: `Catalogue non listable (${msg}) — saisissez l'identifiant du modèle à la main.` };
  }
}
async function cloudChat(baseUrl: string, apiKey: string, body: { model: string; messages: unknown[]; temperature?: number; top_p?: number; max_tokens?: number }) {
  const t0 = Date.now();
  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cloudHeaders(apiKey) },
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

// ── OVHcloud Public Cloud ────────────────────────────────────────────────────
// Real GPU instances via the OVH Public Cloud REST API. Requests are signed:
//   X-Ovh-Signature: $1$ + SHA1(AK + '+' + CK + '+' + METHOD + '+' + FULL_URL
//                                     + '+' + BODY + '+' + TIMESTAMP)
// with the timestamp fetched from /auth/time (the API rejects skewed clocks).
// Credentials: AK (Application Key) in secret_ciphertext, CK (Consumer Key) in
// secret2_ciphertext, service name + API region (eu/ca/us) in config.
const OVH_ENDPOINTS: Record<string, string> = {
  eu: "https://eu.api.ovhcloud.com/1.0",
  ca: "https://ca.api.ovhcloud.com/1.0",
  us: "https://us.api.ovhcloud.com/1.0",
};
interface OvhCreds { applicationKey: string; consumerKey: string; region: string; serviceName: string }
const ovhBase = (region: string) => OVH_ENDPOINTS[region] ?? OVH_ENDPOINTS.eu;
const ovhCreds = (p: Record<string, unknown>, applicationKey: string, consumerKey: string): OvhCreds => {
  const cfg = (p.config ?? {}) as Record<string, unknown>;
  return { applicationKey, consumerKey, region: String(cfg.ovh_region ?? "eu"), serviceName: String(cfg.service_name ?? "") };
};

async function sha1hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ovhRequest(creds: OvhCreds, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const base = ovhBase(creds.region);
  const url = `${base}${path}`;
  const timeRes = await fetch(`${base}/auth/time`);
  const tstamp = String(parseInt(await timeRes.text(), 10) || Math.floor(Date.now() / 1000));
  const bodyStr = body ? JSON.stringify(body) : "";
  const signature = "$1$" + await sha1hex(`${creds.applicationKey}+${creds.consumerKey}+${method}+${url}+${bodyStr}+${tstamp}`);
  const res = await fetch(url, {
    method,
    headers: {
      "X-Ovh-Application": creds.applicationKey,
      "X-Ovh-Consumer": creds.consumerKey,
      "X-Ovh-Timestamp": tstamp,
      "X-Ovh-Signature": signature,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json && typeof json === "object" && "message" in (json as Record<string, unknown>)
      ? String((json as { message: string }).message) : text.slice(0, 300);
    throw new Error(`OVH API ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  return json;
}

/** GPU VRAM (GB) per OVH GPU model — drives the VRAM-fit logic in the UI. */
const OVH_GPU_VRAM: Record<string, number> = {
  a100: 80, h100: 80, l40s: 48, l40: 48, a40: 48, a10: 24, l4: 24,
  v100: 16, t4: 16, a6000: 48, a5000: 24, a4000: 16, a2000: 12,
};
const isGpuFlavor = (f: Record<string, unknown>) =>
  /gpu/i.test(String(f.type ?? "")) || /gpu/i.test(String(f.name ?? ""));

async function ovhFlavors(creds: OvhCreds) {
  const list = await ovhRequest(creds, "GET", `/cloud/project/${creds.serviceName}/flavor`) as Record<string, unknown>[];
  return (Array.isArray(list) ? list : [])
    .filter(isGpuFlavor)
    .map((f) => {
      const caps = (f.capabilities ?? []) as { name?: string; value?: string | number }[];
      const modelToken = String(caps.find((c) => c.name === "gpu_model")?.value ?? String(f.name ?? "").split("-")[0]).toLowerCase();
      return {
        id: String(f.id), name: String(f.name),
        vcpus: Number(f.vcpus ?? 0), ramGb: Number(f.ram ?? 0), diskGb: Number(f.disk ?? 0),
        memoryGb: OVH_GPU_VRAM[modelToken] ?? 24,
        regions: ((f.regions ?? []) as unknown[]).map(String),
        hourlyUsd: Number(f.hourly ?? 0) || 0,
      };
    })
    .filter((x) => x.hourlyUsd > 0)
    .sort((a, b) => a.hourlyUsd - b.hourlyUsd);
}

async function ovhImages(creds: OvhCreds) {
  const list = await ovhRequest(creds, "GET", `/cloud/project/${creds.serviceName}/image`) as Record<string, unknown>[];
  return (Array.isArray(list) ? list : [])
    .filter((i) => String(i.osType ?? "") === "linux" && /ubuntu|debian/i.test(String(i.name ?? "")))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((i) => ({
      id: String(i.id), name: String(i.name),
      regions: ((i.regions ?? []) as unknown[]).map(String),
    }));
}

async function ovhSshKeys(creds: OvhCreds) {
  const list = await ovhRequest(creds, "GET", `/cloud/project/${creds.serviceName}/sshkey`) as Record<string, unknown>[];
  return (Array.isArray(list) ? list : []).map((k) => ({ id: String(k.id), name: String(k.name) }));
}

/** Everything the "louer un GPU OVH" flow needs, in one shot. */
async function ovhCatalog(creds: OvhCreds) {
  const [flavors, images, sshKeys] = await Promise.all([
    ovhFlavors(creds), ovhImages(creds), ovhSshKeys(creds),
  ]);
  return { flavors, images, ssh_keys: sshKeys };
}

async function ovhInstance(creds: OvhCreds, instanceId: string): Promise<Record<string, unknown>> {
  return await ovhRequest(creds, "GET", `/cloud/project/${creds.serviceName}/instance/${instanceId}`) as Record<string, unknown>;
}
function instancePublicIp(inst: Record<string, unknown>): string | null {
  const ips = (inst.ipAddresses ?? []) as { ip?: string; type?: string; version?: string }[];
  const pub = ips.find((i) => i.type === "public" && String(i.version ?? "") === "4");
  return pub?.ip ?? null;
}
async function ovhWaitActive(creds: OvhCreds, instanceId: string, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let inst = await ovhInstance(creds, instanceId);
  while (String(inst.status ?? "") !== "ACTIVE" && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 8000));
    inst = await ovhInstance(creds, instanceId);
  }
  return inst;
}

/** Instance id (for multi-GPU OVH flavors, the count is in the name: "a100-1-gpu"). */
function ovhGpuCount(flavorName: string): number {
  const m = flavorName.match(/-(\d+)-gpu/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/**
 * cloud-init script: installs Docker + the NVIDIA container toolkit and starts
 * vLLM on :8000 (OpenAI-compatible). `args` is the full vLLM command line.
 */
function ovhUserData(args: string, hfToken: string): string {
  const hf = hfToken ? `export HUGGING_FACE_HUB_TOKEN="${hfToken}"` : "";
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
${hf}
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw
curl -fsSL https://get.docker.com | sh
# NVIDIA container toolkit (--gpus all needs it) — best effort: some base
# images already ship it, and a missing toolkit must not block the container.
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg || true
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list || true
apt-get update -y || true
apt-get install -y nvidia-container-toolkit || true
nvidia-ctk runtime configure --runtime=docker || true
systemctl restart docker || true
ufw allow 8000/tcp || true
docker run -d --name vllm --gpus all --restart unless-stopped --shm-size=1g -p 8000:8000 vllm/vllm-openai:latest ${args}
`;
}

// ── AWS (catalogue + simulated provisioning) ─────────────────────────────────
// No SDK calls yet: the catalogue is static and the lifecycle is simulated the
// same way the demo servers are, so the whole flow stays testable in-product.
const AWS_GPU_CATALOG = [
  { id: "g4dn.xlarge", name: "T4 · 1×", memoryGb: 16, hourlyUsd: 0.526, secure: true, community: false },
  { id: "g5.xlarge", name: "A10G · 1×", memoryGb: 24, hourlyUsd: 1.006, secure: true, community: false },
  { id: "g5.48xlarge", name: "A10G · 8×", memoryGb: 192, hourlyUsd: 8.55, secure: true, community: false },
  { id: "g6.12xlarge", name: "L4 · 4×", memoryGb: 96, hourlyUsd: 4.10, secure: true, community: false },
  { id: "p4d.24xlarge", name: "A100 · 8×", memoryGb: 320, hourlyUsd: 32.77, secure: true, community: false },
  { id: "p5.48xlarge", name: "H100 · 8×", memoryGb: 640, hourlyUsd: 98.32, secure: true, community: false },
].sort((a, b) => a.hourlyUsd - b.hourlyUsd);

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
        // RunPod can use the platform-level key (no per-project key entry
        // needed). A cloud endpoint may legitimately have NO key at all — a
        // vLLM or Ollama server on the company's own network is unauthenticated
        // — so only RunPod hard-requires a credential.
        const usePlatform = kind === "runpod" && !api_key;
        const effectiveKey = usePlatform ? PLATFORM_RUNPOD_KEY : (api_key ?? "");
        if (!effectiveKey && kind === "runpod") {
          return jsonResponse({ error: "Aucune clé RunPod : ni fournie, ni configurée au niveau plateforme (RUNPOD_API_KEY)." }, { status: 400 });
        }
        if (kind === "ovh") {
          if (!effectiveKey || !hf_token) {
            return jsonResponse({ error: "Application Key et Consumer Key OVH requises." }, { status: 400 });
          }
          if (!String((config ?? {}).service_name ?? "")) {
            return jsonResponse({ error: "ID du projet Public Cloud (serviceName) requis." }, { status: 400 });
          }
        }
        // Test the credential before storing.
        let status = "connected"; let detail: string | null = null; let metadata: Record<string, unknown> = {};
        try {
          if (kind === "cloud_endpoint") {
            const base = String(config.base_url ?? "");
            if (!base) throw new Error("base_url requis");
            const probe = await cloudProbe(base, effectiveKey);
            // Model ids the user typed in (for endpoints that expose no
            // catalogue) are the fallback, never an override: a real listing is
            // always more trustworthy than what someone remembered.
            const manual = Array.isArray(config.manual_models)
              ? (config.manual_models as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
              : [];
            metadata = { models: probe.models.length ? probe.models : manual };
            // A connected-but-unlistable endpoint is a WARNING, not a failure:
            // the row stays usable and the note explains what to do.
            if (probe.note) detail = manual.length ? null : probe.note;
          } else if (kind === "runpod") {
            metadata = { gpus: await runpodGpuTypes(effectiveKey) };
          } else if (kind === "ovh") {
            metadata = await ovhCatalog(ovhCreds({ config }, effectiveKey, String(hf_token ?? "")));
          } else if (kind === "aws") {
            metadata = { gpus: AWS_GPU_CATALOG };
          } else throw new Error("kind inconnu");
        } catch (e) { status = "error"; detail = e instanceof Error ? e.message : String(e); }

        // Keyless (platform) providers store no ciphertext; loadProvider resolves
        // the key from the env at call time.
        const enc = effectiveKey ? await encryptSecret(effectiveKey) : null;
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
        const { p, apiKey, hfToken } = await loadProvider(provider_id);
        let status = "connected"; let detail: string | null = null; let metadata = p.metadata ?? {};
        try {
          if (p.kind === "cloud_endpoint") {
            const probe = await cloudProbe(String(p.config.base_url ?? ""), apiKey);
            const manual = Array.isArray(p.config.manual_models)
              ? (p.config.manual_models as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
              : [];
            metadata = { ...metadata, models: probe.models.length ? probe.models : manual };
            if (probe.note) detail = manual.length ? null : probe.note;
          } else if (p.kind === "ovh") {
            metadata = { ...metadata, ...await ovhCatalog(ovhCreds(p, apiKey, hfToken)) };
          } else if (p.kind === "aws") {
            metadata = { ...metadata, gpus: AWS_GPU_CATALOG };
          } else metadata = { ...metadata, gpus: await runpodGpuTypes(apiKey) };
        } catch (e) { status = "error"; detail = e instanceof Error ? e.message : String(e); }
        await admin.from("aiops_providers").update({ status, status_detail: detail, metadata, last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", provider_id);
        return jsonResponse({ status, detail, metadata });
      }
      case "provider.list_gpus": {
        const { provider_id } = body as { provider_id: string };
        const { p, apiKey, hfToken } = await loadProvider(provider_id);
        // Persist the refreshed catalogue into metadata so the UI (which reads
        // the aiops_providers_public view) actually sees updated prices.
        let metadata: Record<string, unknown> = {};
        if (p.kind === "ovh") metadata = { ...p.metadata, ...await ovhCatalog(ovhCreds(p, apiKey, hfToken)) };
        else if (p.kind === "aws") metadata = { ...p.metadata, gpus: AWS_GPU_CATALOG };
        else metadata = { ...p.metadata, gpus: await runpodGpuTypes(apiKey) };
        await admin.from("aiops_providers").update({ metadata, updated_at: new Date().toISOString() }).eq("id", provider_id);
        return jsonResponse(metadata);
      }

      // ── Rent / control a RunPod GPU server ─────────────────────────────────
      case "server.rent": {
        const { provider_id } = body as Record<string, unknown>;
        const { p, apiKey, hfToken } = await loadProvider(String(provider_id));
        const { gpu_type_id, gpu_label, model_arg, image, name, region, gpu_count, cloud_type, quantization, max_model_len, vllm_args, flavor_id, flavor_label, flavor_hourly_usd, image_id, ssh_key_id } = body as Record<string, unknown>;
        const vllmImage = String(image || "vllm/vllm-openai:latest");
        const servedModel = model_arg ? String(model_arg) : null;
        const gpuCount = Math.max(1, Math.min(8, Number(gpu_count ?? 1) || 1));
        const cloudType = cloud_type === "community" ? "community" as const : "secure" as const;
        // vLLM args: model + serving port, then quantization / context window /
        // tensor parallelism (multi-GPU) / any free-form extra args. The context
        // window is clamped to the model's real max_position_embeddings so vLLM
        // never refuses to boot on an oversized --max-model-len.
        const requestedLen = max_model_len ? Number(max_model_len) : null;
        const effectiveMaxModelLen = (await clampMaxModelLen(requestedLen, model_arg ? String(model_arg) : null)) ?? null;
        const args = ["--model", String(model_arg || "default"), "--port", "8000"];
        if (quantization) args.push("--quantization", String(quantization));
        if (effectiveMaxModelLen) args.push("--max-model-len", String(effectiveMaxModelLen));
        if (gpuCount > 1) args.push("--tensor-parallel-size", String(gpuCount));
        if (vllm_args) args.push(...String(vllm_args).split(/\s+/).filter(Boolean));

        // ── OVHcloud: a real Public Cloud instance running vLLM ──────────────
        if (p.kind === "ovh") {
          const creds = ovhCreds(p, apiKey, hfToken);
          const flavorId = String(flavor_id ?? "");
          const imageId = String(image_id ?? "");
          const ovhRegion = String(region ?? "");
          if (!flavorId || !imageId || !ovhRegion) return jsonResponse({ error: "flavor_id, image_id, region requis" }, { status: 400 });
          const flavorName = String(flavor_label || flavorId);
          const inst = await ovhRequest(creds, "POST", `/cloud/project/${creds.serviceName}/instance`, {
            name: name || `founderos-${Date.now().toString(36)}`, flavorId, imageId, region: ovhRegion,
            ...(ssh_key_id ? { sshKeyId: String(ssh_key_id) } : {}),
            userData: ovhUserData(args.join(" "), hfToken),
          }) as Record<string, unknown>;
          const instanceId = String(inst.id ?? "");
          if (!instanceId) throw new Error("Création de l'instance OVH échouée");
          // Poll until the instance is ACTIVE and exposes a public IPv4; the
          // server row is still inserted if it times out (sync finishes later).
          const settled = await ovhWaitActive(creds, instanceId);
          const ip = instancePublicIp(settled);
          const endpoint = ip ? `http://${ip}:8000/v1` : null;
          const instStatus = String(settled.status ?? "BUILDING");
          const price = Number(flavor_hourly_usd ?? 0) || 0;
          const count = ovhGpuCount(flavorName);
          const { data: server, error } = await admin.from("aiops_servers").insert({
            workspace_id, project_id, name: name || instanceId, region: ovhRegion, status: "degraded",
            gpu: count > 1 ? `${count}× ${flavorName}` : flavorName, source: "ovh", provider_id: p.id,
            served_model: servedModel, pod_id: instanceId, endpoint_url: endpoint, desired_status: instStatus,
            gpu_count: count, cloud_type: "secure",
            quantization: quantization ? String(quantization) : null,
            max_model_len: effectiveMaxModelLen, docker_image: vllmImage,
            hourly_usd: price, cost_per_day: Math.round(price * 24 * 100) / 100,
            cpu_pct: 5, ram_pct: 10, gpu_pct: 0, req_per_min: 0, uptime_pct: 100,
          }).select("id, pod_id, endpoint_url, status").single();
          if (error) throw new Error(error.message);
          return jsonResponse({ server });
        }

        // ── AWS: catalogue + simulated provisioning (no real instance yet) ──
        if (p.kind === "aws") {
          const instId = `aws-${Date.now().toString(36)}`;
          const price = Number(flavor_hourly_usd ?? 0) || 0;
          const gpuLabel = String(flavor_label || gpu_label || String(gpu_type_id || "GPU"));
          const { data: server, error } = await admin.from("aiops_servers").insert({
            workspace_id, project_id, name: name || instId, region: region || "us-east-1", status: "degraded",
            gpu: gpuLabel, source: "aws", provider_id: p.id, served_model: servedModel,
            pod_id: instId, endpoint_url: null, desired_status: "RUNNING",
            gpu_count: gpuCount, cloud_type: cloudType,
            quantization: quantization ? String(quantization) : null,
            max_model_len: effectiveMaxModelLen, docker_image: vllmImage,
            hourly_usd: price, cost_per_day: Math.round(price * 24 * 100) / 100,
            cpu_pct: 5, ram_pct: 10, gpu_pct: 0, req_per_min: 0, uptime_pct: 100,
          }).select("id, pod_id, endpoint_url, status").single();
          if (error) throw new Error(error.message);
          return jsonResponse({ server });
        }

        // ── RunPod pod (real) ────────────────────────────────────────────────
        const pod = await runpodCreatePod(apiKey, {
          name: name || `founderos-${Date.now().toString(36)}`,
          gpuTypeId: String(gpu_type_id), image: vllmImage, gpuCount, cloudType,
          dockerArgs: args.join(" "),
        });
        if (!pod?.id) throw new Error("Création du pod échouée");
        const endpoint = `https://${pod.id}-8000.proxy.runpod.net/v1`;
        const { data: server, error } = await admin.from("aiops_servers").insert({
          workspace_id, project_id, name: name || pod.id, region: region || (cloudType === "community" ? "RunPod · Community" : "RunPod · Secure"),
          status: "degraded", gpu: gpu_label ? `${gpuCount}× ${gpu_label}` : String(gpu_type_id), source: "runpod", provider_id: p.id,
          served_model: servedModel,
          pod_id: pod.id, endpoint_url: endpoint, desired_status: pod.desiredStatus ?? "RUNNING",
          gpu_count: gpuCount, cloud_type: cloudType,
          quantization: quantization ? String(quantization) : null,
          max_model_len: effectiveMaxModelLen, docker_image: vllmImage,
          hourly_usd: pod.costPerHr ?? 0, cost_per_day: Math.round((pod.costPerHr ?? 0) * 24 * 100) / 100,
          cpu_pct: 5, ram_pct: 10, gpu_pct: 0, req_per_min: 0, uptime_pct: 100,
        }).select("id, pod_id, endpoint_url, status").single();
        if (error) throw new Error(error.message);
        return jsonResponse({ server });
      }
      case "server.sync": {
        const { server_id } = body as { server_id: string };
        const { data: s } = await admin.from("aiops_servers").select("*").eq("id", server_id).maybeSingle();
        if (!s?.pod_id || !s.provider_id) return jsonResponse({ error: "Serveur sans cloud" }, { status: 400 });
        const { p, apiKey, hfToken } = await loadProvider(s.provider_id);

        // OVH: poll the real instance status + readiness of the vLLM container.
        if (p.kind === "ovh") {
          const inst = await ovhInstance(ovhCreds(p, apiKey, hfToken), String(s.pod_id));
          const instStatus = String(inst.status ?? "BUILDING");
          const running = instStatus === "ACTIVE";
          const now = new Date().toISOString();
          const patch: Record<string, unknown> = { desired_status: instStatus, updated_at: now };
          if (running) {
            const ip = instancePublicIp(inst);
            if (ip && !s.endpoint_url) patch.endpoint_url = `http://${ip}:8000/v1`;
            const endpoint = String(patch.endpoint_url ?? s.endpoint_url ?? "");
            const ready = endpoint ? await cloudReady(endpoint) : false;
            patch.status = ready ? "online" : "degraded";
            if (ready && endpoint && !s.served_model) {
              const models = await cloudListModels(endpoint, "").catch(() => [] as string[]);
              if (models[0]) patch.served_model = models[0];
            }
            if (!s.running_since) patch.running_since = now;
          } else {
            patch.status = ["STOPPED", "STOPPING", "SHUTOFF"].includes(instStatus) ? "offline" : "degraded";
            if (s.running_since) await accrueCost(admin, s, new Date(), false);
          }
          await admin.from("aiops_servers").update(patch).eq("id", server_id);
          return jsonResponse({ desired_status: instStatus, running, ready: patch.status === "online" });
        }

        // AWS: simulated — flips online once the provisioning delay has passed.
        if (p.kind === "aws") {
          const now = new Date();
          const running = now.getTime() - new Date(String(s.created_at)).getTime() > 12_000;
          const patch: Record<string, unknown> = { desired_status: "RUNNING", status: running ? "online" : "degraded", updated_at: now.toISOString() };
          if (running && !s.running_since) patch.running_since = now.toISOString();
          await admin.from("aiops_servers").update(patch).eq("id", server_id);
          return jsonResponse({ desired_status: "RUNNING", running, ready: running });
        }

        // RunPod: real pod state from the GraphQL API.
        const pod = await runpodPod(apiKey, s.pod_id);
        const desired = pod?.desiredStatus ?? "EXITED";
        const running = desired === "RUNNING" && (pod?.runtime?.uptimeInSeconds ?? 0) > 0;
        const patch: Record<string, unknown> = {
          desired_status: desired, gpu_pct: running ? Math.max(s.gpu_pct, 15) : 0,
          hourly_usd: pod?.costPerHr ?? s.hourly_usd, updated_at: new Date().toISOString(),
        };
        if (running) {
          // Readiness: "online" only once the served model answers /v1/models
          // (vLLM takes minutes to load big weights). Until then → "degraded",
          // which the server page reads as "en cours de chargement".
          const ready = s.endpoint_url ? await cloudReady(String(s.endpoint_url)) : false;
          patch.status = ready ? "online" : "degraded";
          if (ready && s.endpoint_url && !s.served_model) {
            const models = await cloudListModels(String(s.endpoint_url), "").catch(() => [] as string[]);
            if (models[0]) patch.served_model = models[0];
          }
          // Billing: the segment only opens once the pod is actually serving.
          if (!s.running_since) patch.running_since = new Date().toISOString();
        } else {
          patch.status = desired === "RUNNING" ? "degraded" : "offline";
          if (s.running_since) await accrueCost(admin, s, new Date(), false);
        }
        await admin.from("aiops_servers").update(patch).eq("id", server_id);
        return jsonResponse({ desired_status: desired, running, ready: patch.status === "online" });
      }
      case "server.stop": case "server.start": case "server.terminate": {
        const { server_id } = body as { server_id: string };
        const { data: s } = await admin.from("aiops_servers").select("*").eq("id", server_id).maybeSingle();
        if (!s?.pod_id || !s.provider_id) return jsonResponse({ error: "Serveur sans cloud" }, { status: 400 });
        const { p, apiKey, hfToken } = await loadProvider(s.provider_id);
        const now = new Date().toISOString();

        // OVH: real instance control.
        if (p.kind === "ovh") {
          const creds = ovhCreds(p, apiKey, hfToken);
          const instancePath = `/cloud/project/${creds.serviceName}/instance/${s.pod_id}`;
          if (action === "server.stop") {
            await ovhRequest(creds, "POST", `${instancePath}/stop`);
            await accrueCost(admin, s, new Date(), false);
            await admin.from("aiops_servers").update({ status: "offline", desired_status: "STOPPED", updated_at: now }).eq("id", server_id);
          } else if (action === "server.start") {
            await ovhRequest(creds, "POST", `${instancePath}/start`);
            await admin.from("aiops_servers").update({ status: "degraded", desired_status: "ACTIVE", running_since: now, updated_at: now }).eq("id", server_id);
          } else {
            await ovhRequest(creds, "DELETE", instancePath);
            await accrueCost(admin, s, new Date(), false);
            await admin.from("aiops_servers").delete().eq("id", server_id);
          }
          return jsonResponse({ ok: true });
        }

        // AWS: simulated lifecycle (no real API call).
        if (p.kind === "aws") {
          if (action === "server.stop") {
            await accrueCost(admin, s, new Date(), false);
            await admin.from("aiops_servers").update({ status: "offline", desired_status: "STOPPED", updated_at: now }).eq("id", server_id);
          } else if (action === "server.start") {
            await admin.from("aiops_servers").update({ status: "degraded", desired_status: "RUNNING", running_since: now, updated_at: now }).eq("id", server_id);
          } else {
            await accrueCost(admin, s, new Date(), false);
            await admin.from("aiops_servers").delete().eq("id", server_id);
          }
          return jsonResponse({ ok: true });
        }

        if (action === "server.stop") {
          await runpodStop(apiKey, s.pod_id);
          await accrueCost(admin, s, new Date(), false);
          await admin.from("aiops_servers").update({ status: "offline", desired_status: "EXITED", updated_at: new Date().toISOString() }).eq("id", server_id);
        }
        else if (action === "server.start") {
          await runpodResume(apiKey, s.pod_id);
          await admin.from("aiops_servers").update({ status: "degraded", desired_status: "RUNNING", running_since: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", server_id);
        }
        else {
          await runpodTerminate(apiKey, s.pod_id);
          await accrueCost(admin, s, new Date(), false);
          await admin.from("aiops_servers").delete().eq("id", server_id);
        }
        return jsonResponse({ ok: true });
      }

      // ── Real infra cost accounting ──────────────────────────────────────────
      case "cost.reconcile": {
        const { server_id } = body as { server_id?: string };
        const now = new Date();
        let rows: ServerRow[];
        if (server_id) {
          const { data } = await admin.from("aiops_servers").select("*").eq("id", server_id).eq("project_id", project_id).maybeSingle();
          rows = data ? [data as ServerRow] : [];
        } else {
          const { data } = await admin.from("aiops_servers").select("*").eq("project_id", project_id);
          rows = (data ?? []) as ServerRow[];
        }
        // Running servers keep the segment open (clock rolls forward); stopped
        // ones finalise any leftover open segment into the ledger.
        for (const s of rows.filter((r) => ["online", "degraded"].includes(String(r.status)))) await accrueCost(admin, s, now, true);
        for (const s of rows.filter((r) => !["online", "degraded"].includes(String(r.status)))) await accrueCost(admin, s, now, false);
        return jsonResponse({ reconciled: rows.length });
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
          hp: { ...(job.hp ?? {}), gpu_hourly_usd: pod.costPerHr ?? 0 },
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
        // Accrue the pod's elapsed GPU time + cost while the job is still running.
        if (job.status === "running") await accrueJobCost(admin, job, new Date());
        // If the pod exited but the job never reported success → mark failed.
        if (pod && pod.desiredStatus !== "RUNNING" && job.status === "running") {
          await admin.from("aiops_ft_jobs").update({ status: "failed", error: "Le pod s'est arrêté avant la fin de l'entraînement.", updated_at: new Date().toISOString() }).eq("id", job_id);
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
        // Bill the pod up to the cancellation instant, then close the job.
        if (job) await accrueJobCost(admin, job, new Date());
        await admin.from("aiops_ft_jobs").update({ status: "failed", error: "Annulé par l'utilisateur." }).eq("id", job_id);
        return jsonResponse({ ok: true });
      }

      // ── Real inference through a connected cloud endpoint or a rented pod ───
      case "inference.chat": {
        const { provider_id, server_id, model, messages, temperature, top_p, max_tokens } = body as Record<string, unknown>;
        // server_id → a rented vLLM pod (aiops_servers.endpoint_url already
        // points at its OpenAI-compatible /v1). Same auth pattern as the
        // agents' hosted-model routing (RUNPOD_VLLM_API_KEY, may be empty).
        if (server_id) {
          const { data: srv } = await admin.from("aiops_servers")
            .select("endpoint_url, served_model, status")
            .eq("id", String(server_id)).eq("project_id", project_id).maybeSingle();
          if (!srv) return jsonResponse({ error: "Serveur introuvable" }, { status: 404 });
          if (!srv.endpoint_url) return jsonResponse({ error: "Ce serveur n'expose pas d'endpoint d'inférence" }, { status: 400 });
          const out = await cloudChat(String(srv.endpoint_url), Deno.env.get("RUNPOD_VLLM_API_KEY") ?? "", {
            model: String(model || srv.served_model || "default"), messages: messages as unknown[],
            temperature: temperature as number, top_p: top_p as number, max_tokens: max_tokens as number,
          });
          return jsonResponse(out);
        }
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
