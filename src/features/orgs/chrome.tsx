import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { SignOutIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { Logo, Wordmark } from "@/components/Logo";
import { ThemeMenu } from "@/components/ThemeMenu";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useFirstName, useIsPlatformStaff } from "@/features/journey/api";

/**
 * L'habillage commun des pages de sélection (organisations, projets) : la
 * barre du haut à la manière de la navbar de l'application, des étiquettes de
 * section en capitales espacées, des monogrammes teintés au lieu d'icônes
 * génériques. Gris charbon neutres, violet adouci, rien qui brille.
 */

export function SelectionTopBar({ crumbs }: { crumbs?: ReactNode }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const firstName = useFirstName();
  const { data: staff } = useIsPlatformStaff();
  const initial = (firstName || user?.email || "?").charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-3 px-6">
        <button onClick={() => navigate("/orgs")} className="flex items-center gap-2.5 text-foreground" aria-label="Organisations">
          <Logo size={20} color="currentColor" />
          <Wordmark size={18} />
        </button>
        {crumbs && (
          <>
            <span className="h-5 w-px bg-border" />
            <div className="flex min-w-0 items-center gap-2 text-[13px]">{crumbs}</div>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {staff && (
            <button
              onClick={() => navigate("/staff/users")}
              className="hidden h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
            >
              <UsersThreeIcon className="h-3.5 w-3.5" /> Utilisateurs
            </button>
          )}
          <ThemeMenu />
          <div className="ml-1 flex items-center gap-2 rounded-full border border-border py-1 pl-1 pr-1.5">
            <button
              onClick={() => navigate("/welcome?next=/orgs")}
              title="Votre profil"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25"
            >
              {initial}
            </button>
            <span className="hidden max-w-[180px] truncate text-[12px] text-muted-foreground md:block">{user?.email}</span>
            <button
              onClick={() => void signOut()}
              title="Se déconnecter"
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <SignOutIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

/** Une étiquette de section : capitales espacées et un compteur gris. */
export function SectionLabel({ children, count, right }: { children: ReactNode; count?: number; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{children}</span>
      {count != null && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

// Des teintes douces, de même luminosité, pour que deux monogrammes voisins se
// distinguent sans qu'aucun ne crie.
const TINTS = [
  { bg: "bg-violet-500/15", fg: "text-violet-600 dark:text-violet-300" },
  { bg: "bg-sky-500/15", fg: "text-sky-600 dark:text-sky-300" },
  { bg: "bg-emerald-500/15", fg: "text-emerald-600 dark:text-emerald-300" },
  { bg: "bg-amber-500/15", fg: "text-amber-700 dark:text-amber-300" },
  { bg: "bg-rose-500/15", fg: "text-rose-600 dark:text-rose-300" },
  { bg: "bg-indigo-500/15", fg: "text-indigo-600 dark:text-indigo-300" },
  { bg: "bg-teal-500/15", fg: "text-teal-600 dark:text-teal-300" },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

export function Monogram({ name, seed, size = 44, className }: { name: string; seed?: string; size?: number; className?: string }) {
  const t = TINTS[hash(seed ?? name) % TINTS.length];
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-xl font-medium", t.bg, t.fg, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(name)}
    </span>
  );
}

/** Une pastille d'état en capitales mono. */
export function MonoChip({ children, tone = "idle" }: { children: ReactNode; tone?: "idle" | "accent" | "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "status-mono inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        tone === "idle" && "bg-muted text-muted-foreground",
        tone === "accent" && "bg-primary/15 text-primary",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  );
}
