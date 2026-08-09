import { useEffect, useState } from "react";
import { Cloud, Server, Plug, Plus, Loader2, Check, AlertTriangle, RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Pill, Field, Select } from "../ui";
import { SELF_HOSTED_MODELS } from "./data";
import { useProvidersDb, useInfraActions, type Provider, type ProviderKind, type RunpodGpu, type OvhFlavor } from "./infra";

// Visual identity per provider kind (badges, icons, connection cards).
const KIND_META: Record<ProviderKind, { label: string; tone: "cyan" | "violet" | "blue"; Icon: typeof Cloud; bg: string; blurb: string }> = {
  cloud_endpoint: { label: "Endpoint cloud", tone: "cyan", Icon: Cloud, bg: "bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]", blurb: "Vos modèles déjà hébergés (OpenAI-compatible)" },
  runpod: { label: "RunPod", tone: "violet", Icon: Server, bg: "bg-violet-500/10 text-violet-500", blurb: "Louer des GPU à la demande" },
  ovh: { label: "OVHcloud", tone: "cyan", Icon: Cloud, bg: "bg-sky-500/10 text-sky-500", blurb: "Instances GPU réelles (Public Cloud)" },
  aws: { label: "AWS", tone: "blue", Icon: Cloud, bg: "bg-orange-500/10 text-orange-500", blurb: "Catalogue GPU · provisioning simulé" },
};

