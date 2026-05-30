import { useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, ChevronDown, Loader2, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Model {
  id: string;
  name: string;
  description: string;
}

const DEFAULT_MODELS: Model[] = [
  { id: "opus-4.5", name: "Opus 4.5", description: "Most capable for complex work" },
  { id: "sonnet-4.5", name: "Sonnet 4.5", description: "Best for everyday tasks" },
  { id: "haiku-4.5", name: "Haiku 4.5", description: "Fastest for quick answers" },
];

interface ModelSelectorProps {
  models: Model[];
  selectedModel: string;
  onSelect: (id: string) => void;
}

function ModelSelector({ models, selectedModel, onSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === selectedModel) ?? models[0];

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors",
          open
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )}
      >
        <span>{current.name}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onSelect(m.id);
                setOpen(false);
              }}
              className="flex w-full items-start justify-between rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-foreground">{m.name}</span>
                <span className="text-[11px] text-muted-foreground">{m.description}</span>
              </div>
              {selectedModel === m.id && <Check className="mt-1 h-4 w-4 text-[hsl(var(--primary-soft))]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  models?: Model[];
  footerHint?: string;
}

export function ChatComposer({
  onSubmit,
  disabled = false,
  loading = false,
  value,
  onValueChange,
  placeholder = "How can I help you today?",
  models = DEFAULT_MODELS,
  footerHint,
}: ChatComposerProps) {
  const [internal, setInternal] = useState("");
  const message = value ?? internal;
  const setMessage = (v: string) => {
    if (onValueChange) onValueChange(v);
    else setInternal(v);
  };

  const [selectedModel, setSelectedModel] = useState(models[1]?.id ?? models[0].id);
  const [thinking, setThinking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 384) + "px";
  }, [message]);

  const hasContent = message.trim().length > 0;

  const handleSend = () => {
    if (!hasContent || disabled || loading) return;
    onSubmit({ message: message.trim(), model: selectedModel, thinking });
    setMessage("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative mx-auto w-full max-w-2xl">
      <div className="flex flex-col rounded-2xl border border-border bg-card shadow-[0_0_15px_rgba(0,0,0,0.06)] transition-shadow focus-within:shadow-[0_0_25px_rgba(0,0,0,0.12)]">
        <div className="flex flex-col gap-2 px-3 pb-2 pt-3">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            autoFocus
            disabled={disabled}
            className="block w-full resize-none border-0 bg-transparent px-1 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
            style={{ minHeight: "1.5em", maxHeight: "24rem" }}
          />

          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-1">
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Add"
                disabled
              >
                <Plus className="h-5 w-5" />
              </button>

              <button
                type="button"
                onClick={() => setThinking((v) => !v)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
                  thinking
                    ? "bg-[hsl(var(--primary-soft)/0.15)] text-[hsl(var(--primary-soft))]"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
                aria-pressed={thinking}
                aria-label="Extended thinking"
              >
                <Brain className="h-4 w-4" />
                <span className="hidden sm:inline">Thinking</span>
              </button>
            </div>

            <div className="flex items-center gap-1">
              <ModelSelector models={models} selectedModel={selectedModel} onSelect={setSelectedModel} />
              <button
                type="button"
                onClick={handleSend}
                disabled={!hasContent || disabled || loading}
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors",
                  hasContent && !disabled && !loading
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-primary/30 text-primary-foreground/60 cursor-not-allowed",
                )}
                aria-label="Send message"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {footerHint && <p className="mt-3 text-center text-xs text-muted-foreground">{footerHint}</p>}
    </div>
  );
}
