import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  CircleNotchIcon as Loader2,
  PaletteIcon as Palette,
  CursorClickIcon as MousePointerClick,
  LayoutIcon as LayoutPanelTop,
  TextTIcon as TypeIcon,
  SlidersHorizontalIcon as Settings2,
  CodeIcon as Code2,
  MonitorIcon as Monitor,
  DeviceMobileIcon as Smartphone,
  SunIcon as Sun,
  MoonIcon as Moon,
  ChatIcon as MessageSquare,
  SparkleIcon as Sparkles,
  LayoutIcon as LayoutTemplate,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  SoftField, SoftInput, SoftTextarea, SoftSelect, SoftToggle, SoftColor, SoftNumber,
} from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { Agent } from "../AgentBuilder";
import {
  FONT_LABELS, WIDGET_DEFAULTS, WIDGET_MODELS, WIDGET_PRESETS,
  type WidgetConfig, type WidgetModel,
} from "./widgetConfig";
import { AvatarChoices, ThinkingChoices, VoiceGlowControls } from "./StudioPresence";

// Studio du widget public : la configuration à gauche, le widget RÉEL à droite.
//
// L'aperçu ne réimplémente rien — il charge public/widget.js dans une iframe et
// lui pousse le formulaire non enregistré par postMessage. C'est la seule
// garantie qu'un réglage montré ici se comporte pareil chez le visiteur ; une
// seconde implémentation « pour l'aperçu » est exactement comme les deux
// versions du widget ont fini par diverger.

// Les sept onglets sont listés dans publicAgentSubtabs.ts : ils sont dessinés
// par la coque de l'agent public, dans la seconde barre de navigation.
export type StudioTab =
  | "modele" | "apparence" | "lanceur" | "fenetre" | "contenu" | "avance" | "integration";

