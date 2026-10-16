import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { botAvatarTypes, type BotAvatarShading, type BotAvatarState } from "bot-avatars";
import { ArrowCounterClockwise, Check, Shuffle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { SoftToggle } from "@/components/ui/soft-form";
import {
  BOT_PREFIX, FACES, GLASSES, HATS, HOUSE_LOOK, LANDINGS, NUMBER_SPECS, SHADINGS,
  autoBody, bodyColor, bodyLabel, bodyType, botBodies, parseBotLook, serializeBotLook,
  type BotBody, type BotLook, type LookGroup,
} from "@/lib/bot-avatar-look";
import {
  HUMAN_PREFIX, isHumanAvatar, parseHumanLook, resolveHumanLook, serializeHumanLook, type HumanLook,
} from "@/lib/human-avatar-look";
import { Chips, ColourField, HEX6, LookSlider, Section, Swatch, sameColour } from "./studio-controls";
import { HUMAN_TABS, HumanAvatarControls, randomHumanLook, type HumanTab } from "./HumanAvatarControls";
import { webglAvailable } from "@/components/human-avatar/webgl";

/* ------------------------------------------------------------------ *
 * Illustrated agent portraits via the DiceBear library. Agents keep a
 * full portrait URL in `avatar_url`; the picker lets you choose among
 * many DiceBear styles (Adventurer, Avataaars, Bottts, Lorelei…) and a
 * grid of seeds. No emojis/orbs — agents always show a real avatar.
 * ------------------------------------------------------------------ */
const AVATAR_STYLE = "notionists"; // historical default (keeps existing look)

// Curated DiceBear styles (slugs) — mirrors the library gallery.
export const AVATAR_STYLES = [
  "adventurer", "adventurer-neutral", "avataaars", "avataaars-neutral",
  "big-ears", "big-ears-neutral", "big-smile", "bottts", "bottts-neutral",
  "croodles", "croodles-neutral", "dylan", "fun-emoji", "glass", "icons",
  "identicon", "initials", "lorelei", "lorelei-neutral", "micah", "miniavs",
  "notionists", "notionists-neutral", "open-peeps", "personas",
  "pixel-art", "pixel-art-neutral", "shapes", "thumbs",
] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

const AVATAR_SEEDS = [
  "Aiden", "Bella", "Caleb", "Diana", "Ezra", "Faye", "Gabriel", "Hana",
  "Ivan", "Jade", "Kian", "Lia", "Milo", "Nora", "Omar", "Priya",
  "Quentin", "Rosa", "Soren", "Tara", "Umar", "Vera", "Wyatt", "Zoe",
  "Aria", "Bruno", "Cleo", "Dahlia", "Enzo", "Freya",
];

const prettyStyle = (s: string) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function avatarUrl(seed: string, style: string = AVATAR_STYLE): string {
  // Keep the historical gradient background for the default notionists style so
  // existing agents/templates look unchanged; other styles use their own art.
  const bg = style === "notionists" ? "&backgroundType=gradientLinear" : "";
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}${bg}&radius=20`;
}

export const AVATAR_OPTIONS: string[] = AVATAR_SEEDS.map((s) => avatarUrl(s));

/** Render an agent's portrait. Falls back to a deterministic portrait
 *  derived from `seed` (e.g. the agent name) when no URL is stored. */
export function AgentAvatar({
  url, seed, className,
}: {
  url?: string | null;
  seed?: string | null;
  className?: string;
}) {
  const src = url || avatarUrl(seed || "agent");
  return <img src={src} alt="" className={cn("object-cover", className)} loading="lazy" draggable={false} />;
}

const styleFromUrl = (url: string | null | undefined): string => {
  const m = url?.match(/9\.x\/([^/]+)\/svg/);
  return m && (AVATAR_STYLES as readonly string[]).includes(m[1]) ? m[1] : AVATAR_STYLE;
};

/* ------------------------------------------------------------------ *
 * Avatar studio — every setting bot-avatars has, plus the bodies we drew,
 * and a second kind of avatar: 3D humanoids.
 *
 * It replaced the DiceBear gallery, then the bare body grid: agents are living
 * bots, and now they can be dressed — or be people. The whole look is stored
 * in `avatar_url` (`bot:drop?color=…&hat=crown`, see bot-avatar-look.ts;
 * `human:?hair=bun…`, see human-avatar-look.ts), so nothing migrates;
 * « Réinitialiser » goes back to what the agent's name picks.
 * ------------------------------------------------------------------ */

type Kind = "bot" | "human";
const KINDS: { value: Kind; label: string }[] = [
  { value: "bot", label: "Robot" },
  { value: "human", label: "Humain 3D" },
];

type Tab = "body" | "colour" | "material" | "wear" | "light" | "motion";
const TABS: { id: Tab; label: string }[] = [
  { id: "body", label: "Corps" },
  { id: "colour", label: "Couleur" },
  { id: "material", label: "Matière" },
  { id: "wear", label: "Accessoires" },
  { id: "light", label: "Lumière" },
  { id: "motion", label: "Animation" },
];

const SWATCHES = [
  "#ff5c5c", "#ff7a59", "#ff9f5a", "#ffc94d", "#efdb8e", "#9cd66a", "#2fcb7a", "#1ed3c6", "#41c4ff",
  "#4d7cff", "#9a62ff", "#dc48ff", "#ee8bdb", "#c68b59", "#f4f2fa", "#95a6c4", "#3a3a48", "#16161d",
];
const ACCESSORY_SWATCHES = ["#2b2b33", "#f4efe6", "#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#2e86de", "#8e44ad"];
const INKS = [
  { value: "auto", label: "Automatique" },
  { value: "#1b1b2f", label: "Sombre" },
  { value: "#ffffff", label: "Claire" },
];
const PREVIEW_STATES: { value: BotAvatarState; label: string }[] = [
  { value: "default", label: "Repos" },
  { value: "working", label: "Au travail" },
  { value: "sleeping", label: "Endormi" },
];
const PREVIEW_SIZES = [180, 72, 32].map((px) => ({ value: px, label: `${px}px` }));
/** Avatars live on light pages and on black cards: the preview shows both. */
const STAGES = [
  { value: "light", label: "Fond clair" },
  { value: "dark", label: "Fond sombre" },
] as const;
type Stage = (typeof STAGES)[number]["value"];

const isStock = (b: BotBody) => (botAvatarTypes as string[]).includes(b);
const STOCK_BODIES = botBodies.filter(isStock);
const DRAWN_BODIES = botBodies.filter((b) => !isStock(b));

/** What the body thumbnails wear: colour, texture, face, accessories — not
 *  the fur and light settings, each of which is a new bake, times 28. */
const THUMB_KEYS: (keyof BotLook)[] = [
  "color", "brightness", "saturation", "ink", "face", "shading", "hat", "glasses", "headphones", "bowTie", "accessoryColor",
];

const pick =<T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AvatarPicker({
  value,
  onChange,
  accentColor,
  name,
  onDone,
  variant = "compact",
}: {
  value: string | null;
  onChange: (url: string) => void;
  /** « page »: the studio is the whole page (the agent's Avatar tab) — a big
   *  preview that stays in view, the agent seen where it appears, no inner
   *  scrolling box. « compact »: a field among others. */
  variant?: "compact" | "page";
  /** The agent's accent, offered among the colours. */
  accentColor?: string | null;
  /** The agent's name — drives the automatic body. */
  name?: string;
  /** Adds a « Terminé » button, for a studio opened on demand. */
  onDone?: () => void;
}) {
  const seed = name || "agent";
  // Both drafts are kept, so going from robot to human and back loses neither.
  const [kind, setKind] = useState<Kind>(() => (isHumanAvatar(value) ? "human" : "bot"));
  const [look, setLook] = useState<BotLook>(() => parseBotLook(value) ?? {});
  const [human, setHuman] = useState<HumanLook>(() => parseHumanLook(value) ?? {});
  const [tab, setTab] = useState<Tab>("body");
  const [humanTab, setHumanTab] = useState<HumanTab>("presets");
  const [stage, setStage] = useState<Stage>("light");
  const [previewState, setPreviewState] = useState<BotAvatarState>("default");
  const page = variant === "page";
  const [previewSize, setPreviewSize] = useState(page ? 260 : 180);

  // The draft lives here and reaches the parent a beat later: a slider fires
  // on every pixel, and the parent can be a whole agent page re-rendering.
  const sent = useRef(value ?? "");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const v = pending.current;
    pending.current = null;
    if (v === null || v === sent.current) return;
    sent.current = v;
    onChangeRef.current(v);
  }, []);
  // Closing the studio with a change still on its way sends it.
  useEffect(() => flush, [flush]);
  // The parent changed the value itself (another agent, a save): take it.
  useEffect(() => {
    if ((value ?? "") === sent.current) return;
    sent.current = value ?? "";
    pending.current = null;
    if (isHumanAvatar(value)) {
      setKind("human");
      setHuman(parseHumanLook(value) ?? {});
    } else {
      setKind("bot");
      setLook(parseBotLook(value) ?? {});
    }
  }, [value]);

  const emit = (v: string) => {
    pending.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 180);
  };
  const commit = (next: BotLook) => {
    setLook(next);
    emit(serializeBotLook(next));
  };
  const commitHuman = (next: HumanLook) => {
    setHuman(next);
    emit(serializeHumanLook(next));
  };
  /** Sets one trait of the person; undefined hands it back to the name. A
   *  switched-off flag is kept: it may be overriding the name's « on ». */
  const setHumanTrait = (key: keyof HumanLook, v: HumanLook[keyof HumanLook] | undefined) => {
    const next = { ...human } as Record<string, unknown>;
    if (v === undefined) delete next[key];
    else next[key] = v;
    commitHuman(next as HumanLook);
  };
  const switchKind = (k: Kind) => {
    if (k === kind) return;
    setKind(k);
    emit(k === "human" ? serializeHumanLook(human) : serializeBotLook(look));
  };
  /** Sets one setting; undefined (or a switched-off flag) removes it. */
  const set = <K extends keyof BotLook>(key: K, v: BotLook[K] | undefined) => {
    const next = { ...look };
    if (v === undefined || v === false) delete next[key];
    else next[key] = v;
    commit(next);
  };

  const body: BotBody = look.body ?? autoBody(seed);
  const type = bodyType(body);
  const shading: BotAvatarShading = look.shading ?? HOUSE_LOOK.shading;

  // The canvases follow a beat behind as well: each new fur or light value is
  // a new bake, and a drag would queue dozens of them.
  const shown = useDebounced(look, 150);
  const shownValue = useDebounced(kind === "human" ? serializeHumanLook(human) : serializeBotLook(look), 150);
  // Untouched, an uploaded portrait is still what the agent wears.
  const previewUrl = shownValue
    || (value && !value.startsWith(BOT_PREFIX) && !value.startsWith(HUMAN_PREFIX) ? value : "");
  const humanResolved = useMemo(() => resolveHumanLook(human, seed), [human, seed]);
  const humanAuto = useMemo(() => resolveHumanLook({}, seed), [seed]);
  // The tiles redraw a beat behind, like the preview: a colour dragged
  // through the picker would otherwise redraw a whole grid at every step.
  const humanThumb = useDebounced(human, 150);
  const thumbLook = useMemo(
    () => Object.fromEntries(THUMB_KEYS.filter((k) => shown[k] !== undefined).map((k) => [k, shown[k]])) as BotLook,
    [shown],
  );

  const sliders = (group: LookGroup) => {
    const specs = NUMBER_SPECS.filter((s) => s.group === group && (!s.only || s.only.includes(shading)));
    return (
      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        {specs.map((s) => (
          <LookSlider key={s.key} spec={s} value={look[s.key]} def={s.def(type, shading)} onChange={(v) => set(s.key, v)} />
        ))}
      </div>
    );
  };

  const surprise = () =>
    commit({
      body: pick(botBodies),
      ...(Math.random() < 0.5 ? { color: pick(SWATCHES) } : {}),
      ...(Math.random() < 0.5 ? { shading: pick(["plastic", "crisp", "smooth"] as const) } : {}),
      ...(Math.random() < 0.4 ? { hat: pick(HATS.slice(1)).value } : {}),
      ...(Math.random() < 0.3 ? { glasses: pick(GLASSES.slice(1)).value } : {}),
      ...(Math.random() < 0.25 ? { face: "mouth" as const } : {}),
      ...(Math.random() < 0.15 ? { headphones: true } : {}),
      ...(Math.random() < 0.15 ? { bowTie: true } : {}),
    });

  const bodyButton = (b: BotBody) => (
    <button
      key={b}
      type="button"
      title={bodyLabel(b)}
      aria-label={bodyLabel(b)}
      aria-pressed={look.body === b}
      onClick={() => set("body", b)}
      className={cn(
        "flex aspect-square items-center justify-center rounded-xl border transition-colors",
        look.body === b ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50",
      )}
    >
      <AgentIdentity url={serializeBotLook({ ...thumbLook, body: b })} seed={seed} size={34} interactive={false} paused />
    </button>
  );

  const accent = accentColor && HEX6.test(accentColor) ? accentColor : null;

  return (
    // overflow-clip, not hidden: it rounds the corners without becoming a
    // scroll container, which would keep the page variant's preview from
    // sticking while the settings scroll.
    <div className={cn("overflow-clip border border-border", page ? "rounded-2xl" : "rounded-xl")}>
      {/* The two kinds side by side, each showing what this agent would look
          like as it — a pair of words alone went unnoticed. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Type d'avatar</span>
        <div className="flex gap-2">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              aria-pressed={kind === k.value}
              onClick={() => switchKind(k.value)}
              className={cn(
                "flex items-center gap-2 rounded-xl border py-1.5 pl-1.5 pr-3 text-xs transition-colors",
                kind === k.value
                  ? "border-primary bg-primary/10 font-medium text-foreground ring-1 ring-primary/40"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              <AgentIdentity
                url={k.value === "human" ? serializeHumanLook(human) : serializeBotLook(shown)}
                seed={seed}
                size={30}
                interactive={false}
                paused
              />
              {k.label}
            </button>
          ))}
        </div>
      </div>
      {kind === "human" && !webglAvailable() && (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          Ce navigateur refuse WebGL en ce moment : les humains s'affichent dans leur version 2D, sans relief.
          Pour la 3D, redémarrez le navigateur ou activez l'accélération matérielle dans ses paramètres.
        </p>
      )}
      <div className={cn("grid", page ? "lg:grid-cols-[360px_minmax(0,1fr)]" : "sm:grid-cols-[224px_minmax(0,1fr)]")}>
        {/* The preview — the real component, so what is seen here is what every screen shows. */}
        <div
          className={cn(
            "flex flex-col items-center gap-2.5 border-b border-border p-3",
            // Below the page's floating tab bar.
            page ? "lg:sticky lg:top-24 lg:self-start lg:border-b-0 lg:border-r lg:p-4" : "sm:border-b-0 sm:border-r",
          )}
        >
          <div
            data-theme={stage}
            className={cn(
              "flex w-full items-center justify-center rounded-2xl ring-1 ring-inset transition-colors",
              page ? "h-[340px]" : "h-[220px]",
              stage === "dark"
                ? "bg-[radial-gradient(circle_at_50%_40%,#23232b,#09090b)] ring-white/10"
                : "bg-[radial-gradient(circle_at_50%_40%,#ffffff,#eceef3)] ring-black/5",
            )}
          >
            <AgentIdentity url={previewUrl} seed={seed} size={previewSize} state={previewState} />
          </div>
          <Chips size="sm" options={[...STAGES]} value={stage} onChange={setStage} />
          <Chips size="sm" options={PREVIEW_STATES} value={previewState} onChange={setPreviewState} />
          {page ? (
            // Where the agent will be seen: a list row, the chat, a card.
            <div className="grid w-full grid-cols-3 gap-1.5">
              {[
                { size: 24, label: "Liste" },
                { size: 44, label: "Chat" },
                { size: 72, label: "Carte" },
              ].map((c) => (
                <div key={c.label} data-theme={stage} className={cn("flex h-[96px] flex-col items-center justify-end gap-1.5 rounded-xl pb-2 ring-1 ring-inset", stage === "dark" ? "bg-[#0b0b0f] ring-white/10" : "bg-muted/40 ring-black/5")}>
                  <div className="flex flex-1 items-center">
                    <AgentIdentity url={previewUrl} seed={seed} size={c.size} state={previewState} interactive={false} />
                  </div>
                  <span className={cn("text-[10px]", stage === "dark" ? "text-white/60" : "text-muted-foreground")}>{c.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <Chips size="sm" options={PREVIEW_SIZES} value={previewSize} onChange={setPreviewSize} />
          )}
          <div className="grid w-full grid-cols-2 gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => (kind === "human" ? commitHuman(randomHumanLook()) : surprise())}
              className="flex items-center justify-center gap-1 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] transition-colors hover:bg-muted"
            >
              <Shuffle className="h-3.5 w-3.5" /> Surprise
            </button>
            <button
              type="button"
              onClick={() => (kind === "human" ? commitHuman({}) : commit({}))}
              title="Revenir à ce que le nom choisit"
              className="flex items-center justify-center gap-1 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] transition-colors hover:bg-muted"
            >
              <ArrowCounterClockwise className="h-3.5 w-3.5" /> Réinitialiser
            </button>
          </div>
          {onDone && (
            <button
              type="button"
              onClick={() => { flush(); onDone(); }}
              className="flex w-full items-center justify-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" /> Terminé
            </button>
          )}
        </div>

        <div className={cn("min-w-0", page ? "p-4" : "p-3")}>
          <div role="tablist" className={cn("mb-3 flex flex-wrap gap-1 border-b border-border pb-2", page && "mb-5")}>
            {(kind === "human" ? HUMAN_TABS : TABS).map((t) => {
              const selected = kind === "human" ? humanTab === t.id : tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => (kind === "human" ? setHumanTab(t.id as HumanTab) : setTab(t.id as Tab))}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs transition-colors",
                    selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className={cn("space-y-5", !page && "max-h-[480px] overflow-y-auto scrollbar-slim pr-1")}>
            {kind === "human" && (
              <HumanAvatarControls
                tab={humanTab}
                look={human}
                thumb={humanThumb}
                resolved={humanResolved}
                auto={humanAuto}
                seed={seed}
                set={setHumanTrait}
                apply={commitHuman}
              />
            )}
            {kind === "bot" && tab === "body" && (
              <>
                <Section label="Corps" hint={look.body ? undefined : "En automatique, le nom du collaborateur choisit le corps."}>
                  <button
                    type="button"
                    onClick={() => set("body", undefined)}
                    className={cn(
                      "mb-2 rounded-full px-3 py-1 text-[11px] transition-colors",
                      look.body ? "bg-muted/60 text-muted-foreground hover:text-foreground" : "bg-foreground font-medium text-background",
                    )}
                  >
                    Automatique
                  </button>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1.5">{STOCK_BODIES.map(bodyButton)}</div>
                </Section>
                <Section label="Nouveaux corps">
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1.5">{DRAWN_BODIES.map(bodyButton)}</div>
                </Section>
                <Section label="Visage">
                  <Chips options={FACES} value={look.face ?? "eyes"} onChange={(v) => set("face", v === "eyes" ? undefined : v)} />
                </Section>
              </>
            )}

            {kind === "bot" && tab === "colour" && (
              <>
                <Section label="Couleur du corps">
                  <div className="flex flex-wrap items-center gap-2">
                    <Swatch colour={bodyColor(body)} active={!look.color} onClick={() => set("color", undefined)} title="Sa couleur d'origine" />
                    {accent && (
                      <Swatch colour={accent} active={sameColour(look.color, accent)} onClick={() => set("color", accent.toLowerCase())} title="La couleur de l'agent" />
                    )}
                    <span className="mx-0.5 h-5 w-px bg-border" />
                    {SWATCHES.map((c) => (
                      <Swatch key={c} colour={c} active={sameColour(look.color, c)} onClick={() => set("color", c)} />
                    ))}
                  </div>
                  <ColourField value={look.color ?? bodyColor(body)} onChange={(c) => set("color", c)} />
                </Section>
                <Section label="Teinte">{sliders("colour")}</Section>
                <Section label="Encre du visage" hint="En automatique, l'encre s'éclaircit sur un corps sombre.">
                  <Chips
                    options={INKS}
                    value={INKS.some((o) => sameColour(look.ink, o.value)) ? look.ink! : look.ink ? "" : "auto"}
                    onChange={(v) => set("ink", v === "auto" ? undefined : v)}
                  />
                  <ColourField value={look.ink ?? "#1b1b2f"} onChange={(c) => set("ink", c)} />
                </Section>
              </>
            )}

            {kind === "bot" && tab === "material" && (
              <>
                <Section label="Texture">
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {SHADINGS.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        aria-pressed={shading === s.value}
                        onClick={() => set("shading", s.value === HOUSE_LOOK.shading ? undefined : s.value)}
                        className={cn(
                          "rounded-xl px-3 py-2 text-left transition-colors",
                          shading === s.value ? "bg-primary/10 ring-2 ring-primary/40" : "bg-muted/50 hover:bg-muted",
                        )}
                      >
                        <span className="block text-xs font-medium">{s.label}</span>
                        <span className="block text-[10px] text-muted-foreground">{s.hint}</span>
                      </button>
                    ))}
                  </div>
                </Section>
                <Section label="Volume">{sliders("material")}</Section>
                {shading === "fabric" && <Section label="Fourrure">{sliders("fur")}</Section>}
              </>
            )}

            {kind === "bot" && tab === "wear" && (
              <>
                <Section label="Chapeau">
                  <Chips options={HATS} value={look.hat ?? "none"} onChange={(v) => set("hat", v === "none" ? undefined : v)} />
                </Section>
                <Section label="Lunettes">
                  <Chips options={GLASSES} value={look.glasses ?? "none"} onChange={(v) => set("glasses", v === "none" ? undefined : v)} />
                </Section>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <SoftToggle label="Casque audio" checked={!!look.headphones} onChange={(v) => set("headphones", v)} />
                  <SoftToggle label="Nœud papillon" checked={!!look.bowTie} onChange={(v) => set("bowTie", v)} />
                </div>
                <Section label="Couleur des accessoires" hint="Chapeau, casque et nœud papillon. La couronne reste dorée.">
                  <div className="flex flex-wrap items-center gap-2">
                    <Swatch colour="#2b2b33" active={!look.accessoryColor} onClick={() => set("accessoryColor", undefined)} title="Noir doux (par défaut)" />
                    <span className="mx-0.5 h-5 w-px bg-border" />
                    {ACCESSORY_SWATCHES.slice(1).map((c) => (
                      <Swatch key={c} colour={c} active={sameColour(look.accessoryColor, c)} onClick={() => set("accessoryColor", c)} />
                    ))}
                  </div>
                  <ColourField value={look.accessoryColor ?? "#2b2b33"} onChange={(c) => set("accessoryColor", c)} />
                </Section>
              </>
            )}

            {kind === "bot" && tab === "light" && (
              shading === "flat"
                ? <p className="text-xs text-muted-foreground">La texture « Mat » n'a pas d'éclairage : choisissez-en une autre dans Matière pour régler la lumière.</p>
                : <Section label="Éclairage">{sliders("light")}</Section>
            )}

            {kind === "bot" && tab === "motion" && (
              <>
                <Section label="Mouvements" hint="« Au travail », sous l'aperçu, montre les sauts en série.">{sliders("motion")}</Section>
                <Section label="Atterrissage">
                  <Chips
                    options={LANDINGS}
                    value={look.jumpSquashEase ?? "pulse"}
                    onChange={(v) => set("jumpSquashEase", v === "pulse" ? undefined : v)}
                  />
                </Section>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

