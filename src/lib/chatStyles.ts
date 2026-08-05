// Shared visual language for the agent chat surfaces (internal-agent chat +
// Vibe Code) and the dynamic components rendered inside them. Inspired by a
// clean, vivid reference: soft neutral user bubbles, plain assistant text, and
// a vivid BLUE as the accent for rich cards / interactive elements — distinct
// from the app's coral brand, scoped to the conversation surface. Theme-aware
// (works on light and dark) via Tailwind blue + neutral tokens.

/** Soft, generously-rounded user message pill (right-aligned). */
export const chatUserBubble =
  "max-w-[80%] whitespace-pre-wrap rounded-[1.4rem] bg-foreground/[0.055] px-4 py-2.5 text-sm leading-relaxed text-foreground dark:bg-foreground/[0.09]";

/** A clean, airy surface for a dynamic component (KPIs, chart, table). */
export const chatCard =
  "rounded-2xl border border-border/60 bg-card/70 backdrop-blur-[2px]";

/** The signature vivid-blue hero gradient (link cards, prominent tiles). */
export const chatHero =
  "bg-gradient-to-br from-[#4f7dfc] to-[#3a5fe0] text-white";

/** Vivid-blue accents that read well in both themes. */
export const chatAccentText = "text-[#3b63e8] dark:text-[#7fa0ff]";
export const chatAccentBorder = "border-[#4f7dfc]/30";
export const chatAccentSoftBg = "bg-[#4f7dfc]/[0.08]";

/** Soft, neutral pill button (ask_user quick replies) — quiet by default, gently
 *  lifts on hover. No brand/blue fill, so suggestions read as calm chips. */
export const chatOptionPill =
  "rounded-full border border-border/70 bg-foreground/[0.03] px-3.5 py-1.5 text-xs font-medium text-foreground/75 transition-colors hover:border-border hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.1] disabled:cursor-default disabled:opacity-50 dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.1]";

/** Status hues shared across the surfaces. */
export const STATUS_HUE = {
  success: "text-emerald-500",
  progress: "text-amber-500",
  danger: "text-rose-500",
  accent: "text-[#3b63e8] dark:text-[#7fa0ff]",
} as const;
