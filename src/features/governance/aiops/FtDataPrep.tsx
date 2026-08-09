import { useEffect, useMemo, useState } from "react";
import { Eraser, Sparkles, VenetianMask, ScanSearch, ChevronRight, Play } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Select } from "../ui";
import { DATA_PREP_FUNCTIONS } from "./data";
import { useFtDatasetsDb, useCleaningTicker, useFtSettingsDb } from "./db";

// Pipeline stages (spec): Raw → Deduplicate → Remove HTML → Fix Encoding →
// Normalize → Split → Chunk → Tokenize → Ready.
const STAGES = ["Raw Data", "Deduplicate", "Remove HTML", "Fix Encoding", "Normalize", "Split", "Chunk", "Tokenize", "Ready"];

// Function groups, each toggleable. Item names double as the persisted ids.
const GROUPS: { icon: typeof Eraser; title: string; color: string; items: string[] }[] = [
  { icon: Eraser, title: "Suppression", color: "text-red-500", items: ["Doublons", "Signatures", "Mails", "Publicités", "Scripts", "HTML"] },
  { icon: Sparkles, title: "Nettoyage IA", color: "text-[hsl(var(--accent-teal))]", items: ["Correction orthographique", "Uniformisation", "Reformulation"] },
  { icon: VenetianMask, title: "Anonymisation", color: "text-violet-500", items: ["Noms", "Emails", "Téléphones", "IBAN", "Cartes bancaires"] },
  { icon: ScanSearch, title: "Détection", color: "text-amber-500", items: ["Langues", "Qualité", "Documents incomplets"] },
];

export function GovFtDataPrepPage() {
  const { datasets, updateCleaning, loading } = useFtDatasetsDb();
  useCleaningTicker(datasets, updateCleaning);
  const { settings, save } = useFtSettingsDb();
  const [dsId, setDsId] = useState("");
  const ds = datasets.find((d) => d.id === dsId) ?? datasets[0];

  // Pipeline config persisted in the studio settings — read on load, written on
  // every toggle so the choice survives a reload (default: tout activé).
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(settings.dataPrepEnabled.length ? settings.dataPrepEnabled : DATA_PREP_FUNCTIONS));
  useEffect(() => {
    if (settings.dataPrepEnabled.length) setEnabled(new Set(settings.dataPrepEnabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dataPrepEnabled.join(",")]);
  const flip = (item: string) => setEnabled((prev) => {
    const n = new Set(prev);
    if (n.has(item)) n.delete(item); else n.add(item);
    void save({ ...settings, dataPrepEnabled: [...n] });
    return n;
  });

  if (loading) return <PageSkeleton cards={0} rows={7} />;
  if (!ds) return <EmptyState icon={ScanSearch} title="Aucun dataset" description="Importez un dataset dans l'onglet Datasets pour lancer le nettoyage." />;

  // Detection summary (Zendesk-style) derived from the dataset's cleaning stats.
  const dupPct = Math.round((ds.removed.dups / ds.before.rows) * 100);
  const incompletePct = Math.max(1, Math.round((ds.removed.html / ds.before.rows) * 100));
  const stageDone = ds.quality === "validated" ? STAGES.length : ds.quality === "cleaning" ? 5 : 7;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Preparation"
        description="Avant tout entraînement : déduplication, nettoyage IA, anonymisation et détection — pipeline automatique du brut au prêt-à-entraîner."
      />

      {/* Dataset selector + run */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Dataset :</span>
        <Select value={ds.id} onChange={(e) => setDsId(e.target.value)} className="h-9 w-72">
          {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Button size="sm" className="ml-auto" disabled={ds.quality === "cleaning"}
          onClick={() => {
            // Real restart: reset every step, first one running — the ticker does the rest.
            const steps = ds.cleaning.map((c, i) => ({ step: c.step, status: (i === 0 ? "running" : "pending") as typeof c.status }));
            void updateCleaning(ds, steps, "cleaning");
          }}>
          <Play className="mr-1.5 h-3.5 w-3.5" />{ds.quality === "cleaning" ? "Pipeline en cours…" : "Lancer le pipeline"}
        </Button>
      </div>

      {/* Pipeline visual */}
      <Card className="p-5">
        <div className="mb-4 text-sm font-medium">Pipeline</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STAGES.map((s, i) => {
            const done = i < stageDone;
            const current = i === stageDone;
            return (
              <div key={s} className="flex items-center gap-1.5">
                <span className={cn(
                  "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                  done ? "border-[hsl(var(--accent-teal)/0.5)] bg-[hsl(var(--accent-teal)/0.1)] text-foreground" :
                  current ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400 animate-pulse" :
                  "border-border bg-secondary/40 text-muted-foreground",
                  (s === "Raw Data" || s === "Ready") && "font-medium",
                )}>
                  {s}
                </span>
                {i < STAGES.length - 1 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
              </div>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-center">
            <div className="text-sm font-semibold tabular-nums text-red-500">{dupPct}%</div>
            <div className="text-[10px] text-muted-foreground">doublons détectés</div>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-center">
            <div className="text-sm font-semibold tabular-nums text-amber-500">{incompletePct}%</div>
            <div className="text-[10px] text-muted-foreground">documents incomplets</div>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-center">
            <div className="text-sm font-semibold tabular-nums">{ds.removed.emails}</div>
            <div className="text-[10px] text-muted-foreground">emails trouvés</div>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-center">
            <div className="text-sm font-semibold tabular-nums">{ds.removed.pii}</div>
            <div className="text-[10px] text-muted-foreground">PII anonymisées</div>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {ds.before.rows.toLocaleString("fr-FR")} lignes brutes → {ds.rows.toLocaleString("fr-FR")} lignes prêtes · tout est nettoyé automatiquement, les cas ambigus sont marqués « À revoir » dans Datasets.
        </p>
      </Card>

      {/* Function groups */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {GROUPS.map((g) => (
          <Card key={g.title} className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <g.icon className={cn("h-4 w-4", g.color)} /> {g.title}
            </div>
            <div className="space-y-2">
              {g.items.map((item) => {
                const on = enabled.has(item);
                return (
                  <label key={item} className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
                    <span className={cn(!on && "text-muted-foreground")}>{item}</span>
                    <button
                      onClick={() => flip(item)}
                      className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", on ? "bg-[hsl(var(--accent-teal))]" : "bg-muted")}
                      aria-pressed={on}
                    >
                      <span className={cn("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all", on ? "left-[15px]" : "left-0.5")} />
                    </button>
                  </label>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
