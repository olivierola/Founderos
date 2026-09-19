import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  FloppyDiskIcon as Save,
  CheckIcon as Check,
  EyeIcon as Eye,
  PencilSimpleIcon as Pencil,
  TextBIcon as Bold,
  TextItalicIcon as Italic,
  TextStrikethroughIcon as Strikethrough,
  TextHOneIcon as Heading1,
  TextHTwoIcon as Heading2,
  TextHThreeIcon as Heading3,
  ListIcon as List,
  ListNumbersIcon as ListOrdered,
  QuotesIcon as Quote,
  CodeIcon as Code,
  LinkSimpleIcon as Link2,
  FileTextIcon as FileText,
  SparkleIcon as Sparkles,
  HeartIcon as Heart,
  RobotIcon as Bot,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type InternalAgent, renderInstructionBlocks } from "./shared";

/**
 * An agent is written in THREE files, not one (migration 0210).
 *
 *   instructions — ce qu'il fait : sa procédure, ses règles absolues.
 *   soul         — qui il est : sa voix, ce à quoi il tient, ce qu'il refuse.
 *   preferences  — comment SON utilisateur aime les choses.
 *
 * Le troisième est le seul que l'agent écrit lui-même (outil
 * remember_preference) : c'est un dialogue, pas un formulaire — d'où
 * l'attribution affichée en tête (« appris par l'agent »), sans laquelle une
 * ligne apparue toute seule ressemblerait à un bug.
 *
 * Les trois partagent la même chrome (barre markdown, aperçu, sauvegarde) et
 * chacun garde son brouillon quand on passe à l'autre : la sauvegarde écrit
 * tout ce qui a changé, pas seulement le fichier affiché.
 */

type FileKey = "instructions" | "soul" | "preferences";

interface FileSpec {
  key: FileKey;
  label: string;
  fileName: string;
  icon: typeof FileText;
  /** One line under the title — what this file is FOR. */
  blurb: (name: string) => string;
  placeholder: string;
  /** Soft length target; past it the counter turns amber. */
  soft?: number;
}

const FILES: FileSpec[] = [
  {
    key: "instructions",
    label: "Instructions",
    fileName: "instructions.md",
    icon: FileText,
    blurb: (n) => `Ce que ${n} fait : sa procédure de travail et ses règles absolues. Envoyé en entier, à chaque tâche.`,
    placeholder: `# Rôle
Tu traites les demandes entrantes de l'équipe support.

## Pour chaque demande
1. Classe-la et donne-lui une priorité, justifiée en une ligne.
2. Cherche la réponse dans la base de connaissances AVANT le web.
3. Rédige une réponse prête à envoyer : réponse d'abord, contexte ensuite.

## Règles absolues
- Ne promets jamais un remboursement ni une date de livraison.
- Si la doc ne contient pas la réponse, dis-le au lieu d'extrapoler.`,
  },
  {
    key: "soul",
    label: "Âme",
    fileName: "soul.md",
    icon: Heart,
    blurb: (n) => `Qui ${n} est : sa voix, ce à quoi il tient, ce qu'il refuse même quand on insiste. Court, stable, toujours envoyé.`,
    soft: 2400,
    placeholder: `Tu tiens la ligne entre un client qui attend et une équipe qui n'a pas le temps.
Ta valeur n'est pas de répondre vite, c'est de répondre juste : tu préfères dire « je vérifie » plutôt que rassurer avec une réponse plausible.
Ce que tu refuses : promettre à la place de quelqu'un d'autre.

— Écris le caractère, pas la procédure. Ce fichier doit dire ce qu'aucune étape numérotée ne peut dire.`,
  },
  {
    key: "preferences",
    label: "Préférences",
    fileName: "preferences.md",
    icon: Sparkles,
    blurb: () => "Comment votre équipe aime les choses. Une préférence par ligne — l'agent en ajoute lui-même quand vous en exprimez une.",
    soft: 12000,
    placeholder: `- [langue] Répondre en français, même sur une demande en anglais.
- [format] Les rapports font 2 pages maximum, avec un encadré de conclusion.
- ![sécurité] Ne jamais poster dans #general sans validation.

Une ligne = une préférence. [sujet] entre crochets pour la ranger, ! devant pour qu'elle parte à CHAQUE tâche
(sans le !, elle n'est envoyée que quand la tâche s'y rapporte).`,
  },
];