/* ────────────────────────────── petits contrôles ────────────────────────── */

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/40 py-5 last:border-b-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, wide }: {
  label: string; hint?: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className={cn("grid items-center gap-3", wide ? "grid-cols-1" : "grid-cols-[150px_1fr]")}>
      <div className="min-w-0">
        <label className="block text-sm text-muted-foreground">{label}</label>
        {hint && <span className="block text-[11px] leading-snug text-muted-foreground/70">{hint}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Rangée de pastilles — le sélecteur court, quand les options tiennent en un mot. */
function Pills<T extends string>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={cn("inline-flex flex-wrap gap-1 rounded-full bg-muted/50 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-xs transition-colors",
            value === o.value
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ColorRow({ label, hint, value, onChange }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
}) {
  return <Row label={label} hint={hint}><SoftColor value={value} onChange={onChange} /></Row>;
}

function PxRow({ label, value, onChange, max = 40 }: {
  label: string; value: number; onChange: (v: number) => void; max?: number;
}) {
  return (
    <Row label={label}>
      <SoftNumber value={value} onChange={onChange} unit="px" min={0} max={max} />
    </Row>
  );
}

/* ────────────────────────────── le studio ───────────────────────────────── */

export function WidgetStudio({ agent, tab = "modele" }: { agent: Agent; tab?: StudioTab }) {
  const queryClient = useQueryClient();

  // La couleur de marque du collaborateur (onglet Réglages) amorce l'accent et l'orbe,
  // pour qu'un collaborateur jamais ouvert ici s'embarque quand même à ses couleurs.
  const [cfg, setCfg] = useState<WidgetConfig>({
    ...WIDGET_DEFAULTS,
    accent: agent.accent_color ?? WIDGET_DEFAULTS.accent,
    avatar_first: agent.accent_color ?? WIDGET_DEFAULTS.avatar_first,
    ...((agent.widget_config as Record<string, unknown>) ?? {}),
  } as WidgetConfig);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // What is stored, to tell the merchant when the preview shows something
  // their visitors do not see yet — and to throw it away in one click.
  const [baseline, setBaseline] = useState(() => JSON.stringify(cfg));
  const dirty = JSON.stringify(cfg) !== baseline;
  const [copied, setCopied] = useState(false);
  const [statsCopied, setStatsCopied] = useState(false);
  const statsUrl = `${window.location.origin}/stats/${agent.public_key}`;

  function set(k: string, v: unknown) { setCfg((c) => ({ ...c, [k]: v })); }
  function applyPreset(values: Partial<WidgetConfig>) { setCfg((c) => ({ ...c, ...values })); }

  const WIDGET_URL = "https://founderos-peach.vercel.app/widget.js";
  const oneLiner = `<script src="${WIDGET_URL}" data-agent="${agent.public_key}" defer></script>`;

  const SNIPPETS: Record<string, string> = useMemo(() => ({
    HTML: oneLiner,
    React: `import { useEffect } from "react";

export function FounderOSAgent() {
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "${WIDGET_URL}";
    s.dataset.agent = "${agent.public_key}";
    s.defer = true;
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, []);
  return null;
}`,
    "Next.js": `// app/layout.tsx (App Router)
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script src="${WIDGET_URL}" data-agent="${agent.public_key}" strategy="afterInteractive" />
      </body>
    </html>
  );
}`,
    Vue: `<!-- App.vue -->
<script setup>
import { onMounted } from "vue";
onMounted(() => {
  const s = document.createElement("script");
  s.src = "${WIDGET_URL}";
  s.dataset.agent = "${agent.public_key}";
  s.defer = true;
  document.body.appendChild(s);
});
</script>`,
    Angular: `// app.component.ts
ngOnInit() {
  const s = document.createElement("script");
  s.src = "${WIDGET_URL}";
  s.dataset["agent"] = "${agent.public_key}";
  s.defer = true;
  document.body.appendChild(s);
}`,
    WordPress: `// functions.php, le widget sur toutes les pages
add_action("wp_footer", function () {
  echo '<script src="${WIDGET_URL}" data-agent="${agent.public_key}" defer></script>';
});`,
  }), [agent.public_key, oneLiner]);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ widget_config: cfg }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      setBaseline(JSON.stringify(cfg));
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } finally { setSaving(false); }
  }

  const dark = cfg.theme_mode === "dark" || cfg.theme_mode === "auto";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      <div className="min-w-0">
        {tab === "modele" && (
          <>
            <Group
              title="Modèles"
              hint="Un modèle change la STRUCTURE : où vit le champ de saisie, comment la fenêtre se pose, ce que montre l'écran vide. Vos couleurs, vos textes et votre clé publique restent intacts, on essaie un modèle sans rien perdre."
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {WIDGET_MODELS.map((m) => {
                  const active = (cfg.layout ?? "classic") === m.values.layout;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => applyPreset(m.values)}
                      aria-pressed={active}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors",
                        active
                          ? "border-primary/60 bg-primary/5"
                          : "border-border/70 bg-card hover:border-primary/40",
                      )}
                    >
                      <ModelThumb kind={m.thumb} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{m.label}</span>
                          {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                          {m.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Group>

            <Group title="Structure" hint="Les réglages que porte le modèle. Rien n'est verrouillé : un modèle n'est qu'un point de départ.">
              <Row label="Disposition">
                <SoftSelect
                  value={cfg.layout}
                  onChange={(v) => set("layout", v)}
                  options={[
                    { value: "classic", label: "Classique", hint: "Fenêtre d'un seul tenant, en bas à droite" },
                    { value: "detached", label: "Détaché", hint: "Barre de saisie flottante sous la fenêtre" },
                    { value: "dock", label: "Dock", hint: "Barre de collaborateur toujours posée, sans lanceur rond" },
                    { value: "hero", label: "Accueil", hint: "Écran d'accueil centré tant que rien n'est dit" },
                    { value: "sidebar", label: "Volet", hint: "Collé au bord, pleine hauteur" },
                    { value: "spotlight", label: "Projecteur", hint: "Fenêtre centrée sur la page voilée" },
                  ]}
                />
              </Row>
              <Row label="Réponses du collaborateur" hint="À plat : le texte posé sur la surface, sans bulle">
                <Pills
                  value={cfg.bot_bubble}
                  onChange={(v) => set("bot_bubble", v)}
                  options={[{ value: "bubble", label: "En bulle" }, { value: "flat", label: "À plat" }]}
                />
              </Row>
              <Row label="Bouton de fermeture" hint="Le chevron dit « je replie », la croix « je ferme »">
                <Pills
                  value={cfg.close_icon}
                  onChange={(v) => set("close_icon", v)}
                  options={[{ value: "cross", label: "Croix" }, { value: "chevron", label: "Chevron" }]}
                />
              </Row>
              <SoftToggle
                label="Voiler la page derrière la fenêtre"
                checked={cfg.layout === "spotlight" ? cfg.backdrop !== false : cfg.backdrop === true}
                onChange={(v) => set("backdrop", v)}
              />
            </Group>

            <Group title="Saisie">
              <SoftToggle
                label="Dictée vocale"
                checked={cfg.voice_input}
                onChange={(v) => set("voice_input", v)}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Reconnaissance vocale du navigateur du visiteur, aucun appel ni aucune clé de notre côté.
                Là où le navigateur ne la porte pas (Firefox, la plupart des navigateurs mobiles), le bouton
                n'est pas affiché plutôt qu'affiché et inerte.
              </p>
              {cfg.layout === "dock" && (
                <>
                  <SoftToggle
                    label="Raccourcis clavier C et V"
                    checked={cfg.dock_shortcuts}
                    onChange={(v) => set("dock_shortcuts", v)}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Les pastilles de la barre. La touche n'est captée que si personne n'écrit ailleurs sur la
                    page, un raccourci qui vole le « c » d'un formulaire coûte plus qu'il ne rapporte.
                  </p>
                </>
              )}
            </Group>

            <Group
              title="Lueur du champ"
              hint="Le faisceau voice-glow posé sur le champ de saisie : il respire au repos, monte avec la voix pendant la dictée et balaie le champ pendant que le collaborateur répond."
            >
              <SoftToggle label="Afficher la lueur" checked={cfg.voice_glow !== false} onChange={(v) => set("voice_glow", v)} />
              <VoiceGlowControls cfg={cfg} set={set} />
            </Group>

            {cfg.layout === "hero" && (
              <Group
                title="Écran d'accueil"
                hint="Le titre est le message d'accueil du collaborateur (onglet Réglages) et les raccourcis sont les questions suggérées (onglet Contenu) : ils ne se saisissent pas deux fois."
              >
                <Row label="Salutation">
                  <SoftInput
                    value={cfg.text_hero_greeting}
                    placeholder="Bonjour,"
                    onChange={(e) => set("text_hero_greeting", e.target.value)}
                  />
                </Row>
                <Row label="Phrase d'accompagnement" wide>
                  <SoftTextarea
                    rows={2}
                    value={cfg.text_hero_note}
                    placeholder="Je suis là pour vous aider. Choisissez un raccourci ou dites-moi ce qu'il vous faut."
                    onChange={(e) => set("text_hero_note", e.target.value)}
                  />
                </Row>
              </Group>
            )}
          </>
        )}

        {tab === "apparence" && (
          <>
            <Group title="Thèmes" hint="Un point de départ cohérent. Un thème ne touche que la matière, vos textes, vos conditions et votre clé restent intacts.">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {WIDGET_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => applyPreset(p.values)}
                    className="group flex items-center gap-2.5 rounded-xl border border-border/70 bg-card p-2.5 text-left transition-colors hover:border-primary/50"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                      style={{ background: p.swatch[0], borderColor: p.swatch[2] }}
                    >
                      <span className="h-4 w-4 rounded-full" style={{ background: p.swatch[1] }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{p.label}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{p.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Group>

            <Group title="Mode" hint="« Auto » suit le thème du site hôte et bascule à chaud, sans rechargement.">
              <Row label="Thème">
                <Pills
                  value={cfg.theme_mode}
                  onChange={(v) => set("theme_mode", v)}
                  options={[
                    { value: "light", label: "Clair" },
                    { value: "dark", label: "Sombre" },
                    { value: "auto", label: "Auto" },
                  ]}
                />
              </Row>
            </Group>

            <Group title="Accent">
              <ColorRow label="Accent" hint="Vide = couleur de marque du collaborateur" value={cfg.accent} onChange={(v) => set("accent", v)} />
              <Row label="Texte sur l'accent" hint="Auto calcule le contraste">
                <Pills
                  value={cfg.accent_primary === "auto" ? "auto" : "custom"}
                  onChange={(v) => set("accent_primary", v === "auto" ? "auto" : "#ffffff")}
                  options={[{ value: "auto", label: "Auto" }, { value: "custom", label: "Personnalisé" }]}
                />
              </Row>
              {cfg.accent_primary !== "auto" && (
                <ColorRow label="Couleur du texte" value={String(cfg.accent_primary)} onChange={(v) => set("accent_primary", v)} />
              )}
            </Group>

            {cfg.theme_mode !== "dark" && (
              <Group title="Couleurs, thème clair">
                <ColorRow label="Fond" value={cfg.base} onChange={(v) => set("base", v)} />
                <ColorRow label="Bordure" value={cfg.base_border} onChange={(v) => set("base_border", v)} />
                <ColorRow label="Texte" value={cfg.base_primary} onChange={(v) => set("base_primary", v)} />
                <ColorRow label="Texte secondaire" value={cfg.base_subtle} onChange={(v) => set("base_subtle", v)} />
              </Group>
            )}

            {dark && (
              <Group title="Couleurs, thème sombre">
                <ColorRow label="Fond" value={cfg.dark_base} onChange={(v) => set("dark_base", v)} />
                <ColorRow label="Bordure" value={cfg.dark_border} onChange={(v) => set("dark_border", v)} />
                <ColorRow label="Texte" value={cfg.dark_primary} onChange={(v) => set("dark_primary", v)} />
                <ColorRow label="Texte secondaire" value={cfg.dark_subtle} onChange={(v) => set("dark_subtle", v)} />
              </Group>
            )}

            <Group title="Matière">
              <Row label="Surface">
                <Pills
                  value={cfg.panel_style}
                  onChange={(v) => set("panel_style", v)}
                  options={[{ value: "solid", label: "Pleine" }, { value: "glass", label: "Verre dépoli" }]}
                />
              </Row>
              <Row label="Ombre">
                <Pills
                  value={cfg.shadow}
                  onChange={(v) => set("shadow", v)}
                  options={[
                    { value: "none", label: "Aucune" },
                    { value: "soft", label: "Douce" },
                    { value: "strong", label: "Marquée" },
                  ]}
                />
              </Row>
              <Row label="Densité">
                <Pills
                  value={cfg.density}
                  onChange={(v) => set("density", v)}
                  options={[{ value: "comfortable", label: "Confortable" }, { value: "compact", label: "Compacte" }]}
                />
              </Row>
            </Group>

            <Group title="Rayons">
              <PxRow label="Fenêtre" value={cfg.panel_radius} onChange={(v) => set("panel_radius", v)} max={40} />
              <PxRow label="Bulles" value={cfg.bubble_radius} onChange={(v) => set("bubble_radius", v)} max={32} />
              <PxRow label="Champ de saisie" value={cfg.input_radius} onChange={(v) => set("input_radius", v)} max={32} />
              <PxRow label="Boutons" value={cfg.button_radius} onChange={(v) => set("button_radius", v)} max={32} />
            </Group>

            <Group title="Typographie" hint="Uniquement des piles système : aucune police tierce n'est téléchargée chez vos visiteurs.">
              <Row label="Police">
                <SoftSelect
                  className="max-w-xs"
                  value={cfg.font_family}
                  onChange={(v) => set("font_family", v)}
                  options={Object.keys(FONT_LABELS).map((k) => ({ value: k, label: FONT_LABELS[k] }))}
                />
              </Row>
              {cfg.font_family === "custom" && (
                <Row label="Pile CSS" wide>
                  <SoftInput
                    value={cfg.font_family_custom}
                    placeholder='"Inter", system-ui, sans-serif'
                    onChange={(e) => set("font_family_custom", e.target.value)}
                  />
                </Row>
              )}
            </Group>
          </>
        )}

        {tab === "lanceur" && (
          <>
            <Group title="Bouton">
              <Row label="Taille">
                <Pills
                  value={cfg.launcher_size}
                  onChange={(v) => set("launcher_size", v)}
                  options={[{ value: "sm", label: "S" }, { value: "md", label: "M" }, { value: "lg", label: "L" }]}
                />
              </Row>
              <Row label="Icône">
                <Pills
                  value={cfg.launcher_icon}
                  onChange={(v) => set("launcher_icon", v)}
                  options={[
                    { value: "chat", label: "Chat" },
                    { value: "bubble", label: "Bulle" },
                    { value: "help", label: "Aide" },
                    { value: "sparkle", label: "Étincelle" },
                    { value: "bolt", label: "Éclair" },
                    { value: "orb", label: "Orbe vivante" },
                  ]}
                />
              </Row>
              <Row label="Image" hint="Prime sur l'icône">
                <SoftInput
                  value={cfg.launcher_image_url}
                  placeholder="https://…/avatar.png"
                  onChange={(e) => set("launcher_image_url", e.target.value)}
                />
              </Row>
              <Row label="Libellé" hint="Vide = bouton rond">
                <SoftInput
                  value={cfg.text_main_label}
                  placeholder="Besoin d'aide ?"
                  onChange={(e) => set("text_main_label", e.target.value)}
                />
              </Row>
              <SoftToggle label="Anneau d'attention" checked={cfg.launcher_pulse} onChange={(v) => set("launcher_pulse", v)} />
            </Group>

            <Group title="Position" hint="Les décalages servent quand le site porte déjà un bandeau cookies ou un autre bouton flottant.">
              <Row label="Coin">
                <Pills
                  value={cfg.placement}
                  onChange={(v) => set("placement", v)}
                  options={[{ value: "bottom-right", label: "Bas droite" }, { value: "bottom-left", label: "Bas gauche" }]}
                />
              </Row>
              <PxRow label="Décalage latéral" value={cfg.offset_x} onChange={(v) => set("offset_x", v)} max={160} />
              <PxRow label="Décalage bas" value={cfg.offset_y} onChange={(v) => set("offset_y", v)} max={160} />
            </Group>

            <Group title="Accroche" hint="Une bulle d'invitation, une fois par session et refusable. Un refus est mémorisé, rien n'agace autant qu'une accroche qui revient à chaque page.">
              <SoftToggle label="Afficher une accroche" checked={cfg.teaser_enabled} onChange={(v) => set("teaser_enabled", v)} />
              {cfg.teaser_enabled && (
                <>
                  <Row label="Texte" wide>
                    <SoftTextarea
                      rows={2}
                      value={cfg.teaser_text}
                      placeholder="Une question sur nos délais de livraison ? 👋"
                      onChange={(e) => set("teaser_text", e.target.value)}
                    />
                  </Row>
                  <Row label="Après">
                    <SoftNumber
                      value={cfg.teaser_delay_seconds}
                      onChange={(v) => set("teaser_delay_seconds", v)}
                      unit="s" min={0} max={120}
                    />
                  </Row>
                </>
              )}
            </Group>
          </>
        )}

        {tab === "fenetre" && (
          <>
            <Group title="Format">
              <Row label="Taille">
                <Pills
                  value={cfg.variant}
                  onChange={(v) => set("variant", v)}
                  options={[
                    { value: "tiny", label: "Compacte" },
                    { value: "compact", label: "Moyenne" },
                    { value: "full", label: "Grande" },
                  ]}
                />
              </Row>
              <SoftToggle label="Repliable" checked={cfg.collapsible} onChange={(v) => set("collapsible", v)} />
              <SoftToggle label="Afficher « Powered by »" checked={cfg.show_branding} onChange={(v) => set("show_branding", v)} />
            </Group>

            <Group title="En-tête">
              <Row label="Style">
                <Pills
                  value={cfg.header_style}
                  onChange={(v) => set("header_style", v)}
                  options={[
                    { value: "minimal", label: "Sobre" },
                    { value: "accent", label: "Accent" },
                    { value: "gradient", label: "Dégradé" },
                  ]}
                />
              </Row>
              <Row label="Sous-titre" wide>
                <SoftInput
                  value={cfg.text_subtitle}
                  placeholder="Répond en quelques secondes"
                  onChange={(e) => set("text_subtitle", e.target.value)}
                />
              </Row>
              <SoftToggle label="Pastille « en ligne »" checked={cfg.status_dot} onChange={(v) => set("status_dot", v)} />
            </Group>

            <Group title="Présence du collaborateur" hint="Son visage dans l'en-tête, et sur l'écran d'accueil ou la barre du Dock. L'orbe vivante change d'animation selon ce que fait le collaborateur.">
              <AvatarChoices cfg={cfg} set={set} />
              <Row label="Forme">
                <Pills
                  value={cfg.avatar_shape}
                  onChange={(v) => set("avatar_shape", v)}
                  options={[
                    { value: "circle", label: "Rond" },
                    { value: "rounded", label: "Arrondi" },
                    { value: "square", label: "Carré" },
                  ]}
                />
              </Row>
              {cfg.avatar_type === "live" ? null : cfg.avatar_type === "orb" ? (
                <>
                  <ColorRow label="Couleur 1" value={cfg.avatar_first} onChange={(v) => set("avatar_first", v)} />
                  <ColorRow label="Couleur 2" hint="Vide = orbe uni" value={cfg.avatar_second} onChange={(v) => set("avatar_second", v)} />
                </>
              ) : (
                <Row label="URL de l'image" wide>
                  <SoftInput value={cfg.avatar_url} placeholder="https://…" onChange={(e) => set("avatar_url", e.target.value)} />
                </Row>
              )}
            </Group>

            <Group title="Pendant la réponse" hint="Ce que voit le visiteur entre sa question et la réponse.">
              <ThinkingChoices cfg={cfg} set={set} />
              <Row label="Phrase fixe" hint="Vide = la phrase suit l'étape (recherche, rédaction). Reprise dans la barre du Dock." wide>
                <SoftInput
                  value={cfg.text_working}
                  placeholder="Je cherche dans mes connaissances…"
                  onChange={(e) => set("text_working", e.target.value)}
                />
              </Row>
            </Group>

            <Group title="Composeur">
              <Row label="Bouton d'envoi">
                <Pills
                  value={cfg.send_button_style}
                  onChange={(v) => set("send_button_style", v)}
                  options={[
                    { value: "icon", label: "Icône" },
                    { value: "label", label: "Texte" },
                    { value: "both", label: "Les deux" },
                  ]}
                />
              </Row>
              <Row label="Texte du bouton">
                <SoftInput value={cfg.text_send} placeholder="Envoyer" onChange={(e) => set("text_send", e.target.value)} />
              </Row>
              <Row label="Texte d'invite" wide>
                <SoftInput
                  value={cfg.text_placeholder}
                  placeholder="Écrivez votre message…"
                  onChange={(e) => set("text_placeholder", e.target.value)}
                />
              </Row>
            </Group>
          </>
        )}

        {tab === "contenu" && (
          <>
            <Group title="Questions suggérées" hint="Affichées en pastilles sous le message d'accueil. Cinq au maximum sont montrées.">
              <SoftTextarea
                rows={4}
                value={cfg.suggested_questions}
                onChange={(e) => set("suggested_questions", e.target.value)}
                placeholder={"Une par ligne\nQuels sont vos délais de livraison ?\nComment retourner un article ?"}
              />
            </Group>

            <Group title="Libellés">
              <Row label="Bouton conditions">
                <SoftInput value={cfg.text_start_chat} placeholder="Démarrer la discussion" onChange={(e) => set("text_start_chat", e.target.value)} />
              </Row>
              <Row label="Message d'erreur" hint="Vide = message technique par défaut" wide>
                <SoftInput
                  value={cfg.text_error}
                  placeholder="Désolé, je suis momentanément indisponible."
                  onChange={(e) => set("text_error", e.target.value)}
                />
              </Row>
            </Group>

            <Group title="Avis">
              <SoftToggle label="Proposer 👍 / 👎 après la première réponse" checked={cfg.feedback} onChange={(v) => set("feedback", v)} />
            </Group>

            <Group title="Conditions">
              <SoftToggle
                label="Faire accepter les conditions avant de discuter"
                checked={cfg.terms_enabled}
                onChange={(v) => set("terms_enabled", v)}
              />
              {cfg.terms_enabled && (
                <SoftField label="Texte (Markdown)">
                  <SoftTextarea rows={5} value={cfg.terms_content} onChange={(e) => set("terms_content", e.target.value)} />
                </SoftField>
              )}
            </Group>
          </>
        )}

        {tab === "avance" && (
          <>
            <Group title="Confort">
              <SoftToggle
                label="Garder la conversation d'une page à l'autre"
                checked={cfg.persist_conversation}
                onChange={(v) => set("persist_conversation", v)}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Le fil est gardé dans l'onglet du visiteur (sessionStorage), pendant 6 h au plus, et disparaît quand
                il ferme l'onglet. Rien n'est déposé sur son disque durablement.
              </p>
              <SoftToggle
                label="Signal sonore à la réponse"
                checked={cfg.sound_enabled}
                onChange={(v) => set("sound_enabled", v)}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Son synthétisé à la volée : aucun fichier chargé, aucune requête vers un tiers.
              </p>
            </Group>

            <Group
              title="Proactivité"
              hint="Le collaborateur observe la page (visiteur qui ne bouge plus, clics répétés au même endroit, changement de page) et propose son aide quand le moteur d'activation estime avoir quelque chose d'utile à dire."
            >
              <SoftToggle
                label="Proposer de l'aide sans qu'on la demande"
                checked={cfg.proactive}
                onChange={(v) => set("proactive", v)}
              />
              {cfg.proactive && (
                <Row label="Seuil d'inactivité">
                  <SoftNumber
                    value={cfg.proactive_idle_seconds}
                    onChange={(v) => set("proactive_idle_seconds", v)}
                    unit="s" min={10} max={600}
                  />
                </Row>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Rien n'est proposé pendant une conversation ouverte, et une proposition ignorée disparaît d'elle-même
                au bout de 15 s. Sans effet dans l'aperçu : ce moteur ne tourne que sur une vraie page.
              </p>
            </Group>

            <Group title="CSS personnalisé" hint="Injecté tel quel dans la page hôte. Les classes du widget commencent toutes par .fosw-.">
              <SoftTextarea
                rows={7}
                className="font-mono text-xs"
                value={cfg.custom_css}
                onChange={(e) => set("custom_css", e.target.value)}
                placeholder={".fosw-panel { border-width: 2px; }\n.fosw-launcher { box-shadow: none; }"}
              />
            </Group>
          </>
        )}

        {tab === "integration" && (
          <>
            <Group title="Balise à coller" hint="Une ligne, avant la fermeture de </body>. Elle fonctionne sur n'importe quel site.">
              <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted/50 p-3.5 font-mono text-xs leading-relaxed text-foreground/90">{oneLiner}</pre>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => {
                  navigator.clipboard.writeText(oneLiner);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copié" : "Copier"}
              </Button>
            </Group>

            <Group title="Selon votre framework">
              <FrameworkSnippets snippets={SNIPPETS} />
            </Group>

            <Group
              title="Statistiques publiques"
              hint="Une page à partager qui montre les performances de votre collaborateur : conversations, taux de résolution, temps de réponse, note moyenne. Uniquement des totaux, aucune conversation, aucun visiteur n'y apparaît."
            >
              <SoftToggle
                label="Publier la page de statistiques"
                checked={cfg.public_stats === true}
                onChange={(v) => set("public_stats", v)}
              />
              {cfg.public_stats === true && (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-xl bg-muted/50 px-3.5 py-2.5 font-mono text-xs">{statsUrl}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      navigator.clipboard.writeText(statsUrl);
                      setStatsCopied(true);
                      setTimeout(() => setStatsCopied(false), 1500);
                    }}
                  >
                    {statsCopied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    {statsCopied ? "Copié" : "Copier le lien"}
                  </Button>
                  <Button variant="ghost" size="sm" className="rounded-full" asChild>
                    <a href={statsUrl} target="_blank" rel="noopener">Ouvrir</a>
                  </Button>
                </div>
              )}
              {dirty && cfg.public_stats === true && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">Enregistrez pour que la page soit accessible.</p>
              )}
            </Group>

            <Group title="Clé publique">
              <code className="block truncate rounded-xl bg-muted/50 px-3.5 py-2.5 font-mono text-xs">{agent.public_key}</code>
            </Group>
          </>
        )}

        {/* Save bar — a pill that floats at the BOTTOM of the settings column
            and only shows up when there is something to save. At the top it
            parked under the shell's floating tab bars and overlapped them. */}
        <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
          <div
            className={cn(
              "flex items-center gap-2 rounded-full border border-border/70 bg-background/90 py-1.5 pl-4 pr-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.25)] backdrop-blur-xl transition-all duration-300",
              dirty || saved || saving ? "pointer-events-auto translate-y-0 opacity-100" : "translate-y-3 opacity-0",
            )}
            aria-hidden={!(dirty || saved || saving)}
          >
            {dirty ? (
              <>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  <span className="hidden sm:inline">Modifications non enregistrées</span>
                  <span className="sm:hidden">Non enregistré</span>
                </span>
                <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setCfg(JSON.parse(baseline))}>
                  Annuler
                </Button>
                <Button size="sm" onClick={save} disabled={saving} className="rounded-full">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Enregistrer
                </Button>
              </>
            ) : (
              <span className="flex items-center gap-2 py-1.5 pr-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" weight="bold" /> Enregistré, vos visiteurs le voient
              </span>
            )}
          </div>
        </div>
      </div>

      <WidgetPreview agent={agent} cfg={cfg} />
    </div>
  );
}

/* ────────────────────────────── snippets ────────────────────────────────── */

function FrameworkSnippets({ snippets }: { snippets: Record<string, string> }) {
  const frameworks = Object.keys(snippets);
  const [active, setActive] = useState<string>(frameworks[1] ?? frameworks[0]);
  const [copied, setCopied] = useState(false);
  const code = snippets[active] ?? "";
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {frameworks.map((fw) => (
          <button
            key={fw}
            type="button"
            onClick={() => setActive(fw)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              active === fw
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:bg-secondary",
            )}
          >
            {fw}
          </button>
        ))}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre rounded-xl bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground/90">
        {code}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 rounded-full"
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        {copied ? "Copié" : `Copier ${active}`}
      </Button>
    </div>
  );
}

