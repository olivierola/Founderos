import { Palette, Check } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/lib/theme-context";
import { THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * The app-wide skin picker. One choice per person, applied to every dashboard
 * (AI Workforce, Outils IA, Admin, service spaces) and carried across devices
 * through `profiles.theme`.
 */
export function ThemeMenu({ className, align = "end" }: { className?: string; align?: "start" | "end" }) {
  const { theme, setTheme } = useTheme();
  const current = THEMES.find((t) => t.key === theme) ?? THEMES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title={`Thème · ${current.label}`}
          aria-label="Changer de thème"
          className={cn(
            "relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            className,
          )}
        >
          <Palette className="h-4 w-4" />
          {/* The active skin as a dot — this button replaced the separate
              light/dark toggle, so it has to say which theme is on. */}
          <span
            className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-1 ring-black/20"
            style={{ background: current.swatch }}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52 rounded-2xl p-1.5">
        <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Thème</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.key} className="rounded-xl" onSelect={() => setTheme(t.key)}>
            <span className="mr-2 h-4 w-4 shrink-0 rounded-full border border-border" style={{ background: t.swatch }} />
            <span className="min-w-0 flex-1 truncate">{t.label}</span>
            {theme === t.key && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
