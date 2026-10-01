import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleNotchIcon as Loader2, PlusIcon as Plus, TrashIcon as Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LEAD_CONFIG, normalizeLeadConfig, type Criterion, type LeadConfig, type LeadType, type Rep,
} from "./leadConfig";

// La grille LeadSense, partagée par tous les agents du projet qui ont l'outil.
//
// Quatre blocs : le client idéal (ce que « adéquation » mesure), les critères et
// leurs quatre niveaux, les types de demande, et les commerciaux avec ce que
// chacun couvre. Les niveaux sont des SITUATIONS à reconnaître — c'est ce qui
// rend la note comparable d'un prospect à l'autre.

type Section = "grid" | "types" | "reps";

const keyOf = (label: string) =>
  label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "critere";

export function LeadSenseSettings() {
  const { workspaceId, projectId } = useCurrentContext();
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>("grid");
  const [cfg, setCfg] = useState<LeadConfig>(DEFAULT_LEAD_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["leadsense_config", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("leadsense_config").select("config").eq("project_id", projectId!).maybeSingle();
      return normalizeLeadConfig((data as { config?: unknown } | null)?.config);
    },
  });
  useEffect(() => { if (data) { setCfg(data); setDirty(false); } }, [data]);

  const update = (next: LeadConfig) => { setCfg(next); setDirty(true); };
  const setCrit = (i: number, p: Partial<Criterion>) => update({ ...cfg, criteria: cfg.criteria.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setType = (i: number, p: Partial<LeadType>) => update({ ...cfg, lead_types: cfg.lead_types.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const setRep = (i: number, p: Partial<Rep>) => update({ ...cfg, reps: cfg.reps.map((r, j) => (j === i ? { ...r, ...p } : r)) });

  async function save() {
    if (!workspaceId || !projectId) return;
    if (cfg.lead_types.length < 2) { toast.error("Gardez au moins deux types de demande."); return; }
    if (cfg.criteria.some((c) => c.levels.some((l) => !l.trim()))) { toast.error("Chaque critère doit décrire ses quatre niveaux."); return; }
    const used = new Set<string>();
    const uniq = (k: string) => { let x = k; while (used.has(x)) x = `${x}_2`; used.add(x); return x; };
    const clean: LeadConfig = {
      ...cfg,
      criteria: cfg.criteria.map((c) => ({ ...c, key: uniq(c.key || keyOf(c.label)), weight: Math.max(0, Number(c.weight) || 0) })),
      lead_types: cfg.lead_types.map((t) => ({ ...t, key: t.key || keyOf(t.label), examples: (t.examples ?? []).map((e) => e.trim()).filter(Boolean) })),
      reps: cfg.reps.filter((r) => r.name.trim()),
    };
    setSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from("leadsense_config").upsert({
        project_id: projectId, workspace_id: workspaceId, config: clean,
        updated_by: auth.user?.id ?? null, updated_at: new Date().toISOString(),
      }, { onConflict: "project_id" });
      if (error) throw error;
      toast.success("Grille LeadSense enregistrée");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["leadsense_config", projectId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const totalWeight = cfg.criteria.reduce((n, c) => n + (Number(c.weight) || 0), 0);

  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {([["grid", "Grille"], ["types", "Types de demande"], ["reps", "Commerciaux"]] as Array<[Section, string]>).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSection(k)}
              className={cn("rounded-md px-2.5 py-1 text-[11.5px]", section === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">Partagée par tous les agents du projet</span>
        <Button size="sm" className="ml-auto h-7 text-[11.5px]" disabled={!dirty || saving} onClick={save}>
          {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Enregistrer
        </Button>
      </div>

      {section === "grid" && (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Votre client idéal (sert au critère d'adéquation)</span>
            <Textarea rows={2} value={cfg.ideal_customer} className="text-[12px]"
              placeholder="ex. PME SaaS B2B de 20 à 200 salariés, en France ou au Benelux, avec une équipe support dédiée."
              onChange={(e) => update({ ...cfg, ideal_customer: e.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Prospect chaud — à transmettre immédiatement quand…</span>
            <Textarea rows={2} value={cfg.hot_rule} className="text-[12px]" onChange={(e) => update({ ...cfg, hot_rule: e.target.value })} />
          </label>
          <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground">
            Rangs : A dès
            <Input type="number" value={cfg.tiers.a} className="h-7 w-16 text-[12px]" onChange={(e) => update({ ...cfg, tiers: { ...cfg.tiers, a: Number(e.target.value) } })} />
            B dès
            <Input type="number" value={cfg.tiers.b} className="h-7 w-16 text-[12px]" onChange={(e) => update({ ...cfg, tiers: { ...cfg.tiers, b: Number(e.target.value) } })} />
            C dès
            <Input type="number" value={cfg.tiers.c} className="h-7 w-16 text-[12px]" onChange={(e) => update({ ...cfg, tiers: { ...cfg.tiers, c: Number(e.target.value) } })} />
            <span>(score sur 100 · poids total {totalWeight})</span>
          </div>
          {cfg.criteria.map((c, i) => (
            <div key={i} className="space-y-2 rounded-lg bg-muted/30 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={c.label} className="h-7 w-40 text-[12px] font-medium" onChange={(e) => setCrit(i, { label: e.target.value })} />
                <Input value={c.what} className="h-7 min-w-[220px] flex-1 text-[12px]" placeholder="Ce que le critère mesure"
                  onChange={(e) => setCrit(i, { what: e.target.value })} />
                <span className="text-[11px] text-muted-foreground">poids</span>
                <Input type="number" min={0} value={c.weight} className="h-7 w-16 text-[12px]" onChange={(e) => setCrit(i, { weight: Number(e.target.value) })} />
                <button type="button" aria-label="Supprimer le critère" className="rounded p-1 hover:bg-muted"
                  onClick={() => update({ ...cfg, criteria: cfg.criteria.filter((_, j) => j !== i) })}><Trash className="h-3.5 w-3.5" /></button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {c.levels.map((l, li) => (
                  <label key={li} className="flex items-start gap-1.5">
                    <span className="mt-1.5 w-4 shrink-0 text-[11px] font-medium text-muted-foreground">{li}</span>
                    <Textarea rows={2} value={l} className="min-h-0 text-[11.5px]"
                      onChange={(e) => {
                        const levels = [...c.levels] as Criterion["levels"];
                        levels[li] = e.target.value;
                        setCrit(i, { levels });
                      }} />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7 gap-1 text-[11.5px]"
            onClick={() => update({ ...cfg, criteria: [...cfg.criteria, { key: "", label: "Nouveau critère", what: "", weight: 10, levels: ["", "", "", ""] }] })}>
            <Plus className="h-3 w-3" /> Ajouter un critère
          </Button>
        </div>
      )}

      {section === "types" && (
        <div className="space-y-2">
          {cfg.lead_types.map((t, i) => (
            <div key={i} className="space-y-1.5 rounded-lg bg-muted/30 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={t.label} className="h-7 w-48 text-[12px] font-medium" onChange={(e) => setType(i, { label: e.target.value })} />
                <label className="flex items-center gap-1.5 text-[11.5px]">
                  <input type="checkbox" checked={t.qualify} onChange={(e) => setType(i, { qualify: e.target.checked })} />
                  C'est un prospect (reçoit un score)
                </label>
                <button type="button" aria-label="Supprimer le type" className="ml-auto rounded p-1 hover:bg-muted"
                  onClick={() => update({ ...cfg, lead_types: cfg.lead_types.filter((_, j) => j !== i) })}><Trash className="h-3.5 w-3.5" /></button>
              </div>
              <Input value={t.what} className="h-7 text-[12px]" placeholder="Définition" onChange={(e) => setType(i, { what: e.target.value })} />
              <Input value={t.not_for ?? ""} className="h-7 text-[12px]" placeholder="Ce n'est pas… (ce qui relève d'un type voisin)" onChange={(e) => setType(i, { not_for: e.target.value })} />
              <Input value={(t.examples ?? []).join(" | ")} className="h-7 text-[12px]" placeholder="Exemples réels, séparés par |"
                onChange={(e) => setType(i, { examples: e.target.value.split("|") })} />
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7 gap-1 text-[11.5px]"
            onClick={() => update({ ...cfg, lead_types: [...cfg.lead_types, { key: "", label: "Nouveau type", what: "", qualify: true }] })}>
            <Plus className="h-3 w-3" /> Ajouter un type
          </Button>
        </div>
      )}

      {section === "reps" && (
        <div className="space-y-2">
          <p className="text-[11.5px] text-muted-foreground">
            Décrivez ce que chacun couvre (segment, taille, secteur, région, langue) : c'est ce texte qui sert à choisir.
            Avec un seul commercial, il reçoit tous les prospects ; sans commercial, l'agent vous transmet les prospects chauds.
          </p>
          {cfg.reps.map((r, i) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-2">
              <Input value={r.name} className="h-7 w-40 text-[12px]" placeholder="Nom" onChange={(e) => setRep(i, { name: e.target.value })} />
              <Input value={r.email ?? ""} className="h-7 w-48 text-[12px]" placeholder="E-mail" onChange={(e) => setRep(i, { email: e.target.value })} />
              <Input value={r.covers} className="h-7 min-w-[220px] flex-1 text-[12px]" placeholder="ex. PME France, secteur santé"
                onChange={(e) => setRep(i, { covers: e.target.value })} />
              <button type="button" aria-label="Retirer" className="rounded p-1 hover:bg-muted"
                onClick={() => update({ ...cfg, reps: cfg.reps.filter((_, j) => j !== i) })}><Trash className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7 gap-1 text-[11.5px]"
            onClick={() => update({ ...cfg, reps: [...cfg.reps, { id: crypto.randomUUID(), name: "", covers: "" }] })}>
            <Plus className="h-3 w-3" /> Ajouter un commercial
          </Button>
        </div>
      )}
    </div>
  );
}