/* ────────────────────────────── aperçu ─────────────────────────────────── */

type PreviewState = "open" | "thinking" | "launcher";
type PreviewDevice = "desktop" | "mobile";

/** Page hôte factice derrière le widget. Sans elle, on juge des couleurs sur du
 *  vide : la question réelle est « est-ce que ça tient sur MON site ». Une
 *  boutique crédible (marque, héros, fiches produit) plutôt que des barres
 *  grises : un widget se juge sur une vraie page, pas sur un schéma. */
function mockPage(dark: boolean, mobile: boolean): string {
  const bg = dark ? "#0b0b0e" : "#f7f7f5";
  const card = dark ? "#141418" : "#ffffff";
  const line = dark ? "#24242b" : "#e8e6e1";
  const ink = dark ? "#f4f4f5" : "#1c1917";
  const soft = dark ? "#a1a1aa" : "#78716c";
  const tint = dark ? "#1c1c22" : "#efece6";
  const products = [
    ["Lin lavé, Écru", "89 €", "linear-gradient(135deg,#e7d8c3,#c9b08e)"],
    ["Plaid alpaga", "129 €", "linear-gradient(135deg,#b9c4c9,#7f929b)"],
    ["Céramique sable", "34 €", "linear-gradient(135deg,#e9c9b1,#c98f6a)"],
  ];
  return `
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:${bg};color:${ink};overflow:hidden;
      font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
    .nav{display:flex;align-items:center;gap:${mobile ? 12 : 22}px;padding:${mobile ? "16px 18px" : "16px 28px"};border-bottom:1px solid ${line}}
    .brand{font-weight:700;letter-spacing:.14em;font-size:12px;text-transform:uppercase}
    .links{display:${mobile ? "none" : "flex"};gap:18px;font-size:12.5px;color:${soft}}
    .sp{flex:1}
    .cart{font-size:12px;white-space:nowrap;border:1px solid ${line};border-radius:999px;padding:6px 12px;color:${ink};background:${card}}
    .hero{margin:${mobile ? "16px" : "22px 28px"};border-radius:18px;overflow:hidden;position:relative;
      height:${mobile ? 190 : 230}px;background:linear-gradient(120deg,#d9c7ae 0%,#b89b7a 45%,#8a7058 100%)}
    .hero:after{content:"";position:absolute;inset:0;background:radial-gradient(80% 90% at 85% 20%,rgba(255,255,255,.35),transparent 60%)}
    .htext{position:absolute;left:${mobile ? 18 : 28}px;bottom:${mobile ? 18 : 26}px;z-index:1;color:#fff;max-width:70%}
    .eyebrow{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;opacity:.85}
    .h1{font-size:${mobile ? 22 : 30}px;font-weight:650;line-height:1.08;margin-top:6px;letter-spacing:-.01em}
    .btn{display:inline-block;margin-top:12px;font-size:12px;background:#fff;color:#1c1917;border-radius:999px;padding:7px 14px;font-weight:600}
    .row{display:flex;align-items:baseline;justify-content:space-between;margin:${mobile ? "4px 16px 10px" : "6px 28px 12px"}}
    .row b{font-size:14px}.row span{font-size:12px;color:${soft}}
    .grid{display:grid;grid-template-columns:repeat(${mobile ? 2 : 3},1fr);gap:14px;margin:0 ${mobile ? 16 : 28}px}
    .p{background:${card};border:1px solid ${line};border-radius:14px;overflow:hidden}
    .img{height:${mobile ? 96 : 118}px}
    .meta{padding:10px 12px;display:flex;justify-content:space-between;gap:8px;font-size:12px}
    .meta i{font-style:normal;color:${soft}}
    .band{margin:16px ${mobile ? 16 : 28}px 0;background:${tint};border-radius:14px;height:60px}
  </style>
  <div class="nav">
    <div class="brand">Maison Aurore</div>
    <div class="links"><span>Nouveautés</span><span>Maison</span><span>Linge</span><span>Journal</span></div>
    <div class="sp"></div>
    <div class="cart">Panier · 2</div>
  </div>
  <div class="hero"><div class="htext">
    <div class="eyebrow">Collection automne</div>
    <div class="h1">La douceur des matières naturelles</div>
    <span class="btn">Découvrir</span>
  </div></div>
  <div class="row"><b>Sélection du moment</b><span>Voir tout</span></div>
  <div class="grid">
    ${products.slice(0, mobile ? 2 : 3).map(([n, p, g]) => `<div class="p"><div class="img" style="background:${g}"></div><div class="meta"><span>${n}</span><i>${p}</i></div></div>`).join("")}
  </div>
  <div class="band"></div>`;
}

