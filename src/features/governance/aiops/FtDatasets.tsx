import { useMemo, useEffect, useRef, useState } from "react";
import {
  Database, Upload, Eraser, ShieldCheck, CheckCircle2, Loader2, CircleAlert, Circle,
  Eye, Pencil, GitMerge, Trash2, ArrowDown,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Pill, FormDialog, type FieldDef } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  timeAgo, DS_QUALITY_META, CLEAN_STEP_META, DS_TYPE_META, IMPORT_PIPELINE,
  type FtDataset, type CleanStepStatus,
} from "./data";
import { useFtDatasetsDb, useCleaningTicker } from "./db";

const STEP_ICON: Record<CleanStepStatus, typeof CheckCircle2> = {
  done: CheckCircle2, running: Loader2, pending: Circle, flagged: CircleAlert,
};
const STEP_COLOR: Record<CleanStepStatus, string> = {
  done: "text-emerald-500", running: "text-blue-500 animate-spin", pending: "text-muted-foreground/50", flagged: "text-red-500",
};

const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${(n / 1000).toFixed(1)} k` : String(n));

export function GovFtDatasetsPage() {
  const { datasets, createFromUpload, remove, updateCleaning, updateMeta, merge } = useFtDatasetsDb();
  // Advance the cleaning pipeline of freshly imported datasets (real row updates).
  useCleaningTicker(datasets, updateCleaning);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const sel = useMemo(() => datasets.find((d) => d.id === selId) ?? null, [datasets, selId]);
  const [preview, setPreview] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);

  // Real preview: download the first lines of the imported file from Storage.
  useEffect(() => {
    if (!preview || !sel || !sel.storagePath) { setPreviewText(null); setPreviewLoading(false); return; }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase.storage.from("ft-datasets").createSignedUrl(sel.storagePath!, 60);
        if (cancelled) return;
        if (error || !data?.signedUrl) { setPreviewText(null); return; }
        const res = await fetch(data.signedUrl);
        const text = await res.text();
        if (cancelled) return;
        setPreviewText(text.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n"));
      } catch { if (!cancelled) setPreviewText(null); }
      finally { if (!cancelled) setPreviewLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [preview, sel]);

  const stats = useMemo(() => ({
    total: datasets.length,
    validated: datasets.filter((d) => d.quality === "validated").length,
    tokens: datasets.reduce((s, d) => s + d.tokens, 0),
  }), [datasets]);

  const editFields: FieldDef[] = [
    { key: "name", label: "Nom", required: true },
    { key: "version", label: "Version", half: true, placeholder: "v1" },
    { key: "lang", label: "Langue", half: true, placeholder: "FR" },
    { key: "tags", label: "Tags (séparés par des virgules)", placeholder: "support, ton de marque" },
  ];

  const edit = async (values: Record<string, unknown>) => {
    if (!sel) return;
    await updateMeta(sel, {
      name: String(values.name).trim() || sel.name,
      tags: String(values.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      lang: String(values.lang || "FR"),
      version: String(values.version || sel.version),
    });
  };

  const mergeFields: FieldDef[] = [
    { key: "other", label: "Fusionner avec…", type: "select", required: true,
      options: datasets.filter((d) => d.id !== sel?.id).map((d) => ({ value: d.id, label: d.name })) },
  ];

  const doMerge = async (values: Record<string, unknown>) => {
    const other = datasets.find((d) => d.id === String(values.other));
    if (sel && other) { await merge(sel, other); setSelId(null); setPreview(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datasets"
        description="Jeux de données d'entraînement — import multi-sources, nettoyage automatique (dédup, anonymisation, HTML, PII…), versionnés et tagués."
        actions={
          <>
            <input
              ref={fileRef} type="file" accept=".jsonl,.json,.csv,.txt" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void createFromUpload(f); e.target.value = ""; }}
            />
            <Button onClick={() => fileRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" />Importer</Button>
          </>
        }
      />

      {/* Sources supportées */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-muted-foreground">Sources :</span>
        {Object.entries(DS_TYPE_META).map(([k, m]) => (
          <span key={k} className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] text-muted-foreground">{m.label}</span>
        ))}
      </div>

      {/* Mécanique d'import */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="mr-1">Chaque import :</span>
        {IMPORT_PIPELINE.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="rounded bg-secondary px-1.5 py-0.5">{s}</span>
            {i < IMPORT_PIPELINE.length - 1 && <span className="text-muted-foreground/50">→</span>}
          </span>
        ))}
        <span className="text-muted-foreground/50">→</span>
        <span className="rounded bg-[hsl(var(--accent-teal)/0.12)] px-1.5 py-0.5 font-medium text-[hsl(var(--accent-teal))]">Dataset</span>
        <span className="ml-1">· docs, tokens, langue, qualité, doublons et données sensibles détectés automatiquement</span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Datasets" value={String(stats.total)} icon={Database} />
        <MetricCard label="Validés" value={`${stats.validated}/${stats.total}`} icon={ShieldCheck} hint="prêts pour l'entraînement" />
        <MetricCard label="Tokens" value={fmtK(stats.tokens)} icon={Eraser} hint="après nettoyage" />
      </div>

      {/* Table des datasets */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Nom</th>
                <th className="px-3 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 text-right font-medium">Docs</th>
                <th className="px-3 py-2.5 text-right font-medium">Tokens</th>
                <th className="px-3 py-2.5 font-medium">Langue</th>
                <th className="px-3 py-2.5 font-medium">Version</th>
                <th className="px-3 py-2.5 font-medium">Tags</th>
                <th className="px-3 py-2.5 font-medium">Statut</th>
                <th className="px-3 py-2.5 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {datasets.map((d) => (
                <tr key={d.id} onClick={() => { setSelId(d.id); setPreview(false); }} className="cursor-pointer transition-colors hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-mono text-xs font-medium">{d.name}</td>
                  <td className="px-3 py-2.5"><Pill meta={DS_TYPE_META[d.type]} className="px-1.5 py-0 text-[10px]" /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs">{d.docs.toLocaleString("fr-FR")}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs">{fmtK(d.tokens)}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{d.lang}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{d.version}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {d.tags.map((t) => <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5"><Pill meta={DS_QUALITY_META[d.quality]} className="px-1.5 py-0 text-[10px]" /></td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{timeAgo(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {sel && (
        <DetailSheet
          onClose={() => setSelId(null)}
          title={sel.name}
          subtitle={`${sel.source} · importé ${timeAgo(sel.createdAt)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"><Database className="h-[18px] w-[18px]" /></div>}
          actions={
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Prévisualiser" onClick={() => setPreview((v) => !v)}><Eye className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Modifier" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Fusionner avec…" onClick={() => setMerging(true)}><GitMerge className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Supprimer"
                onClick={() => { if (confirm("Supprimer ce dataset ?")) { void remove(sel); setSelId(null); } }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          }
        >
          {preview && (
            <DetailSection title={`Prévisualisation${sel.storagePath ? "" : " — aucun fichier réel"}`}>
              {previewLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Téléchargement du fichier…</div>
              ) : sel.storagePath && previewText ? (
                <pre className="scrollbar-slim overflow-x-auto rounded-md border border-border bg-[#0b0b0f] p-3 text-[10px] leading-relaxed text-zinc-300">
                  {previewText}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {sel.storagePath
                    ? "Impossible de lire le fichier (bucket inaccessible ?)."
                    : "Ce dataset n'a pas de fichier réel importé. Importez un .jsonl (bouton Importer) pour pouvoir le prévisualiser et l'entraîner sur RunPod."}
                </p>
              )}
            </DetailSection>
          )}

          <DetailSection title="Dataset">
            <DetailRow label="Type"><Pill meta={DS_TYPE_META[sel.type]} /></DetailRow>
            <DetailRow label="Statut"><Pill meta={DS_QUALITY_META[sel.quality]} /></DetailRow>
            <DetailRow label="Documents">{sel.docs.toLocaleString("fr-FR")}</DetailRow>
            <DetailRow label="Exemples">{sel.rows.toLocaleString("fr-FR")}</DetailRow>
            <DetailRow label="Tokens">{fmtK(sel.tokens)}</DetailRow>
            <DetailRow label="Langue">{sel.lang}</DetailRow>
            <DetailRow label="Version"><span className="font-mono text-xs">{sel.version}</span></DetailRow>
            <DetailRow label="Taille">{sel.sizeMB} MB</DetailRow>
            <DetailRow label="Tags">
              <span className="flex flex-wrap justify-end gap-1">{sel.tags.map((t) => <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}</span>
            </DetailRow>
          </DetailSection>

          {/* Avant → Nettoyage → Après */}
          <DetailSection title="Avant → Nettoyage → Après">
            <div className="space-y-2 text-center">
              <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
                <div className="text-sm font-semibold tabular-nums">{sel.before.rows.toLocaleString("fr-FR")} lignes · {fmtK(sel.before.tokens)} tokens</div>
                <div className="text-[10px] text-muted-foreground">brut importé</div>
              </div>
              <ArrowDown className="mx-auto h-4 w-4 text-muted-foreground" />
              <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-left">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>− {sel.removed.dups.toLocaleString("fr-FR")} doublons</span>
                  <span>− {sel.removed.pii.toLocaleString("fr-FR")} PII anonymisées</span>
                  <span>− {sel.removed.html.toLocaleString("fr-FR")} balises HTML</span>
                  <span>− {sel.removed.emails.toLocaleString("fr-FR")} emails</span>
                </div>
              </div>
              <ArrowDown className="mx-auto h-4 w-4 text-muted-foreground" />
              <div className="rounded-md border border-[hsl(var(--accent-teal)/0.4)] bg-[hsl(var(--accent-teal)/0.08)] p-2.5">
                <div className="text-sm font-semibold tabular-nums">{sel.rows.toLocaleString("fr-FR")} lignes · {fmtK(sel.tokens)} tokens</div>
                <div className="text-[10px] text-muted-foreground">prêt pour l'entraînement</div>
              </div>
            </div>
          </DetailSection>

          <DetailSection title="Pipeline de nettoyage (9 étapes)">
            <div className="space-y-1.5">
              {sel.cleaning.map((c) => {
                const Icon = STEP_ICON[c.status];
                return (
                  <div key={c.step} className="rounded-md border border-border/60 p-2">
                    <div className="flex items-center gap-2 text-[13px]">
                      <Icon className={cn("h-4 w-4 shrink-0", STEP_COLOR[c.status])} />
                      <span className="flex-1">{c.step}</span>
                      <Pill meta={CLEAN_STEP_META[c.status]} className="px-1.5 py-0 text-[10px]" />
                    </div>
                    {c.note && <p className="mt-1 pl-6 text-xs text-red-500/90">{c.note}</p>}
                  </div>
                );
              })}
            </div>
          </DetailSection>

          {sel.quality === "issues" && (
            <Button className="w-full" variant="outline"
              onClick={() => {
                const steps = sel.cleaning.map((c, i) => ({ ...c, status: (c.status === "flagged" ? (i === sel.cleaning.findIndex((x) => x.status === "flagged") ? "running" : "pending") : c.status) as typeof c.status, note: c.status === "flagged" ? undefined : c.note }));
                void updateCleaning(sel, steps, "cleaning");
              }}>
              <Eraser className="mr-1.5 h-4 w-4" />Relancer le nettoyage
            </Button>
          )}
        </DetailSheet>
      )}

      {editing && sel && (
        <FormDialog
          title={`Modifier « ${sel.name} »`}
          fields={editFields}
          initial={{ name: sel.name, version: sel.version, lang: sel.lang, tags: sel.tags.join(", ") }}
          submitLabel="Enregistrer"
          onClose={() => setEditing(false)}
          onSubmit={edit}
        />
      )}

      {merging && sel && (
        <FormDialog
          title={`Fusionner « ${sel.name} »`}
          fields={mergeFields}
          initial={{ other: "" }}
          submitLabel="Fusionner"
          onClose={() => setMerging(false)}
          onSubmit={doMerge}
        />
      )}
    </div>
  );
}
