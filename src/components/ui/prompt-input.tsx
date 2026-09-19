"use client";

import * as React from "react";
import { useRef, useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useDictation } from "@/lib/useDictation";
import { VoiceComposer } from "@/components/ui/composer-voice-glow";

// Dictation runs through the shared streaming hook (useDictation): live Deepgram
// transcription over a WebSocket, with the text appearing in the composer as you
// speak. Push-to-talk (hold Space) is an opt-in persisted here.
const PTT_PREF_KEY = "fos-dictation-ptt";

// ----------------------------------------------------------------------
// Tagging (@ mentions) + / slash actions — opt-in, gated behind props so the
// default composer (agent chats) is unchanged.
// ----------------------------------------------------------------------
export interface MentionAgent { id: string; name: string; accentColor?: string | null; connectors?: string[]; }
export interface SlashCommand { key: string; label: string; color: string; icon?: React.ComponentType<{ className?: string }>; }

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Soft colored pill. Negative margins keep the padded background from changing
// the glyph advance, so the backdrop stays aligned with the transparent textarea.
function badgePillStyle(color?: string | null): React.CSSProperties {
  const base: React.CSSProperties = { padding: "1px 4px", margin: "0 -4px", borderRadius: 5, fontWeight: 500 };
  if (color && /^#([0-9a-f]{6})$/i.test(color)) return { ...base, color, backgroundColor: color + "26" };
  return { ...base, color: "hsl(var(--primary))", backgroundColor: "hsl(var(--primary) / 0.15)" };
}

// Mirror of the text with @mentions and /slash tokens rendered as colored badges.
function highlightComposer(value: string, agents: MentionAgent[], slash: SlashCommand[]): React.ReactNode[] {
  const names = agents.map((a) => a.name).sort((a, b) => b.length - a.length).map(reEsc);
  const labels = slash.map((s) => s.label).map(reEsc);
  const pats: string[] = [];
  if (names.length) pats.push(`@(?:${names.join("|")})\\b`);
  if (labels.length) pats.push(`(?<=^|\\s)/(?:${labels.join("|")})\\b`);
  if (!pats.length) return [value + "​"];
  const colorByName = new Map(agents.map((a) => [a.name, a.accentColor]));
  const colorByLabel = new Map(slash.map((s) => [s.label, s.color]));
  const re = new RegExp(pats.join("|"), "g");
  const out: React.ReactNode[] = [];
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push(value.slice(last, m.index));
    const tok = m[0];
    const color = tok.startsWith("@") ? colorByName.get(tok.slice(1)) : colorByLabel.get(tok.slice(1));
    out.push(<span key={i++} style={badgePillStyle(color)}>{tok}</span>);
    last = m.index + tok.length;
  }
  out.push(value.slice(last) + "​"); // zero-width char preserves the last line height
  return out;
}

function deriveMentionIds(value: string, agents: MentionAgent[]): string[] {
  if (!agents.length || !value) return [];
  const idByName = new Map(agents.map((a) => [a.name, a.id]));
  const re = new RegExp(`@(${agents.map((a) => reEsc(a.name)).join("|")})\\b`, "g");
  const out: string[] = []; const seen = new Set<string>(); let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) { const id = idByName.get(m[1]); if (id && !seen.has(id)) { seen.add(id); out.push(id); } }
  return out;
}

// ----------------------------------------------------------------------
// Transition Physics
// ----------------------------------------------------------------------
const SPRING_TRANSITION = "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
const SMOOTH_HEIGHT_TRANSITION = "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.15s ease-out";

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------
interface Attachment {
  id: string;
  file: File;
  url: string;
  name: string;
  width?: number;
  height?: number;
}

// A paste larger than either threshold collapses into a block chip instead of
// flooding the input; it's re-inlined as a fenced ```text block on submit.
interface PastedBlock {
  id: string;
  text: string;
  lines: number;
  chars: number;
}
const PASTE_BLOCK_MIN_CHARS = 1500;
const PASTE_BLOCK_MIN_LINES = 20;

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------
function MorphingText({ text }: { text: string }) {
  const [width, setWidth] = useState<number | "auto">("auto");
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (spanRef.current) {
      setWidth(spanRef.current.offsetWidth);
    }
  }, [text]);

  return (
    <span
      className="relative inline-flex items-center justify-center overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]"
      style={{ width }}
    >
      <span ref={spanRef} className="invisible whitespace-nowrap px-1">
        {text}
      </span>
      <span
        key={text}
        className="absolute inset-0 flex items-center justify-center whitespace-nowrap animate-in fade-in zoom-in-95 duration-300"
      >
        {text}
      </span>
    </span>
  );
}

function ModelIcon({ model, className }: { model: string; className?: string }) {
  const icons: Record<string, string> = {
    "Composer 2.5": "https://res.cloudinary.com/drhx7imeb/image/upload/v1781695268/cursor-ai-code-icon_j4vnux.svg",
    "Gemini 3.5 Flash": "https://res.cloudinary.com/drhx7imeb/image/upload/v1781695268/google-gemini-icon_l6kk5q.svg",
    "GPT 5.5": "https://res.cloudinary.com/drhx7imeb/image/upload/v1781695269/openai-icon_zozuib.svg",
    "Opus 4.8": "https://res.cloudinary.com/drhx7imeb/image/upload/v1781695268/Claude_AI_symbol_yqfzlc.svg",
    "GLM 5.2": "https://res.cloudinary.com/drhx7imeb/image/upload/v1781695269/z-ai-icon_xi4xvo.svg"
  };

  const filters: Record<string, string> = {
    "GPT 5.5": "dark:invert",
  };

  return (
    <img
      src={icons[model] || icons["GPT 5.5"]}
      alt={model}
      className={cn("object-contain", filters[model], className)}
    />
  );
}

function ArrowUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 6.6h.01M6 6.6h.01M8 6.6h.01M10 6.6h.01M12 6.6h.01M5 9.4h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function AtSignIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SlashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 20L15 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 2.5L11.5 11.5M11.5 2.5L2.5 11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function DynamicBarsIcon({ level }: { level: string }) {
  const isMediumOrHigh = level === "Medium" || level === "Max Effort";
  const isHigh = level === "Max Effort";

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="8" width="2.5" height="4.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={1} />
      <rect x="5.75" y="5" width="2.5" height="7.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={isMediumOrHigh ? 1 : 0.3} />
      <rect x="10" y="2" width="2.5" height="10.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={isHigh ? 1 : 0.3} />
    </svg>
  );
}

// ----------------------------------------------------------------------
// Attachment Thumbnail
// ----------------------------------------------------------------------
function AttachmentThumb({
  attachment,
  index,
  onRemove,
  onOpen,
  registerRef,
}: {
  attachment: Attachment;
  index: number;
  onRemove: (id: string) => void;
  onOpen: (attachment: Attachment, rect: DOMRect) => void;
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={(el) => {
        btnRef.current = el;
        registerRef(attachment.id, el);
      }}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (btnRef.current) {
          onOpen(attachment, btnRef.current.getBoundingClientRect());
        }
      }}
      style={{ animationDelay: `${index * 35}ms`, animationFillMode: "backwards" }}
      className={cn(
        "group relative size-12 shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none",
        "transition-transform duration-200 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:scale-[1.04] active:scale-[0.96]",
        "animate-in fade-in slide-in-from-top-3 zoom-in-90 duration-400"
      )}
      aria-label={`Open preview of ${attachment.name}`}
    >
      <img src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
      <span className={cn("absolute inset-0 flex items-start justify-end bg-black/0 transition-colors duration-200", isHovered && "bg-black/25")}>
        <span
          role="button" tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onRemove(attachment.id); }}
          className={cn(
            "m-1 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground/70 shadow-sm transition-all duration-200 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:bg-background hover:text-foreground hover:scale-110",
            isHovered ? "opacity-100 scale-100" : "opacity-0 scale-50 pointer-events-none"
          )}
          aria-label={`Remove ${attachment.name}`}
        >
          <CloseIcon />
        </span>
      </span>
    </button>
  );
}

// ----------------------------------------------------------------------
// Shared-Element Gallery Modal
// ----------------------------------------------------------------------
function AttachmentGalleryModal({
  attachment,
  originRect,
  onClose,
}: {
  attachment: Attachment;
  originRect: DOMRect;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"opening" | "open" | "closing">("opening");
  const [targetRect, setTargetRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    radius: number;
  } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const maxW = Math.min(window.innerWidth * 0.86, 560);
    const maxH = Math.min(window.innerHeight * 0.78, 720);

    const naturalW = attachment.width || 800;
    const naturalH = attachment.height || 600;
    const scale = Math.min(maxW / naturalW, maxH / naturalH, 1.6);

    const width = naturalW * scale;
    const height = naturalH * scale;

    setTargetRect({
      top: (window.innerHeight - height) / 2,
      left: (window.innerWidth - width) / 2,
      width,
      height,
      radius: 20,
    });

    const raf = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(raf);
  }, [attachment]);

  const handleClose = useCallback(() => setPhase("closing"), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const isOpen = phase === "open";
  const isClosing = phase === "closing";

  const geometry = isOpen && targetRect
      ? targetRect
      : { top: originRect.top, left: originRect.left, width: originRect.width, height: originRect.height, radius: 12 };

  const animEasing = isClosing ? "ease-out" : "cubic-bezier(0.175, 0.885, 0.32, 1.275)";
  const animDur = isClosing ? "0.3s" : "0.45s";
  const flipTransition = `top ${animDur} ${animEasing}, left ${animDur} ${animEasing}, width ${animDur} ${animEasing}, height ${animDur} ${animEasing}, border-radius ${animDur} ${animEasing}`;

  return (
    <div className="fixed inset-0 z-[100]" onClick={handleClose} role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-md transition-opacity duration-400" style={{ opacity: isOpen ? 1 : 0 }} />
      <div
        style={{
          position: "fixed",
          top: geometry.top, left: geometry.left, width: geometry.width, height: geometry.height,
          borderRadius: geometry.radius, transition: flipTransition, overflow: "hidden",
          boxShadow: isOpen ? "0 24px 60px -12px rgb(0 0 0 / 0.35)" : "0 0px 0px 0px rgb(0 0 0 / 0)",
        }}
        className="bg-muted"
        onTransitionEnd={() => { if (phase === "closing") onClose(); }}
        onClick={(e) => e.stopPropagation()}
      >
        <img ref={imgRef} src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
      </div>

      <button
        type="button" onClick={handleClose}
        style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? "scale(1)" : "scale(0.7)" }}
        className={cn(
          "fixed right-4 top-4 flex size-9 items-center justify-center rounded-full bg-card/90 text-foreground/70 shadow-md backdrop-blur-sm",
          "transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:bg-card hover:text-foreground",
          !isOpen && "pointer-events-none"
        )}
      >
        <span className="scale-150"><CloseIcon /></span>
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------

