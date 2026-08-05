"use client";

import type React from "react";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Plus, ArrowUp, X, FileText, Image as ImageIcon, Video, Music, Archive,
  Loader2, Copy, Mic, Square, AtSign, Slash, Keyboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useDictation } from "@/lib/useDictation";
import { cn } from "@/lib/utils";

export interface MentionAgent { id: string; name: string; accentColor?: string | null; avatarUrl?: string | null; }
export interface SlashCommand { key: string; label: string; color: string; icon?: React.ComponentType<{ className?: string }>; }
const PTT_PREF_KEY = "fos-dictation-ptt";
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Sober pill for @mentions / slash-actions — neutral (no flashy accent colours),
// just a faint tint so the token reads as a chip. Negative margins keep the
// padded background from shifting glyph advance (backdrop stays aligned).
function badgePill(_color?: string | null): React.CSSProperties {
  return {
    padding: "1px 4px", margin: "0 -4px", borderRadius: 5, fontWeight: 500,
    color: "hsl(var(--foreground))", backgroundColor: "hsl(var(--foreground) / 0.08)",
  };
}
function highlightNodes(value: string, agents: MentionAgent[], slash: SlashCommand[]): React.ReactNode[] {
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
    out.push(<span key={i++} style={badgePill(color)}>{tok}</span>);
    last = m.index + tok.length;
  }
  out.push(value.slice(last) + "​");
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

// Rich chat composer — file uploads (image/textual/generic previews), large-paste
// → collapsed cards, drag-and-drop, and streaming voice dictation. Theme-aware
// (uses design tokens, not hardcoded colors). Used on Home + in rooms.

export interface FileWithPreview {
  id: string;
  file: File;
  preview?: string;
  type: string;
  textContent?: string;
}
export interface PastedContent {
  id: string;
  content: string;
  wordCount: number;
}

const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PASTE_THRESHOLD = 200;
const uid = () => Math.random().toString(36).slice(2, 10);

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
function getFileTypeLabel(type: string): string {
  const parts = type.split("/");
  let label = parts[parts.length - 1].toUpperCase();
  if (label.length > 7 && label.includes("-")) label = label.substring(0, label.indexOf("-"));
  if (label.length > 10) label = label.substring(0, 10) + "…";
  return label;
}
function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toUpperCase() || "FILE";
  return ext.length > 8 ? ext.substring(0, 8) + "…" : ext;
}
const TEXT_EXT = new Set(["txt","md","py","js","ts","jsx","tsx","html","htm","css","scss","json","xml","yaml","yml","csv","sql","sh","bash","php","rb","go","java","c","cpp","h","cs","rs","swift","kt","r","vue","svelte","toml","ini","conf","log"]);
function isTextualFile(file: File): boolean {
  if (/^text\//.test(file.type) || /json|xml|javascript|typescript/.test(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return TEXT_EXT.has(ext) || /readme|dockerfile|makefile/i.test(file.name);
}
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) || "");
    reader.onerror = (e) => reject(e);
    reader.readAsText(file);
  });
}
function fileIcon(type: string) {
  if (type.startsWith("image/")) return <ImageIcon className="h-5 w-5 text-muted-foreground" />;
  if (type.startsWith("video/")) return <Video className="h-5 w-5 text-muted-foreground" />;
  if (type.startsWith("audio/")) return <Music className="h-5 w-5 text-muted-foreground" />;
  if (/zip|rar|tar/.test(type)) return <Archive className="h-5 w-5 text-muted-foreground" />;
  return <FileText className="h-5 w-5 text-muted-foreground" />;
}

const cardBase = "relative shrink-0 size-[120px] overflow-hidden rounded-xl border border-border bg-muted shadow-sm";
const tag = "rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-medium capitalize text-foreground/80";

