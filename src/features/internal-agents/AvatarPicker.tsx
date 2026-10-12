import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { botAvatarTypes, type BotAvatarShading, type BotAvatarState } from "bot-avatars";
import { ArrowCounterClockwise, Check, Shuffle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { SoftColor, SoftRange, SoftToggle } from "@/components/ui/soft-form";
import {
  BOT_PREFIX, FACES, GLASSES, HATS, HOUSE_LOOK, LANDINGS, NUMBER_SPECS, SHADINGS,
  autoBody, bodyColor, bodyLabel, bodyType, botBodies, parseBotLook, serializeBotLook,
  type BotBody, type BotLook, type LookGroup, type NumberSpec,
} from "@/lib/bot-avatar-look";

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
 * Avatar studio — every setting bot-avatars has, plus the bodies we drew.
 *
 * It replaced the DiceBear gallery, then the bare body grid: agents are living
 * bots, and now they can be dressed. The whole look is stored in `avatar_url`
 * (`bot:drop?color=…&hat=crown`, see bot-avatar-look.ts), so nothing migrates;
 * « Réinitialiser » clears it and the agent's name picks the body again.
 * ------------------------------------------------------------------ */

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
const PREVIEW_SIZES = [120, 64, 32].map((px) => ({ value: px, label: `${px}px` }));

const isStock = (b: BotBody) => (botAvatarTypes as string[]).includes(b);
const STOCK_BODIES = botBodies.filter(isStock);
const DRAWN_BODIES = botBodies.filter((b) => !isStock(b));

/** What the body thumbnails wear: colour, texture, face, accessories — not
 *  the fur and light settings, each of which is a new bake, times 28. */
const THUMB_KEYS: (keyof BotLook)[] = [
  "color", "brightness", "saturation", "ink", "face", "shading", "hat", "glasses", "headphones", "bowTie", "accessoryColor",
];

const HEX6 = /^#[0-9a-f]{6}$/i;
const sameColour = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

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
}: {
  value: string | null;
  onChange: (url: string) => void;
  /** The agent's accent, offered among the colours. */
  accentColor?: string | null;
  /** The agent's name — drives the automatic body. */
  name?: string;
  /** Adds a « Terminé » button, for a studio opened on demand. */
  onDone?: () => void;
}) {
  const seed = name || "agent";
  const [look, setLook] = useState<BotLook>(() => parseBotLook(value) ?? {});
  const [tab, setTab] = useState<Tab>("body");
  const [previewState, setPreviewState] = useState<BotAvatarState>("default");
  const [previewSize, setPreviewSize] = useState(120);

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
    setLook(parseBotLook(value) ?? {});
  }, [value]);

  const commit = (next: BotLook) => {
    setLook(next);
    pending.current = serializeBotLook(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 180);
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
  const shownValue = serializeBotLook(shown);
  // Untouched, an uploaded portrait is still what the agent wears.
  const previewUrl = shownValue || (value && !value.startsWith(BOT_PREFIX) ? value : "");
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
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid sm:grid-cols-[172px_minmax(0,1fr)]">
        {/* The preview — the real component, so what is seen here is what every screen shows. */}
        <div className="flex flex-col items-center gap-2.5 border-b border-border p-3 sm:border-b-0 sm:border-r">
          <div className="flex h-[164px] w-full items-center justify-center rounded-xl bg-muted/40">
            <AgentIdentity url={previewUrl} seed={seed} size={previewSize} state={previewState} />
          </div>
          <Chips size="sm" options={PREVIEW_STATES} value={previewState} onChange={setPreviewState} />
          <Chips size="sm" options={PREVIEW_SIZES} value={previewSize} onChange={setPreviewSize} />
          <div className="grid w-full grid-cols-2 gap-1.5 pt-1">
            <button
              type="button"
              onClick={surprise}
              className="flex items-center justify-center gap-1 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] transition-colors hover:bg-muted"
            >
              <Shuffle className="h-3.5 w-3.5" /> Surprise
            </button>
            <button
              type="button"
              onClick={() => commit({})}
              title="Revenir au corps et à la couleur que le nom choisit"
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

        <div className="min-w-0 p-3">
          <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-border pb-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs transition-colors",
                  tab === t.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="max-h-[340px] space-y-4 overflow-y-auto scrollbar-slim pr-1">
            {tab === "body" && (
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

            {tab === "colour" && (
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

            {tab === "material" && (
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

            {tab === "wear" && (
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

            {tab === "light" && (
              shading === "flat"
                ? <p className="text-xs text-muted-foreground">La texture « Mat » n'a pas d'éclairage : choisissez-en une autre dans Matière pour régler la lumière.</p>
                : <Section label="Éclairage">{sliders("light")}</Section>
            )}

            {tab === "motion" && (
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

function Section({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>}
    </section>
  );
}

function Chips<T extends string | number>({ options, value, onChange, size = "md" }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("flex flex-wrap", size === "sm" ? "justify-center gap-1" : "gap-1.5")}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full transition-colors",
            size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-[11px]",
            o.value === value
              ? "bg-foreground font-medium text-background"
              : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Swatch({ colour, active, onClick, title }: { colour: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title ?? colour}
      aria-label={title ?? colour}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 w-6 shrink-0 rounded-full ring-1 ring-inset ring-black/10 transition-transform hover:scale-110",
        active && "outline outline-2 outline-offset-2 outline-primary",
      )}
      style={{ background: colour }}
    />
  );
}

/** A hex field that lets a half-typed value sit until it is a colour. */
function ColourField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <SoftColor
      value={draft}
      onChange={(v) => {
        setDraft(v);
        if (HEX6.test(v)) onChange(v.toLowerCase());
      }}
      className="mt-2 max-w-[220px]"
    />
  );
}

function LookSlider({ spec, value, def, onChange }: {
  spec: NumberSpec;
  value: number | undefined;
  /** What the library draws when unset; null when it decides by itself. */
  def: number | null;
  onChange: (v: number | undefined) => void;
}) {
  const at = value ?? def ?? (spec.min + spec.max) / 2;
  const fmt = (n: number) => (spec.step >= 1 ? String(Math.round(n)) : n.toFixed(2));
  const reading = value === undefined && def === null ? "auto" : at === 0 && spec.zero ? spec.zero : `${fmt(at)}${spec.unit ?? ""}`;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{spec.label}</span>
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          <span className={value === undefined ? "text-muted-foreground/70" : "font-medium"}>{reading}</span>
          {value !== undefined && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              title="Revenir à la valeur par défaut"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowCounterClockwise className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
      <SoftRange
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={at}
        aria-label={spec.label}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}
