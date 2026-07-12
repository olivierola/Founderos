import { useState } from "react";
import { Cloud, Server, Plug, Plus, Loader2, Check, AlertTriangle, RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Pill, Field, Select } from "../ui";
import { SELF_HOSTED_MODELS } from "./data";
import { useProvidersDb, useInfraActions, type Provider, type RunpodGpu } from "./infra";

export function ProvidersPanel() {
  const { providers, loading, connect, test, remove, runpodProviders } = useProvidersDb();
  const [connecting, setConnecting] = useState(false);
  const [renting, setRenting] = useState(false);
  const [platformBusy, setPlatformBusy] = useState(false);
  const [platformErr, setPlatformErr] = useState<string | null>(null);

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
        <span className="text-xs text-muted-foreground">— vos modèles sur un endpoint cloud, ou des GPU loués sur RunPod</span>
        <div className="ml-auto flex gap-2">
          {!hasPlatformRunpod && (
            <Button size="sm" variant="outline" disabled={platformBusy} onClick={connectPlatform} title="Utilise la clé RunPod configurée au niveau de la plateforme">
              {platformBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Server className="mr-1.5 h-3.5 w-3.5 text-violet-500" />}
              Connecter RunPod (plateforme)
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={runpodProviders.length === 0} onClick={() => setRenting(true)}>
            <Zap className="mr-1.5 h-3.5 w-3.5" />Louer un GPU
          </Button>
          <Button size="sm" onClick={() => setConnecting(true)}><Plus className="mr-1.5 h-4 w-4" />Connecter</Button>
        </div>
      </div>
      {platformErr && <p className="border-b border-border/60 bg-red-500/5 px-5 py-2 text-xs text-red-500">{platformErr}</p>}

      {loading ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Chargement…</p>
      ) : providers.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          Aucun fournisseur connecté. Connectez un <span className="font-medium text-foreground">endpoint cloud</span> (vos modèles, OpenAI-compatible)
          ou une clé <span className="font-medium text-foreground">RunPod</span> pour louer des GPU à la demande.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {providers.map((p) => <ProviderRow key={p.id} p={p} onTest={() => test(p.id)} onRemove={() => { if (confirm(`Déconnecter ${p.name} ?`)) void remove(p.id); }} />)}
        </div>
      )}

      {connecting && <ConnectDialog onClose={() => setConnecting(false)} onConnect={connect} />}
      {renting && <RentDialog providers={runpodProviders} onClose={() => setRenting(false)} />}
    </Card>
  );
}

function ProviderRow({ p, onTest, onRemove }: { p: Provider; onTest: () => Promise<unknown>; onRemove: () => void }) {
  const [testing, setTesting] = useState(false);
  const Icon = p.kind === "cloud_endpoint" ? Cloud : Server;
  const models = p.metadata.models ?? [];
  const gpus = p.metadata.gpus ?? [];
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", p.kind === "cloud_endpoint" ? "bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]" : "bg-violet-500/10 text-violet-500")}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{p.name}</span>
          <Pill meta={p.kind === "cloud_endpoint" ? { label: "Endpoint cloud", tone: "cyan" } : { label: "RunPod", tone: "violet" }} className="px-1.5 py-0 text-[10px]" />
          {p.status === "connected" ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500"><Check className="h-3 w-3" />connecté</span>
            : p.status === "error" ? <span className="inline-flex items-center gap-1 text-[11px] text-red-500"><AlertTriangle className="h-3 w-3" />erreur</span>
            : <span className="text-[11px] text-muted-foreground">en attente</span>}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {p.kind === "cloud_endpoint"
            ? `${p.config.base_url ?? ""} · ${models.length} modèle${models.length > 1 ? "s" : ""}${models.length ? " : " + models.slice(0, 3).join(", ") : ""}`
            : `${gpus.length} types de GPU disponibles${gpus[0] ? ` · dès $${gpus[0].hourlyUsd}/h` : ""}`}
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

