import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "../pickers";
import { cyclePhase, fetchCycles, setIssueCycle, type PjCycle, type PjIssue } from "../model";
import { Modal } from "../ui";

/**
 * Le transfert des work items non terminés d'un cycle échu.
 *
 * C'est le geste qui manque à tout suivi par itérations : un cycle se termine,
 * il reste du travail, et il faut décider où il va. Sans ce geste, les items
 * restent accrochés à un cycle mort — ils disparaissent des boards de
 * l'itération suivante tout en comptant encore comme « non terminés » dans les
 * statistiques de l'ancienne.
 *
 * On ne transfère QUE les non-terminés. Déplacer aussi les items livrés
 * réécrirait l'histoire : le cycle passé perdrait ce qu'il a effectivement
 * produit, et son burndown deviendrait faux rétroactivement.
 */
export function TransferIssues({
  cycle, issues, projectId, workspaceId, onDone,
}: {
  cycle: PjCycle;
  issues: PjIssue[];
  projectId: string;
  workspaceId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = useMemo(() => issues.filter((i) => !i.completed_at), [issues]);

  // Rien à transférer, ou cycle encore ouvert : le bouton n'a pas lieu d'être.
  if (!pending.length || cyclePhase(cycle) !== "completed") return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 text-11 font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-500"
      >
        <WarningIcon className="h-3.5 w-3.5" />
        Transférer {pending.length} non terminé{pending.length > 1 ? "s" : ""}
      </button>

      {open && (
        <TransferDialog
          cycle={cycle}
          pending={pending}
          projectId={projectId}
          workspaceId={workspaceId}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      )}
    </>
  );
}

function TransferDialog({
  cycle, pending, projectId, workspaceId, onClose, onDone,
}: {
  cycle: PjCycle;
  pending: PjIssue[];
  projectId: string;
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const { data: cycles } = useQuery({
    queryKey: ["pj_cycles", projectId],
    queryFn: () => fetchCycles(projectId),
  });

  // Seuls les cycles à venir ou en cours peuvent recevoir : transférer vers un
  // cycle déjà clos ne ferait que déplacer le problème.
  const candidates = (cycles ?? []).filter((c) => {
    if (c.id === cycle.id) return false;
    const phase = cyclePhase(c);
    return phase === "current" || phase === "upcoming";
  });

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // En série, avec un compteur : sur trente items, un envoi parallèle sature
      // la connexion et l'utilisateur n'a aucun retour pendant l'attente.
      for (const [index, issue] of pending.entries()) {
        await setIssueCycle(issue.id, workspaceId, target);
        setProgress(index + 1);
      }
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Transférer les work items non terminés"
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button onClick={run} disabled={busy}>
            <ArrowRightIcon className="mr-1 h-4 w-4" />
            Transférer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
          <p className="text-12 text-secondary">
            <span className="font-medium">{pending.length}</span> work item
            {pending.length > 1 ? "s" : ""} du cycle « {cycle.name} » ne
            {pending.length > 1 ? " sont" : " s'est"} pas terminé
            {pending.length > 1 ? "s" : ""}. Les livrés restent où ils sont —
            les déplacer fausserait le bilan du cycle passé.
          </p>

          <div className="space-y-1">
            {candidates.map((c) => (
              <TargetRow
                key={c.id}
                active={target === c.id}
                onSelect={() => setTarget(c.id)}
                label={c.name}
                hint={
                  c.start_date && c.end_date
                    ? `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`
                    : "Sans dates"
                }
              />
            ))}
            <TargetRow
              active={target === null}
              onSelect={() => setTarget(null)}
              label="Aucun cycle"
              hint="Les items retournent au backlog du projet."
            />
          </div>

          {busy && (
            <p className="text-11 text-muted-foreground">
              Transfert… {progress}/{pending.length}
            </p>
          )}

      </div>
    </Modal>
  );
}

function TargetRow({
  active, onSelect, label, hint,
}: { active: boolean; onSelect: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted",
      )}
    >
      <span className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
        active ? "border-primary" : "border-border",
      )}>
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-13">{label}</span>
        <span className="block text-11 text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