export function ProvidersPanel() {
  const { providers, loading, connect, test, remove, runpodProviders, ovhProviders, awsProviders, listGpus } = useProvidersDb();
  const [connecting, setConnecting] = useState(false);
  const [renting, setRenting] = useState(false);
  const [platformBusy, setPlatformBusy] = useState(false);
  const [platformErr, setPlatformErr] = useState<string | null>(null);

  const computeProviders = [...runpodProviders, ...ovhProviders, ...awsProviders];

  // One-click: register a keyless RunPod provider that resolves to the platform
  // RUNPOD_API_KEY secret at call time — no key entry.
  const hasPlatformRunpod = providers.some((p) => p.kind === "runpod" && (p.config as { uses_platform_key?: boolean }).uses_platform_key);
  async function connectPlatform() {
    setPlatformBusy(true); setPlatformErr(null);
    try { await connect("runpod", "RunPod (plateforme)", "", { uses_platform_key: true }); }
    catch (e) { setPlatformErr(e instanceof Error ? e.message : "Échec"); }
    finally { setPlatformBusy(false); }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3.5">
        <Plug className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Fournisseurs de calcul</span>
        <span className="text-xs text-muted-foreground">— endpoint cloud, GPU RunPod, OVHcloud ou AWS</span>
        <div className="ml-auto flex gap-2">
          {!hasPlatformRunpod && (
            <Button size="sm" variant="outline" disabled={platformBusy} onClick={connectPlatform} title="Utilise la clé RunPod configurée au niveau de la plateforme">
              {platformBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Server className="mr-1.5 h-3.5 w-3.5 text-violet-500" />}
              Connecter RunPod (plateforme)
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={computeProviders.length === 0} onClick={() => setRenting(true)}>
            <Zap className="mr-1.5 h-3.5 w-3.5" />Louer un GPU
          </Button>
          <Button size="sm" onClick={() => setConnecting(true)}><Plus className="mr-1.5 h-4 w-4" />Connecter</Button>
        </div>
      </div>
      {platformErr && <p className="border-b border-border/60 bg-red-500/5 px-5 py-2 text-xs text-red-500">{platformErr}</p>}

      {loading ? (
        <div className="space-y-2.5 px-5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-4 w-44" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : providers.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          Aucun fournisseur connecté. Connectez un <span className="font-medium text-foreground">endpoint cloud</span> (vos modèles, OpenAI-compatible),
          une clé <span className="font-medium text-foreground">RunPod</span>, un compte <span className="font-medium text-foreground">OVHcloud</span> ou
          <span className="font-medium text-foreground"> AWS</span> pour louer des GPU à la demande.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {providers.map((p) => <ProviderRow key={p.id} p={p} onTest={() => test(p.id)} onRemove={() => { if (confirm(`Déconnecter ${p.name} ?`)) void remove(p.id); }} />)}
        </div>
      )}

      {connecting && <ConnectDialog onClose={() => setConnecting(false)} onConnect={connect} />}
      {renting && <RentDialog providers={computeProviders} onClose={() => setRenting(false)} onRefreshGpus={listGpus} onTest={test} />}
    </Card>
  );
}

function ProviderRow({ p, onTest, onRemove }: { p: Provider; onTest: () => Promise<unknown>; onRemove: () => void }) {
  const [testing, setTesting] = useState(false);
  const meta = KIND_META[p.kind];
  const Icon = meta.Icon;
  const models = p.metadata.models ?? [];
  const gpus = p.metadata.gpus ?? [];
  const flavors = p.metadata.flavors ?? [];
  const detail = p.kind === "cloud_endpoint"
    ? `${p.config.base_url ?? ""} · ${models.length} modèle${models.length > 1 ? "s" : ""}${models.length ? " : " + models.slice(0, 3).join(", ") : ""}`
    : p.kind === "ovh"
      ? `${p.config.service_name ?? ""} · ${flavors.length} flavors GPU${flavors[0] ? ` · dès $${flavors[0].hourlyUsd}/h` : ""}`
      : p.kind === "aws"
        ? `${gpus.length} types d'instances${gpus[0] ? ` · dès $${gpus[0].hourlyUsd}/h` : ""} · provisioning simulé`
        : `${gpus.length} types de GPU disponibles${gpus[0] ? ` · dès $${gpus[0].hourlyUsd}/h` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", meta.bg)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{p.name}</span>
          <Pill meta={{ label: meta.label, tone: meta.tone }} className="px-1.5 py-0 text-[10px]" />
          {p.status === "connected" ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500"><Check className="h-3 w-3" />connecté</span>
            : p.status === "error" ? <span className="inline-flex items-center gap-1 text-[11px] text-red-500"><AlertTriangle className="h-3 w-3" />erreur</span>
            : <span className="text-[11px] text-muted-foreground">en attente</span>}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {detail}
          {p.status === "error" && p.statusDetail ? ` — ${p.statusDetail}` : ""}
        </div>
      </div>
      <Button size="icon" variant="ghost" className="h-7 w-7" title="Re-tester" onClick={async () => { setTesting(true); try { await onTest(); } finally { setTesting(false); } }}>
        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7" title="Déconnecter" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></Button>
    </div>
  );
}

function ConnectDialog({ onClose, onConnect }: { onClose: () => void; onConnect: (kind: ProviderKind, name: string, apiKey: string, config: Record<string, unknown>, secret2?: string) => Promise<unknown> }) {
  const [kind, setKind] = useState<ProviderKind>("cloud_endpoint");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [appKey, setAppKey] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [ovhRegion, setOvhRegion] = useState("eu");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const defaultName = { cloud_endpoint: "Endpoint cloud", runpod: "RunPod", ovh: "OVHcloud", aws: "AWS" }[kind];
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const cfg: Record<string, unknown> = kind === "cloud_endpoint" ? { base_url: baseUrl }
        : kind === "ovh" ? { service_name: serviceName, ovh_region: ovhRegion }
        : {};
      const key = kind === "ovh" ? appKey : kind === "aws" ? "" : apiKey;
      const secret2 = kind === "ovh" ? consumerKey : kind === "runpod" ? hfToken || undefined : undefined;
      await onConnect(kind, name || defaultName, key, cfg, secret2);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec"); } finally { setBusy(false); }
  };

  const disabled = kind === "cloud_endpoint" ? (!apiKey || !baseUrl)
    : kind === "ovh" ? (!appKey || !consumerKey || !serviceName)
    : false;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Connecter un fournisseur de calcul</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["cloud_endpoint", "runpod", "ovh", "aws"] as ProviderKind[]).map((k) => {
              const m = KIND_META[k];
              return (
                <button key={k} onClick={() => setKind(k)} className={cn("rounded-lg border p-3 text-left transition-colors", kind === k ? "border-[hsl(var(--accent-teal)/0.6)] bg-[hsl(var(--accent-teal)/0.08)]" : "border-border hover:bg-muted/40")}>
                  <m.Icon className={cn("h-4 w-4", k === "runpod" ? "text-violet-500" : k === "ovh" ? "text-sky-500" : k === "aws" ? "text-orange-500" : "text-[hsl(var(--accent-teal))]")} />
                  <div className="mt-1 text-sm font-medium">{m.label}</div>
                  <div className="text-[10px] leading-tight text-muted-foreground">{m.blurb}</div>
                </button>
              );
            })}
          </div>

          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} /></Field>
          {kind === "cloud_endpoint" && (
            <Field label="Base URL (OpenAI-compatible)" hint="ex : https://votre-serveur/v1 ou https://api.together.xyz/v1">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
            </Field>
          )}
          {kind === "cloud_endpoint" && (
            <Field label="Clé API" hint="chiffrée au repos (AES-256) — jamais renvoyée au navigateur">
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
            </Field>
          )}
          {kind === "runpod" && (
            <>
              <Field label="Clé API RunPod (optionnel)" hint="laissez vide pour utiliser la clé RunPod de la plateforme — sinon chiffrée au repos (AES-256)">
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="rp_… (ou vide = clé plateforme)" />
              </Field>
              <Field label="Token Hugging Face (optionnel)" hint="requis pour entraîner sur des modèles gated (Llama, Gemma) — chiffré aussi">
                <Input type="password" value={hfToken} onChange={(e) => setHfToken(e.target.value)} placeholder="hf_…" />
              </Field>
            </>
          )}
          {kind === "ovh" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Application Key" hint="créée sur api.ovh.com — chiffrée au repos">
                  <Input type="password" value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder="xxxxxxxxxxxx" />
                </Field>
                <Field label="Consumer Key" hint="générée par l'app — chiffrée au repos">
                  <Input type="password" value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxx" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="ID du projet Public Cloud" hint="visible dans l'interface OVH">
                  <Input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="e.g. scugmxahflsjabglodyv" />
                </Field>
                <Field label="Région API">
                  <Select value={ovhRegion} onChange={(e) => setOvhRegion(e.target.value)}>
                    <option value="eu">Europe (eu.api.ovhcloud.com)</option>
                    <option value="ca">Canada (ca.api.ovhcloud.com)</option>
                    <option value="us">USA (us.api.ovhcloud.com)</option>
                  </Select>
                </Field>
              </div>
            </>
          )}
          {kind === "aws" && (
            <p className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
              AWS est en <span className="font-medium text-foreground">mode catalogue</span> : on liste des types d'instances GPU réalistes et le
              provisioning est simulé — aucune instance AWS réelle n'est créée.
            </p>
          )}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={busy || disabled}>
            {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Test & connexion…</> : "Connecter & tester"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// VRAM footprint of a model on disk given a quantization — the vLLM server
// needs this much GPU memory to hold the weights (plus ~2 GB of KV cache).
const QUANT_VRAM_FACTOR: Record<string, number> = { none: 1, awq: 0.55, gptq: 0.6, fp8: 0.65 };
const QUANT_LABEL: Record<string, string> = { none: "FP16 (pleine précision)", awq: "AWQ (4-bit)", gptq: "GPTQ (4-bit)", fp8: "FP8" };
const AWS_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "eu-west-3"];
const RENT_KINDS: ProviderKind[] = ["runpod", "ovh", "aws"];

function RentDialog({ providers, onClose, onRefreshGpus, onTest }: {
  providers: Provider[]; onClose: () => void;
  onRefreshGpus: (providerId: string) => Promise<unknown>;
  onTest: (providerId: string) => Promise<unknown>;
}) {
  const { rent } = useInfraActions();
  const kinds = RENT_KINDS.filter((k) => providers.some((p) => p.kind === k));
  const [tab, setTab] = useState<ProviderKind>(kinds[0] ?? "runpod");
  const tabProviders = providers.filter((p) => p.kind === tab);
  const [providerId, setProviderId] = useState(tabProviders[0]?.id ?? "");
  useEffect(() => { setProviderId(tabProviders[0]?.id ?? ""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  const provider = tabProviders.find((p) => p.id === providerId) ?? tabProviders[0];

  // Shared model selection (vLLM) — same for every cloud.
  const [modelId, setModelId] = useState(SELF_HOSTED_MODELS[0]?.id ?? "");
  const [quant, setQuant] = useState("none");
  const model = SELF_HOSTED_MODELS.find((m) => m.id === modelId) ?? SELF_HOSTED_MODELS[0];
  const factor = QUANT_VRAM_FACTOR[quant] ?? 1;
  const vramNeeded = Math.ceil((model?.vramGb ?? 0) * factor);

  // RunPod tab state.
  const gpus: RunpodGpu[] = [...(provider?.metadata.gpus ?? [])].sort((a, b) => a.hourlyUsd - b.hourlyUsd);
  const [gpuId, setGpuId] = useState(gpus[0]?.id ?? "");
  const [cloud, setCloud] = useState<"secure" | "community">("secure");
  const [gpuCount, setGpuCount] = useState(1);
  const gpu = gpus.find((g) => g.id === gpuId) ?? gpus[0];
  const minCount = gpu ? Math.max(1, Math.ceil(vramNeeded / gpu.memoryGb)) : 1;
  useEffect(() => { setGpuCount((c) => Math.max(c, minCount)); }, [minCount]);

  // OVH tab state.
  const flavors: OvhFlavor[] = [...(provider?.metadata.flavors ?? [])].sort((a, b) => a.hourlyUsd - b.hourlyUsd);
  const [flavorId, setFlavorId] = useState(flavors[0]?.id ?? "");
  const flavor = flavors.find((f) => f.id === flavorId) ?? flavors[0];
  const [ovhRegion, setOvhRegion] = useState("");
  const region = flavor?.regions.includes(ovhRegion) ? ovhRegion : (flavor?.regions[0] ?? "");
  const images = (provider?.metadata.images ?? []).filter((i) => !region || i.regions.length === 0 || i.regions.includes(region));
  const [imageIdState, setImageIdState] = useState(images[0]?.id ?? "");
  const imageId = images.some((i) => i.id === imageIdState) ? imageIdState : (images[0]?.id ?? "");
  const sshKeys = provider?.metadata.ssh_keys ?? [];
  const [sshKeyId, setSshKeyId] = useState("");

  // AWS tab state.
  const awsRegions = AWS_REGIONS;
  const [awsRegion, setAwsRegion] = useState(awsRegions[0]);
  const [awsGpuId, setAwsGpuId] = useState(gpus[0]?.id ?? "");
  const awsGpu = gpus.find((g) => g.id === awsGpuId) ?? gpus[0];

  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hourly = tab === "runpod" ? (gpu ? gpu.hourlyUsd * gpuCount : 0)
    : tab === "ovh" ? (flavor?.hourlyUsd ?? 0)
    : (awsGpu?.hourlyUsd ?? 0);

  const refresh = async () => {
    if (!provider) return;
    setRefreshing(true); setErr(null);
    try { await (tab === "ovh" ? onTest(provider.id) : onRefreshGpus(provider.id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Refresh échoué"); }
    finally { setRefreshing(false); }
  };

  const submit = async () => {
    if (!provider) return;
    setBusy(true); setErr(null);
    try {
      const baseOpts = { providerId: provider.id, kind: tab as ProviderKind, modelArg: model?.hfRepo, quantization: quant === "none" ? undefined : quant, maxModelLen: model?.maxContextLen ?? undefined };
      if (tab === "runpod" && gpu) {
        await rent({ ...baseOpts, gpuTypeId: gpu.id, gpuLabel: gpu.name, gpuCount, cloudType: cloud });
      } else if (tab === "ovh" && flavor && imageId && region) {
        await rent({ ...baseOpts, flavorId: flavor.id, flavorLabel: flavor.name, flavorHourlyUsd: flavor.hourlyUsd, imageId, region, sshKeyId: sshKeyId || undefined });
      } else if (tab === "aws" && awsGpu) {
        await rent({ ...baseOpts, gpuTypeId: awsGpu.id, gpuLabel: awsGpu.name, flavorHourlyUsd: awsGpu.hourlyUsd, region: awsRegion });
      } else return;
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec de la location"); } finally { setBusy(false); }
  };

  const canSubmit = tab === "runpod" ? !!gpu
    : tab === "ovh" ? (!!flavor && !!imageId && !!region)
    : !!awsGpu;
  const submitLabel = tab === "ovh" ? "Créer l'instance" : tab === "aws" ? "Provisionner (simulé)" : "Louer & déployer";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Louer un serveur GPU</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {kinds.length > 1 && (
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border/60 p-1">
              {kinds.map((k) => (
                <button key={k} onClick={() => setTab(k)} className={cn("rounded-md px-2 py-1.5 text-xs font-medium transition-colors", tab === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
          )}
          {tabProviders.length > 1 && (
            <Field label={`Compte ${KIND_META[tab].label}`}>
              <Select value={provider?.id ?? ""} onChange={(e) => setProviderId(e.target.value)}>
                {tabProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Modèle à servir" hint="déployé avec vLLM (endpoint OpenAI-compatible sur le port 8000)">
                <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  {SELF_HOSTED_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label} · {m.sizeGB} GB{m.vramGb ? ` · ~${m.vramGb} GB VRAM` : ""}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-44">
              <Field label="Quantization" hint="réduit la VRAM, dégrade légèrement la qualité">
                <Select value={quant} onChange={(e) => setQuant(e.target.value)}>
                  {Object.keys(QUANT_VRAM_FACTOR).map((q) => <option key={q} value={q}>{QUANT_LABEL[q]}</option>)}
                </Select>
              </Field>
            </div>
          </div>

          {tab === "runpod" && (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="GPU" hint="prix à la demande — les moins chers d'abord">
                    <Select value={gpuId} onChange={(e) => setGpuId(e.target.value)}>
                      {gpus.map((g) => {
                        const needed = Math.ceil(vramNeeded / g.memoryGb);
                        const tooBig = needed > 8;
                        return (
                          <option key={g.id} value={g.id} disabled={tooBig}>
                            {g.name} · {g.memoryGb} GB · ${g.hourlyUsd}/h{needed > 1 ? ` · ${tooBig ? "VRAM insuffisante" : `${needed}× requis`}` : ""}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Nb GPU" hint={minCount > 1 ? `minimum ${minCount} (tensor-parallel)` : "recommandé : 1"}>
                    <Select value={gpuCount} onChange={(e) => setGpuCount(Number(e.target.value))}>
                      {[1, 2, 4, 8].filter((n) => n >= minCount).map((n) => <option key={n} value={n}>{n}×</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="w-36">
                  <Field label="Cloud" hint="community ≈ −60 % Secure">
                    <Select value={cloud} onChange={(e) => setCloud(e.target.value as "secure" | "community")}>
                      <option value="secure">Secure</option>
                      <option value="community">Community</option>
                    </Select>
                  </Field>
                </div>
              </div>
              {gpu && vramNeeded > 0 && (
                <p className="text-[11px] text-muted-foreground">VRAM : {vramNeeded} GB requis{vramNeeded > gpu.memoryGb * gpuCount ? ` → ${gpuCount}× ${gpu.name}` : ""}</p>
              )}
            </>
          )}

          {tab === "ovh" && (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="Flavor GPU" hint="le prix horaire inclut le GPU">
                    <Select value={flavorId} onChange={(e) => setFlavorId(e.target.value)}>
                      {flavors.map((f) => {
                        const tooSmall = vramNeeded > 0 && f.memoryGb < vramNeeded;
                        return (
                          <option key={f.id} value={f.id} disabled={tooSmall}>
                            {f.name} · {f.memoryGb} GB VRAM · {f.vcpus} vCPU/{f.ramGb} Go · ${f.hourlyUsd}/h{tooSmall ? " · VRAM insuffisante" : ""}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>
                </div>
                <div className="w-40">
                  <Field label="Région" hint="disponibilité du flavor">
                    <Select value={region} onChange={(e) => setOvhRegion(e.target.value)}>
                      {flavor?.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </Field>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="Image système" hint="cloud-init installe Docker + vLLM">
                    <Select value={imageId} onChange={(e) => setImageIdState(e.target.value)}>
                      {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="w-44">
                  <Field label="Clé SSH" hint="optionnelle — sans clé, le mot de passe root est envoyé par email">
                    <Select value={sshKeyId} onChange={(e) => setSshKeyId(e.target.value)}>
                      <option value="">— sans clé</option>
                      {sshKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                    </Select>
                  </Field>
                </div>
              </div>
              {!provider?.metadata.flavors?.length && (
                <p className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
                  Catalogue vide — vérifiez vos clés ou actualisez les prix.
                </p>
              )}
            </>
          )}

          {tab === "aws" && (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="Type d'instance" hint="catalogue — provisioning simulé">
                    <Select value={awsGpuId} onChange={(e) => setAwsGpuId(e.target.value)}>
                      {gpus.map((g) => {
                        const tooSmall = vramNeeded > 0 && g.memoryGb < vramNeeded;
                        return (
                          <option key={g.id} value={g.id} disabled={tooSmall}>
                            {g.id} · {g.name} · {g.memoryGb} GB VRAM · ${g.hourlyUsd}/h{tooSmall ? " · VRAM insuffisante" : ""}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>
                </div>
                <div className="w-44">
                  <Field label="Région">
                    <Select value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)}>
                      {awsRegions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </Field>
                </div>
              </div>
              <p className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
                Aucune instance AWS réelle n'est créée : le serveur passe au statut <span className="font-medium text-foreground">en ligne</span> après un
                délai de provisioning simulé, et la facturation est calculée au tarif horaire du type choisi.
              </p>
            </>
          )}

          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={refresh} disabled={refreshing || !provider} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Actualiser {tab === "ovh" ? "le catalogue" : "les prix"}
            </button>
            {hourly > 0 && (
              <span className="font-medium text-foreground">≈ ${hourly.toFixed(2)}/h · ${(hourly * 24).toFixed(2)}/jour</span>
            )}
          </div>
          {quant !== "none" && model && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
              {QUANT_LABEL[quant]} : {model.vramGb ?? 0} GB → ~{vramNeeded} GB de VRAM requise.
            </div>
          )}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={busy || !canSubmit || !provider}>
            {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Création…</> : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
