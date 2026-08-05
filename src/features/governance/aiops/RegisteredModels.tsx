import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Loader2, Check, AlertTriangle, Cloud, Server, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// Company-registered models: bring-your-own cloud API (key) or a custom
// OpenAI-compatible endpoint. Backed by aiops_providers (kind cloud_endpoint) —
// aiops-infra tests the key and discovers the available models. Agents then pick
// one of these in their settings (or keep the AchiCorp default).

interface ProviderRow {
  id: string; kind: string; name: string;
  config: { base_url?: string } | null;
  status: string; status_detail: string | null;
  metadata: { models?: string[] } | null;
}

// OpenAI-compatible cloud presets — base_url filled in for the user.
const CLOUD_PRESETS: { id: string; label: string; base_url: string; example: string }[] = [
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", example: "gpt-4o" },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", example: "deepseek-chat" },
  { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", example: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", example: "anthropic/claude-3.5-sonnet" },
  { id: "together", label: "Together AI", base_url: "https://api.together.xyz/v1", example: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "mistral", label: "Mistral", base_url: "https://api.mistral.ai/v1", example: "mistral-large-latest" },
  { id: "xai", label: "xAI (Grok)", base_url: "https://api.x.ai/v1", example: "grok-2-latest" },
];

export function RegisteredModels() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

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
    if (!confirm("Supprimer ce modèle ? Les agents qui l'utilisent repasseront au modèle par défaut.")) return;
    await supabase.from("aiops_providers").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["aiops_registered_models", projectId] });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-primary" /> Vos modèles
          <span className="text-xs font-normal text-muted-foreground">— vos propres APIs cloud ou endpoints, choisissez ce que vos agents utilisent</span>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Ajouter un modèle</Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : (providers ?? []).length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <Cloud className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm font-medium">Aucun modèle enregistré</p>
          <p className="max-w-md text-xs text-muted-foreground">Ajoutez un modèle cloud (avec sa clé API) ou un endpoint personnalisé pour que vos agents l'utilisent à la place du modèle par défaut AchiCorp.</p>
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
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3" /> connecté · {(p.metadata?.models ?? []).length} modèles</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400" title={p.status_detail ?? ""}><AlertTriangle className="h-3 w-3" /> {p.status_detail ? "erreur" : p.status}</span>
                )}
              </div>
            </Card>
          ))}
        </div>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedBaseUrl = mode === "cloud" ? preset.base_url : baseUrl.trim();
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
        config: { base_url: resolvedBaseUrl },
        api_key: apiKey.trim() || undefined,
      });
      if (res.provider?.status === "error") {
        setError(res.provider.status_detail || "Connexion refusée par le fournisseur.");
        return; // keep the dialog open so the user can fix the key/endpoint
      }
      onAdded();
      onOpenChange(false);
      setName(""); setBaseUrl(""); setApiKey("");
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
                <div className="grid grid-cols-2 gap-1.5">
                  {CLOUD_PRESETS.map((p) => (
                    <button key={p.id} onClick={() => setPreset(p)}
                      className={cn("rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors", preset.id === p.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30")}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">{preset.base_url}</p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Clé API</label>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Endpoint (OpenAI-compatible, …/v1)</label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mon-endpoint.example.com/v1" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Clé API (optionnelle)</label>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="laisser vide si aucune" />
              </div>
            </>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Nom {mode === "cloud" && <span className="text-muted-foreground/60">(optionnel)</span>}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "cloud" ? preset.label : "Mon modèle"} />
          </div>

          <p className="text-[11px] text-muted-foreground">
            La clé est stockée chiffrée côté serveur et n'est jamais renvoyée au navigateur. Les modèles disponibles sont découverts automatiquement à la connexion.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="mr-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              Où trouver ma clé ? <ExternalLink className="h-3 w-3" />
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
