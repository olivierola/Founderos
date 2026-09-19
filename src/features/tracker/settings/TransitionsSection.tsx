import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { StateIcon } from "../pickers";
import { Switch } from "../ui";
import {
  fetchStates, fetchTransitions, setTransition, updateProject, type PjProject,
} from "../model";

/**
 * Les transitions autorisées entre états.
 *
 * La règle vit en base (trigger de 0224), pas seulement ici : une contrainte
 * qu'on peut contourner par un appel direct à l'API n'est pas une contrainte,
 * c'est une suggestion.
 *
 * Deux garde-fous, tous deux délibérés :
 *   · désactivé par défaut — un projet qui refuse des changements d'état sans
 *     qu'on l'ait demandé passe pour cassé ;
 *   · actif MAIS sans aucune règle déclarée = tout passe. Autrement, cocher la
 *     case gèlerait le projet d'un coup, et personne ne comprendrait pourquoi
 *     plus rien ne bouge.
 */
export function TransitionsSection({
  project, onChanged,
}: { project: PjProject; onChanged: () => void }) {
  const qc = useQueryClient();

  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });
  const { data: transitions } = useQuery({
    queryKey: ["pj_transitions", project.id],
    queryFn: () => fetchTransitions(project.id),
  });

  const list = states ?? [];
  const allowed = new Set((transitions ?? []).map((t) => `${t.from_state_id}>${t.to_state_id}`));
  const enforced = project.enforce_transitions ?? false;

  const toggle = async (from: string, to: string) => {
    const key = `${from}>${to}`;
    await setTransition({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      from, to, on: !allowed.has(key),
    });
    qc.invalidateQueries({ queryKey: ["pj_transitions", project.id] });
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h3 className="text-14 font-medium">Transitions d&apos;état</h3>
          <p className="text-11 text-muted-foreground">
            {enforced
              ? "Seuls les passages cochés sont autorisés. Aucune case cochée = tout reste permis."
              : "Désactivé : tous les passages sont permis."}
          </p>
        </div>
        <Switch
          checked={enforced}
          label="Appliquer les transitions d'état"
          onChange={async (v) => {
            await updateProject(project.id, { enforce_transitions: v } as Partial<PjProject>);
            onChanged();
          }}
        />
      </div>

      {enforced && list.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full text-12">
            <thead>
              <tr className="border-b border-border">
                <th className="px-2 py-2 text-left font-medium text-muted-foreground">
                  De ↓ / vers →
                </th>
                {list.map((s) => (
                  <th key={s.id} className="px-2 py-2 font-medium">
                    <span className="flex items-center justify-center gap-1">
                      <StateIcon group={s.group} color={s.color} className="h-3 w-3" />
                      <span className="max-w-[70px] truncate">{s.name}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((from) => (
                <tr key={from.id} className="border-b border-border/40 last:border-0">
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <StateIcon group={from.group} color={from.color} className="h-3 w-3" />
                      <span className="truncate">{from.name}</span>
                    </span>
                  </td>
                  {list.map((to) => {
                    // La diagonale n'a pas de sens : on ne « passe » pas d'un
                    // état à lui-même, et le trigger ignore ce cas de toute façon.
                    if (from.id === to.id) {
                      return <td key={to.id} className="bg-muted/40 px-2 py-1.5" />;
                    }
                    const on = allowed.has(`${from.id}>${to.id}`);
                    return (
                      <td key={to.id} className="px-2 py-1.5 text-center">
                        <button
                          type="button"
                          onClick={() => toggle(from.id, to.id)}
                          aria-pressed={on}
                          aria-label={`${from.name} vers ${to.name}`}
                          className={cn(
                            "mx-auto flex h-5 w-5 items-center justify-center rounded border transition-colors",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border hover:bg-muted",
                          )}
                        >
                          {on && <CheckIcon className="h-3 w-3" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
