import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, RobotIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { PickerTrigger } from "./pickers";
import { fetchProjectAgents, fetchTrackerAgents, type TrackerAgent } from "./model";

/**
 * Le choix des agents assignés à un work item.
 *
 * Il est SÉPARÉ du sélecteur de personnes, et c'est délibéré. Fusionner les
 * deux dans une seule liste « assignés » paraît plus simple, mais efface la
 * seule question qu'on se pose vraiment en regardant une ligne : est-ce qu'une
 * machine s'en occupe, ou quelqu'un ? Les deux ne se relancent pas de la même
 * façon, ne se rappellent pas de la même façon, et n'ont pas les mêmes délais.
 *
 * Un work item peut porter les deux. C'est même le cas normal : un agent
 * prépare, une personne valide.
 */

/**
 * La pastille d'un agent.
 *
 * Trois cas, dans cet ordre : son PORTRAIT quand il en a un — c'est le cas de
 * la plupart, la création du produit en génère un —, son emoji sinon, et le
 * pictogramme générique en dernier recours. Prendre l'emoji d'abord, comme on
 * le faisait, affichait un robot gris pour tout le monde.
 */
export function AgentAvatar({ agent, size = 20 }: { agent: TrackerAgent | undefined; size?: number }) {
  if (!agent) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-md bg-muted text-tertiary"
        style={{ width: size, height: size }}
      >
        <RobotIcon className="h-3 w-3" />
      </span>
    );
  }

  if (agent.avatar_url) {
    return (
      <img
        src={agent.avatar_url}
        alt=""
        title={agent.name}
        className="shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title={agent.name}
      className="flex shrink-0 items-center justify-center rounded-md leading-none"
      style={{
        width: size,
        height: size,
        // Le fond reprend la couleur d'accent de l'agent, très diluée : c'est
        // ce qui permet de distinguer deux agents au coin de l'œil sans que
        // trois pastilles vives se disputent la ligne.
        background: `${agent.accent_color ?? "#6b7280"}26`,
        fontSize: size * 0.55,
      }}
    >
      {agent.avatar_emoji || "🤖"}
    </span>
  );
}

/** Les agents assignés, empilés comme les avatars des personnes. */
export function AgentStack({
  ids, agents, max = 3,
}: { ids: string[]; agents: TrackerAgent[]; max?: number }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {shown.map((id) => (
        <AgentAvatar key={id} agent={agents.find((a) => a.id === id)} size={18} />
      ))}
      {ids.length > max && (
        <span className="flex h-[18px] items-center rounded-md bg-muted px-1 text-10 text-tertiary">
          +{ids.length - max}
        </span>
      )}
    </span>
  );
}

export function AgentPicker({
  dashboardId, workspaceId, pjProjectId, value, onChange, compact,
}: {
  dashboardId: string;
  /** Le filet de sécurité : si le tableau ne donne rien, on cherche à
   *  l'échelle du workspace plutôt que de rendre une liste vide. */
  workspaceId?: string | null;
  /**
   * Le projet de l'item. Il RESTREINT la liste à l'équipage : seuls les agents
   * autorisés sur ce projet peuvent y être assignés.
   *
   * Ce n'est pas une commodité d'affichage mais la correction d'un mensonge.
   * Un agent absent de `pj_project_agents` n'a aucun droit d'écriture ici
   * (0232) : le proposer laissait assigner quelqu'un qui échouerait à chaque
   * outil, et l'item portait alors le nom d'un porteur qui ne pouvait rien
   * faire. La liste dit désormais la vérité du périmètre.
   */
  pjProjectId?: string | null;
  value: string[];
  onChange: (ids: string[]) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const { data: agents, error } = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId, workspaceId],
    queryFn: () => fetchTrackerAgents(dashboardId, workspaceId),
    // Il suffit de l'UN des deux : sans tableau on cherche dans le workspace.
    enabled: (!!dashboardId || !!workspaceId) && (open || value.length > 0),
  });

  const { data: crew } = useQuery({
    queryKey: ["pj_project_agents", pjProjectId],
    enabled: !!pjProjectId && (open || value.length > 0),
    queryFn: () => fetchProjectAgents(pjProjectId!),
  });

  const roster = agents ?? [];
  // Un observateur lit le projet mais n'y écrit pas : lui confier un item
  // reviendrait à désigner un porteur qui ne peut pas porter.
  const allowed = new Set(
    (crew ?? []).filter((c) => c.role !== "observer").map((c) => c.agent_id),
  );
  const list = pjProjectId
    // Ceux DÉJÀ assignés restent visibles même si leur accès a été révoqué
    // depuis : les faire disparaître de leur propre item donnerait une pastille
    // sans nom et aucun moyen de la retirer.
    ? roster.filter((a) => allowed.has(a.id) || value.includes(a.id))
    : roster;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={value.length > 0} title="Agents">
          {value.length
            ? <AgentStack ids={value} agents={list} />
            : <RobotIcon className="h-3.5 w-3.5" />}
          {!compact && !value.length && <span>Agents</span>}
        </PickerTrigger>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un agent…" />
          <CommandList>
            <CommandEmpty>
              {/* Trois causes, trois messages. Un seul texte pour les trois
                  ferait chercher un agent inexistant, ou croire à une panne
                  quand c'est une faute de frappe. */}
              <span className="block px-3 py-3 text-11 leading-snug text-tertiary">
                {error
                  ? `La liste n'a pas pu être chargée : ${error.message}`
                  : list.length
                    ? "Aucun agent ne correspond à cette recherche."
                    : pjProjectId && roster.length
                      // La cause la plus fréquente, et la seule qui ait un
                      // remède à portée de clic.
                      ? "Aucun agent n'est autorisé sur ce projet. Ouvrez l'onglet Équipage pour en ajouter un."
                      : "Aucun agent dans cet espace de travail. Créez-en un depuis l'onglet Agents."}
              </span>
            </CommandEmpty>
            <CommandGroup>
              {list.map((a) => (
                <CommandItem key={a.id} value={a.name} onSelect={() => toggle(a.id)}>
                  <AgentAvatar agent={a} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {/* Rattaché ailleurs : on le propose quand même — c'est mieux
                      que de le cacher — mais on le dit, sinon on croirait
                      travailler avec un agent de ce service. */}
                  {dashboardId && a.service_dashboard_id && a.service_dashboard_id !== dashboardId && (
                    <span className="shrink-0 rounded bg-muted px-1.5 text-10 text-tertiary">
                      autre service
                    </span>
                  )}
                  {value.includes(a.id) && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        <p className={cn(
          "border-t border-border px-3 py-2 text-10 leading-snug text-tertiary",
        )}>
          Seuls les agents de l&apos;équipage du projet apparaissent ici. Un agent
          assigné démarre seul si le work item porte un travail à faire et le
          travail autonome ; sinon il attend qu&apos;on le lance.
        </p>
      </PopoverContent>
    </Popover>
  );
}
