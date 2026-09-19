import { cn } from "@/lib/utils";
import { AgentChatInput } from "./agent-chat-input";
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
  /** A run is already active: the voice beam sweeps and send becomes stop. */
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
 * ChatComposer is the thin adapter every agent chat and the internal SaaS
 * assistant go through. It renders {@link AgentChatInput} — the voice-glow
 * chat input — and keeps its public API stable for existing call sites.
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
  // The real list: a picker offering models we don't run is worse than none.
  models = CHAT_MODELS,
  footerHint,
  className,
}: ChatComposerProps) {
  return (
    <div className={cn("mx-auto flex w-full max-w-2xl flex-col items-center", className)}>
      <AgentChatInput
        value={value}
        onChange={onValueChange}
        placeholder={placeholder}
        busy={running ?? loading}
        onStop={onStop}
        disabled={disabled || loading}
        models={models}
        onSubmit={(message, model) => {
          if (message.trim() === "") return;
          onSubmit({ message, model, thinking: true });
        }}
      />
      {footerHint && <p className="mt-3 text-center text-xs text-muted-foreground">{footerHint}</p>}
    </div>
  );
}
