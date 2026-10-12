import { useRef } from "react";
import { WrenchIcon, LightningIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { BrandLogo } from "@/components/BrandLogo";
import type { ToolNeed } from "./useToolkits";
import { cn } from "@/lib/utils";

/**
 * Catalogue card — the shape used for both the agent roster and the template
 * gallery: a large centred glyph on its own plate, a rule, then the name, two
 * count metrics, capability pills and a right-aligned mono meta string.
 */
export interface CatalogBadge {
  label: string;
  /** "auth" = accent-blue pill, "key" = emerald pill (the two tints of the design). */
  tone?: "auth" | "key";
  title?: string;
}

/** What a collaborator is doing right now, under its name. Templates have none. */
export interface CatalogStatus {
  tone: "working" | "waiting" | "error" | "idle";
  label: string;
  /** The task in hand, the last error… one line, truncated. */
  detail?: string;
}

const STATUS_DOT: Record<CatalogStatus["tone"], string> = {
  working: "bg-emerald-500",
  waiting: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
};

const STATUS_TEXT: Record<CatalogStatus["tone"], string> = {
  working: "text-emerald-700 dark:text-emerald-400",
  waiting: "text-amber-700 dark:text-amber-400",
  error: "text-red-700 dark:text-red-400",
  idle: "text-muted-foreground",
};

/** Same states, on the portrait card's black ground: the light cut of each
 *  colour in both themes, since the card itself never turns light. */
const STATUS_TEXT_ON_BLACK: Record<CatalogStatus["tone"], string> = {
  working: "text-emerald-400",
  waiting: "text-amber-400",
  error: "text-red-400",
  idle: "text-white/55",
};

type CatalogCardProps = {
  /** "portrait" = the collaborator roster: a black card that shows only the
   *  avatar, large, and reveals the name and the rest on hover. */
  variant?: "default" | "portrait";
  glyph: React.ReactNode;
  name: string;
  status?: CatalogStatus;
  /** Wrench count — tools. `null` renders the em dash of the design. */
  tools: number | null;
  /** Bolt count — skills / triggers. */
  extras: number | null;
  badges?: CatalogBadge[];
  /** Small shield after the pills (approval required). */
  shield?: boolean;
  /** Mono text on the right of the pill row. */
  meta?: string;
  /** Revealed over the glyph plate on hover (e.g. an "Add collaborateur" affordance). */
  overlay?: React.ReactNode;
  /** Apps this agent/template depends on, connected or not. */
  tools_needed?: ToolNeed[];
  /** Corner control (menu, …). Rendered OUTSIDE the button — nesting one
   *  interactive element inside another is invalid and breaks click handling. */
  action?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
};

export function CatalogCard(props: CatalogCardProps) {
  if (props.variant === "portrait") return <PortraitCard {...props} />;
  const {
    glyph, name, status, tools, extras, badges, shield, meta, overlay, action, tools_needed, onClick, disabled, className,
  } = props;
  return (
    // h-full + a stretched grid item: every card in a row matches the tallest,
    // and the pill row is pinned to the bottom, so an optional logo strip can
    // no longer make one card shorter than its neighbours.
    <div className={cn("group relative h-full", className)}>
      {action && (
        <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {action}
        </div>
      )}
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card/30 text-left transition-colors",
        "hover:border-border hover:bg-card/60 disabled:opacity-60",
      )}
    >
      <div className="relative flex h-[112px] shrink-0 items-center justify-center bg-[hsl(var(--catalog-stage))]">
        {glyph}
        {overlay && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100">
            {overlay}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col border-t border-border/70 px-3.5 py-3">
        <div className="truncate text-[15px] font-semibold">{name}</div>

        {status && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px]" title={status.detail ?? status.label}>
            <span className="relative flex h-2 w-2 shrink-0">
              {status.tone === "working" && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              )}
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", STATUS_DOT[status.tone])} />
            </span>
            <span className={cn("shrink-0 font-medium", STATUS_TEXT[status.tone])}>{status.label}</span>
            {status.detail && <span className="min-w-0 truncate text-muted-foreground">{status.detail}</span>}
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-3.5 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-1" title="Outils">
            <WrenchIcon className="h-3 w-3" /> {tools === null || tools === 0 ? "–" : tools}
          </span>
          <span className="flex items-center gap-1" title="Skills">
            <LightningIcon className="h-3 w-3" /> {extras === null || extras === 0 ? "–" : extras}
          </span>
        </div>

        {/* Apps the agent runs on. A dimmed logo with a dashed ring means the
            toolkit still has to be connected for the agent to work. */}
        {tools_needed && tools_needed.length > 0 && (
          <div className="mt-2.5 flex items-center gap-1">
            {tools_needed.slice(0, 5).map((t) => (
              <span
                key={t.slug}
                title={t.connected ? `${t.name} · connecté` : `${t.name} · à connecter`}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md border",
                  t.connected ? "border-transparent bg-muted" : "border-dashed border-muted-foreground/40 opacity-50",
                )}
              >
                {t.logo
                  ? <img src={t.logo} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" loading="lazy" />
                  : <BrandLogo slug={t.slug} className="h-3.5 w-3.5" />}
              </span>
            ))}
            {tools_needed.length > 5 && (
              <span className="text-[11px] text-muted-foreground">+{tools_needed.length - 5}</span>
            )}
          </div>
        )}

        <div className="mt-auto flex items-center gap-1.5 pt-2.5">
          {(badges ?? []).map((b) => (
            <span
              key={b.label} title={b.title ?? b.label}
              className={cn(
                "max-w-[92px] truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]",
                b.tone === "key"
                  ? "bg-emerald-500/12 text-emerald-500"
                  : "bg-coral/10 text-primary",
              )}
            >
              {b.label}
            </span>
          ))}
          {shield && <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          {meta && <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">{meta}</span>}
        </div>
      </div>
    </button>
    </div>
  );
}

