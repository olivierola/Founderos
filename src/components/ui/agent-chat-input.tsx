import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowElbowDownLeftIcon as ArrowElbowDownLeft,
  WaveformIcon as Waveform,
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
const RADIUS = 16;
// Text-like files the "+" can attach: read in the browser and sent as a
// fenced block, the same way a long paste is.
const ATTACH_ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.html,.log,.sql,.js,.ts,.tsx,.py";
const ATTACH_MAX_BYTES = 400_000;

interface PastedBlock { id: string; label: string; text: string }

// The controls under the card: bare icons, no pill — the card is the only
// surface; what sits below it reads as a toolbar, not as more buttons.
const BARE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition-colors "
  + "hover:bg-muted/60 hover:text-foreground";

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
  /** Context the host attached (the browser panel's page, selection, element),
   *  shown as chips inside the card next to pasted blocks. The host owns them:
   *  it decides what they mean when the message is sent. */
  chips?: React.ReactNode;
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
  chips,
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
    <div className={cn("mx-auto w-full max-w-[720px]", className)}>
      {/* ── La carte : le champ seul, et la touche d'envoi (↵) à droite ── */}
      <VoiceComposer
        stream={dictation.stream}
        processing={busy || dictation.connecting}
        radius={RADIUS}
        idle={0.32}
        reach={1.4}
      >
        <div
          className="relative flex w-full cursor-text flex-col border border-border/70 bg-card shadow-[0_6px_24px_rgba(0,0,0,0.14)]"
          style={{ borderRadius: RADIUS }}
          onMouseDown={(e) => {
            // Clicking the card's padding focuses the field, like a real input.
            if (e.target === e.currentTarget) { e.preventDefault(); taRef.current?.focus(); }
          }}
        >
          {(blocks.length > 0 || chips) && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {chips}
              {blocks.map((b) => (
                <span
                  key={b.id}
                  className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border border-border/70 bg-muted/60 py-1 pl-2.5 pr-1 text-xs text-foreground/80"
                >
                  <TextIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{b.label}</span>
                  <button
                    type="button"
                    onClick={() => setBlocks((all) => all.filter((x) => x.id !== b.id))}
                    className="rounded-md p-0.5 hover:bg-foreground/10 hover:text-foreground"
                    aria-label={`Retirer ${b.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 pl-5 pr-2.5">
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
              className="block max-h-[220px] min-h-[52px] min-w-0 flex-1 resize-none border-0 bg-transparent py-[14px] text-[15px] leading-6 text-foreground placeholder:text-muted-foreground"
            />
            {showStop ? (
              <button
                type="button"
                onClick={onStop}
                title="Arrêter le run"
                aria-label="Arrêter le run"
                className="mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted"
              >
                <Stop weight="fill" className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                title="Envoyer (Entrée)"
                aria-label="Envoyer"
                className={cn(
                  "mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                  canSend ? "text-foreground hover:bg-muted" : "cursor-default text-muted-foreground/60",
                )}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowElbowDownLeft className="h-[18px] w-[18px]" />}
              </button>
            )}
          </div>
        </div>
      </VoiceComposer>

      {/* ── Sous la carte : joindre, dicter · l'avertissement · le modèle ── */}
      <div className="mt-2 flex items-center gap-0.5 px-1">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Joindre un fichier texte"
          aria-label="Joindre un fichier texte"
          className={BARE}
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
        <button
          type="button"
          onClick={toggleMic}
          title={dictation.recording ? "Arrêter la dictée" : "Dicter"}
          aria-label={dictation.recording ? "Arrêter la dictée" : "Dicter un message"}
          className={cn(BARE, dictation.recording && "bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive")}
        >
          {dictation.connecting
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : dictation.recording ? <Square weight="fill" className="h-3.5 w-3.5" /> : <Mic className="h-[18px] w-[18px]" />}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="Voix" aria-label="Options de voix" className={cn(BARE, "w-auto gap-0.5 px-1.5")}>
              <Waveform className="h-[18px] w-[18px]" />
              <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 rounded-xl">
            <DropdownMenuItem onClick={toggleMic} className="gap-2">
              <Mic className="h-4 w-4" />
              {dictation.recording ? "Arrêter la dictée" : "Dicter un message"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled className="text-[11px] text-muted-foreground">
              La transcription s'écrit dans le champ pendant que vous parlez.
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className={cn(
          "min-w-0 flex-1 truncate px-2 text-center text-[12.5px]",
          hint ? "text-destructive" : "hidden text-muted-foreground sm:block",
        )}>
          {hint ?? "L'IA peut commettre des erreurs."}
        </span>
        {!hint && <span className="flex-1 sm:hidden" />}

        {models.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={models.length < 2}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13.5px] transition-colors hover:bg-muted/60 disabled:pointer-events-none"
                title={model?.description}
              >
                <span className="font-medium text-foreground">{model?.name ?? "Modèle"}</span>
                {model?.level && <span className="text-muted-foreground">{model.level}</span>}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 rounded-xl">
              {models.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => setModelId(m.id)} className="items-start gap-2 rounded-lg">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      {m.name}{m.level && <span className="ml-1.5 text-muted-foreground">{m.level}</span>}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{m.description}</span>
                  </span>
                  {m.id === modelId && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
