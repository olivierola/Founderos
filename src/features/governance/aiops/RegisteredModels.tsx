import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus,
  TrashIcon as Trash2,
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
  WarningIcon as AlertTriangle,
  CloudIcon as Cloud,
  HardDrivesIcon as Server,
  ArrowSquareOutIcon as ExternalLink,
  PathIcon as Route,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";

// Company-registered models: bring-your-own cloud API (key) or a custom
// OpenAI-compatible endpoint. Backed by aiops_providers (kind cloud_endpoint) —
// aiops-infra tests the key and discovers the available models. Agents then pick
// one of these in their settings (or keep the Agent company default).

interface ProviderRow {
  id: string; kind: string; name: string;
  config: { base_url?: string; model_routes?: Record<string, string>; manual_models?: string[] } | null;
  status: string; status_detail: string | null;
  metadata: { models?: string[] } | null;
}

/**
 * Les routes d'un connecteur : un modèle par palier et par critère. Le runtime
 * choisit la route d'après la requête (palier, puis code / vision / long
 * contexte détectés) et retombe sur le palier, puis sur « Moyen », quand un
 * critère n'a pas de modèle. Même table côté serveur (ROUTE_KEYS, llm-upstream).
 */
const ROUTES: Array<{ key: string; label: string; hint: string }> = [
  { key: "light", label: "Léger", hint: "Salutations, réponses courtes, appels rapides." },
  { key: "standard", label: "Moyen (défaut)", hint: "Le travail courant : outils, rédaction, recherche." },
  { key: "heavy", label: "Lourd", hint: "Raisonnement, analyse, plans complexes — et l'escalade quand un run bloque." },
  { key: "code", label: "Code", hint: "Écrire, corriger ou relire du code, du SQL, une config." },
  { key: "vision", label: "Vision", hint: "Lire une image ou une capture jointe à la demande." },
  { key: "long_context", label: "Long contexte", hint: "Gros documents, transcrits très longs." },
  { key: "image", label: "Génération d'images", hint: "L'outil generate_image des agents." },
  { key: "judge", label: "Juges & extraction", hint: "Classements, contrats de réussite, extraction JSON — un petit modèle suffit." },
];

