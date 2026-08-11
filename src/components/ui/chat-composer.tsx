import { cn } from "@/lib/utils";
import { PromptInput } from "./prompt-input";
import { CHAT_MODELS, type ChatModel as Model } from "@/lib/models";

export interface ChatComposerSubmit {
  message: string;
  model: string;
  thinking: boolean;
}

interface ChatComposerProps {
  onSubmit: (data: ChatComposerSubmit) => void;
  disabled?: boolean;
  loading?: boolean;
  /** A run is already active: spins an accent border and keeps the input open. */
  running?: boolean;
  /** Cancel the active run from the composer itself. */
  onStop?: () => void;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  models?: Model[];
  footerHint?: string;
  /** Override the outer container width (defaults to a centered max-w-2xl). */
  className?: string;
}

/**
 * ChatComposer is a thin adapter over {@link PromptInput} so every agent chat and
 * the internal SaaS assistant share the same rich prompt input (expand-on-focus,
 * model/effort pickers, image attachments, voice-to-text). The public API is kept
 * stable for existing call sites.
 */
export function ChatComposer({
  onSubmit,
  disabled = false,
  loading = false,
  running,
  onStop,
  value,
  onValueChange,
  placeholder = "How can I help you today?",
  // Default to the real list: PromptInput's own fallback is a demo list of
  // models we don't run, and a picker that lies is worse than no picker.
  models = CHAT_MODELS,
  footerHint,
  className,
}: ChatComposerProps) {
  return (
    <div className={cn("mx-auto flex w-full max-w-2xl flex-col items-center", className)}>
      <PromptInput
        value={value}
        onChange={onValueChange}
        placeholder={placeholder}
        busy={running ?? loading}
        onStop={onStop}
        models={models?.map((m) => m.name)}
        onSubmit={(message, meta) => {
          // Preserve ChatComposer semantics: don't emit while busy/disabled.
          if (disabled || loading) return;
          if (message.trim() === "") return;
          // PromptInput only knows display names; callers need the model ID they
          // declared, which is what the backend routes on.
          const picked = models?.find((m) => m.name === meta.model);
          onSubmit({ message, model: picked?.id ?? meta.model, thinking: meta.effort !== "Low" });
        }}
      />
      {footerHint && <p className="mt-3 text-center text-xs text-muted-foreground">{footerHint}</p>}
    </div>
  );
}
