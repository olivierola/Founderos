import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { PageSkeleton } from "@/components/ui/skeleton";
import remarkGfm from "remark-gfm";
import {
  PlusIcon as Plus,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  ShieldCheckIcon as ShieldCheck,
  LightningIcon as Zap,
} from "@phosphor-icons/react";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Pill, Field, Select } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  newGuardrail, ENFORCEMENT_META, GUARDRAIL_SCOPE_META, timeAgo,
  type Guardrail, type Enforcement, type GuardrailScope,
} from "./data";
import { useGuardrailsDb } from "./db";

export function GovGuardrailsPage() {
  const { items, loading, save, toggle: toggleDb, remove: removeDb } = useGuardrailsDb();
  const [editing, setEditing] = useState<Guardrail | null>(null);
  const [sel, setSel] = useState<Guardrail | null>(null);

  const upsert = (g: Guardrail) => { void save(g, !items.some((x) => x.id === g.id)); };
  const remove = (id: string) => {
    const g = items.find((x) => x.id === id);
    if (g && confirm("Supprimer ce guardrail ?")) void removeDb(g);
  };
  const toggle = (id: string) => { const g = items.find((x) => x.id === id); if (g) void toggleDb(g); };

  const stats = useMemo(() => {
    const all = items;
    return {
      total: all.length, active: all.filter((g) => g.enabled).length,
      blocking: all.filter((g) => g.enforcement === "block" && g.enabled).length,
      enforced: all.filter((g) => g.enabled && g.matchPattern?.trim()).length,
    };
  }, [items]);

  if (loading) return <PageSkeleton cards={0} rows={6} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Guardrails"
        description="Règles de sécurité et de comportement appliquées à vos agents, éditables en markdown."
        actions={<Button onClick={() => setEditing(newGuardrail())}><Plus className="mr-1.5 h-4 w-4" />Guardrail</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Guardrails" value={String(stats.total)} icon={ShieldCheck} />
        <MetricCard label="Actifs" value={String(stats.active)} />
        <MetricCard label="Appliqués en runtime" value={String(stats.enforced)} hint="avec un motif de détection" icon={Zap} />
        <MetricCard label="Bloquants" value={String(stats.blocking)} hint="stoppent l'action de l'agent" />
      </div>

      {items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Aucun guardrail" description="Définissez les règles que vos agents doivent respecter — protection des données, actions sous approbation, budgets…"
          action={<Button onClick={() => setEditing(newGuardrail())}><Plus className="mr-1.5 h-4 w-4" />Créer un guardrail</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((g) => (
            <Card key={g.id} onClick={() => setSel(g)} className={cn("flex cursor-pointer flex-col overflow-hidden transition-colors hover:bg-muted/20", !g.enabled && "opacity-60")}>
              <div className="flex items-start gap-3 border-b border-border/60 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]">
                  <ShieldCheckIcon weight="duotone" className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{g.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Pill meta={ENFORCEMENT_META[g.enforcement]} />
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{g.category}</span>
                    {g.matchPattern?.trim() ? (
                      <Pill meta={{ label: GUARDRAIL_SCOPE_META[g.matchScope ?? "all"].label, tone: "blue" }} />
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">documentaire</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); toggle(g.id); }}
                  className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", g.enabled ? "bg-[hsl(var(--accent-teal))]" : "bg-muted")}
                  aria-pressed={g.enabled} aria-label="Activer/désactiver"
                >
                  <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", g.enabled ? "left-[18px]" : "left-0.5")} />
                </button>
              </div>

              <div className="chat-prose max-h-40 overflow-hidden px-4 py-3 text-[13px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{g.body}</ReactMarkdown>
              </div>

              <div className="mt-auto flex items-center justify-between border-t border-border/60 px-4 py-2.5">
                <span className="text-[11px] text-muted-foreground">Modifié {timeAgo(g.updatedAt)}</span>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); setEditing(g); }}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); remove(g.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.title}
          subtitle={`${sel.category} · modifié ${timeAgo(sel.updatedAt)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]"><ShieldCheckIcon weight="duotone" className="h-5 w-5" /></div>}
          actions={<Button size="sm" variant="outline" className="h-8" onClick={() => { setEditing(sel); setSel(null); }}><Pencil className="mr-1.5 h-3.5 w-3.5" />Éditer</Button>}
        >
          <DetailSection title="Règle">
            <DetailRow label="Application"><Pill meta={ENFORCEMENT_META[sel.enforcement]} /></DetailRow>
            <DetailRow label="Catégorie">{sel.category}</DetailRow>
            <DetailRow label="État">{sel.enabled ? "Actif" : "Désactivé"}</DetailRow>
            {sel.matchPattern?.trim() && (
              <>
                <DetailRow label="Surface de contrôle"><Pill meta={GUARDRAIL_SCOPE_META[sel.matchScope ?? "all"]} /></DetailRow>
                <DetailRow label="Motif de détection"><code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{sel.matchPattern}</code></DetailRow>
              </>
            )}
            <DetailRow label="Modifié">{new Date(sel.updatedAt).toLocaleString("fr-FR")}</DetailRow>
          </DetailSection>
          <DetailSection title="Contenu">
            <div className="chat-prose rounded-md border border-border bg-card px-4 py-3 text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{sel.body}</ReactMarkdown>
            </div>
          </DetailSection>
        </DetailSheet>
      )}

      {editing && <GuardrailEditor initial={editing} onClose={() => setEditing(null)} onSave={(g) => { upsert(g); setEditing(null); }} />}
    </div>
  );
}

function GuardrailEditor({ initial, onClose, onSave }: { initial: Guardrail; onClose: () => void; onSave: (g: Guardrail) => void }) {
  const [g, setG] = useState<Guardrail>(initial);
  const set = <K extends keyof Guardrail>(k: K, v: Guardrail[K]) => setG((p) => ({ ...p, [k]: v }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{initial.title ? "Éditer le guardrail" : "Nouveau guardrail"}</DialogTitle></DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Titre" className="col-span-2"><Input value={g.title} onChange={(e) => set("title", e.target.value)} placeholder="Protection des données personnelles" /></Field>
          <Field label="Catégorie" className="col-span-1"><Input value={g.category} onChange={(e) => set("category", e.target.value)} placeholder="Données, Sécurité, Coûts…" /></Field>
          <Field label="Application" className="col-span-1">
            <Select value={g.enforcement} onChange={(e) => set("enforcement", e.target.value as Enforcement)}>
              {Object.entries(ENFORCEMENT_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </Select>
          </Field>
        </div>

        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <Field label="Motif de détection (regex)">
            <Input value={g.matchPattern ?? ""} onChange={(e) => set("matchPattern", e.target.value || undefined)} placeholder="\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b — vide = documentaire" className="font-mono text-[12px]" />
          </Field>
          <Field label="Surface de contrôle">
            <Select value={g.matchScope ?? "all"} onChange={(e) => set("matchScope", e.target.value as GuardrailScope)}>
              {Object.entries(GUARDRAIL_SCOPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </Select>
          </Field>
        </div>
        {g.matchPattern?.trim() && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Le motif est testé en runtime sur les {GUARDRAIL_SCOPE_META[g.matchScope ?? "all"].label.toLowerCase()} pendant chaque exécution d'agent ({g.enforcement === "block" ? "l'action est bloquée" : g.enforcement === "warn" ? "un avertissement est enregistré" : "le passage est journalisé"}).
          </p>
        )}

        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <Field label="Contenu (markdown)">
            <Textarea value={g.body} onChange={(e) => set("body", e.target.value)} className="min-h-[280px] font-mono text-[13px] leading-relaxed" />
          </Field>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Aperçu</span>
            <div className="chat-prose max-h-[280px] overflow-y-auto rounded-md border border-border bg-card px-4 py-3 text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{g.body || "_Rien à afficher_"}</ReactMarkdown>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={() => onSave(g)} disabled={!g.title.trim()}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
