// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/llm-context.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Qui appelle le modèle : l'agent, la personne pour qui il agit, le run.
//
// La passerelle LLM de l'installation dédiée (LiteLLM) en a besoin à chaque
// appel : la clé virtuelle de l'agent porte son budget, le champ `user` celui de
// la personne, et les métadonnées relient l'appel au run dans les journaux. Les
// fonctions de ai.ts sont appelées depuis des dizaines d'endroits : plutôt que
// de faire descendre ces informations partout, le run les pose dans un contexte
// asynchrone que postChat relit.
//
// Le stockage (AsyncLocalStorage) est fourni par le backend Node
// (backend/src/compat/index.ts). Sous Deno, il n'existe pas : withLlmCaller
// exécute simplement la fonction, et rien n'est transmis — l'instance SaaS n'a
// pas de passerelle à renseigner.

export interface LlmCaller {
  agentId?: string;
  agentName?: string;
  /** Utilisateur FounderOS pour qui l'agent agit ; null : exécution planifiée. */
  userId?: string | null;
  runId?: string | null;
}

interface CallerStore {
  run<R>(store: LlmCaller, fn: () => R): R;
  getStore(): LlmCaller | undefined;
}

const store = (): CallerStore | undefined => (globalThis as { __llmCallerStore?: CallerStore }).__llmCallerStore;

/** Exécute `fn` dans un contexte d'appel neuf. */
export function withLlmCaller<R>(caller: LlmCaller, fn: () => R): R {
  const s = store();
  return s ? s.run({ ...caller }, fn) : fn();
}

/** Complète le contexte courant, dès que le run connaît l'agent ou la personne. */
export function setLlmCaller(patch: LlmCaller): void {
  const current = store()?.getStore();
  if (current) Object.assign(current, patch);
}

export function currentLlmCaller(): LlmCaller | undefined {
  return store()?.getStore();
}
