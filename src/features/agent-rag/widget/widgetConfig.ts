// Configuration du widget public — la liste de référence côté application.
//
// ⚠️ Cette liste est le miroir EXACT de `DEFAULTS` dans public/widget.js : le
// script embarqué lit ces clés-là et rien d'autre. Une option ajoutée ici sans
// sa lecture là-bas est un réglage qui ne fait rien — c'est exactement comme ça
// que le panneau et l'embed avaient divergé.

export type VoiceGlowPalette =
  | "colorful" | "mono" | "ocean" | "sunset" | "forest" | "candy" | "ice" | "gold";

export const VOICE_GLOW_PALETTES: { value: VoiceGlowPalette; label: string }[] = [
  { value: "colorful", label: "Spectre" },
  { value: "ocean", label: "Océan" },
  { value: "candy", label: "Bonbon" },
  { value: "sunset", label: "Couchant" },
  { value: "gold", label: "Or" },
  { value: "forest", label: "Forêt" },
  { value: "ice", label: "Glace" },
  { value: "mono", label: "Mono" },
];

export const WIDGET_DEFAULTS = {
  // Modèle — la structure de la fenêtre (voir WIDGET_MODELS)
  layout: "classic" as "classic" | "detached" | "hero" | "sidebar" | "spotlight" | "dock",
  backdrop: false,
  bot_bubble: "bubble" as "bubble" | "flat",
  close_icon: "cross" as "cross" | "chevron",
  voice_input: false,
  // Lueur voice-glow sur le champ : respire au repos, suit la voix, balaie
  // pendant la réponse. Palette = colorVariant de voice-glow.
  voice_glow: true,
  voice_glow_palette: "colorful" as VoiceGlowPalette,
  // Indicateur pendant que l'agent répond : orbe thinking-orbs + phrase, ou
  // les trois points historiques.
  thinking_style: "orb" as "orb" | "dots",
  dock_shortcuts: true,
  text_working: "",
  text_hero_greeting: "",
  text_hero_note: "",

  // Placement
  variant: "full" as "tiny" | "compact" | "full",
  placement: "bottom-right" as "bottom-right" | "bottom-left",
  offset_x: 20,
  offset_y: 20,
  collapsible: true,
  feedback: true,

  // Thème
  theme_mode: "light" as "light" | "dark" | "auto",
  base: "#ffffff",
  base_border: "#e5e7eb",
  base_subtle: "#6b7280",
  base_primary: "#18181b",
  dark_base: "#101013",
  dark_border: "#2a2a30",
  dark_subtle: "#a1a1aa",
  dark_primary: "#f4f4f5",
  accent: "",
  accent_primary: "auto",

  // Formes & matière
  panel_radius: 18,
  button_radius: 12,
  input_radius: 12,
  bubble_radius: 16,
  panel_style: "solid" as "solid" | "glass",
  shadow: "soft" as "none" | "soft" | "strong",
  density: "comfortable" as "comfortable" | "compact",
  font_family: "system" as "system" | "rounded" | "serif" | "mono" | "custom",
  font_family_custom: "",

  // Fenêtre
  header_style: "minimal" as "minimal" | "accent" | "gradient",
  text_subtitle: "",
  status_dot: true,
  avatar_type: "live" as "live" | "orb" | "image",
  avatar_shape: "rounded" as "circle" | "rounded" | "square",
  avatar_first: "",
  avatar_second: "",
  avatar_url: "",

  // Lanceur
  launcher_icon: "chat" as "chat" | "bubble" | "help" | "sparkle" | "bolt" | "orb",
  launcher_image_url: "",
  launcher_size: "md" as "sm" | "md" | "lg",
  launcher_pulse: false,
  teaser_enabled: false,
  teaser_text: "",
  teaser_delay_seconds: 8,

  // Contenu
  terms_enabled: false,
  terms_content: "",
  suggested_questions: "",
  show_branding: true,
  text_main_label: "Besoin d'aide ?",
  text_start_chat: "Démarrer la discussion",
  text_send: "Envoyer",
  text_placeholder: "Écrivez votre message…",
  text_error: "",

  // Proactivité
  proactive: false,
  proactive_idle_seconds: 90,

  // Confort
  send_button_style: "icon" as "icon" | "label" | "both",
  sound_enabled: false,
  persist_conversation: true,
  custom_css: "",
};

export type WidgetConfig = typeof WIDGET_DEFAULTS & Record<string, unknown>;

