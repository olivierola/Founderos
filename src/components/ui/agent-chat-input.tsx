import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpIcon as ArrowUp,
  StopIcon as Stop,
  MicrophoneIcon as Mic,
  SquareIcon as Square,
  CircleNotchIcon as Loader2,
  CaretDownIcon as ChevronDown,
  CheckIcon as Check,
  TextAlignLeftIcon as TextIcon,
  PlusIcon as Plus,
  XIcon as X,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceComposer } from "@/components/ui/composer-voice-glow";
import { useDictation } from "@/lib/useDictation";
import type { ChatModel } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * The agents' and the assistant's chat input, built on voice-glow.
 *
 *   <VoiceBeam stream={mic.stream} processing={thinking}>
 *     <ChatInput />
 *   </VoiceBeam>
 *
 * A frosted-glass card, always open, wrapped whole by the beam: it breathes at
 * rest, rises with the voice while dictating (Deepgram streaming — the
 * transcript lands in the field as you speak) and sweeps the edge while the
 * agent works. The bottom row is a row of glass pills: attach, then the
 * model, the mic and send — which turns into stop while a run is live.
 */

// Pastes this long become a chip (sent as a fenced block) instead of flooding
// the field: the question stays readable above the material.
const PASTE_CHIP_CHARS = 1200;
const RADIUS = 24;
// Text-like files the "+" can attach: read in the browser and sent as a
// fenced block, the same way a long paste is.
const ATTACH_ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.html,.log,.sql,.js,.ts,.tsx,.py";
const ATTACH_MAX_BYTES = 400_000;

interface PastedBlock { id: string; label: string; text: string }

// One glass pill style for every control of the bottom row.
const GLASS =
  "border border-foreground/10 bg-foreground/[0.06] text-foreground/80 transition-colors "
  + "hover:bg-foreground/[0.11] hover:text-foreground";

export interface AgentChatInputProps {
  value?: string;
  onChange?: (value: string) => void;
  /** Receives the final text (pasted / attached blocks appended) and the picked model id. */
  onSubmit: (message: string, modelId: string) => void;
  placeholder?: string;
  /** A run / reply is in progress: the beam sweeps; send is blocked. */
  busy?: boolean;
  /** Cancel the run in flight — the send button becomes stop while busy. */
  onStop?: () => void;
  /** Blocks sending (the field stays editable). */
  disabled?: boolean;
  models?: ChatModel[];
  className?: string;
}