/**
 * Aperçu en direct : le VRAI public/widget.js, dans une iframe, posé sur une
 * page factice. Trois états (conversation, réflexion, au repos) parce que la
 * moitié des réglages — lanceur, anneau, accroche, indicateur de réflexion,
 * lueur — ne se voient que dans l'un d'eux.
 *
 * Il se colle SOUS les barres flottantes de la coque (--float-offset), jamais
 * dessous : en haut à 16 px, il passait derrière elles au défilement.
 */
function WidgetPreview({ agent, cfg }: { agent: Agent; cfg: WidgetConfig }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PreviewState>("open");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [hostDark, setHostDark] = useState(false);
  const mobile = device === "mobile";

  const src = `${window.location.origin}/widget.js`;
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `</head><body>${mockPage(hostDark, mobile)}` +
      `<script src="${src}" data-agent="${agent.public_key}" data-preview="1" data-onboarding="off"><\/script>` +
      `</body></html>`,
    [src, agent.public_key, hostDark, mobile],
  );

  // Remonter l'iframe (changement de page hôte) invalide la poignée de main :
  // on réarme l'attente du "preview-ready" au lieu de pousser dans le vide.
  useEffect(() => { setReady(false); }, [srcDoc, device]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "founderos:preview-ready") setReady(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "founderos:preview-config", config: cfg, preview: { state } },
      "*",
    );
  }, [cfg, ready, state]);

  const frameH = mobile ? 700 : 600;

  return (
    <div className="xl:sticky xl:self-start" style={{ top: "var(--float-offset, 16px)" }}>
      {/* One control bar: what the visitor sees (state), on what (device), on
          which kind of site (host theme). */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground/80">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Aperçu en direct
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur">
          {([
            ["open", "Conversation"],
            ["thinking", "Réflexion"],
            ["launcher", "Au repos"],
          ] as [PreviewState, string][]).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setState(v)}
              aria-pressed={state === v}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                state === v ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <IconToggle active={!mobile} onClick={() => setDevice("desktop")} title="Ordinateur"><Monitor className="h-3.5 w-3.5" /></IconToggle>
          <IconToggle active={mobile} onClick={() => setDevice("mobile")} title="Mobile"><Smartphone className="h-3.5 w-3.5" /></IconToggle>
          <span className="mx-1 h-4 w-px bg-border" />
          <IconToggle active={!hostDark} onClick={() => setHostDark(false)} title="Site clair"><Sun className="h-3.5 w-3.5" /></IconToggle>
          <IconToggle active={hostDark} onClick={() => setHostDark(true)} title="Site sombre"><Moon className="h-3.5 w-3.5" /></IconToggle>
        </div>
      </div>

      {/* Stage: a quiet dotted ground with a soft halo, so the device reads as
          an object placed on a surface rather than a box in a box. */}
      <div
        className="relative overflow-hidden rounded-[28px] border border-border/60 p-5"
        style={{
          backgroundColor: "hsl(var(--muted) / 0.35)",
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, hsl(var(--primary) / 0.10), transparent 70%), radial-gradient(hsl(var(--foreground) / 0.07) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 16px 16px",
        }}
      >
        {!mobile ? (
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_24px_60px_-12px_rgba(0,0,0,0.35)] ring-1 ring-black/5">
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3.5 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="mx-auto flex min-w-0 max-w-[60%] items-center gap-1.5 truncate rounded-full bg-background/80 px-3 py-1 text-[10.5px] text-muted-foreground ring-1 ring-border/60">
                <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                maison-aurore.fr
              </span>
              <span className="w-[42px]" />
            </div>
            <iframe
              key={`d-${hostDark}`}
              ref={frameRef}
              title="Aperçu du widget"
              srcDoc={srcDoc}
              className="block w-full border-0"
              style={{ height: frameH, colorScheme: hostDark ? "dark" : "light" }}
            />
          </div>
        ) : (
          <div className="mx-auto w-[340px] max-w-full rounded-[2.9rem] bg-neutral-900 p-[10px] shadow-[0_30px_70px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
            <div className="relative overflow-hidden rounded-[2.3rem] bg-card">
              <div className="absolute left-1/2 top-2.5 z-10 h-[22px] w-[92px] -translate-x-1/2 rounded-full bg-neutral-900" />
              <iframe
                key={`m-${hostDark}`}
                ref={frameRef}
                title="Aperçu du widget (mobile)"
                srcDoc={srcDoc}
                className="block w-full border-0"
                style={{ height: frameH, colorScheme: hostDark ? "dark" : "light" }}
              />
            </div>
          </div>
        )}
      </div>

      <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
        C'est le widget réel, branché sur le collaborateur : les messages envoyés ici comptent comme de vraies conversations
        et apparaissent dans l'onglet Analytics.
      </p>
    </div>
  );
}

