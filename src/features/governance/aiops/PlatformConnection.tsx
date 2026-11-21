import { useMemo, useState } from "react";
import {
  CheckIcon as Check,
  WarningIcon as AlertTriangle,
  CircleNotchIcon as Loader2,
  MagnifyingGlassIcon as Search,
  PlugsConnectedIcon as Plug,
} from "@phosphor-icons/react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  MODEL_ROUTES, PROVIDER_LABEL, primaryModel, shortModel, usePlatformModels, type PlatformModel,
} from "@/lib/platformModels";

// The platform's default connection: what every agent and the assistant run on
// until the company registers its own models below. Read-only here; each agent
// picks its own models per task in its settings (Cerveau → Modèles par tâche).

export function PlatformConnection({ className }: { className?: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { data, isLoading } = usePlatformModels(workspaceId, projectId);
  const [browsing, setBrowsing] = useState(false);

  const provider = data?.provider ? PROVIDER_LABEL[data.provider] ?? data.provider : null;
  const textCount = (data?.models ?? []).filter((m) => m.output.includes("text")).length;
  const imageCount = (data?.models ?? []).filter((m) => m.output.includes("image") && !m.output.includes("text")).length;

  return (
    <div className={className}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Plug className="h-4 w-4 text-primary" /> Connexion par défaut
        <span className="text-xs font-normal text-muted-foreground">ce que vos agents utilisent sans modèle à vous</span>
      </div>
      <Card className="p-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        ) : !data?.provider ? (
          <p className="text-sm text-muted-foreground">
            Aucune connexion par défaut configurée sur le serveur (OPENROUTER_API_KEY).
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-sm font-medium">{provider}</span>
              {data.connected && !data.error ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3" /> connecté</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400" title={data.error ?? ""}><AlertTriangle className="h-3 w-3" /> {data.error ? "erreur" : "non connecté"}</span>
              )}
              {data.free_only && (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Gratuits uniquement</span>
              )}
              {data.models.length > 0 && (
                <button
                  type="button" onClick={() => setBrowsing(true)}
                  className="ml-auto text-[12px] font-medium text-primary hover:underline"
                >
                  {textCount} modèle{textCount > 1 ? "s" : ""} de texte · {imageCount} d'image
                </button>
              )}
            </div>
            {data.error && <p className="mt-1.5 text-[11px] text-muted-foreground">{data.error}</p>}

            <div className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {MODEL_ROUTES.filter((r) => data.routes[r.key]).map((r) => (
                <div key={r.key} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                  <span className="w-24 shrink-0 text-muted-foreground">{r.label}</span>
                  <span className="truncate font-mono text-[11.5px]" title={data.routes[r.key]}>{shortModel(primaryModel(data.routes[r.key]))}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Chaque agent peut choisir ses propres modèles par type de tâche dans ses réglages.
            </p>
          </>
        )}
      </Card>
      {browsing && data && (
        <PlatformModelsDialog models={data.models} freeOnly={data.free_only} onClose={() => setBrowsing(false)} />
      )}
    </div>
  );
}

function PlatformModelsDialog({ models, freeOnly, onClose }: { models: PlatformModel[]; freeOnly: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"text" | "image">("text");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return models
      .filter((m) => (kind === "image" ? m.output.includes("image") && !m.output.includes("text") : m.output.includes("text")))
      .filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }, [models, q, kind]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Modèles disponibles{freeOnly ? " · gratuits" : ""}</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="h-8 pl-8 text-[12.5px]" />
          </div>
          <div className="flex gap-1 rounded-full border border-border p-0.5 text-xs">
            {(["text", "image"] as const).map((k) => (
              <button
                key={k} type="button" onClick={() => setKind(k)}
                className={cn("rounded-full px-3 py-1 font-medium transition-colors", kind === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                {k === "text" ? "Texte" : "Images"}
              </button>
            ))}
          </div>
        </div>
        <ul className="scrollbar-hide max-h-[56vh] divide-y divide-border/60 overflow-y-auto">
          {list.map((m) => (
            <li key={m.id} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] font-medium">{m.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {m.free ? "gratuit" : m.price_in != null ? `${m.price_in} $ / ${m.price_out ?? 0} $ par M` : ""}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                <span className="font-mono">{m.id}</span>
                {m.context_length ? <span>{Math.round(m.context_length / 1000)}k contexte</span> : null}
                {m.tools && <span>outils</span>}
                {m.input.includes("image") && m.output.includes("text") && <span>vision</span>}
                {m.expires && <span className="text-amber-600 dark:text-amber-400">retiré le {new Date(m.expires).toLocaleDateString("fr-FR")}</span>}
              </div>
            </li>
          ))}
          {list.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">Aucun modèle</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
