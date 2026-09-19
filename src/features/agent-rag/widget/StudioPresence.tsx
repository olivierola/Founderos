// Studio — the controls for the widget's "presence": how the agent shows it is
// there (avatar), that it is working (thinking indicator) and that it hears
// (the voice glow on the field). Each choice is drawn with the REAL component
// the visitor will see — thinking-orbs and voice-glow — not a description of it.
import { useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { VoiceBeam, voicePalettes } from "voice-glow";
import { CheckIcon as Check, ImageIcon, UserCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useThemeMode } from "@/lib/theme-context";
import { VOICE_GLOW_PALETTES, type VoiceGlowPalette, type WidgetConfig } from "./widgetConfig";

type SetFn = (k: string, v: unknown) => void;

function useDark() {
  const mode = useThemeMode();
  return mode === "dark"
    || (typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
}

/** A selectable card whose top half is a live rendering of the option. */
function ChoiceCard({ active, onClick, title, hint, children }: {
  active: boolean; onClick: () => void; title: string; hint: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border text-left transition-all",
        active
          ? "border-primary/60 bg-primary/[0.04] shadow-sm ring-1 ring-primary/30"
          : "border-border/70 bg-card hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm",
      )}
    >
      <span className="flex h-24 items-center justify-center border-b border-border/50 bg-muted/30">
        {children}
      </span>
      <span className="px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {title}
          {active && <Check className="h-3 w-3 text-primary" weight="bold" />}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/* ───────────────────────────── Avatar ──────────────────────────────── */

export function AvatarChoices({ cfg, set }: { cfg: WidgetConfig; set: SetFn }) {
  const accent = (cfg.avatar_first as string) || (cfg.accent as string) || "#6366f1";
  const second = (cfg.avatar_second as string) || accent;
  const shape = cfg.avatar_shape === "circle" ? "rounded-full" : cfg.avatar_shape === "square" ? "rounded-md" : "rounded-2xl";
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      <ChoiceCard
        active={cfg.avatar_type === "live"}
        onClick={() => set("avatar_type", "live")}
        title="Orbe vivante"
        hint="Respire au repos, écoute, cherche puis rédige"
      >
        <span
          className={cn("flex h-16 w-16 items-center justify-center ring-1 ring-border", shape)}
          style={{ background: `radial-gradient(120% 120% at 28% 18%, ${accent}22, transparent 72%)` }}
        >
          <ThinkingOrb state="breathing" size={64} style={{ width: 56, height: 56 }} />
        </span>
      </ChoiceCard>
      <ChoiceCard
        active={cfg.avatar_type === "orb"}
        onClick={() => set("avatar_type", "orb")}
        title="Pastille"
        hint="Dégradé à vos couleurs, glyphe d'agent"
      >
        <span
          className={cn("flex h-16 w-16 items-center justify-center text-white", shape)}
          style={{ background: `linear-gradient(135deg, ${accent}, ${second})` }}
        >
          <UserCircleIcon className="h-7 w-7 opacity-90" />
        </span>
      </ChoiceCard>
      <ChoiceCard
        active={cfg.avatar_type === "image"}
        onClick={() => set("avatar_type", "image")}
        title="Image"
        hint="Votre logo ou un portrait"
      >
        {cfg.avatar_url ? (
          <img src={cfg.avatar_url as string} alt="" className={cn("h-16 w-16 object-cover ring-1 ring-border", shape)} />
        ) : (
          <span className={cn("flex h-16 w-16 items-center justify-center bg-muted text-muted-foreground ring-1 ring-border", shape)}>
            <ImageIcon className="h-6 w-6" />
          </span>
        )}
      </ChoiceCard>
    </div>
  );
}

/* ─────────────────────── Indicateur de réflexion ───────────────────── */

export function ThinkingChoices({ cfg, set }: { cfg: WidgetConfig; set: SetFn }) {
  const label = String(cfg.text_working || "").trim() || "Je cherche dans mes connaissances…";
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <ChoiceCard
        active={(cfg.thinking_style ?? "orb") === "orb"}
        onClick={() => set("thinking_style", "orb")}
        title="Orbe + ce que fait l'agent"
        hint="L'orbe cherche, puis rédige ; la phrase le dit en mots"
      >
        <span className="flex max-w-[92%] items-center gap-2 rounded-2xl bg-background/80 px-3 py-2 ring-1 ring-border/60">
          <ThinkingOrb state="searching" size={20} />
          <span className="agent-activity-live truncate text-xs font-medium">{label}</span>
        </span>
      </ChoiceCard>
      <ChoiceCard
        active={cfg.thinking_style === "dots"}
        onClick={() => set("thinking_style", "dots")}
        title="Trois points"
        hint="L'indicateur classique, le plus discret"
      >
        <span className="flex items-center gap-1 rounded-2xl bg-background/80 px-3.5 py-3 ring-1 ring-border/60">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
      </ChoiceCard>
    </div>
  );
}

/* ─────────────────────────── Lueur du champ ────────────────────────── */

export function VoiceGlowControls({ cfg, set }: { cfg: WidgetConfig; set: SetFn }) {
  const dark = useDark();
  const [processing, setProcessing] = useState(false);
  const palette = ((cfg.voice_glow_palette as VoiceGlowPalette) || "colorful");
  const on = cfg.voice_glow !== false;

  return (
    <div className="space-y-3">
      {/* Live specimen: the real VoiceBeam, on a field shaped like the widget's. */}
      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
        <VoiceBeam
          active={on}
          processing={processing}
          colorVariant={palette}
          theme={dark ? "dark" : "light"}
          borderRadius={16}
          style={{ width: "100%" }}
        >
          <div className="flex h-14 items-center rounded-2xl border border-border bg-card px-4 text-sm text-muted-foreground">
            Écrivez votre message…
          </div>
        </VoiceBeam>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {on ? (processing ? "Pendant la réponse de l'agent" : "Au repos — elle suit la voix pendant la dictée") : "Lueur désactivée"}
          </span>
          <button
            type="button"
            disabled={!on}
            onClick={() => setProcessing((v) => !v)}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] transition-colors disabled:opacity-40",
              processing ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {processing ? "Revenir au repos" : "Simuler une réponse"}
          </button>
        </div>
      </div>

      <div className={cn("grid grid-cols-4 gap-2", !on && "pointer-events-none opacity-40")}>
        {VOICE_GLOW_PALETTES.map((p) => {
          const colors = voicePalettes[p.value]?.[dark ? "dark" : "light"] ?? [];
          const active = palette === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => set("voice_glow_palette", p.value)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors",
                active ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-primary/40",
              )}
            >
              <span
                className="h-6 w-full rounded-full"
                style={{ background: `linear-gradient(90deg, ${colors.join(", ")})` }}
              />
              <span className="text-[11px] font-medium">{p.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
