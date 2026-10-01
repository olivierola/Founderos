// `confirm()` et `prompt()` natifs, remplacés par la même chose en vrai.
//
// Le produit en comptait plus de cent vingt (avec les `alert()`, partis en
// toasts). Une boîte de dialogue du navigateur, c'est la police du système
// d'exploitation au milieu d'un produit soigné, le nom du domaine en en-tête,
// aucun moyen de nommer l'action autrement que « OK », et un blocage total du
// fil d'exécution. Pour quelqu'un qui évalue le produit avant d'acheter, c'est
// le signal le plus court qu'il reste du provisoire.
//
// Il en fallait des remplaçants qui s'appellent COMME les originaux, sinon la
// conversion aurait demandé de restructurer chaque appelant autour d'un état
// d'ouverture :
//
//     if (!(await confirm("Supprimer ce garde-fou ?"))) return;
//     const motif = await promptText("Motif du rejet (optionnel) :");
//
// D'où des promesses. Le hook rend une fonction qui ouvre le dialogue et se
// résout au clic. La forme de l'appelant ne change pas — seul le `await`
// s'ajoute, et TypeScript signale les endroits où la fonction englobante doit
// devenir `async`.

import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { PromptDialog } from "./PromptDialog";

export interface ConfirmOptions {
  /** La question. Courte, à la deuxième personne. */
  title: string;
  /** Ce qu'il faut savoir avant de trancher — notamment l'irréversible. */
  description?: string;
  /** Le libellé du bouton d'action. « Supprimer » vaut mieux que « OK ». */
  confirmText?: string;
  /** Rouge par défaut : ces dialogues gardent presque toujours une destruction. */
  destructive?: boolean;
  /** Exige de retaper ce texte — pour ce qui ne se rattrape pas. */
  typeToConfirm?: string;
}

/** Une saisie libre. Rend `null` si on renonce, exactement comme `prompt()`. */
export interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
}

type Ask = (opts: ConfirmOptions | string) => Promise<boolean>;
type AskText = (opts: PromptOptions | string) => Promise<string | null>;

const Ctx = createContext<Ask | null>(null);
const TextCtx = createContext<AskText | null>(null);

const joined = (o: { title: string; description?: string }) =>
  [o.title, o.description].filter(Boolean).join("\n\n");

/* Hors du provider (une page publique, un test), on retombe sur le dialogue
   natif plutôt que de casser : mieux vaut laid que bloquant. */
const FALLBACK: Ask = async (opts) =>
  window.confirm(typeof opts === "string" ? opts : joined(opts));

const TEXT_FALLBACK: AskText = async (opts) =>
  window.prompt(
    typeof opts === "string" ? opts : joined(opts),
    typeof opts === "string" ? "" : (opts.initialValue ?? ""),
  );

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [confirmOpts, setConfirmOpts] = useState<ConfirmOptions | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promptOpts, setPromptOpts] = useState<PromptOptions | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  // Les promesses en attente. Des refs plutôt que du state : les résoudre ne
  // doit pas provoquer de rendu, et elles doivent survivre à ceux que le
  // dialogue provoque.
  const pendingConfirm = useRef<((v: boolean) => void) | null>(null);
  const pendingPrompt = useRef<((v: string | null) => void) | null>(null);

  const settleConfirm = useCallback((value: boolean) => {
    const resolve = pendingConfirm.current;
    pendingConfirm.current = null;
    resolve?.(value);
  }, []);

  const settlePrompt = useCallback((value: string | null) => {
    const resolve = pendingPrompt.current;
    pendingPrompt.current = null;
    resolve?.(value);
  }, []);

  const ask = useCallback<Ask>((input) => {
    // Une demande qui en écrase une autre : l'ancienne se résout en « non ».
    // Laisser sa promesse pendante gèlerait l'appelant pour de bon.
    settleConfirm(false);
    setConfirmOpts(typeof input === "string" ? { title: input } : input);
    setConfirmOpen(true);
    return new Promise<boolean>((resolve) => { pendingConfirm.current = resolve; });
  }, [settleConfirm]);

  const askText = useCallback<AskText>((input) => {
    settlePrompt(null);
    setPromptOpts(typeof input === "string" ? { title: input } : input);
    setPromptOpen(true);
    return new Promise<string | null>((resolve) => { pendingPrompt.current = resolve; });
  }, [settlePrompt]);

  // Fermé autrement que par le bouton d'action (Échap, clic dehors, croix) :
  // c'est un refus.
  const onConfirmOpenChange = useCallback((next: boolean) => {
    setConfirmOpen(next);
    if (!next) settleConfirm(false);
  }, [settleConfirm]);

  const onPromptOpenChange = useCallback((next: boolean) => {
    setPromptOpen(next);
    if (!next) settlePrompt(null);
  }, [settlePrompt]);

  const askValue = useMemo(() => ask, [ask]);
  const askTextValue = useMemo(() => askText, [askText]);

  return (
    <Ctx.Provider value={askValue}>
      <TextCtx.Provider value={askTextValue}>
        {children}

        {confirmOpts && (
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={onConfirmOpenChange}
            title={confirmOpts.title}
            description={confirmOpts.description}
            confirmText={confirmOpts.confirmText ?? "Confirmer"}
            destructive={confirmOpts.destructive ?? true}
            typeToConfirm={confirmOpts.typeToConfirm}
            onConfirm={() => {
              // On résout AVANT la fermeture : l'appelant reprend la main tout
              // de suite, et son propre indicateur de chargement prend le relais.
              settleConfirm(true);
              setConfirmOpen(false);
            }}
          />
        )}

        {promptOpts && (
          <PromptDialog
            open={promptOpen}
            onOpenChange={onPromptOpenChange}
            title={promptOpts.title}
            description={promptOpts.description}
            label={promptOpts.label}
            placeholder={promptOpts.placeholder}
            initialValue={promptOpts.initialValue ?? ""}
            confirmText={promptOpts.confirmText ?? "Valider"}
            onSubmit={(value) => {
              settlePrompt(value);
              setPromptOpen(false);
            }}
          />
        )}
      </TextCtx.Provider>
    </Ctx.Provider>
  );
}

export function useConfirm(): Ask {
  return useContext(Ctx) ?? FALLBACK;
}

/** Nommé `promptText` et non `prompt` : `prompt` est déjà pris par le vocabulaire
 *  du produit (le prompt d'un agent), et un appelant qui lit `await prompt(...)`
 *  dans ce dépôt penserait à un modèle, pas à une saisie. */
export function usePromptText(): AskText {
  return useContext(TextCtx) ?? TEXT_FALLBACK;
}