/** Silhouette d'un modèle — une forme, pas un rendu. Six aperçus fidèles côte à
 *  côte se ressembleraient tous ; ce qui distingue un modèle d'un autre, c'est
 *  où sont ses blocs. Le rendu réel, lui, est dans l'aperçu à droite. */
function ModelThumb({ kind }: { kind: WidgetModel["thumb"] }) {
  const surface = "absolute rounded-[3px] bg-background ring-1 ring-foreground/25";
  const line = "absolute rounded-full bg-foreground/20";

  return (
    <span className="relative block h-14 w-[72px] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      {kind === "spotlight" && <span className="absolute inset-0 bg-foreground/25" />}

      {kind === "sidebar" && (
        <span className={cn(surface, "inset-y-0 right-0 w-[44%] rounded-r-none")}>
          <span className={cn(line, "left-1 right-1 top-1.5 h-1.5")} />
          <span className="absolute inset-x-1 bottom-1 h-2.5 rounded-[2px] bg-foreground/15" />
        </span>
      )}

      {kind === "spotlight" && (
        <span className={cn(surface, "left-1/2 top-1/2 h-9 w-11 -translate-x-1/2 -translate-y-1/2")}>
          <span className={cn(line, "left-1 right-1 top-1.5 h-1.5")} />
          <span className="absolute inset-x-1 bottom-1 h-2 rounded-[2px] bg-foreground/15" />
        </span>
      )}

      {kind === "classic" && (
        <span className={cn(surface, "bottom-1.5 right-1.5 h-10 w-12")}>
          <span className={cn(line, "left-1 right-1 top-1.5 h-1.5")} />
          <span className="absolute inset-x-1 bottom-1 h-2.5 rounded-[2px] bg-foreground/15" />
        </span>
      )}

      {kind === "detached" && (
        <>
          <span className={cn(surface, "bottom-[18px] right-1.5 h-8 w-12")}>
            <span className={cn(line, "left-1 right-1 top-1.5 h-1.5")} />
            <span className={cn(line, "left-1 w-6 top-4 h-1")} />
          </span>
          <span className="absolute bottom-1.5 right-1.5 h-3 w-12 rounded-full bg-background ring-1 ring-foreground/25" />
        </>
      )}

      {kind === "dock" && (
        <>
          <span className={cn(surface, "bottom-[19px] right-1.5 h-7 w-12")}>
            <span className={cn(line, "left-1 w-7 top-1.5 h-1")} />
            <span className={cn(line, "left-1 w-5 top-3.5 h-1")} />
          </span>
          <span className={cn(surface, "bottom-1.5 right-1.5 h-4 w-12")}>
            <span className="absolute left-1 top-1 h-2 w-2 rounded-[2px] bg-foreground/30" />
            <span className={cn(line, "left-3.5 right-3 top-1.5 h-1")} />
            <span className="absolute right-1 top-1 h-2 w-2 rounded-[2px] bg-primary/70" />
          </span>
        </>
      )}

      {kind === "hero" && (
        <span className={cn(surface, "bottom-1.5 right-1.5 h-11 w-12")}>
          <span className="absolute left-1/2 top-2 h-2.5 w-2.5 -translate-x-1/2 rounded-[3px] bg-foreground/30" />
          <span className={cn(line, "left-2.5 right-2.5 top-5 h-1")} />
          <span className={cn(line, "left-3.5 right-3.5 top-[26px] h-1")} />
          <span className="absolute inset-x-1 bottom-1 h-3 rounded-[2px] bg-foreground/10 ring-1 ring-foreground/15" />
        </span>
      )}
    </span>
  );
}

function IconToggle({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full p-1.5 transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