/**
 * Thèmes prêts à poser.
 *
 * Ils ne touchent QUE la matière (couleurs, formes, densité, ombre) : jamais les
 * textes, ni la clé publique, ni les conditions. Appliquer un thème ne doit
 * jamais effacer le travail d'écriture du marchand — c'est la seule raison pour
 * laquelle un bouton « thème » reste sans danger.
 */
export interface WidgetPreset {
  key: string;
  label: string;
  hint: string;
  /** Aperçu de la pastille : [fond, accent, bordure]. */
  swatch: [string, string, string];
  values: Partial<WidgetConfig>;
}

export const WIDGET_PRESETS: WidgetPreset[] = [
  {
    key: "epure",
    label: "Épuré",
    hint: "Blanc, bords doux, ombre légère",
    swatch: ["#ffffff", "#111827", "#e5e7eb"],
    values: {
      theme_mode: "light", panel_style: "solid", shadow: "soft", density: "comfortable",
      base: "#ffffff", base_border: "#e5e7eb", base_subtle: "#6b7280", base_primary: "#18181b",
      panel_radius: 18, bubble_radius: 16, input_radius: 12, button_radius: 12,
      header_style: "minimal", avatar_shape: "rounded", font_family: "system",
    },
  },
  {
    key: "nuit",
    label: "Nuit",
    hint: "Sombre, verre dépoli, ombre marquée",
    swatch: ["#101013", "#6366f1", "#2a2a30"],
    values: {
      theme_mode: "dark", panel_style: "glass", shadow: "strong", density: "comfortable",
      dark_base: "#101013", dark_border: "#2a2a30", dark_subtle: "#a1a1aa", dark_primary: "#f4f4f5",
      panel_radius: 20, bubble_radius: 16, input_radius: 14, button_radius: 14,
      header_style: "minimal", avatar_shape: "circle", font_family: "system",
    },
  },
  {
    key: "verre",
    label: "Verre",
    hint: "Translucide, en-tête dégradé, grands rayons",
    swatch: ["#f8fafc", "#0ea5e9", "#dbeafe"],
    values: {
      theme_mode: "auto", panel_style: "glass", shadow: "soft", density: "comfortable",
      base: "#f8fafc", base_border: "#e2e8f0", base_subtle: "#64748b", base_primary: "#0f172a",
      panel_radius: 24, bubble_radius: 20, input_radius: 16, button_radius: 16,
      header_style: "gradient", avatar_shape: "circle", font_family: "rounded",
    },
  },
  {
    key: "corporate",
    label: "Corporate",
    hint: "Angles nets, en-tête plein, dense",
    swatch: ["#ffffff", "#1d4ed8", "#cbd5e1"],
    values: {
      theme_mode: "light", panel_style: "solid", shadow: "soft", density: "compact",
      base: "#ffffff", base_border: "#cbd5e1", base_subtle: "#64748b", base_primary: "#0f172a",
      panel_radius: 8, bubble_radius: 8, input_radius: 6, button_radius: 6,
      header_style: "accent", avatar_shape: "square", font_family: "system",
    },
  },
  {
    key: "vitamine",
    label: "Vitaminé",
    hint: "Rond, coloré, lanceur qui appelle",
    swatch: ["#fffbf5", "#f97316", "#fed7aa"],
    values: {
      theme_mode: "light", panel_style: "solid", shadow: "strong", density: "comfortable",
      base: "#fffbf5", base_border: "#fed7aa", base_subtle: "#a16207", base_primary: "#1c1917",
      panel_radius: 26, bubble_radius: 22, input_radius: 20, button_radius: 20,
      header_style: "gradient", avatar_shape: "circle", font_family: "rounded",
      launcher_size: "lg", launcher_pulse: true, voice_glow_palette: "sunset",
    },
  },
  {
    key: "graphite",
    label: "Graphite",
    hint: "Sombre, orbe vivante, lueur monochrome",
    swatch: ["#0c0c0e", "#e4e4e7", "#27272a"],
    values: {
      theme_mode: "dark", panel_style: "glass", shadow: "strong", density: "comfortable",
      dark_base: "#0c0c0e", dark_border: "#27272a", dark_subtle: "#a1a1aa", dark_primary: "#fafafa",
      accent: "#e4e4e7",
      panel_radius: 22, bubble_radius: 18, input_radius: 16, button_radius: 20,
      header_style: "minimal", avatar_type: "live", avatar_shape: "circle", font_family: "system",
      launcher_icon: "orb", thinking_style: "orb", voice_glow: true, voice_glow_palette: "mono",
    },
  },
  {
    key: "aurore",
    label: "Aurore",
    hint: "Clair nacré, orbe vivante, lueur océan",
    swatch: ["#fbfbfe", "#6366f1", "#e0e7ff"],
    values: {
      theme_mode: "auto", panel_style: "glass", shadow: "soft", density: "comfortable",
      base: "#fbfbfe", base_border: "#e0e7ff", base_subtle: "#64748b", base_primary: "#0f172a",
      panel_radius: 24, bubble_radius: 20, input_radius: 18, button_radius: 18,
      header_style: "minimal", avatar_type: "live", avatar_shape: "circle", font_family: "rounded",
      launcher_icon: "orb", thinking_style: "orb", voice_glow: true, voice_glow_palette: "ocean",
    },
  },
];