export interface PromptInputProps {
  onSubmit?: (
    value: string,
    meta: { model: string; effort: string; attachments: File[]; mentionedIds: string[] }
  ) => void;
  placeholder?: string;
  className?: string;
  models?: string[];
  efforts?: string[];
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  maxAttachments?: number;
  /** A run is in progress: keep the input open and spin an accent border around it. */
  busy?: boolean;
  /** Stop the run in flight. When given, the action button becomes a stop
   *  button for as long as `busy` — you cancel where you launched, not in a
   *  menu somewhere else on the page. */
  onStop?: () => void;
  /** Never collapse to the pill — the card stays open (used in rooms). */
  alwaysExpanded?: boolean;
  /** Enable @ tagging: taggable agents (name + accent colour + connector badges). */
  mentionAgents?: MentionAgent[];
  /** Enable / actions as colored badges (e.g. create document/spreadsheet…). */
  slashCommands?: SlashCommand[];
  /** Hide the model picker (irrelevant in rooms). */
  showModelSelect?: boolean;
  /** Hide the effort picker. */
  showEffort?: boolean;
  /** Max width when open (default 480). Rooms want the full column width. */
  maxOpenWidth?: number;
}

export const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      onSubmit,
      placeholder = "Ask anything",
      className,
      models = ["GPT 5.5", "Opus 4.8", "Gemini 3.5 Flash", "Composer 2.5", "GLM 5.2"],
      efforts = ["Low", "Medium", "Max Effort"],
      defaultValue = "",
      value: controlledValue,
      onChange,
      maxAttachments = 6,
      busy = false,
      onStop,
      alwaysExpanded = false,
      mentionAgents = [],
      slashCommands = [],
      showModelSelect = true,
      showEffort = true,
      maxOpenWidth = 480,
    },
    ref
  ) => {
    const [expanded, setExpanded] = useState(alwaysExpanded);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [slashOpen, setSlashOpen] = useState(false);
    const backdropRef = useRef<HTMLDivElement>(null);
    const hasHighlight = mentionAgents.length > 0 || slashCommands.length > 0;
    const [isSmoothResize, setIsSmoothResize] = useState(false);
    const [localValue, setLocalValue] = useState(defaultValue);
    const [selectedModel, setSelectedModel] = useState(models[0]);
    const [effortIndex, setEffortIndex] = useState(1);
    const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);

    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [activeAttachment, setActiveAttachment] = useState<{ attachment: Attachment; rect: DOMRect } | null>(null);
    const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
    const [expandedBlockId, setExpandedBlockId] = useState<string | null>(null);

    // Audio/Voice recording — streaming dictation via the shared useDictation hook.
    const [audioData, setAudioData] = useState<number[]>(new Array(5).fill(0));
    const valueRef = useRef(controlledValue !== undefined ? controlledValue : localValue);
    // The composer text captured when dictation starts; live transcript is appended to it.
    const baselineRef = useRef("");

    // Push-to-talk: hold Space to dictate. Opt-in, persisted in localStorage.
    const [pttEnabled, setPttEnabled] = useState(false);
    useEffect(() => {
      try { setPttEnabled(localStorage.getItem(PTT_PREF_KEY) === "1"); } catch { /* noop */ }
    }, []);
    const togglePtt = useCallback(() => {
      setPttEnabled((v) => {
        const next = !v;
        try { localStorage.setItem(PTT_PREF_KEY, next ? "1" : "0"); } catch { /* noop */ }
        return next;
      });
    }, []);

    const [hoverStyle, setHoverStyle] = useState({ opacity: 0, transform: "translateY(0px) scale(0.95)", transition: "none" });
    const [containerHeight, setContainerHeight] = useState(116);
    const [textareaHeight, setTextareaHeight] = useState(68);
    const [isScrolling, setIsScrolling] = useState(false);

    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : localValue;
    const hasValue = value.trim() !== "" || attachments.length > 0 || pastedBlocks.length > 0;
    const hasAttachments = attachments.length > 0;
    const hasPastedBlocks = pastedBlocks.length > 0;
    // While a run is active (or in rooms) we force the card open (no collapsed pill).
    const isOpen = expanded || busy || alwaysExpanded;
    // Tagged agents derived from the text (so deleting an @mention untags it).
    const mentionedIds = hasHighlight ? deriveMentionIds(value, mentionAgents) : [];

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const internalContainerRef = useRef<HTMLDivElement>(null);
    const topFadeRef = useRef<HTMLDivElement>(null);
    const bottomFadeRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const thumbRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

    // Sync value ref for audio callback closure
    useEffect(() => {
      valueRef.current = value;
    }, [value]);

    const updateFades = () => {
      const el = textareaRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (topFadeRef.current) {
        topFadeRef.current.style.opacity = Math.min(scrollTop / 20, 1).toString();
      }
      if (bottomFadeRef.current) {
        const bottomScroll = scrollHeight - clientHeight - scrollTop;
        bottomFadeRef.current.style.opacity = Math.min(Math.max(bottomScroll - 16, 0) / 10, 1).toString();
      }
    };

    const handleValueChange = useCallback((val: string) => {
      setIsSmoothResize(true);
      if (!isControlled) setLocalValue(val);
      onChange?.(val);
    }, [isControlled, onChange]);
    // Stable handle for the push-to-talk listeners (which shouldn't re-subscribe
    // every render just because onChange is an inline prop).
    const handleValueChangeRef = useRef(handleValueChange);
    handleValueChangeRef.current = handleValueChange;

    // Text change that also drives the @-mention menu (when tagging is enabled).
    const onTextChange = (val: string) => {
      handleValueChange(val);
      if (!mentionAgents.length) return;
      const pos = textareaRef.current?.selectionStart ?? val.length;
      const mm = val.slice(0, pos).match(/(?:^|\s)@(\w*)$/);
      setMentionQuery(mm ? mm[1] : null);
      if (mm) setSlashOpen(false);
    };
    const setValueWithCaret = (next: string, caret: number) => {
      handleValueChange(next);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
      });
    };
    const insertMention = (agent: MentionAgent) => {
      const pos = textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, pos).replace(/@\w*$/, `@${agent.name} `);
      setMentionQuery(null);
      setValueWithCaret(before + value.slice(pos), before.length);
    };
    const openMentionMenu = () => {
      const pos = textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, pos);
      const insert = before.endsWith("@") ? "" : (before && !before.endsWith(" ") ? " @" : "@");
      const nb = before + insert;
      setSlashOpen(false); setMentionQuery("");
      setValueWithCaret(nb + value.slice(pos), nb.length);
    };
    const pickSlash = (cmd: SlashCommand) => {
      const rest = value.replace(new RegExp(`^/(?:${slashCommands.map((s) => reEsc(s.label)).join("|")})\\s+`), "");
      const prefix = `/${cmd.label} `;
      setSlashOpen(false);
      setValueWithCaret(prefix + rest, prefix.length);
    };
    const filteredMentionAgents = mentionQuery == null ? [] : mentionAgents.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));

    const expand = () => {
      setIsSmoothResize(false);
      setExpanded(true);
    };

    // --- Voice Recording Logic (streaming Deepgram dictation) ---
    // The transcript overwrites `baseline + live text` as you speak. The hook
    // object is fresh each render, so route through a ref to keep the start/stop
    // wrappers stable (the unmount-cleanup effect depends on that).
    const onDictatedText = useCallback((dictated: string) => {
      const base = baselineRef.current;
      handleValueChange(base + (base && dictated ? " " : "") + dictated);
    }, [handleValueChange]);
    const dictation = useDictation(onDictatedText);
    const dictationRef = useRef(dictation);
    dictationRef.current = dictation;
    const isRecording = dictation.recording;
    const isConnecting = dictation.connecting;

    const stopRecording = useCallback(() => {
      dictationRef.current.stop();
    }, []);

    const startRecording = useCallback(() => {
      setIsSmoothResize(false);
      setExpanded(true);
      baselineRef.current = (valueRef.current || "").trimEnd();
      void dictationRef.current.start();
    }, []);

    // Drive the 5-bar visualizer off the live mic level.
    useEffect(() => {
      if (!isRecording) { setAudioData(new Array(5).fill(0)); return; }
      const l = dictation.level;
      setAudioData([0.55, 0.85, 1, 0.7, 0.5].map((k) => Math.min(1, l * k * (0.85 + Math.random() * 0.4))));
    }, [dictation.level, isRecording]);

    // Push-to-talk: HOLD Space to dictate (works even when the composer already
    // has text — dictation appends). A quick TAP still types a literal space, so
    // typing isn't broken; only a deliberate hold (>180ms) starts the mic.
    useEffect(() => {
      if (!pttEnabled) return;
      const isEditable = (el: Element | null) =>
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
      const insertSpace = () => {
        const ta = textareaRef.current;
        const v = valueRef.current || "";
        let start = v.length, end = v.length;
        if (ta && ta === document.activeElement) { start = ta.selectionStart ?? v.length; end = ta.selectionEnd ?? start; }
        handleValueChangeRef.current(v.slice(0, start) + " " + v.slice(end));
        if (ta) requestAnimationFrame(() => { try { ta.setSelectionRange(start + 1, start + 1); } catch { /* noop */ } });
      };
      let holdTimer: number | null = null;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== "Space" || e.repeat) return;
        const el = document.activeElement;
        const inOurBox = el === textareaRef.current;
        // Leave OTHER text fields alone; our composer + non-editable focus arm PTT.
        if (isEditable(el) && !inOurBox) return;
        e.preventDefault();
        if (dictationRef.current.recording || dictationRef.current.connecting || holdTimer !== null) return;
        holdTimer = window.setTimeout(() => { holdTimer = null; startRecording(); }, 180);
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code !== "Space") return;
        const el = document.activeElement;
        const inOurBox = el === textareaRef.current;
        if (isEditable(el) && !inOurBox) return;
        if (holdTimer !== null) {
          // Released before the threshold → it was a tap: type a real space.
          window.clearTimeout(holdTimer); holdTimer = null;
          if (inOurBox) insertSpace();
          return;
        }
        if (dictationRef.current.recording || dictationRef.current.connecting) {
          e.preventDefault();
          stopRecording();
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      return () => {
        if (holdTimer !== null) window.clearTimeout(holdTimer);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
      };
    }, [pttEnabled, startRecording, stopRecording]);

    // Keep textarea auto-scrolled to bottom while recording
    useEffect(() => {
      if (isRecording && textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
      }
    }, [value, isRecording]);

    // Ensure cleanup of mic/streams on unmount
    useEffect(() => {
      return () => {
        stopRecording();
        attachments.forEach((a) => URL.revokeObjectURL(a.url));
      };
    }, [stopRecording, attachments]);


    useEffect(() => {
      if ((value.trim() !== "" || hasAttachments || hasPastedBlocks) && !expanded) {
        setIsSmoothResize(false);
        setExpanded(true);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, expanded, hasAttachments, hasPastedBlocks]);

    useEffect(() => {
      if (expanded && !isRecording) {
        const timer = setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            const length = textareaRef.current.value.length;
            textareaRef.current.setSelectionRange(length, length);
          }
        }, 50);
        return () => clearTimeout(timer);
      }
    }, [expanded, isRecording]);

    // ONLY updates height on value/text change. Adding attachments leaves this completely isolated.
    useEffect(() => {
      if (!textareaRef.current) return;
      const el = textareaRef.current;

      const currentHeight = el.style.height;
      el.style.transition = 'none';
      el.style.height = "0px";
      const scrollHeight = el.scrollHeight;
      el.style.height = currentHeight;
      void el.offsetHeight;
      el.style.transition = '';

      const newHeight = Math.max(68, Math.min(scrollHeight, 160));
      el.style.height = `${newHeight}px`;

      setTextareaHeight(newHeight);
      setIsScrolling(scrollHeight > 160);

      setTimeout(updateFades, 0);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, expanded]);

    useEffect(() => {
      setContainerHeight(Math.max(116, textareaHeight + 48));
      setTimeout(updateFades, 0);
    }, [textareaHeight]);

    useEffect(() => {
      if (!isModelSelectOpen) return;
      const handleOutsideClick = (e: MouseEvent) => {
        if (internalContainerRef.current && !internalContainerRef.current.contains(e.target as Node)) {
          setIsModelSelectOpen(false);
        }
      };
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [isModelSelectOpen]);

    const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      if (internalContainerRef.current && internalContainerRef.current.contains(e.relatedTarget as Node)) return;
      setMentionQuery(null); setSlashOpen(false);
      if (value.trim() === "" && !hasAttachments && !hasPastedBlocks && !isRecording && !busy && !alwaysExpanded) {
        setIsSmoothResize(false);
        setExpanded(false);
        setIsModelSelectOpen(false);
      }
    };

    const handleSubmit = () => {
      if (value.trim() === "" && !hasAttachments && !hasPastedBlocks) return;
      setIsSmoothResize(false);
      // Re-inline any collapsed paste blocks as fenced sections so the agent gets
      // the full content while the input stayed uncluttered.
      const blocksText = pastedBlocks.map((b) => "```text\n" + b.text + "\n```").join("\n\n");
      const finalMessage = [value.trim(), blocksText].filter(Boolean).join("\n\n");
      onSubmit?.(finalMessage, { model: selectedModel, effort: efforts[effortIndex], attachments: attachments.map((a) => a.file), mentionedIds });
      handleValueChange("");
      attachments.forEach((a) => URL.revokeObjectURL(a.url));
      setAttachments([]);
      setPastedBlocks([]);
      setExpandedBlockId(null);
      setMentionQuery(null);
      setSlashOpen(false);
      if (!alwaysExpanded) setExpanded(false);
      setIsModelSelectOpen(false);
    };

    const cycleEffort = (e: React.MouseEvent) => {
      e.stopPropagation();
      setEffortIndex((prev) => (prev + 1) % efforts.length);
    };

    const openFileChooser = (e: React.MouseEvent) => {
      e.stopPropagation();
      fileInputRef.current?.click();
    };

    const handleFilesChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
      e.target.value = "";

      if (files.length === 0) return;
      const room = Math.max(0, maxAttachments - attachments.length);
      const accepted = files.slice(0, room);

      if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
      else { setIsSmoothResize(true); }

      for (const file of accepted) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => addAttachment(file, url, img.naturalWidth, img.naturalHeight);
        img.onerror = () => addAttachment(file, url, 800, 600);
        img.src = url;
      }
    };

    const addAttachment = (file: File, url: string, width: number, height: number) => {
      const id = `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((prev) => [...prev, { id, file, url, name: file.name, width, height }]);
    };

    const removeAttachment = (id: string) => {
      setIsSmoothResize(true);
      setAttachments((prev) => {
        const target = prev.find((a) => a.id === id);
        if (target) URL.revokeObjectURL(target.url);
        return prev.filter((a) => a.id !== id);
      });
      thumbRefs.current.delete(id);
    };

    // Large pastes become a collapsed block chip instead of flooding the input.
    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData("text");
      if (!text) return;
      const lines = text.split("\n").length;
      if (text.length < PASTE_BLOCK_MIN_CHARS && lines < PASTE_BLOCK_MIN_LINES) return; // normal paste
      e.preventDefault();
      const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPastedBlocks((prev) => [...prev, { id, text, lines, chars: text.length }]);
      if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
    };

    const removePastedBlock = (id: string) => {
      setIsSmoothResize(true);
      setPastedBlocks((prev) => prev.filter((b) => b.id !== id));
      setExpandedBlockId((cur) => (cur === id ? null : cur));
    };

    // Calculate action button states. During a run the empty composer offers
    // "stop"; the moment there's text it goes back to "send", because typing
    // while the agent works is mid-run steering, not a cancellation.
    const canStopRun = busy && !!onStop && !hasValue && !isRecording && !isConnecting;
    const showArrow = hasValue && !isRecording && !isConnecting;
    const showStop = isRecording || canStopRun;
    const showMic = !hasValue && !canStopRun && !isRecording && !isConnecting;

    const onActionButtonClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (isConnecting) return;
      if (isRecording) {
        stopRecording();
      } else if (canStopRun) {
        onStop!();
      } else if (hasValue) {
        handleSubmit();
      } else {
        startRecording();
      }
    };

    return (
      <>
        {/* Outer Wrapper for positioning and max-width scaling */}
        <div
          ref={(node) => {
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
            // @ts-ignore
            internalContainerRef.current = node;
          }}
          onBlur={handleBlur}
          className={cn("relative flex flex-col w-full", className)}
          style={{
            maxWidth: isOpen ? maxOpenWidth : 320,
            transition: isSmoothResize ? "max-width 0.15s ease-out" : "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFilesChosen}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />

          {/* Independent Attachment Tab (Slides up from behind the prompt input) */}
          <div
            aria-hidden={!hasAttachments}
            style={{
              height: hasAttachments && expanded ? 68 : 0,
              transition: isSmoothResize
                ? "height 0.15s ease-out"
                : "height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
            }}
            className="w-full relative z-0 overflow-hidden"
          >
            <div
              style={{
                position: "absolute",
                bottom: -8,
                left: 20,
                right: 20,
                height: 68,
                transform: hasAttachments && expanded ? "translateY(0)" : "translateY(100%)",
                opacity: hasAttachments && expanded ? 1 : 0,
                transition: isSmoothResize
                  ? "transform 0.15s ease-out, opacity 0.15s ease-out"
                  : "transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease-out",
              }}
              className="border border-border border-b-0 bg-muted rounded-t-2xl px-2 pt-2 pb-1 flex items-start gap-2 overflow-x-auto prompt-scrollbar"
            >
              {attachments.map((attachment, index) => (
                <AttachmentThumb
                  key={attachment.id}
                  attachment={attachment}
                  index={index}
                  onRemove={removeAttachment}
                  onOpen={(a, rect) => setActiveAttachment({ attachment: a, rect })}
                  registerRef={(id, el) => thumbRefs.current.set(id, el)}
                />
              ))}
            </div>
          </div>

          {/* Pasted-text blocks — large pastes collapsed into tidy chips */}
          {hasPastedBlocks && (
            <div className="mb-2 flex flex-col gap-1.5">
              {pastedBlocks.map((b) => (
                <div key={b.id} className="overflow-hidden rounded-xl border border-border bg-muted/60 text-xs animate-in fade-in slide-in-from-top-2 duration-300">
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="text-sm leading-none">📄</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setExpandedBlockId((cur) => (cur === b.id ? null : b.id))}
                      className="flex-1 truncate text-left font-medium text-foreground/80 transition-colors hover:text-foreground"
                    >
                      Texte collé <span className="font-normal text-muted-foreground">· {b.lines} lignes · {b.chars.toLocaleString()} car.</span>
                    </button>
                    <span
                      role="button" tabIndex={-1}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      onClick={() => removePastedBlock(b.id)}
                      className="flex size-4 shrink-0 items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-background hover:text-foreground"
                      aria-label="Retirer le bloc collé"
                    >
                      <CloseIcon />
                    </span>
                  </div>
                  {expandedBlockId === b.id && (
                    <pre className="prompt-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {b.text.slice(0, 2000)}{b.text.length > 2000 ? "\n…" : ""}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Main Input Card — framed by voice-glow (VoiceComposer): breathing at
              rest, following the dictated voice, sweeping while the agent runs. */}
          <VoiceComposer stream={dictation.stream} processing={busy || isConnecting} radius={24}>
          <div
            onMouseDown={(e) => {
              const isTextarea = e.target === textareaRef.current;
              if (expanded && !isTextarea && !isRecording) {
                e.preventDefault();
                textareaRef.current?.focus();
              }
            }}
            style={{
              borderRadius: 24,
              height: isOpen ? containerHeight : 48,
              transition: isSmoothResize ? SMOOTH_HEIGHT_TRANSITION : SPRING_TRANSITION,
              overflow: isOpen ? "visible" : "hidden",
            }}
            className={cn(
              "relative w-full border border-border bg-card shadow-sm focus-within:border-ring/40 focus-within:ring-1 focus-within:ring-ring/20 hover:border-border/80 z-10",
              isOpen ? "cursor-text" : "cursor-default",
            )}
          >
            <style dangerouslySetInnerHTML={{ __html: `
              .prompt-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; background: transparent; }
              .prompt-scrollbar::-webkit-scrollbar-track { background: transparent; }
              .prompt-scrollbar::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
              .prompt-scrollbar:hover::-webkit-scrollbar-thumb { background: hsl(var(--muted-foreground) / 0.3); }
            `}} />

            {/* @ mention menu */}
            {mentionAgents.length > 0 && mentionQuery !== null && (
              <div className="absolute bottom-full left-1 z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
                <div className="max-h-64 overflow-y-auto py-1">
                  {filteredMentionAgents.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Aucun agent.</div>
                  ) : filteredMentionAgents.map((a) => (
                    <button key={a.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(a)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: a.accentColor || "hsl(var(--primary))" }} />
                      <span className="min-w-0 flex-1 truncate font-medium" style={a.accentColor ? { color: a.accentColor } : undefined}>{a.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* / slash-action menu */}
            {slashCommands.length > 0 && slashOpen && (
              <div className="absolute bottom-full left-1 z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-border bg-popover py-1 shadow-lg">
                {slashCommands.map((c) => (
                  <button key={c.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickSlash(c)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: c.color + "26", color: c.color }}>{c.icon ? <c.icon className="h-3.5 w-3.5" /> : <span className="text-xs font-bold">/</span>}</span>
                    {c.label}
                  </button>
                ))}
              </div>
            )}

            {/* Badge backdrop: mirrors the text with @/​slash badges, behind the
                transparent-text textarea (which keeps the caret + interaction). */}
            {hasHighlight && (
              <div
                ref={backdropRef}
                aria-hidden
                className={cn(
                  "prompt-scrollbar pointer-events-none absolute top-0 inset-x-0 z-0 w-full overflow-hidden whitespace-pre-wrap break-words pl-4 pr-12 py-3.5 text-sm leading-[22px] text-foreground",
                  isOpen ? "opacity-100" : "opacity-0"
                )}
                style={{ height: `${textareaHeight}px` }}
              >
                {highlightComposer(value, mentionAgents, slashCommands)}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onTextChange(e.target.value)}
              onScroll={(e) => { updateFades(); if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop; }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (e.key === "Escape") {
                  if (mentionQuery !== null || slashOpen) { setMentionQuery(null); setSlashOpen(false); return; }
                  if (value.trim() === "" && !hasAttachments && !hasPastedBlocks && !alwaysExpanded) {
                    setIsSmoothResize(false);
                    setExpanded(false);
                    setIsModelSelectOpen(false);
                  }
                }
              }}
              placeholder={placeholder}
              aria-label="Prompt"
              disabled={isRecording}
              style={{
                caretColor: hasHighlight ? "hsl(var(--foreground))" : undefined,
                transition: isSmoothResize
                  ? "height 0.15s ease-out"
                  : "opacity 0.3s ease-out, transform 0.3s ease-out, height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
              }}
              className={cn(
                "prompt-scrollbar absolute top-0 inset-x-0 z-[1] w-full resize-none bg-transparent pl-4 pr-12 py-3.5 text-sm leading-[22px] outline-none placeholder:font-medium placeholder:text-muted-foreground/80 cursor-text",
                hasHighlight ? "text-transparent" : "text-foreground",
                isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 -translate-y-1 pointer-events-none",
                isScrolling ? "overflow-y-auto" : "overflow-y-hidden",
                isRecording && "pointer-events-none"
              )}
            />

            <div
              ref={topFadeRef}
              className="absolute left-4 right-12 top-0 z-[2] h-8 bg-gradient-to-b from-card via-card/90 to-transparent pointer-events-none"
            />
            <div
              ref={bottomFadeRef}
              className="absolute left-4 right-12 z-[2] h-8 bg-gradient-to-t from-card via-card/90 to-transparent pointer-events-none"
              style={{
                opacity: 0,
                top: `${textareaHeight - 32}px`,
                transition: isSmoothResize ? "top 0.15s ease-out" : "top 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
              }}
            />

            <button
              type="button"
              onClick={expand}
              style={{ transition: isSmoothResize ? "none" : "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)" }}
              className={cn(
                "absolute inset-x-0 top-0 z-[1] cursor-text pl-4 pr-12 py-[15px] text-left text-sm font-medium leading-[17px] text-muted-foreground/80 outline-none",
                !isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-105 translate-y-1 pointer-events-none"
              )}
              aria-label="Open prompt input"
            >
              {placeholder}
            </button>

            {/* Bottom Actions Wrapper - Hides when recording to make space for visualizer */}
            <div
              className={cn(
                "absolute bottom-2 left-3 right-12 z-[10] flex items-center gap-0 transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]",
                isOpen && !isRecording ? "opacity-100 blur-0 translate-y-0 pointer-events-auto" : "opacity-0 blur-sm translate-y-2 pointer-events-none"
              )}
            >
              {mentionAgents.length > 0 && (
                <button
                  type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); openMentionMenu(); }}
                  title="Taguer un agent (@)"
                  className="flex size-7 items-center justify-center rounded-full text-foreground/50 transition-all duration-200 hover:bg-accent/60 hover:text-foreground outline-none cursor-default"
                >
                  <AtSignIcon />
                </button>
              )}
              {slashCommands.length > 0 && (
                <button
                  type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); setSlashOpen((v) => !v); setMentionQuery(null); }}
                  title="Actions (/)"
                  className={cn("flex size-7 items-center justify-center rounded-full text-foreground/50 transition-all duration-200 hover:bg-accent/60 hover:text-foreground outline-none cursor-default", slashOpen && "bg-accent/60 text-foreground")}
                >
                  <SlashIcon />
                </button>
              )}
              {showModelSelect && (
              <div className="relative">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsModelSelectOpen((prev) => !prev);
                  }}
                  className={cn(
                    "group flex items-center gap-1 rounded-full px-2 py-1 text-foreground/50 transition-all duration-200 outline-none hover:bg-accent/60 hover:text-foreground cursor-default",
                    isModelSelectOpen ? "bg-accent/60 text-foreground" : ""
                  )}
                  aria-label={`Select model. Current: ${selectedModel}`}
                >
                  <ModelIcon model={selectedModel} className="size-3.5 opacity-70 group-hover:opacity-100 transition-opacity" />
                  <span className="text-xs font-semibold select-none transition-colors">
                    <MorphingText text={selectedModel} />
                  </span>
                </button>

                <div
                  style={{ transformOrigin: "bottom left" }}
                  onMouseLeave={() => {
                    setHoverStyle((prev) => ({
                      ...prev, opacity: 0, transform: prev.transform.replace("scale(1)", "scale(0.95)"), transition: "opacity 0.2s ease-in, transform 0.2s ease-out",
                    }));
                  }}
                  className={cn(
                    "absolute bottom-full left-0 mb-2.5 z-50 w-44 rounded-2xl border border-border bg-card/95 p-1 shadow-xl backdrop-blur-md flex flex-col gap-0.5 transition-all duration-400 cursor-default",
                    isModelSelectOpen
                      ? "opacity-100 scale-100 translate-y-0 pointer-events-auto ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                      : "opacity-0 scale-95 translate-y-3 pointer-events-none ease-[cubic-bezier(0.175,0.885,0.32,1.275)]"
                  )}
                >
                  <div className="relative flex flex-col gap-0.5">
                    <div style={hoverStyle} className="absolute left-0 right-0 top-0 h-8 -z-10 rounded-xl bg-accent pointer-events-none" />
                    {models.map((model, idx) => (
                      <button
                        key={model}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => {
                          setHoverStyle((prev) => ({
                            opacity: 1, transform: `translateY(${idx * 34}px) scale(1)`,
                            transition: prev.opacity === 0 ? "opacity 0.15s ease-out" : "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.15s ease",
                          }));
                        }}
                        onClick={(e) => { e.stopPropagation(); setSelectedModel(model); setIsModelSelectOpen(false); }}
                        className="group relative flex h-8 w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-xs font-medium text-foreground/80 outline-none active:scale-[0.98] cursor-default"
                      >
                        <span className="flex items-center gap-2">
                          <ModelIcon model={model} className="size-3.5 opacity-85 group-hover:opacity-100 transition-opacity" />
                          {model}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              )}

              {showEffort && (
              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={cycleEffort}
                className="group flex items-center gap-1 rounded-full px-2 py-1 text-foreground/50 transition-all duration-200 hover:bg-accent/60 hover:text-foreground outline-none cursor-default"
              >
                <DynamicBarsIcon level={efforts[effortIndex]} />
                <span className="text-xs font-semibold select-none transition-colors"><MorphingText text={efforts[effortIndex]} /></span>
              </button>
              )}

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); togglePtt(); }}
                title={pttEnabled ? "Push-to-talk activé — maintenez Espace pour dicter" : "Activer le push-to-talk (maintenir Espace pour dicter)"}
                aria-pressed={pttEnabled}
                className={cn(
                  "ml-auto flex size-7 items-center justify-center rounded-full transition-all duration-200 outline-none cursor-default",
                  pttEnabled ? "bg-primary/15 text-primary" : "text-foreground/50 hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <KeyboardIcon />
              </button>

              {/* Continue dictating even when the composer already has text (the
                  bottom-right button is a Send arrow at that point). */}
              {hasValue && !isRecording && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); if (isConnecting) return; startRecording(); }}
                  title="Continuer en dictant"
                  aria-label="Continue dictating"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full transition-all duration-200 outline-none cursor-default",
                    isConnecting ? "text-primary" : "text-foreground/50 hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {isConnecting ? (
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                  ) : <MicIcon />}
                </button>
              )}

              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={openFileChooser} disabled={attachments.length >= maxAttachments}
                className="flex size-7 items-center justify-center rounded-full text-foreground/50 transition-all duration-200 hover:bg-accent/60 hover:text-foreground outline-none cursor-default disabled:opacity-40 disabled:pointer-events-none"
              >
                <PlusIcon />
              </button>
            </div>

            {/* Audio Wave Visualizer Overlay positioned precisely to the left of the mic button */}
            <div
              className={cn(
                "absolute right-12 bottom-2 z-[10] flex h-8 items-center justify-end gap-[3px] transition-all duration-400 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]",
                isRecording ? "w-16 opacity-100 translate-x-0" : "w-0 opacity-0 translate-x-4 pointer-events-none"
              )}
            >
              {audioData.map((val, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-primary transition-[height] duration-75 ease-out"
                  style={{ height: `${Math.max(4, val * 24)}px` }}
                />
              ))}
            </div>

            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={onActionButtonClick}
              aria-label={showArrow ? "Send prompt" : canStopRun ? "Arrêter le run" : showStop ? "Stop recording" : "Use voice input"}
              title={canStopRun ? "Arrêter le run" : undefined}
              style={{ borderRadius: 9999 }}
              className="absolute right-2 bottom-2 z-[10] flex h-8 w-8 items-center justify-center bg-primary text-primary-foreground transition-all duration-300 hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-default"
            >
              <span className="relative flex h-full w-full items-center justify-center">
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showArrow ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <ArrowUpIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showMic ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 -rotate-45 blur-[1px] pointer-events-none")}>
                  <MicIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showStop ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <StopIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300", isConnecting ? "opacity-100 scale-100" : "opacity-0 scale-50 pointer-events-none")}>
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                </span>
              </span>
            </button>
          </div>
          </VoiceComposer>
        </div>

        {activeAttachment && (
          <AttachmentGalleryModal
            attachment={activeAttachment.attachment} originRect={activeAttachment.rect} onClose={() => setActiveAttachment(null)}
          />
        )}
      </>
    );
  }
);

PromptInput.displayName = "PromptInput";