export function InstructionsEditor({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<FileKey>("instructions");
  const [drafts, setDrafts] = useState<Record<FileKey, string>>(() => initialDrafts(agent));
  const [saved, setSaved] = useState<Record<FileKey, string>>(() => initialDrafts(agent));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const next = initialDrafts(agent);
    setDrafts(next);
    setSaved(next);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const spec = FILES.find((f) => f.key === active)!;
  const text = drafts[active];
  const dirty = useMemo(
    () => FILES.filter((f) => drafts[f.key] !== saved[f.key]).map((f) => f.key),
    [drafts, saved],
  );

  const setText = useCallback((value: string) => {
    setDrafts((d) => ({ ...d, [active]: value }));
  }, [active]);

  // Apply a markdown transform to the current selection, then restore focus and
  // a sensible caret/selection so the user can keep typing.
  const applyFormat = useCallback((fmt: Format) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const { value, selStart, selEnd } = transform(text, start, end, fmt);
    setText(value);
    // Restore selection after React re-renders the controlled value.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
    });
  }, [text, setText]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") { e.preventDefault(); void save(); return; }
    const map: Record<string, Format> = { b: "bold", i: "italic", k: "link" };
    if (map[key]) {
      e.preventDefault();
      applyFormat(map[key]);
    }
  }

  // Saving writes every file that changed, not just the one on screen — the
  // switcher keeps drafts, so anything else would silently drop an edit made
  // two tabs ago.
  async function save() {
    if (dirty.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const key of dirty) patch[key] = drafts[key];
      // Instructions are now a single document; collapse the legacy block model
      // the first time they are written.
      if (dirty.includes("instructions")) patch.instruction_blocks = [];
      if (dirty.includes("preferences")) {
        patch.preferences_updated_at = new Date().toISOString();
        patch.preferences_updated_by = "user";
      }
      const { error: err } = await supabase.from("internal_agents").update(patch).eq("id", agent.id);
      if (err) throw err;
      setSaved({ ...drafts });
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  const count = text.trim().length;
  const over = spec.soft != null && count > spec.soft;

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      {/* File switcher — three files, one chrome. */}
      <div className="flex flex-wrap items-center gap-1 pb-3">
        {FILES.map((f) => {
          const Icon = f.icon;
          const isDirty = drafts[f.key] !== saved[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => { setActive(f.key); setPreview(false); }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs transition-colors",
                f.key === active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {f.fileName}
              {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Modifications non enregistrées" />}
            </button>
          );
        })}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{spec.label}</h2>
          <p className="text-xs text-muted-foreground">{spec.blurb(agent.name)}</p>
          {active === "preferences" && agent.preferences_updated_at && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {agent.preferences_updated_by === "agent"
                ? <><Bot className="h-3.5 w-3.5" /> Dernière ligne apprise par l'agent {timeAgo(agent.preferences_updated_at)}.</>
                : <>Modifié par vous {timeAgo(agent.preferences_updated_at)}.</>}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {spec.soft != null && count > 0 && (
            <span className={cn("text-xs tabular-nums", over ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground")}>
              {count} / {spec.soft}
            </span>
          )}
          {savedAt && Date.now() - savedAt < 4000 && dirty.length === 0 && (
            <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Enregistré</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>
            {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span className="ml-1">{preview ? "Éditer" : "Aperçu"}</span>
          </Button>
          <Button size="sm" onClick={save} disabled={saving || dirty.length === 0}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            <span className="ml-1">
              {dirty.length > 1 ? `Enregistrer (${dirty.length} fichiers)` : "Enregistrer"}
            </span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {active === "soul" && over && (
        <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-500">
          Au-delà de {spec.soft} caractères l'âme est tronquée dans le prompt. Une page de caractère est un caractère que personne ne lit — gardez l'essentiel.
        </div>
      )}

      {/* Formatting toolbar — only while editing. */}
      {!preview && (
        <div className="mb-2 flex flex-wrap items-center gap-0.5">
          <ToolbarBtn title="Gras (Ctrl/⌘B)" onClick={() => applyFormat("bold")}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Italique (Ctrl/⌘I)" onClick={() => applyFormat("italic")}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Barré" onClick={() => applyFormat("strike")}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Titre 1" onClick={() => applyFormat("h1")}><Heading1 className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Titre 2" onClick={() => applyFormat("h2")}><Heading2 className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Titre 3" onClick={() => applyFormat("h3")}><Heading3 className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Liste à puces" onClick={() => applyFormat("ul")}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Liste numérotée" onClick={() => applyFormat("ol")}><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Citation" onClick={() => applyFormat("quote")}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Code" onClick={() => applyFormat("code")}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Lien (Ctrl/⌘K)" onClick={() => applyFormat("link")}><Link2 className="h-3.5 w-3.5" /></ToolbarBtn>
        </div>
      )}

      {/* Editor / preview — borderless, flush with the container background. */}
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {text.trim() ? (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">Rien à prévisualiser.</p>
          )}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={spec.placeholder}
          spellCheck={false}
          className={cn(
            "min-h-0 flex-1 w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-foreground",
            "border-0 p-0 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0",
          )}
        />
      )}
    </div>
  );
}

function ToolbarBtn({
  title, onClick, children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      // Keep the textarea selection: prevent the button from stealing focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "à l'instant";
  const min = Math.round(ms / 60000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `il y a ${d} j` : new Date(iso).toLocaleDateString("fr-FR");
}

// ── Markdown transforms ───────────────────────────────────────────────────────
type Format =
  | "bold" | "italic" | "strike" | "code" | "link"
  | "h1" | "h2" | "h3" | "ul" | "ol" | "quote";

const INLINE: Partial<Record<Format, { wrap: string; placeholder: string }>> = {
  bold: { wrap: "**", placeholder: "texte en gras" },
  italic: { wrap: "*", placeholder: "texte en italique" },
  strike: { wrap: "~~", placeholder: "texte barré" },
  code: { wrap: "`", placeholder: "code" },
};

const LINE_PREFIX: Partial<Record<Format, (i: number) => string>> = {
  h1: () => "# ",
  h2: () => "## ",
  h3: () => "### ",
  ul: () => "- ",
  ol: (i) => `${i + 1}. `,
  quote: () => "> ",
};

interface TransformResult { value: string; selStart: number; selEnd: number }

function transform(text: string, start: number, end: number, fmt: Format): TransformResult {
  const selected = text.slice(start, end);

  // Inline wrap (bold/italic/strike/code).
  const inline = INLINE[fmt];
  if (inline) {
    const { wrap, placeholder } = inline;
    const body = selected || placeholder;
    const insert = `${wrap}${body}${wrap}`;
    const value = text.slice(0, start) + insert + text.slice(end);
    // Select the inner text so the user can overtype the placeholder.
    const innerStart = start + wrap.length;
    return { value, selStart: innerStart, selEnd: innerStart + body.length };
  }

  // Link.
  if (fmt === "link") {
    const label = selected || "texte du lien";
    const insert = `[${label}](url)`;
    const value = text.slice(0, start) + insert + text.slice(end);
    // Select the "url" portion for quick replacement.
    const urlStart = start + 1 + label.length + 2; // [label](
    return { value, selStart: urlStart, selEnd: urlStart + 3 };
  }

  // Line-prefix formats (headings/lists/quote) — apply to each selected line.
  const prefixFn = LINE_PREFIX[fmt];
  if (prefixFn) {
    // Expand selection to whole lines.
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = text.length;
    const block = text.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const newBlock = lines
      .map((ln, i) => {
        const stripped = ln.replace(/^(\s*)(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)/, "$1");
        return prefixFn(i) + stripped;
      })
      .join("\n");
    const value = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
    return { value, selStart: lineStart, selEnd: lineStart + newBlock.length };
  }

  return { value: text, selStart: start, selEnd: end };
}

function initialDrafts(agent: InternalAgent): Record<FileKey, string> {
  return {
    instructions: initialInstructions(agent),
    // An agent created before 0210 has no soul file; its persona is the closest
    // thing it ever had to one, and the migration seeded it — this is only the
    // fallback for a row read from a stale cache.
    soul: agent.soul ?? agent.persona ?? "",
    preferences: agent.preferences ?? "",
  };
}

// Prefer the stored free-form instructions; fall back to rendering any legacy
// instruction blocks into markdown so nothing is lost on first open.
function initialInstructions(agent: InternalAgent): string {
  if (agent.instructions?.trim()) return agent.instructions;
  if (agent.instruction_blocks && agent.instruction_blocks.length > 0) {
    return renderInstructionBlocks(agent.instruction_blocks);
  }
  return "";
}