function ConnectDialog({ onClose, onConnect }: { onClose: () => void; onConnect: (kind: "cloud_endpoint" | "runpod", name: string, apiKey: string, config: Record<string, unknown>, hfToken?: string) => Promise<unknown> }) {
  const [kind, setKind] = useState<"cloud_endpoint" | "runpod">("cloud_endpoint");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await onConnect(kind, name || (kind === "runpod" ? "RunPod" : "Endpoint cloud"), apiKey, kind === "cloud_endpoint" ? { base_url: baseUrl } : {}, kind === "runpod" ? hfToken || undefined : undefined);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec"); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Connecter un fournisseur de calcul</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setKind("cloud_endpoint")} className={cn("rounded-lg border p-3 text-left transition-colors", kind === "cloud_endpoint" ? "border-[hsl(var(--accent-teal)/0.6)] bg-[hsl(var(--accent-teal)/0.08)]" : "border-border hover:bg-muted/40")}>
              <Cloud className="h-4 w-4 text-[hsl(var(--accent-teal))]" />
              <div className="mt-1 text-sm font-medium">Endpoint cloud</div>
              <div className="text-[11px] text-muted-foreground">Vos modèles déjà hébergés (OpenAI-compatible)</div>
            </button>
            <button onClick={() => setKind("runpod")} className={cn("rounded-lg border p-3 text-left transition-colors", kind === "runpod" ? "border-violet-500/60 bg-violet-500/8" : "border-border hover:bg-muted/40")}>
              <Server className="h-4 w-4 text-violet-500" />
              <div className="mt-1 text-sm font-medium">RunPod</div>
              <div className="text-[11px] text-muted-foreground">Louer des GPU à la demande</div>
            </button>
          </div>

          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "runpod" ? "RunPod prod" : "vLLM interne"} /></Field>
          {kind === "cloud_endpoint" && (
            <Field label="Base URL (OpenAI-compatible)" hint="ex : https://votre-serveur/v1 ou https://api.together.xyz/v1">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
            </Field>
          )}
          <Field
            label={kind === "runpod" ? "Clé API RunPod (optionnel)" : "Clé API"}
            hint={kind === "runpod" ? "laissez vide pour utiliser la clé RunPod de la plateforme — sinon chiffrée au repos (AES-256)" : "chiffrée au repos (AES-256) — jamais renvoyée au navigateur"}
          >
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={kind === "runpod" ? "rp_… (ou vide = clé plateforme)" : "sk-…"} />
          </Field>
          {kind === "runpod" && (
            <Field label="Token Hugging Face (optionnel)" hint="requis pour entraîner sur des modèles gated (Llama, Gemma) — chiffré aussi">
              <Input type="password" value={hfToken} onChange={(e) => setHfToken(e.target.value)} placeholder="hf_…" />
            </Field>
          )}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={busy || (kind === "cloud_endpoint" && (!apiKey || !baseUrl))}>
            {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Test & connexion…</> : "Connecter & tester"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RentDialog({ providers, onClose }: { providers: Provider[]; onClose: () => void }) {
  const { rent } = useInfraActions();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const gpus: RunpodGpu[] = provider?.metadata.gpus ?? [];
  const [gpuId, setGpuId] = useState(gpus[0]?.id ?? "");
  const [model, setModel] = useState(SELF_HOSTED_MODELS[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const gpu = gpus.find((g) => g.id === gpuId) ?? gpus[0];
  // A HuggingFace repo the vLLM image can pull for the chosen catalog model.
  const HF: Record<string, string> = {
    "llama-4-maverick": "meta-llama/Llama-3.3-70B-Instruct", "mistral-small-3.2": "mistralai/Mistral-Small-Instruct-2409",
    "qwen3-32b": "Qwen/Qwen2.5-32B-Instruct", "deepseek-r1-distill": "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
    "glm-4.5-air": "THUDM/glm-4-9b-chat", "gemma-3-27b": "google/gemma-2-27b-it",
  };

  const submit = async () => {
    if (!provider || !gpu) return;
    setBusy(true); setErr(null);
    try {
      await rent({ providerId: provider.id, gpuTypeId: gpu.id, gpuLabel: gpu.name, modelArg: HF[model] });
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : "Échec de la location"); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Louer un serveur GPU (RunPod)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {providers.length > 1 && (
            <Field label="Compte RunPod">
              <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="GPU" hint="prix à la demande, les moins chers en premier">
            <Select value={gpuId} onChange={(e) => setGpuId(e.target.value)}>
              {gpus.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.memoryGb} GB · ${g.hourlyUsd}/h</option>)}
            </Select>
          </Field>
          <Field label="Modèle à servir" hint="déployé avec vLLM (endpoint OpenAI-compatible sur le port 8000)">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {SELF_HOSTED_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.sizeGB} GB)</option>)}
            </Select>
          </Field>
          {gpu && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
              Estimation : <span className="font-medium text-foreground">${gpu.hourlyUsd}/h</span> ≈ <span className="font-medium text-foreground">${(gpu.hourlyUsd * 24).toFixed(2)}/jour</span> tant que le pod tourne. Vous pourrez l'arrêter à tout moment.
            </div>
          )}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={busy || !gpu}>
            {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Création du pod…</> : "Louer & déployer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
