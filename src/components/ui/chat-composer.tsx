import { cn } from "@/lib/utils";
import { PromptInput } from "./prompt-input";

// A model as accepted by callers (id/name/description). Only `name` is surfaced by
// the underlying PromptInput, which renders the model picker + icons.
interface Model {
  id: string;
  name: string;
  description: string;
}

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
  value,
  onValueChange,
  placeholder = "How can I help you today?",
  models,
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
        models={models?.map((m) => m.name)}
        onSubmit={(message, meta) => {
          // Preserve ChatComposer semantics: don't emit while busy/disabled.
          if (disabled || loading) return;
          if (message.trim() === "") return;
          onSubmit({ message, model: meta.model, thinking: meta.effort !== "Low" });
        }}
      />
      {footerHint && <p className="mt-3 text-center text-xs text-muted-foreground">{footerHint}</p>}
    </div>
  );
}
