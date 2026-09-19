import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RobotIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentPicker";
import { TextAreaField } from "./ui";
import {
  fetchProjectAgents, fetchTrackerAgents,
  type PjProject, type TrackerAgent,
} from "./model";

/**
 * Le composeur de commentaire d'un work item — avec la mention d'agent.
 *
 * C'est le point de rencontre qui manquait entre humains et agents. Dans une
 * room, on écrit « @Analyste, regarde ça » et l'agent s'y met ; dans la
 * discussion d'un work item, là où se prennent pourtant les décisions sur le
 * travail, on ne pouvait que parler entre humains, puis aller ouvrir « Confier à
 * un agent » et récrire la demande ailleurs. La demande existait déjà, écrite,
 * au bon endroit : il manquait de pouvoir l'adresser.
 *
 * Mentionner un agent ici fait trois choses, dans l'ordre :
 *   1. le commentaire est publié, comme n'importe quel autre ;
 *   2. l'agent reçoit une mission sur CET item, dont la consigne est le
 *      commentaire — le prompt y ajoute le nom, la description et le travail
 *      à faire de l'item ;
 *   3. l'agent répond dans ce même fil, par un commentaire : la conversation
 *      reste là où elle a commencé.
 *
 * Ne sont proposés que les agents AUTORISÉS EN ÉCRITURE sur le projet. En
 * proposer d'autres reviendrait à lancer une mission qui échouera sur chaque
 * outil, ou pire, à laisser croire qu'un agent a reçu une demande qu'il ne peut
 * pas traiter.
 */

export function CommentComposer({
  project, onSubmit,
}: {
  project: PjProject;
  /** Publie le commentaire, puis lance les agents mentionnés. */
  onSubmit: (text: string, agentIds: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  /** Nom affiché → identifiant, pour retrouver à l'envoi qui a été mentionné. */
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map());
  const ref = useRef<HTMLTextAreaElement>(null);

  const { data: roster } = useQuery({
    queryKey: ["pj_tracker_agents", project.dashboard_id, project.workspace_id],
    queryFn: () => fetchTrackerAgents(project.dashboard_id, project.workspace_id),
  });
  const { data: scope } = useQuery({
    queryKey: ["pj_project_agents", project.id],
    queryFn: () => fetchProjectAgents(project.id),
  });

  const writable = useMemo(() => {
    const ids = new Set((scope ?? []).filter((a) => a.role !== "observer").map((a) => a.agent_id));
    return (roster ?? []).filter((a) => ids.has(a.id));
  }, [roster, scope]);

  const matches = query === null
    ? []
    : writable.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  /** Le « @mot » en cours de frappe, juste avant le curseur. */
  const detect = (text: string, caret: number) => {
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
    setQuery(m ? m[1] : null);
    setCursor(0);
  };

  const insert = (agent: TrackerAgent) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${agent.name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentioned((prev) => new Map(prev).set(agent.name, agent.id));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  // Les agents encore présents dans le texte à l'envoi. Une mention effacée
  // pendant la rédaction ne doit pas mettre quelqu'un au travail.
  const targets = [...mentioned.entries()]
    .filter(([name]) => draft.includes(`@${name}`))
    .map(([, id]) => id);

  const submit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(draft.trim(), targets);
      setDraft("");
      setMentioned(new Map());
      setQuery(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative space-y-1.5">
      {query !== null && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-overlay-200">
          <p className="px-2 py-1 text-10 font-medium uppercase tracking-wide text-tertiary">
            Mettre un agent au travail
          </p>
          {matches.length ? matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(a)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12",
                i === cursor ? "bg-muted" : "hover:bg-muted",
              )}
            >
              <AgentAvatar agent={a} size={20} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </button>
          )) : (
            <p className="px-2 py-2 text-11 leading-snug text-tertiary">
              {writable.length
                ? "Aucun agent ne correspond."
                : "Aucun agent n'est autorisé en écriture sur ce projet. Ajoutez-en un dans l'onglet Équipage."}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <TextAreaField
          ref={ref}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={(e) => {
            if (query !== null && matches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % matches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + matches.length) % matches.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(matches[cursor]); return; }
            }
            if (e.key === "Escape" && query !== null) { e.preventDefault(); setQuery(null); return; }
            // Cmd/Ctrl+Entrée envoie, Entrée saute une ligne : sur un champ
            // multiligne, l'inverse coupe les commentaires en deux.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          }}
          onBlur={() => setQuery(null)}
          placeholder="Écrire un commentaire… @ pour mettre un agent au travail"
          className="min-h-[64px] text-14"
        />
        <Button size="sm" onClick={() => void submit()} disabled={!draft.trim() || busy}>
          {busy ? "Envoi…" : "Envoyer"}
        </Button>
      </div>

      {/* Dit AVANT l'envoi ce que l'envoi va déclencher. Une mention qui lance
          une mission payante ne doit pas se découvrir après coup. */}
      {targets.length > 0 && (
        <p className="flex items-center gap-1.5 text-11 text-primary">
          <RobotIcon className="h-3.5 w-3.5" />
          {targets.length === 1
            ? "L'agent mentionné se mettra au travail sur cet item et répondra ici."
            : `${targets.length} agents mentionnés se mettront au travail sur cet item et répondront ici.`}
        </p>
      )}
    </div>
  );
}