// OpenAI-compatible cloud presets — base_url filled in so the company only has
// to paste a key. `keysUrl` is where that key is issued; pointing everyone at
// OpenAI's page (as this used to) is useless for the other seven.
interface CloudPreset { id: string; label: string; base_url: string; example: string; keysUrl: string; keyPrefix: string }
const CLOUD_PRESETS: CloudPreset[] = [
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", example: "gpt-4o", keysUrl: "https://platform.openai.com/api-keys", keyPrefix: "sk-…" },
  { id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com/v1", example: "claude-sonnet-4-5", keysUrl: "https://console.anthropic.com/settings/keys", keyPrefix: "sk-ant-…" },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", example: "deepseek-chat", keysUrl: "https://platform.deepseek.com/api_keys", keyPrefix: "sk-…" },
  { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", example: "llama-3.3-70b-versatile", keysUrl: "https://console.groq.com/keys", keyPrefix: "gsk_…" },
  { id: "mistral", label: "Mistral", base_url: "https://api.mistral.ai/v1", example: "mistral-large-latest", keysUrl: "https://console.mistral.ai/api-keys", keyPrefix: "…" },
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", example: "anthropic/claude-sonnet-4.5", keysUrl: "https://openrouter.ai/keys", keyPrefix: "sk-or-…" },
  // Runware n'expose pas de catalogue /models : les identifiants AIR se
  // saisissent ici, ou directement dans les modèles par tâche.
  { id: "runware", label: "Runware", base_url: "https://api.runware.ai/v1", example: "openai:gpt@5.4-mini, google:gemini@3.5-flash", keysUrl: "https://runware.ai", keyPrefix: "…" },
  { id: "together", label: "Together AI", base_url: "https://api.together.xyz/v1", example: "meta-llama/Llama-3.3-70B-Instruct-Turbo", keysUrl: "https://api.together.ai/settings/api-keys", keyPrefix: "…" },
  { id: "fireworks", label: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", example: "accounts/fireworks/models/llama-v3p3-70b-instruct", keysUrl: "https://fireworks.ai/account/api-keys", keyPrefix: "fw_…" },
  { id: "cerebras", label: "Cerebras", base_url: "https://api.cerebras.ai/v1", example: "llama-3.3-70b", keysUrl: "https://cloud.cerebras.ai/platform", keyPrefix: "csk-…" },
  { id: "xai", label: "xAI (Grok)", base_url: "https://api.x.ai/v1", example: "grok-4", keysUrl: "https://console.x.ai", keyPrefix: "xai-…" },
  { id: "gemini", label: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", example: "gemini-2.5-flash", keysUrl: "https://aistudio.google.com/apikey", keyPrefix: "AIza…" },
  // Azure's v1 API takes the key as a Bearer and the deployment name as `model`.
  // Its /models lists base models, not deployments: the deployment goes in the
  // model ids field.
  { id: "azure", label: "Azure OpenAI", base_url: "", example: "nom-de-votre-deploiement", keysUrl: "https://portal.azure.com", keyPrefix: "…" },
];

export function RegisteredModels() {
  const confirm = useConfirm();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [routing, setRouting] = useState<ProviderRow | null>(null);

  const { data: providers, isLoading } = useQuery({
    queryKey: ["aiops_registered_models", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_providers_public")
        .select("id, kind, name, config, status, status_detail, metadata")
        .eq("project_id", projectId!).eq("kind", "cloud_endpoint")
        .order("created_at", { ascending: false });
      return (data ?? []) as ProviderRow[];
    },
  });

  async function remove(id: string) {
    if (!(await confirm("Supprimer ce modèle ? Les agents qui l'utilisent repasseront au modèle par défaut."))) return;
    await supabase.from("aiops_providers").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["aiops_registered_models", projectId] });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-primary" /> Vos modèles
          <span className="text-xs font-normal text-muted-foreground">vos propres APIs cloud ou endpoints, choisissez ce que vos agents utilisent</span>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Ajouter un modèle</Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : (providers ?? []).length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <Cloud className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm font-medium">Aucun modèle enregistré</p>
          <p className="max-w-md text-xs text-muted-foreground">Ajoutez un modèle cloud (avec sa clé API) ou un endpoint personnalisé pour que vos agents l'utilisent à la place du modèle par défaut Agent company.</p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(providers ?? []).map((p) => (
            <Card key={p.id} className="group p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Server className="h-[18px] w-[18px]" /></div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{p.config?.base_url}</div>
                  </div>
                </div>
                <button onClick={() => remove(p.id)} className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {p.status === "connected" ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3" /> connecté · {(p.metadata?.models ?? []).length} modèle{(p.metadata?.models ?? []).length > 1 ? "s" : ""}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400" title={p.status_detail ?? ""}><AlertTriangle className="h-3 w-3" /> {p.status_detail ? "erreur" : p.status}</span>
                )}
              </div>
              {/* A connected endpoint can still carry a note (no catalogue to
                  list) — it is actionable, so it belongs on the card, not in a
                  tooltip. */}
              {p.status === "connected" && p.status_detail && (
                <p className="mt-1.5 text-[10px] leading-snug text-amber-600 dark:text-amber-400">{p.status_detail}</p>
              )}
              {p.status !== "connected" && p.status_detail && (
                <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">{p.status_detail}</p>
              )}

              {/* Les modèles par tâche : ce que le runtime choisit selon la requête. */}
              <div className="mt-3 border-t border-border/60 pt-2.5">
                {Object.keys(p.config?.model_routes ?? {}).length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {ROUTES.filter((r) => p.config?.model_routes?.[r.key]).map((r) => (
                      <span key={r.key} title={p.config!.model_routes![r.key]} className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground">{r.label}</span> · {p.config!.model_routes![r.key]!.split(",")[0]}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">Un seul modèle pour tout — choisissez-en un par tâche pour que l'agent prenne le bon à chaque requête.</p>
                )}
                <button
                  type="button"
                  onClick={() => setRouting(p)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  <Route className="h-3.5 w-3.5" /> Modèles par tâche
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {routing && (
        <ModelRoutesDialog
          provider={routing}
          onClose={() => setRouting(null)}
          onSaved={() => { setRouting(null); queryClient.invalidateQueries({ queryKey: ["aiops_registered_models", projectId] }); }}
        />
      )}

      <AddModelDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={() => queryClient.invalidateQueries({ queryKey: ["aiops_registered_models", projectId] })}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

/**
 * Les modèles d'un connecteur, par tâche. Chaque champ accepte un identifiant
 * de modèle, ou plusieurs séparés par des virgules : le premier sert, les
 * suivants sont des replis (natifs chez OpenRouter). Un champ vide : la tâche
 * retombe sur son palier, puis sur « Moyen », puis sur le modèle de l'agent.
 */
function ModelRoutesDialog({ provider, onClose, onSaved }: {
  provider: ProviderRow; onClose: () => void; onSaved: () => void;
}) {
  const known = provider.metadata?.models ?? [];
  const [routes, setRoutes] = useState<Record<string, string>>(() => ({ ...(provider.config?.model_routes ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = `routes-models-${provider.id}`;

  async function save() {
    setSaving(true); setError(null);
    try {
      const clean: Record<string, string> = {};
      for (const r of ROUTES) {
        const v = (routes[r.key] ?? "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
        if (v) clean[r.key] = v;
      }
      const { error: err } = await supabase.from("aiops_providers")
        .update({ config: { ...(provider.config ?? {}), model_routes: clean }, updated_at: new Date().toISOString() })
        .eq("id", provider.id);
      if (err) throw err;
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Modèles par tâche · {provider.name}</DialogTitle></DialogHeader>
        <p className="-mt-1 text-xs text-muted-foreground">
          À chaque requête, l'agent prend le modèle qui correspond : son palier (léger, moyen, lourd), et le critère
          détecté (code, vision, long contexte). Plusieurs modèles séparés par des virgules servent de replis.
        </p>
        <datalist id={listId}>{known.map((m) => <option key={m} value={m} />)}</datalist>
        <div className="max-h-[56vh] space-y-2.5 overflow-y-auto pr-1">
          {ROUTES.map((r) => (
            <div key={r.key} className="grid grid-cols-[132px_1fr] items-start gap-2">
              <div className="pt-1.5">
                <div className="text-[12.5px] font-medium">{r.label}</div>
                <div className="text-[10.5px] leading-snug text-muted-foreground">{r.hint}</div>
              </div>
              <Input
                list={listId}
                value={routes[r.key] ?? ""}
                onChange={(e) => setRoutes((prev) => ({ ...prev, [r.key]: e.target.value }))}
                placeholder={r.key === "standard" ? "modèle par défaut de l'agent" : "— hérite du palier —"}
                className="h-8 text-[12.5px]"
              />
            </div>
          ))}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Enregistrer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddModelDialog({
  open, onOpenChange, onAdded, workspaceId, projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => void;
  workspaceId: string | null | undefined;
  projectId: string | null | undefined;
}) {
  const [mode, setMode] = useState<"cloud" | "custom">("cloud");
  const [preset, setPreset] = useState(CLOUD_PRESETS[0]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manualModels, setManualModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Azure (and any preset with no fixed host) needs its own URL typed in.
  const presetNeedsUrl = mode === "cloud" && !preset.base_url;
  const resolvedBaseUrl = mode === "cloud" && preset.base_url ? preset.base_url : baseUrl.trim();
  const resolvedName = name.trim() || (mode === "cloud" ? preset.label : "");

  async function submit() {
    setError(null);
    if (!workspaceId || !projectId) return;
    if (!resolvedBaseUrl) { setError("Endpoint (base URL) requis."); return; }
    if (mode === "cloud" && !apiKey.trim()) { setError("Clé API requise."); return; }
    if (!resolvedName) { setError("Nom requis."); return; }
    setSaving(true);
    try {
      const res = await callEdge<{ provider?: { status?: string; status_detail?: string } }>("aiops-infra", {
        action: "provider.connect",
        workspace_id: workspaceId, project_id: projectId,
        kind: "cloud_endpoint",
        name: resolvedName,
        config: {
          base_url: resolvedBaseUrl,
          // Used only when the endpoint exposes no /models catalogue.
          manual_models: manualModels.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        },
        // A private endpoint may have no auth at all — send nothing rather than
        // an empty string, which some servers reject as a malformed header.
        api_key: apiKey.trim() || undefined,
      });
      if (res.provider?.status === "error") {
        setError(res.provider.status_detail || "Connexion refusée par le fournisseur.");
        return; // keep the dialog open so the user can fix the key/endpoint
      }
      onAdded();
      onOpenChange(false);
      setName(""); setBaseUrl(""); setApiKey(""); setManualModels("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Ajouter un modèle</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1 rounded-full border border-border p-0.5 text-xs">
            {(["cloud", "custom"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={cn("flex-1 rounded-full px-3 py-1.5 font-medium transition-colors", mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
                {m === "cloud" ? "API cloud" : "Endpoint personnalisé"}
              </button>
            ))}
          </div>

          {mode === "cloud" ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Fournisseur</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {CLOUD_PRESETS.map((p) => (
                    <button key={p.id} onClick={() => setPreset(p)}
                      className={cn("truncate rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors", preset.id === p.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30")}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {preset.base_url && <p className="mt-1 truncate text-[11px] text-muted-foreground">{preset.base_url}</p>}
              </div>
              {presetNeedsUrl && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Endpoint de votre déploiement</label>
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mon-ressource.openai.azure.com/openai/v1" />
                  {preset.id === "azure" && (
                    <p className="mt-1 text-[11px] text-muted-foreground">Indiquez le nom de votre déploiement dans « Identifiants de modèles » ci-dessous.</p>
                  )}
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Clé API</label>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset.keyPrefix} />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Endpoint (OpenAI-compatible, …/v1)</label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mon-endpoint.example.com/v1" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Clé API <span className="text-muted-foreground/60">(optionnelle)</span></label>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="laisser vide si l'endpoint n'en demande pas" />
              </div>
            </>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Nom {mode === "cloud" && <span className="text-muted-foreground/60">(optionnel)</span>}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "cloud" ? preset.label : "Mon modèle"} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Identifiants de modèles <span className="text-muted-foreground/60">(optionnel)</span>
            </label>
            <Input value={manualModels} onChange={(e) => setManualModels(e.target.value)} placeholder={preset.example} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Séparés par des virgules. Utile uniquement si l'endpoint n'expose pas de catalogue <code>/models</code> sinon
              il est découvert automatiquement.
            </p>
          </div>

          <p className="text-[11px] text-muted-foreground">
            La clé est stockée chiffrée côté serveur (AES-256) et n'est jamais renvoyée au navigateur.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <a href={preset.keysUrl} target="_blank" rel="noopener noreferrer" className="mr-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              Où trouver ma clé {mode === "cloud" ? preset.label : ""} ? <ExternalLink className="h-3 w-3" />
            </a>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />} Ajouter & tester
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