export function AgentChatInput({
  value: controlled,
  onChange,
  onSubmit,
  placeholder = "Écrivez votre message…",
  busy = false,
  onStop,
  disabled = false,
  models = [],
  className,
}: AgentChatInputProps) {
  const [local, setLocal] = useState("");
  const value = controlled ?? local;
  const setValue = useCallback((v: string) => {
    if (controlled === undefined) setLocal(v);
    onChange?.(v);
  }, [controlled, onChange]);
  const valueRef = useRef(value); valueRef.current = value;

  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === modelId)) setModelId(models[0].id);
  }, [models, modelId]);
  const model = models.find((m) => m.id === modelId);

  const [blocks, setBlocks] = useState<PastedBlock[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const addBlock = (label: string, text: string) =>
    setBlocks((b) => [...b, { id: Math.random().toString(36).slice(2), label, text }]);

  // Dictation: the live transcript is appended to what was typed before.
  const baseRef = useRef("");
  const dictation = useDictation((d) => {
    const base = baseRef.current;
    setValue(base + (base && d ? " " : "") + d);
  });
  const listening = dictation.recording || dictation.connecting;
  const toggleMic = () => {
    if (listening) { dictation.stop(); return; }
    baseRef.current = valueRef.current.trimEnd();
    void dictation.start();
  };

  // Auto-grow up to a ceiling, then scroll.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const hasContent = value.trim().length > 0 || blocks.length > 0;
  const canSend = hasContent && !busy && !disabled;
  const showStop = busy && !!onStop && !hasContent;

  const submit = () => {
    if (!canSend) return;
    if (listening) dictation.stop();
    const extra = blocks.map((b) => "```text\n" + b.text + "\n```").join("\n\n");
    onSubmit([value.trim(), extra].filter(Boolean).join("\n\n"), modelId);
    setValue("");
    setBlocks([]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (text.length < PASTE_CHIP_CHARS) return;
    e.preventDefault();
    addBlock(`Texte collé · ${text.split("\n").length} lignes`, text);
  };

  const onFiles = async (list: FileList | null) => {
    setAttachError(null);
    for (const f of Array.from(list ?? [])) {
      if (f.size > ATTACH_MAX_BYTES) { setAttachError(`« ${f.name} » dépasse 400 ko`); continue; }
      try { addBlock(f.name, await f.text()); } catch { setAttachError(`« ${f.name} » illisible`); }
    }
  };

  const hint = attachError ?? dictation.error;

  return (
    <VoiceComposer
      stream={dictation.stream}
      processing={busy || dictation.connecting}
      radius={RADIUS}
      idle={0.42}
      reach={1.5}
      className={cn("mx-auto w-full max-w-[600px]", className)}
    >
      <div
        className="relative flex w-full cursor-text flex-col border border-foreground/10 bg-foreground/[0.04] shadow-[0_8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl"
        style={{ borderRadius: RADIUS }}
        onMouseDown={(e) => {
          // Clicking the card's padding focuses the field, like a real input.
          if (e.target === e.currentTarget) { e.preventDefault(); taRef.current?.focus(); }
        }}
      >
        {blocks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3.5">
            {blocks.map((b) => (
              <span
                key={b.id}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/[0.06] py-1 pl-2.5 pr-1 text-xs text-foreground/75"
              >
                <TextIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{b.label}</span>
                <button
                  type="button"
                  onClick={() => setBlocks((all) => all.filter((x) => x.id !== b.id))}
                  className="rounded-full p-0.5 hover:bg-foreground/10 hover:text-foreground"
                  aria-label={`Retirer ${b.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
          placeholder={listening ? "Je vous écoute…" : placeholder}
          aria-label={placeholder}
          // The card is the field: no focus ring of its own. Inline, because
          // the apple skin draws an outline on every textarea:focus-visible
          // with a selector no utility class outranks.
          style={{ outline: "none", boxShadow: "none" }}
          className="block max-h-[200px] min-h-[48px] w-full resize-none border-0 bg-transparent px-5 pb-1 pt-4 text-[15px] leading-6 text-foreground placeholder:text-foreground/35"
        />

        <div className="flex items-center gap-2 px-3 pb-3 pt-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Joindre un fichier texte"
            aria-label="Joindre un fichier texte"
            className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", GLASS)}
          >
            <Plus className="h-[18px] w-[18px]" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
          />

          <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-destructive">{hint}</span>

          {models.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn("flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium", GLASS)}
                >
                  {model?.name ?? "Modèle"}
                  <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {models.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => setModelId(m.id)} className="items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{m.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{m.description}</span>
                    </span>
                    {m.id === modelId && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : model ? (
            <span className={cn("flex h-10 items-center rounded-full px-4 text-sm font-medium", GLASS)}>{model.name}</span>
          ) : null}

          <button
            type="button"
            onClick={toggleMic}
            title={dictation.recording ? "Arrêter la dictée" : "Dicter"}
            aria-label={dictation.recording ? "Arrêter la dictée" : "Dicter un message"}
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              dictation.recording ? "border border-destructive/30 bg-destructive/15 text-destructive" : GLASS,
            )}
          >
            {dictation.connecting
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : dictation.recording ? <Square weight="fill" className="h-3.5 w-3.5" /> : <Mic className="h-[18px] w-[18px]" />}
          </button>

          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              title="Arrêter le run"
              aria-label="Arrêter le run"
              className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", GLASS)}
            >
              <Stop weight="fill" className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              title="Envoyer"
              aria-label="Envoyer"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
                canSend
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : cn(GLASS, "cursor-default text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/40"),
              )}
            >
              <ArrowUp weight="bold" className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </VoiceComposer>
  );
}
