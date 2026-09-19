import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TextField } from "../ui";
import {
  createEstimate, deleteEstimate, fetchEstimates, setEstimateActive,
  type EstimateType, type PjEstimate, type PjProject,
} from "../model";

/**
 * Les échelles d'estimation.
 *
 * Le `type` n'est pas décoratif : il dit ce que l'outil a le droit
 * d'ADDITIONNER. Des points se somment (« il reste 21 points ») ; des tailles
 * de t-shirt ne se somment pas — « M + L » ne vaut rien — et du temps se somme
 * mais dans une autre unité. Confondre les trois donne des totaux qui ont
 * l'air justes et ne veulent rien dire.
 *
 * Une seule échelle est active à la fois par projet : deux échelles
 * simultanées rendraient tout total ambigu.
 */
const TYPES: { key: EstimateType; label: string; hint: string; values: string[] }[] = [
  {
    key: "points", label: "Points", hint: "Se somment. Suite de Fibonacci.",
    values: ["1", "2", "3", "5", "8", "13", "21"],
  },
  {
    key: "categories", label: "Catégories", hint: "Ne se somment PAS. Tailles de t-shirt.",
    values: ["XS", "S", "M", "L", "XL", "XXL"],
  },
  {
    key: "time", label: "Temps", hint: "Se somme, en heures.",
    values: ["1h", "2h", "4h", "1j", "2j", "1sem"],
  },
];

export function EstimatesSection({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<EstimateType>("points");
  const [values, setValues] = useState<string[]>(TYPES[0].values);

  const { data: estimates } = useQuery({
    queryKey: ["pj_estimates", project.id],
    queryFn: () => fetchEstimates(project.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_estimates", project.id] });

  const pickType = (t: EstimateType) => {
    setType(t);
    setValues(TYPES.find((x) => x.key === t)!.values);
  };

  const submit = async () => {
    if (!name.trim()) return;
    await createEstimate({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: name.trim(), type, values: values.filter(Boolean),
    });
    setName("");
    setAdding(false);
    refresh();
  };

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Estimations</h3>
      <p className="text-11 text-muted-foreground">
        Une seule échelle active à la fois : deux échelles simultanées rendraient
        tout total ambigu.
      </p>

      <div className="rounded-lg border border-border/70">
        {(estimates ?? []).map((e) => (
          <EstimateRow key={e.id} estimate={e} onChanged={refresh} />
        ))}

        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-13 text-muted-foreground hover:text-foreground"
          >
            <PlusIcon className="h-4 w-4" /> Nouvelle échelle
          </button>
        ) : (
          <div className="space-y-2.5 p-3">
            <TextField
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Nom de l'échelle" className="h-8 text-14"
            />
            <div className="grid gap-1.5 sm:grid-cols-3">
              {TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => pickType(t.key)}
                  className={cn(
                    "rounded border p-2 text-left text-12 transition-colors",
                    type === t.key ? "border-primary/60 bg-primary/10" : "border-border hover:bg-muted",
                  )}
                >
                  <span className="block font-medium">{t.label}</span>
                  <span className="block text-10 text-muted-foreground">{t.hint}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {values.map((v, i) => (
                <TextField
                  key={i}
                  value={v}
                  onChange={(e) => setValues((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                  className="h-7 w-16 text-center text-12"
                />
              ))}
              <button
                type="button"
                onClick={() => setValues((prev) => [...prev, ""])}
                className="rounded border border-dashed border-border px-2 text-12 text-muted-foreground hover:bg-muted"
              >
                +
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Annuler</Button>
              <Button size="sm" onClick={submit} disabled={!name.trim()}>Créer</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function EstimateRow({ estimate, onChanged }: { estimate: PjEstimate; onChanged: () => void }) {
  // `fetchEstimates` embarque déjà les points, triés : les recharger ici
  // ajouterait une requête par ligne pour une donnée déjà en mémoire.
  const points = estimate.points ?? [];
  const typeLabel = TYPES.find((t) => t.key === estimate.type)?.label ?? estimate.type;

  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-13">{estimate.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-10 text-muted-foreground">
            {typeLabel}
          </span>
          {estimate.is_active && (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-10 text-emerald-600">
              Active
            </span>
          )}
        </span>
        <span className="flex flex-wrap gap-1 pt-1">
          {points.map((p) => (
            <span key={p.id} className="rounded border border-border/60 px-1.5 py-0.5 text-10">
              {p.value}
            </span>
          ))}
        </span>
      </span>
      <button
        type="button"
        onClick={async () => { await setEstimateActive(estimate.pj_project_id, estimate.id); onChanged(); }}
        className="text-11 text-muted-foreground hover:text-foreground"
      >
        {estimate.is_active ? "Active" : "Activer"}
      </button>
      <button
        type="button"
        onClick={async () => { await deleteEstimate(estimate.id); onChanged(); }}
        className="rounded p-1 text-muted-foreground hover:text-red-600"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
