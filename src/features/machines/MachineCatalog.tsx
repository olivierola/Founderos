import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ShieldCheckIcon, ShieldWarningIcon, ChartBarIcon, CodeIcon, BrainIcon, GlobeIcon, CloudIcon, FileTextIcon,
  PackageIcon, WarningIcon, CheckIcon, CircleNotchIcon as Loader2, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { fleetApi, presetShape, toolCount, useRefreshFleet, type Fleet, type MachinePreset, type MachineTool } from "./api";

/** L'icône d'une catégorie d'outils. */
export const CATEGORY_ICON: Record<string, PhosphorIcon> = {
  dev: CodeIcon, data: ChartBarIcon, ia: BrainIcon, web: GlobeIcon, ops: CloudIcon, docs: FileTextIcon,
  defsec: ShieldCheckIcon, netsec: ShieldWarningIcon,
};

/**
 * Composer une machine : partir de la machine de base (team-machine) et cocher
 * les outils, pris dans le catalogue par catégorie. La même sélection crée une
 * machine d'équipe ou embarque un agent (onglet Agents embarqués).
 */
export function MachineCatalog({ dashboardId, base, fleet }: { dashboardId: string; base: string; fleet: Fleet }) {
  const navigate = useNavigate();
  const cat = fleet.catalog;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  if (!cat) return <p className="text-[13px] text-muted-foreground">Le catalogue n'est pas disponible sur ce serveur.</p>;

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const applyPreset = (p: MachinePreset) => setPicked(new Set(p.tools));
  const chosen = cat.tools.filter((t) => picked.has(t.id));
  const shown = cat.tools.filter((t) => category === "all" || t.category === category);
  const canCreate = !!fleet.provisioner?.available;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        <div>
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Sélections toutes faites</div>
          <div className="flex flex-wrap gap-2">
            {cat.presets.map((p) => {
              const Icon = CATEGORY_ICON[p.category] ?? PackageIcon;
              const on = p.tools.length > 0 && p.tools.every((t) => picked.has(t)) && chosen.length === p.tools.length;
              return (
                <button key={p.id} type="button" onClick={() => applyPreset(p)} title={p.summary}
                  className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                    on ? "border-primary bg-primary/5 font-medium" : "border-border hover:bg-muted/50")}>
                  <Icon className="h-4 w-4" /> {p.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[{ id: "all", label: "Toutes" }, ...cat.categories].map((c) => (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)}
              className={cn("rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                category === c.id ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground hover:text-foreground")}>
              {c.id === "all" ? "Toutes" : c.label}
            </button>
          ))}
        </div>

        {cat.categories.filter((c) => category === "all" || c.id === category).map((c) => {
          const items = shown.filter((t) => t.category === c.id);
          if (!items.length) return null;
          const Icon = CATEGORY_ICON[c.id] ?? PackageIcon;
          return (
            <section key={c.id} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <Icon className="h-4 w-4 self-center text-muted-foreground" />
                <h2 className="text-[14px] font-semibold">{c.label}</h2>
                <p className="text-[12px] text-muted-foreground">{c.summary}</p>
              </div>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                {items.map((t) => <ToolRow key={t.id} t={t} on={picked.has(t.id)} onToggle={() => toggle(t.id)} />)}
              </div>
            </section>
          );
        })}
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 text-[14px] font-medium"><PackageIcon className="h-4 w-4" /> Votre machine</div>
          <p className="mt-1 text-[12px] text-muted-foreground">Machine de base (Node, Python, shell, navigateur) et les outils cochés.</p>
          <div className="mt-3 min-h-[2rem]">
            {chosen.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">Aucun outil : la machine de base.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {chosen.map((t) => (
                  <button key={t.id} type="button" onClick={() => toggle(t.id)} title="Retirer"
                    className="rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] hover:bg-muted/70">{t.name} ✕</button>
                ))}
              </div>
            )}
          </div>
          {chosen.some((t) => t.note) && (
            <p className="mt-3 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
              <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {chosen.find((t) => t.category === "netsec") ? "Les outils d'audit réseau ne s'utilisent que sur des systèmes que vous êtes autorisé à tester." : "Certains outils demandent de respecter les conditions d'utilisation des services visés."}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => setCreating(true)} disabled={!canCreate} title={canCreate ? undefined : fleet.provisioner?.reason}>
              Créer cette machine
            </Button>
            <Button variant="outline" onClick={() => navigate(`${base}/embedded?new=1${chosen.length ? `&tools=${chosen.map((t) => t.id).join(",")}` : ""}`)}>
              <PackageIcon className="mr-1.5 h-4 w-4" /> Embarquer un agent
            </Button>
            {chosen.length > 0 && <button type="button" onClick={() => setPicked(new Set())} className="text-[12px] text-muted-foreground hover:underline">Tout retirer</button>}
          </div>
          {!canCreate && <p className="mt-2 text-[12px] text-muted-foreground">{fleet.provisioner?.reason}</p>}
        </div>
      </aside>

      <CreateMachine open={creating} dashboardId={dashboardId} tools={chosen}
        onClose={() => setCreating(false)} onCreated={(id) => navigate(`${base}/machines?m=${id}`)} />
    </div>
  );
}

function ToolRow({ t, on, onToggle }: { t: MachineTool; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className={cn("flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
      <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
        {on && <CheckIcon className="h-3 w-3" weight="bold" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">{t.name}{t.note && <WarningIcon className="h-3.5 w-3.5 text-amber-600" />}</span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground">{t.summary}</span>
        <span className="mt-1 block font-mono text-[11px] text-muted-foreground/80">{toolCount(t)}</span>
      </span>
    </button>
  );
}

function CreateMachine({ open, dashboardId, tools, onClose, onCreated }: {
  open: boolean; dashboardId: string; tools: MachineTool[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const refresh = useRefreshFleet(dashboardId);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const r = await fleetApi.provision(dashboardId, { name: name.trim() || "Machine", tools: tools.map((t) => t.id) });
      await refresh();
      onClose();
      setName("");
      onCreated(r.machine.id);
      toast.success("Machine en création", tools.length ? "Son image se construit la première fois : quelques minutes." : "Prête dans un instant.");
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Créer la machine</DialogTitle>
          <DialogDescription>
            Une machine d'équipe lancée sur ce poste, avec {tools.length === 0 ? "la base seule" : `${tools.length} outil${tools.length > 1 ? "s" : ""}`}. Donnez-la ensuite à une équipe ou à un agent (Attributions).
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-muted-foreground">Nom</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Machine data du site" />
        </label>
        {tools.length > 0 && <p className="text-[12px] text-muted-foreground">{tools.map((t) => t.name).join(", ")}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Créer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