/** Entre deux sauts provoqués par le survol : assez long pour qu'un balayage
 *  de la grille ne fasse pas sauter le même avatar en boucle. */
const POKE_COOLDOWN_MS = 1600;

/**
 * La carte collaborateur : une carte noire, l'avatar en grand dans le haut, et
 * sous lui le nom, l'état, les outils et la charge.
 *
 * L'avatar répond à la main :
 *   · à l'entrée du pointeur, il saute et fait un tour sur lui-même — le geste
 *     que la librairie réserve au clic, qu'on ne verrait jamais ici puisque le
 *     clic ouvre la fiche ;
 *   · tant que le pointeur bouge sur la carte, il s'incline vers lui (ses yeux
 *     le suivent déjà, c'est la librairie qui s'en charge) ;
 *   · au survol il monte d'un cran sur un ressort, et s'écrase un peu quand on
 *     appuie.
 * Tout cela s'efface sous `prefers-reduced-motion`.
 *
 * La pastille du coin ne s'allume que si le collaborateur travaille, attend
 * quelqu'un ou est en erreur : « Disponible » ne demande rien à personne.
 */
function PortraitCard({
  glyph, name, status, tools, extras, badges, shield, meta, action, tools_needed, onClick, disabled, className,
}: CatalogCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  const lastPoke = useRef(0);
  // Vrai pendant le clic qu'on envoie nous-mêmes à l'avatar : ce clic-là doit
  // le faire sauter, pas ouvrir la fiche.
  const poking = useRef(false);
  const dot = (tone: CatalogStatus["tone"]) => (tone === "idle" ? "bg-white/35" : STATUS_DOT[tone]);

  const reducedMotion = () =>
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const poke = () => {
    const now = performance.now();
    if (disabled || now - lastPoke.current < POKE_COOLDOWN_MS || reducedMotion()) return;
    const canvas = stageRef.current?.querySelector<HTMLCanvasElement>("canvas[data-bot-avatar]");
    if (!canvas) return; // un portrait téléversé : rien à faire sauter
    lastPoke.current = now;
    poking.current = true;
    try { canvas.click(); } finally { poking.current = false; }
  };

  // L'inclinaison passe par deux variables CSS, pas par un état React : elle
  // change à chaque mouvement du pointeur, et re-rendre la carte — donc
  // l'avatar — à cette cadence n'apporterait que des saccades. Elles sont
  // posées sur la scène et non sur la carte, pour que seul l'avatar recalcule
  // son style ; et le cadre de la carte est mesuré une fois, à l'entrée, plutôt
  // qu'à chaque mouvement.
  const rect = useRef<DOMRect | null>(null);
  const tilt = (e: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage || e.pointerType !== "mouse" || reducedMotion()) return;
    const r = (rect.current ??= rootRef.current?.getBoundingClientRect() ?? null);
    if (!r) return;
    stage.style.setProperty("--tx", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    stage.style.setProperty("--ty", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  };
  const untilt = () => {
    rect.current = null;
    stageRef.current?.style.setProperty("--tx", "0");
    stageRef.current?.style.setProperty("--ty", "0");
  };

  return (
    <div
      ref={rootRef}
      className={cn("group relative h-full rounded-2xl", className)}
      onPointerEnter={(e) => {
        rect.current = null;
        if (e.pointerType === "mouse") poke();
      }}
      onPointerMove={tilt}
      onPointerLeave={untilt}
    >
      {action && (
        <div className="absolute right-3 top-3 z-20 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {action}
        </div>
      )}
      {status && status.tone !== "idle" && (
        <span aria-hidden className="pointer-events-none absolute left-4 top-4 z-20 flex h-2.5 w-2.5">
          {status.tone === "working" && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          )}
          <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-black", dot(status.tone))} />
        </span>
      )}

      <button
        onClick={() => { if (!poking.current) onClick?.(); }}
        onFocus={poke}
        disabled={disabled}
        className={cn(
          "relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-black text-left text-white",
          "ring-1 ring-inset ring-white/[0.07] transition-[box-shadow,transform] duration-300 ease-smooth",
          "hover:-translate-y-0.5 hover:ring-white/[0.16] motion-reduce:hover:translate-y-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        )}
      >
        {/* La scène de l'avatar. La place au-dessus de lui n'est pas perdue :
            c'est là qu'il monte quand il saute. */}
        <span className="relative flex h-[164px] shrink-0 items-center justify-center pt-5">
          {/* Une lueur derrière l'avatar, pour qu'un corps sombre se lise
              encore sur le noir ; elle s'ouvre quand on s'approche. Un dégradé
              radial et non un flou : un `blur` de 40 px se recalculait à chaque
              image de la transition. Seules l'échelle et l'opacité bougent. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute left-1/2 top-[56%] h-52 w-52 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.55]",
              "transition-[transform,opacity] duration-500 ease-smooth group-hover:scale-125 group-hover:opacity-100",
            )}
            style={{ background: "radial-gradient(closest-side, rgb(255 255 255 / 0.11), transparent)" }}
          />
          {/* Deux étages, deux tempos. L'inclinaison suit le pointeur : une
              transition courte, sinon chaque mouvement relançait un ressort
              d'une demi-seconde et l'avatar traînait derrière la main. La montée
              et l'écrasement gardent leur ressort, plus vif qu'avant. */}
          <span
            ref={stageRef}
            className="relative will-change-transform motion-reduce:![transform:none]"
            style={{
              transform: "perspective(640px) rotateX(calc(var(--ty, 0) * -18deg)) rotateY(calc(var(--tx, 0) * 22deg))",
              transition: "transform 140ms ease-out",
            }}
          >
            <span
              className={cn(
                "block",
                "group-hover:[--lift:-6px] group-hover:[--grow:1.08] group-active:[--grow:0.94]",
                "motion-reduce:![transform:none]",
              )}
              style={{
                transform: "translateY(var(--lift, 0px)) scale(var(--grow, 1))",
                // Le ressort « bouncy » : l'avatar dépasse un peu sa cible et
                // revient, comme un jouet qu'on effleure.
                transition: "transform 340ms cubic-bezier(0.34, 1.56, 0.64, 1)",
              }}
            >
              {glyph}
            </span>
          </span>
        </span>

        <span className="flex flex-1 flex-col px-5 pb-5 pt-1">
          <span className="truncate text-[17px] font-semibold tracking-tight">{name}</span>

          {status && (
            <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px]" title={status.detail ?? status.label}>
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot(status.tone))} />
              <span className={cn("shrink-0 font-medium", STATUS_TEXT_ON_BLACK[status.tone])}>{status.label}</span>
              {status.detail && <span className="min-w-0 truncate text-white/50">{status.detail}</span>}
            </span>
          )}

          <span className="mt-3 flex items-center gap-3.5 text-[12.5px] text-white/60">
            <span className="flex items-center gap-1" title="Outils">
              <WrenchIcon className="h-3.5 w-3.5" /> {tools === null || tools === 0 ? "–" : tools}
            </span>
            <span className="flex items-center gap-1" title="Skills">
              <LightningIcon className="h-3.5 w-3.5" /> {extras === null || extras === 0 ? "–" : extras}
            </span>
            {/* Les apps sur la même ligne que les compteurs : ce sont deux
                façons de dire avec quoi il travaille. */}
            {tools_needed && tools_needed.length > 0 && (
              <span className="ml-auto flex items-center gap-1.5">
                {tools_needed.slice(0, 4).map((t) => (
                  <span
                    key={t.slug}
                    title={t.connected ? `${t.name} · connecté` : `${t.name} · à connecter`}
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full",
                      t.connected ? "bg-white/10" : "border border-dashed border-white/25 opacity-50",
                    )}
                  >
                    {t.logo
                      ? <img src={t.logo} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" loading="lazy" />
                      : <BrandLogo slug={t.slug} className="h-3.5 w-3.5" />}
                  </span>
                ))}
                {tools_needed.length > 4 && (
                  <span className="text-[11px] text-white/50">+{tools_needed.length - 4}</span>
                )}
              </span>
            )}
          </span>

          {((badges?.length ?? 0) > 0 || shield || meta) && (
            <span className="mt-auto flex items-center gap-1.5 pt-3.5">
              {(badges ?? []).map((b) => (
                <span
                  key={b.label} title={b.title ?? b.label}
                  className={cn(
                    "max-w-[160px] truncate rounded-full px-2.5 py-1 font-mono text-[11.5px]",
                    b.tone === "key"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-[hsl(var(--primary)/0.28)] text-white",
                  )}
                >
                  {b.label}
                </span>
              ))}
              {shield && <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-white/55" />}
              {meta && <span className="ml-auto shrink-0 font-mono text-[11px] text-white/45">{meta}</span>}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