function TextualFilePreviewCard({ file, onRemove }: { file: FileWithPreview; onRemove: (id: string) => void }) {
  const preview = file.textContent?.slice(0, 180) ?? "";
  return (
    <div className={cardBase}>
      <div className="custom-scrollbar max-h-full overflow-y-auto p-2.5 text-[8px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
        {file.textContent ? preview + ((file.textContent.length > 180) ? "…" : "")
          : <div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>}
      </div>
      <div className="group absolute inset-0 flex items-end bg-gradient-to-b from-transparent to-background/90 p-2">
        <span className={tag}>{getFileExtension(file.file.name)}</span>
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {file.textContent && (
            <Button size="icon" variant="outline" className="size-6" onClick={() => navigator.clipboard.writeText(file.textContent || "")} title="Copier"><Copy className="h-3 w-3" /></Button>
          )}
          <Button size="icon" variant="outline" className="size-6" onClick={() => onRemove(file.id)} title="Retirer"><X className="h-3 w-3" /></Button>
        </div>
      </div>
    </div>
  );
}

function FilePreviewCard({ file, onRemove }: { file: FileWithPreview; onRemove: (id: string) => void }) {
  if (isTextualFile(file.file)) return <TextualFilePreviewCard file={file} onRemove={onRemove} />;
  const isImage = file.type.startsWith("image/");
  return (
    <div className={cn(cardBase, "group")}>
      {isImage && file.preview ? (
        <img src={file.preview} alt={file.file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full flex-col justify-between p-2.5">
          <div className="flex items-center gap-1.5">{fileIcon(file.type)}</div>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground" title={file.file.name}>{file.file.name}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{formatFileSize(file.file.size)}</p>
          </div>
        </div>
      )}
      {isImage && (
        <div className="absolute inset-0 flex items-end bg-gradient-to-b from-transparent to-background/80 p-2"><span className={tag}>{getFileTypeLabel(file.type)}</span></div>
      )}
      <Button size="icon" variant="outline" className="absolute right-1.5 top-1.5 size-6 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => onRemove(file.id)}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
}

function PastedContentCard({ content, onRemove }: { content: PastedContent; onRemove: (id: string) => void }) {
  const preview = content.content.slice(0, 180);
  return (
    <div className={cardBase}>
      <div className="custom-scrollbar max-h-full overflow-y-auto p-2.5 text-[8px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
        {preview}{content.content.length > 180 && "…"}
      </div>
      <div className="group absolute inset-0 flex items-end bg-gradient-to-b from-transparent to-background/90 p-2">
        <span className={tag}>Collé · {content.wordCount} mots</span>
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button size="icon" variant="outline" className="size-6" onClick={() => navigator.clipboard.writeText(content.content)} title="Copier"><Copy className="h-3 w-3" /></Button>
          <Button size="icon" variant="outline" className="size-6" onClick={() => onRemove(content.id)} title="Retirer"><X className="h-3 w-3" /></Button>
        </div>
      </div>
    </div>
  );
}

export interface ChatInputProps {
  onSendMessage?: (message: string, files: File[], mentionedIds: string[]) => void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  maxFiles?: number;
  maxFileSize?: number;
  autoFocus?: boolean;
  className?: string;
  /** Enable @ tagging: taggable agents (name + accent colour → colored badges). */
  mentionAgents?: MentionAgent[];
  /** Enable / actions as colored badges (create document/spreadsheet…). */
  slashCommands?: SlashCommand[];
}

export function ChatInput({
  onSendMessage,
  disabled = false,
  busy = false,
  placeholder = "Comment puis-je vous aider ?",
  maxFiles = MAX_FILES,
  maxFileSize = MAX_FILE_SIZE,
  autoFocus,
  className,
  mentionAgents = [],
  slashCommands = [],
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [pasted, setPasted] = useState<PastedContent[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [pttEnabled, setPttEnabled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef(message); messageRef.current = message;

  const hasHighlight = mentionAgents.length > 0 || slashCommands.length > 0;
  const mentionedIds = hasHighlight ? deriveMentionIds(message, mentionAgents) : [];
  const filteredMentionAgents = mentionQuery == null ? [] : mentionAgents.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));

  // Streaming voice dictation → appended to the message.
  const voiceBaseRef = useRef("");
  const dictation = useDictation((dictated) => {
    const base = voiceBaseRef.current;
    setMessage(base + (base && dictated ? " " : "") + dictated);
  });
  const dictationRef = useRef(dictation); dictationRef.current = dictation;
  const startVoice = useCallback(() => { voiceBaseRef.current = messageRef.current.trimEnd(); void dictationRef.current.start(); }, []);
  const stopVoice = useCallback(() => dictationRef.current.stop(), []);
  const toggleVoice = () => {
    if (dictation.recording || dictation.connecting) stopVoice();
    else startVoice();
  };

  // Push-to-talk preference.
  useEffect(() => { try { setPttEnabled(localStorage.getItem(PTT_PREF_KEY) === "1"); } catch { /* noop */ } }, []);
  const togglePtt = () => setPttEnabled((v) => { const n = !v; try { localStorage.setItem(PTT_PREF_KEY, n ? "1" : "0"); } catch { /* noop */ } return n; });

  // Hold Space to dictate (opt-in). A quick tap still types a space, so typing
  // isn't broken; only a deliberate hold (>180ms) starts the mic.
  useEffect(() => {
    if (!pttEnabled) return;
    const isEditable = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
    const insertSpace = () => {
      const ta = textareaRef.current; const v = messageRef.current;
      let start = v.length, end = v.length;
      if (ta && ta === document.activeElement) { start = ta.selectionStart ?? v.length; end = ta.selectionEnd ?? start; }
      const next = v.slice(0, start) + " " + v.slice(end);
      setMessage(next);
      if (ta) requestAnimationFrame(() => { try { ta.setSelectionRange(start + 1, start + 1); } catch { /* noop */ } });
    };
    let holdTimer: number | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = document.activeElement; const inBox = el === textareaRef.current;
      if (isEditable(el) && !inBox) return;
      e.preventDefault();
      if (dictationRef.current.recording || dictationRef.current.connecting || holdTimer !== null) return;
      holdTimer = window.setTimeout(() => { holdTimer = null; startVoice(); }, 180);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement; const inBox = el === textareaRef.current;
      if (isEditable(el) && !inBox) return;
      if (holdTimer !== null) { window.clearTimeout(holdTimer); holdTimer = null; if (inBox) insertSpace(); return; }
      if (dictationRef.current.recording || dictationRef.current.connecting) { e.preventDefault(); stopVoice(); }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { if (holdTimer !== null) window.clearTimeout(holdTimer); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [pttEnabled, startVoice, stopVoice]);

  const setValueWithCaret = (next: string, caret: number) => {
    setMessage(next);
    requestAnimationFrame(() => { const ta = textareaRef.current; if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); } });
  };
  const onTextChange = (val: string) => {
    setMessage(val);
    if (!mentionAgents.length) return;
    const pos = textareaRef.current?.selectionStart ?? val.length;
    const mm = val.slice(0, pos).match(/(?:^|\s)@(\w*)$/);
    setMentionQuery(mm ? mm[1] : null);
    if (mm) setSlashOpen(false);
  };
  const insertMention = (agent: MentionAgent) => {
    const pos = textareaRef.current?.selectionStart ?? message.length;
    const before = message.slice(0, pos).replace(/@\w*$/, `@${agent.name} `);
    setMentionQuery(null);
    setValueWithCaret(before + message.slice(pos), before.length);
  };
  const openMentionMenu = () => {
    const pos = textareaRef.current?.selectionStart ?? message.length;
    const before = message.slice(0, pos);
    const insert = before.endsWith("@") ? "" : (before && !before.endsWith(" ") ? " @" : "@");
    const nb = before + insert;
    setSlashOpen(false); setMentionQuery("");
    setValueWithCaret(nb + message.slice(pos), nb.length);
  };
  const pickSlash = (cmd: SlashCommand) => {
    const rest = message.replace(new RegExp(`^/(?:${slashCommands.map((s) => reEsc(s.label)).join("|")})\\s+`), "");
    const prefix = `/${cmd.label} `;
    setSlashOpen(false);
    setValueWithCaret(prefix + rest, prefix.length);
  };

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [message]);
  useEffect(() => { if (autoFocus) textareaRef.current?.focus(); }, [autoFocus]);
  useEffect(() => () => { files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)); }, [files]);

  const addFiles = useCallback((list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => {
      const room = Math.max(0, maxFiles - prev.length);
      const accepted = Array.from(list).slice(0, room).filter((f) => f.size <= maxFileSize);
      const mapped: FileWithPreview[] = accepted.map((file) => ({
        id: uid(), file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        type: file.type || "application/octet-stream",
      }));
      mapped.forEach((m) => {
        if (isTextualFile(m.file)) {
          readFileAsText(m.file).then((textContent) =>
            setFiles((cur) => cur.map((f) => (f.id === m.id ? { ...f, textContent } : f)))).catch(() => {});
        }
      });
      return [...prev, ...mapped];
    });
  }, [maxFiles, maxFileSize]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const t = prev.find((f) => f.id === id);
      if (t?.preview) URL.revokeObjectURL(t.preview);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter((it) => it.kind === "file");
    if (fileItems.length && files.length < maxFiles) {
      e.preventDefault();
      const dt = new DataTransfer();
      fileItems.map((it) => it.getAsFile()).filter(Boolean).forEach((f) => dt.items.add(f as File));
      addFiles(dt.files);
      return;
    }
    const text = e.clipboardData.getData("text");
    if (text && text.length > PASTE_THRESHOLD && pasted.length < 5) {
      e.preventDefault();
      setPasted((prev) => [...prev, { id: uid(), content: text, wordCount: text.split(/\s+/).filter(Boolean).length }]);
    }
  }, [addFiles, files.length, maxFiles, pasted.length]);

  const hasContent = message.trim() || files.length > 0 || pasted.length > 0;
  const canSend = hasContent && !disabled && !busy;

  const send = useCallback(() => {
    if (!canSend) return;
    const blocks = pasted.map((p) => "```text\n" + p.content + "\n```").join("\n\n");
    const finalMessage = [message.trim(), blocks].filter(Boolean).join("\n\n");
    onSendMessage?.(finalMessage, files.map((f) => f.file), mentionedIds);
    setMessage(""); setPasted([]); setMentionQuery(null); setSlashOpen(false);
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [canSend, message, pasted, files, onSendMessage, mentionedIds]);

  return (
    <div
      className={cn("relative mx-auto w-full", className)}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10">
          <p className="flex items-center gap-2 text-sm font-medium text-primary"><ImageIcon className="h-4 w-4" /> Déposez les fichiers ici</p>
        </div>
      )}

      {/* @ mention menu — sober (Avatar + name + status dot), AssigneeUser style */}
      {mentionAgents.length > 0 && mentionQuery !== null && (
        <div className="absolute bottom-full left-1 z-40 mb-2 w-[224px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Taguer un agent</div>
          <div className="max-h-64 overflow-y-auto">
            {filteredMentionAgents.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">Aucun agent.</div>
            ) : filteredMentionAgents.map((a) => (
              <button key={a.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(a)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent">
                <span className="relative shrink-0">
                  <Avatar className="size-6">
                    {a.avatarUrl && <AvatarImage src={a.avatarUrl} alt={a.name} />}
                    <AvatarFallback className="text-[10px] font-medium">{a.name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
                  </Avatar>
                  <span className="absolute -bottom-0.5 -end-0.5 size-2 rounded-full border-2 border-popover bg-emerald-500" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* / slash menu */}
      {slashCommands.length > 0 && slashOpen && (
        <div className="absolute bottom-full left-1 z-40 mb-2 w-64 overflow-hidden rounded-2xl border border-border bg-popover py-1 shadow-lg">
          {slashCommands.map((c) => (
            <button key={c.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickSlash(c)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted">
              <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: c.color + "26", color: c.color }}>{c.icon ? <c.icon className="h-3.5 w-3.5" /> : <span className="text-xs font-bold">/</span>}</span>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className={cn("flex min-h-[128px] flex-col rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/40", busy && "prompt-run-border")}>
        {/* Mentions/slash render as colored badges: a backdrop mirrors the text
            with badges, under a transparent-text textarea that owns the caret. */}
        <div className="relative w-full">
          {hasHighlight && (
            <div
              ref={backdropRef}
              aria-hidden
              className="custom-scrollbar pointer-events-none absolute inset-0 max-h-[180px] overflow-hidden whitespace-pre-wrap break-words px-4 pt-4 text-sm leading-6 text-foreground"
            >
              {highlightNodes(message, mentionAgents, slashCommands)}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => onTextChange(e.target.value)}
            onScroll={(e) => { if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop; }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              if (e.key === "Escape") { setMentionQuery(null); setSlashOpen(false); }
            }}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            style={{ caretColor: hasHighlight ? "hsl(var(--foreground))" : undefined }}
            className={cn(
              "custom-scrollbar relative max-h-[180px] min-h-[84px] w-full resize-none border-0 bg-transparent px-4 pt-4 text-sm leading-6 outline-none placeholder:text-muted-foreground focus:outline-none",
              hasHighlight ? "text-transparent" : "text-foreground",
            )}
          />
        </div>

        <div className="flex w-full items-center justify-between gap-2 px-3 pb-2.5">
          <div className="flex items-center gap-0.5">
            <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => fileInputRef.current?.click()} disabled={disabled || files.length >= maxFiles} title="Joindre des fichiers">
              <Plus className="h-[18px] w-[18px]" />
            </Button>
            {mentionAgents.length > 0 && (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={openMentionMenu} title="Taguer un agent (@)"><AtSign className="h-4 w-4" /></Button>
            )}
            {slashCommands.length > 0 && (
              <Button size="icon" variant="ghost" className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", slashOpen && "text-foreground")} onClick={() => { setSlashOpen((v) => !v); setMentionQuery(null); }} title="Actions (/)"><Slash className="h-4 w-4" /></Button>
            )}
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", pttEnabled ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")} onClick={togglePtt} title={pttEnabled ? "Push-to-talk activé — maintenez Espace" : "Activer le push-to-talk (maintenir Espace)"}><Keyboard className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", dictation.recording && "text-destructive")} onClick={toggleVoice} title={dictation.recording ? "Arrêter la dictée" : "Dictée vocale"}>
              {dictation.connecting ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : dictation.recording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-[18px] w-[18px]" />}
            </Button>
            <Button
              size="icon"
              className={cn("h-9 w-9 rounded-xl transition-colors", canSend ? "bg-foreground text-background hover:bg-foreground/90" : "bg-muted text-muted-foreground")}
              onClick={send}
              disabled={!canSend}
              title="Envoyer"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {(files.length > 0 || pasted.length > 0) && (
          <div className="hide-scroll-bar w-full overflow-x-auto rounded-b-2xl border-t border-border bg-muted/40 p-3">
            <div className="flex gap-3">
              {pasted.map((p) => <PastedContentCard key={p.id} content={p} onRemove={(id) => setPasted((prev) => prev.filter((c) => c.id !== id))} />)}
              {files.map((f) => <FilePreviewCard key={f.id} file={f} onRemove={removeFile} />)}
            </div>
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); if (e.target) e.target.value = ""; }} />
    </div>
  );
}

export default ChatInput;
