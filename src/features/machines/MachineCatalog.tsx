import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ShieldCheckIcon, ChartBarIcon, CodeIcon, BrainIcon, GlobeIcon, CloudIcon, FileTextIcon, SquaresFourIcon,
  PlusIcon, PackageIcon, WarningIcon, CircleNotchIcon as Loader2, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { fleetApi, templateShape, useRefreshFleet, type Fleet, type MachineTemplate } from "./api";

/** L'icône d'une catégorie du catalogue. */
export const CATEGORY_ICON: Record<string, PhosphorIcon> = {
  cyber: ShieldCheckIcon, data: ChartBarIcon, dev: CodeIcon, ia: BrainIcon, web: GlobeIcon, ops: CloudIcon, docs: FileTextIcon,
};

/**
 * Le catalogue des machines taillées par métier : une machine d'équipe avec
 * les outils de son métier et des ressources à sa mesure. On la crée pour des
 * équipes et des agents, ou on embarque un agent dedans (onglet Agents embarqués).
 */
export function MachineCatalog({ dashboardId, base, fleet }: { dashboardId: string; base: string; fleet: Fleet }) {
  const navigate = useNavigate();
  const [category, setCategory] = useState<string>("all");
  const [creating, setCreating] = useState<MachineTemplate | null>(null);
  const cat = fleet.catalog;
  const shown = useMemo(
    () => (cat?.templates ?? []).filter((t) => category === "all" || t.category === category),
    [cat, category],
  );
  const used = (id: string) => fleet.machines.filter((m) => m.template === id).length;
  if (!cat) return <p className="text-[13px] text-muted-foreground">Le catalogue n'est pas disponible sur ce serveur.</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1.5">
        {[{ id: "all", label: "Toutes" }, ...cat.categories].map((c) => {
          const Icon = c.id === "all" ? SquaresFourIcon : CATEGORY_ICON[c.id] ?? PackageIcon;
          const count = c.id === "all" ? cat.templates.length : cat.templates.filter((t) => t.category === c.id).length;
          return (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)}
              className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                category === c.id ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {c.label}
              <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>

      {cat.categories.filter((c) => category === "all" || c.id === category).map((c) => {
        const items = shown.filter((t) => t.category === c.id);
        if (!items.length) return null;
        const Icon = CATEGORY_ICON[c.id] ?? PackageIcon;
        return (
          <section key={c.id} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <Icon className="h-4 w-4 self-center text-muted-foreground" />
              <h2 className="text-[15px] font-semibold">{c.label}</h2>
              <p className="text-[12px] text-muted-foreground">{c.summary}</p>
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
              {items.map((t) => (
                <TemplateCard key={t.id} t={t} used={used(t.id)}
                  canCreate={!!fleet.provisioner?.available} reason={fleet.provisioner?.reason}
                  onCreate={() => setCreating(t)}
                  onEmbed={() => navigate(`${base}/embedded?new=1&template=${t.id}`)} />
              ))}
            </div>
          </section>
        );
      })}

      <CreateFromTemplate template={creating} dashboardId={dashboardId}
        onClose={() => setCreating(null)}
        onCreated={(id) => navigate(`${base}/machines?m=${id}`)} />
    </div>
  );
}

function TemplateCard({ t, used, canCreate, reason, onCreate, onEmbed }: {
  t: MachineTemplate; used: number; canCreate: boolean; reason?: string; onCreate: () => void; onEmbed: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col rounded-xl border border-border p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{t.name}</div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.summary}</p>
        </div>
        {used > 0 && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{used} créée{used > 1 ? "s" : ""}</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {t.highlights.map((h) => (
          <span key={h} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{h}</span>
        ))}
      </div>
      <div className="mt-3 font-mono text-[11.5px] text-muted-foreground">{templateShape(t)}</div>
      {t.note && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
          <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t.note}
        </p>
      )}
      <button type="button" onClick={() => setOpen(!open)} className="mt-2 self-start text-[12px] text-muted-foreground underline-offset-2 hover:underline">
        {open ? "Masquer les paquets" : "Voir les paquets"}
      </button>
      {open && (
        <dl className="mt-2 space-y-1 text-[11.5px]">
          {([["apt", t.apt], ["pip", t.pip], ["npm", t.npm]] as const).filter(([, xs]) => xs.length).map(([k, xs]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-8 shrink-0 font-mono text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words font-mono">{xs.join(" ")}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <Button size="sm" onClick={onCreate} disabled={!canCreate} title={canCreate ? undefined : reason}>
          <PlusIcon className="mr-1.5 h-3.5 w-3.5" /> Créer cette machine
        </Button>
        <Button size="sm" variant="outline" onClick={onEmbed}>
          <PackageIcon className="mr-1.5 h-3.5 w-3.5" /> Embarquer un agent
        </Button>
      </div>
    </div>
  );
}

function CreateFromTemplate({ template, dashboardId, onClose, onCreated }: {
  template: MachineTemplate | null; dashboardId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const refresh = useRefreshFleet(dashboardId);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  if (template && lastId !== template.id) { setLastId(template.id); setName(template.name); }

  const submit = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const r = await fleetApi.provision(dashboardId, { name: name.trim() || template.name, template: template.id });
      await refresh();
      onClose();
      onCreated(r.machine.id);
      toast.success("Machine en création", "La première fois, son image se construit : quelques minutes.");
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!template} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Créer « {template?.name} »</DialogTitle>
          <DialogDescription>
            Une machine d'équipe avec les outils de ce métier, lancée sur ce poste. Donnez-la ensuite à une équipe ou à un agent (Attributions).
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-muted-foreground">Nom</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {template && <p className="font-mono text-[12px] text-muted-foreground">{templateShape(template)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Créer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