/**
 * Modèles de widget.
 *
 * Un modèle ne décrit qu'une STRUCTURE : où vit le composeur, comment la
 * fenêtre se pose, ce que montre l'écran vide. Il ne touche ni les couleurs de
 * marque, ni les textes, ni la clé publique — on essaie un modèle sans perdre
 * sa configuration, exactement comme pour les thèmes.
 *
 * `thumb` est la vignette dessinée dans le studio : elle décrit la silhouette
 * (fenêtre, composeur, lanceur) et non un rendu — le vrai rendu est l'aperçu.
 */
export interface WidgetModel {
  key: string;
  label: string;
  hint: string;
  /** Silhouette pour la vignette du studio. */
  thumb: "classic" | "detached" | "hero" | "sidebar" | "spotlight" | "dock";
  values: Partial<WidgetConfig>;
}

export const WIDGET_MODELS: WidgetModel[] = [
  {
    key: "classic",
    label: "Classique",
    hint: "Fenêtre et champ de saisie d'un seul tenant",
    thumb: "classic",
    values: {
      layout: "classic", bot_bubble: "bubble", close_icon: "cross", backdrop: false,
      panel_style: "solid", panel_radius: 18, bubble_radius: 16, input_radius: 12,
    },
  },
  {
    key: "detached",
    label: "Détaché",
    hint: "Barre de saisie flottante sous la fenêtre, réponses à plat",
    thumb: "detached",
    values: {
      layout: "detached", bot_bubble: "flat", close_icon: "chevron", backdrop: false,
      panel_style: "glass", shadow: "strong", panel_radius: 22, bubble_radius: 18,
      header_style: "minimal", avatar_shape: "rounded", voice_input: true,
    },
  },
  {
    key: "dock",
    label: "Dock",
    hint: "Barre d'agent toujours posée : état, voix, raccourcis clavier",
    thumb: "dock",
    values: {
      layout: "dock", bot_bubble: "flat", close_icon: "chevron", backdrop: false,
      panel_style: "solid", shadow: "strong", panel_radius: 16, button_radius: 10,
      bubble_radius: 14, avatar_shape: "rounded", voice_input: true, dock_shortcuts: true,
    },
  },
  {
    key: "hero",
    label: "Accueil",
    hint: "Écran d'accueil centré, raccourcis, champ à barre d'outils",
    thumb: "hero",
    values: {
      layout: "hero", bot_bubble: "bubble", close_icon: "cross", backdrop: false,
      panel_style: "solid", shadow: "soft", panel_radius: 16, input_radius: 10,
      bubble_radius: 14, header_style: "minimal", voice_input: true,
    },
  },
  {
    key: "sidebar",
    label: "Volet",
    hint: "Collé au bord, pleine hauteur, à côté de la page",
    thumb: "sidebar",
    values: {
      layout: "sidebar", bot_bubble: "bubble", close_icon: "cross", backdrop: false,
      panel_style: "solid", shadow: "strong", panel_radius: 0, bubble_radius: 14,
    },
  },
  {
    key: "spotlight",
    label: "Projecteur",
    hint: "Fenêtre centrée sur la page voilée",
    thumb: "spotlight",
    values: {
      layout: "spotlight", bot_bubble: "bubble", close_icon: "cross", backdrop: true,
      panel_style: "solid", shadow: "strong", panel_radius: 20, bubble_radius: 16,
    },
  },
];

export const FONT_LABELS: Record<string, string> = {
  system: "Système (par défaut)",
  rounded: "Arrondie",
  serif: "Serif",
  mono: "Monospace",
  custom: "Pile CSS personnalisée",
};
