import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon, FileArrowUpIcon, FileTextIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Les champs de texte de la création de mission.
//
// SmartTextarea : un cadre plutôt qu'une simple boîte — le texte grandit avec
// ce qu'on écrit (entre un minimum et un maximum de lignes), et une barre en
// pied accueille ce qui accompagne le champ : compteur, actions.
//
// BriefInput : le brief d'une mission. On l'écrit, ou on l'IMPORTE — un .txt
// ou un .md, par le bouton ou en le déposant sur le champ. Un import se
// défait d'un clic. Un titre « # … » en tête du fichier peut servir de titre à
// la mission quand elle n'en a pas encore.

const LINE = 20; // px, pour text-13 / leading-5

export function SmartTextarea({
  value, onChange, placeholder, minRows = 2, maxRows = 12, footer, autoFocus, label, hint, className, onFocusChange,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  /** Ce qui s'affiche dans la barre du bas, à gauche (actions). */
  footer?: ReactNode;
  autoFocus?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
  onFocusChange?: (focused: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // La hauteur suit le contenu : remise à zéro, puis relue.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minRows * LINE + 16), maxRows * LINE + 16)}px`;
  }, [value, minRows, maxRows]);

  return (
    <div className={className}>
      {(label || hint) && (
        <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between gap-2 text-12 font-medium">
          {label}
          {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
        </label>
      )}
      <div className="rounded-xl border border-border bg-muted/20 transition-colors focus-within:border-primary/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/15">
        <textarea
          id={id} ref={ref} value={value} autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-3.5 py-2 text-13 leading-5 outline-none placeholder:text-muted-foreground/70"
          style={{ minHeight: minRows * LINE + 16 }}
        />
        {footer && (
          <div className="flex items-center gap-2 border-t border-border/60 px-2 py-1.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

const ACCEPT = ".txt,.md,.markdown,text/plain,text/markdown";
const MAX_BYTES = 200 * 1024;
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function BriefInput({ value, onChange, onTitle }: {
  value: string;
  onChange: (v: string) => void;
  /** Le titre trouvé en tête d'un fichier importé (« # Titre »). */
  onTitle?: (title: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [imported, setImported] = useState<{ name: string; before: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !/^text\//.test(file.type)) {
      setError("Seuls les fichiers .txt et .md sont acceptés.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Fichier trop lourd : 200 Ko au plus pour un brief.");
      return;
    }
    const text = (await file.text()).replace(/\r\n/g, "\n").trim();
    if (!text) { setError("Ce fichier est vide."); return; }
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (heading) onTitle?.(heading);
    // Un brief déjà écrit n'est pas écrasé : le fichier s'ajoute à la suite.
    setImported({ name: file.name, before: value });
    onChange(value.trim() ? `${value.trim()}\n\n${text}` : text);
  };

  return (
    <div
      className="relative"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void load(e.dataTransfer.files?.[0]); }}
    >
      <SmartTextarea
        label="Brief pour l'équipe"
        hint="facultatif · Markdown accepté"
        value={value}
        onChange={(v) => { onChange(v); if (imported && !v.trim()) setImported(null); }}
        placeholder="Le contexte, l'objectif, les contraintes, ce qui compte vraiment… ou déposez un fichier .txt / .md"
        minRows={7}
        maxRows={16}
        footer={
          <>
            <button
              type="button" onClick={() => input.current?.click()}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-12 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <FileArrowUpIcon className="h-3.5 w-3.5" /> Importer .txt / .md
            </button>
            {imported && (
              <span className="flex min-w-0 items-center gap-1 rounded-md bg-primary/10 py-0.5 pl-1.5 pr-0.5 text-11 text-primary">
                <FileTextIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{imported.name}</span>
                <button
                  type="button" title="Annuler l'import" aria-label="Annuler l'import"
                  onClick={() => { onChange(imported.before); setImported(null); }}
                  className="rounded p-0.5 hover:bg-primary/15"
                >
                  <ArrowCounterClockwiseIcon className="h-3 w-3" />
                </button>
              </span>
            )}
            <span className="ml-auto pr-1 text-11 tabular-nums text-muted-foreground">
              {words(value)} mot{words(value) > 1 ? "s" : ""}
            </span>
          </>
        }
      />
      <input
        ref={input} type="file" accept={ACCEPT} className="hidden"
        onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ""; }}
      />
      {drag && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-6 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary bg-background/90 text-13 font-medium text-primary">
          <FileArrowUpIcon className="h-6 w-6" />
          Déposez le brief ici
          <span className="text-11 font-normal text-muted-foreground">.txt ou .md, 200 Ko au plus</span>
        </div>
      )}
      {error && (
        <p className="mt-1.5 flex items-center gap-1 text-11 text-red-600">
          <XIcon className="h-3 w-3" /> {error}
        </p>
      )}
    </div>
  );
}
