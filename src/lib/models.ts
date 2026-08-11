// The models our chats actually run on — one list, used by every composer.
//
// These are REAL provider model ids: a composer sends the id straight to the
// backend (internal-agent-run / ai-agent-chat), which pins the turn on it.
//
// Groq's small models are deliberately absent, and banned server-side too (see
// sanitizeModel in supabase/functions/_shared/model-router.ts):
// `llama-3.1-8b-instant` is capped at 6 000 tokens per minute on the on-demand
// tier, so any turn carrying a real toolbox dies on a 413 "Request too large".

export interface ChatModel {
  /** Provider model id, sent as-is to the backend. */
  id: string;
  /** Shown in the composer's picker. */
  name: string;
  description: string;
}

export const CHAT_MODELS: ChatModel[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V4",
    description: "Par défaut — raisonnement et tool calling solides",
  },
  {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B (Groq)",
    description: "Plus rapide, pour les échanges courts",
  },
];

export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;
