import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { CheckIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { IssueKey, PriorityIcon, StateIcon } from "../pickers";
import { TextField } from "../ui";
import {
  fetchIssues, fetchStates, setIssueCycle, setIssueModules,
  type PjIssue, type PjProject,
} from "../model";

/**
 * Verser du travail DÉJÀ EXISTANT dans un cycle ou un module.
 *
 * C'est le geste qui manquait, et c'est pourtant le plus courant : on planifie
 * une itération à partir du backlog, pas en réécrivant des tickets. Sans lui,
 * la seule façon de remplir un cycle était de créer les items dedans — donc de
 * dupliquer ce qui existait déjà, ou d'ouvrir chaque fiche une par une pour y
 * changer le cycle.
 *
 * On ne propose QUE ce qui n'est pas déjà rattaché, et on masque les items
 * terminés : mettre un ticket livré dans le cycle qui commence fausserait son
 * point de départ, qui doit être « zéro de fait ».
 */
export function AddExistingIssues({
  project, target, onClose, onDone,
}: {
  project: PjProject;
  /** Le cycle ou le module qui reçoit. */
  target: { kind: "cycle" | "module"; id: string; name: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });

  const done = useMemo(
    () => new Set((states ?? []).filter((s) => s.group === "completed").map((s) => s.id)),
    [states],
  );

  const candidates = useMemo(() => {
    const already = (i: PjIssue) => target.kind === "cycle"
      ? i.cycle_id === target.id
      : i.module_ids.includes(target.id);

    const q = query.trim().toLowerCase();
    return (issues ?? [])
      .filter((i) => !i.is_epic && !already(i) && !done.has(i.state_id ?? ""))
      .filter((i) => !q
        || i.name.toLowerCase().includes(q)
        || `${project.identifier}-${i.sequence_id}`.toLowerCase().includes(q))
      // Le non-planifié d'abord : c'est ce qu'on vient chercher. Un item déjà
      // dans un autre cycle reste proposé — le déplacer est un choix légitime —
      // mais il ne doit pas occuper le haut de la liste.
      .sort((a, b) => {
        const pa = target.kind === "cycle" && a.cycle_id ? 1 : 0;
        const pb = target.kind === "cycle" && b.cycle_id ? 1 : 0;
        return pa - pb || a.sequence_id - b.sequence_id;
      });
  }, [issues, query, target, done, project.identifier]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!picked.size || busy) return;
    setBusy(true);
    try {
      // En série avec un compteur : sur trente items, un envoi parallèle sature
      // la connexion et l'utilisateur n'a aucun retour pendant l'attente.
      let count = 0;
      for (const id of picked) {
        if (target.kind === "cycle") {
          await setIssueCycle(id, project.workspace_id, target.id);
        } else {
          const current = (issues ?? []).find((i) => i.id === id);
          await setIssueModules(id, project.workspace_id, [
            ...(current?.module_ids ?? []), target.id,
          ]);
        }
        setProgress(++count);
      }
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Ajouter des work items à « {target.name} »</DialogTitle>
        </DialogHeader>

        <div className="px-5 pt-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
            <TextField
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Chercher par titre ou par référence…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!candidates.length ? (
            <p className="py-8 text-center text-12 text-tertiary">
              {query
                ? "Rien ne correspond."
                : "Tout le travail ouvert de ce projet est déjà rattaché."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {candidates.map((i) => {
                const state = (states ?? []).find((s) => s.id === i.state_id);
                const on = picked.has(i.id);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => toggle(i.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        on ? "bg-primary/10" : "hover:bg-muted",
                      )}
                    >
                      <span className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                      )}>
                        {on && <CheckIcon weight="bold" className="h-3 w-3" />}
                      </span>
                      {state && <StateIcon group={state.group} color={state.color} />}
                      <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />
                      <span className="min-w-0 flex-1 truncate text-13">{i.name}</span>
                      {/* Le rattachement actuel, quand il existe : cocher cet
                          item le DÉPLACERA, ce qu'il vaut mieux savoir avant. */}
                      {target.kind === "cycle" && i.cycle_id && (
                        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-10 text-amber-600">
                          déjà dans un cycle
                        </span>
                      )}
                      <PriorityIcon priority={i.priority} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="text-12 text-tertiary">
            {busy
              ? `Ajout… ${progress}/${picked.size}`
              : picked.size
                ? `${picked.size} sélectionné${picked.size > 1 ? "s" : ""}`
                : "Aucune sélection"}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button size="sm" onClick={submit} disabled={!picked.size || busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            <PlusIcon className="mr-1 h-4 w-4" /> Ajouter
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
