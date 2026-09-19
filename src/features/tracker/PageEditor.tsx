import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactPlateEditor } from "@/features/artifacts/PlateEditor";
import { richValueToText, slateToMarkdown } from "@/features/artifacts/shared";
import { cn } from "@/lib/utils";

/**
 * L'éditeur d'une page du suivi de travail.
 *
 * Il réutilise l'éditeur Plate du produit — barre d'outils, tableaux, blocs de
 * code, commandes slash, IA ancrée sur la base de connaissances — plutôt que
 * d'en réimplémenter un. Un second éditeur voudrait dire deux jeux de
 * raccourcis, deux comportements de collage et deux endroits où corriger le
 * même bug de liste imbriquée.
 *
 * L'enregistrement est DIFFÉRÉ d'une seconde et demie après la dernière frappe.
 * Écrire à chaque touche produirait une requête par caractère ; n'écrire qu'à
 * la fermeture perdrait le travail d'un onglet fermé par accident. Une seconde
 * et demie est le compromis : assez pour regrouper une phrase, assez court pour
 * qu'on ne perde jamais plus que ce qu'on vient de taper.
 */
export function PageEditor({
  value, onSave, readOnly, placeholder, workspaceId, projectId, className,
}: {
  /** L'arbre Plate, ou du texte pour une page écrite avant l'éditeur riche. */
  value: unknown;
  /** Reçoit l'arbre ET son rendu texte : le second alimente recherche et exports. */
  onSave: (rich: unknown[], text: string, markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  className?: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<unknown[] | null>(null);

  const flush = useCallback(() => {
    if (!pending.current) return;
    const rich = pending.current;
    pending.current = null;
    onSave(rich, richValueToText(rich), slateToMarkdown(rich as any[]));
  }, [onSave]);

  // Un dernier enregistrement au démontage : quitter la page ne doit pas
  // emporter la frappe des 1,5 dernières secondes.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    flush();
  }, [flush]);

  const handleChange = useCallback((next: unknown[]) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1500);
  }, [flush]);

  return (
    <ArtifactPlateEditor
      value={value}
      onChange={readOnly ? undefined : handleChange}
      placeholder={placeholder ?? "Commencez à écrire…"}
      workspaceId={workspaceId}
      projectId={projectId}
      className={cn("h-full", className)}
      editorClassName={cn(readOnly && "pointer-events-none opacity-90")}
    />
  );
}

/**
 * L'indicateur d'enregistrement.
 *
 * Il montre trois états et pas deux : « Enregistré » rassure, « Enregistrement »
 * explique un délai, et l'absence des deux dit qu'il n'y a rien à enregistrer.
 * Un composant qui n'afficherait que « Enregistré » en permanence ne
 * distinguerait pas « c'est fait » de « ça n'a pas encore commencé ».
 */
export function SaveState({ state }: { state: "idle" | "saving" | "saved" }) {
  if (state === "idle") return null;
  return (
    <span className={cn(
      "text-11 transition-opacity",
      state === "saving" ? "text-muted-foreground" : "text-muted-foreground/70",
    )}>
      {state === "saving" ? "Enregistrement…" : "Enregistré"}
    </span>
  );
}

/** Le va-et-vient d'état d'enregistrement, partagé par les deux écrans. */
export function useSaveState() {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const begin = useCallback(() => setState("saving"), []);
  const done = useCallback(() => {
    setState("saved");
    if (timer.current) clearTimeout(timer.current);
    // « Enregistré » s'efface au bout de deux secondes : un indicateur permanent
    // devient un élément d'interface qu'on cesse de voir, donc inutile.
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { state, begin, done };
}
