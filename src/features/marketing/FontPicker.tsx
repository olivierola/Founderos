import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { FONTS, familyCss, ensureFontLoaded, preloadAllFonts } from "./fonts";

interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
}

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "display", label: "Display" },
  { id: "handwriting", label: "Script" },
  { id: "mono", label: "Mono" },
] as const;

export function FontPicker({ value, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<string>("all");
  const ref = useRef<HTMLDivElement>(null);

  // Preload all font CSS lazily once the dropdown is first opened, so the
  // preview in the list actually renders in the proper face.
  const [preloaded, setPreloaded] = useState(false);
  useEffect(() => {
    if (open && !preloaded) {
      preloadAllFonts();
      setPreloaded(true);
    }
  }, [open, preloaded]);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = FONTS.filter((f) => {
    if (cat !== "all" && f.category !== cat) return false;
    if (search.trim() && !f.family.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const activeFont = FONTS.find((f) => f.family === value) ?? FONTS[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center justify-between rounded border border-input bg-background px-2 text-xs"
      >
        <span className="truncate" style={{ fontFamily: familyCss(activeFont.family) }}>
          {activeFont.family}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
          <div className="space-y-2 border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search font…"
                className="h-7 w-full rounded border border-input bg-background pl-6 pr-2 text-xs"
                autoFocus
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCat(c.id)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] transition",
                    cat === c.id
                      ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((f) => (
              <button
                key={f.family}
                type="button"
                onClick={() => {
                  ensureFontLoaded(f.family);
                  onChange(f.family);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-secondary",
                  value === f.family && "bg-secondary/60",
                )}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm" style={{ fontFamily: familyCss(f.family) }}>
                    {f.family}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    The quick brown fox jumps over the lazy dog
                  </div>
                </div>
                {value === f.family && <Check className="h-3.5 w-3.5 text-[hsl(var(--primary-soft))]" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">No font matches.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
