import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Les douze couleurs système d'Apple (HIG), disponibles en
        // `text-sys-blue`, `bg-sys-red`… Elles suivent le mode clair/sombre et
        // le contraste accru toutes seules, parce que ce sont des variables que
        // la peau réassigne. Hors peau Apple, le repli donne les valeurs
        // publiées en mode clair — ce sont de bonnes couleurs d'état.
        sys: {
          red: "rgb(var(--sys-red, 255 56 60) / <alpha-value>)",
          orange: "rgb(var(--sys-orange, 255 141 40) / <alpha-value>)",
          yellow: "rgb(var(--sys-yellow, 255 204 0) / <alpha-value>)",
          green: "rgb(var(--sys-green, 52 199 89) / <alpha-value>)",
          mint: "rgb(var(--sys-mint, 0 200 179) / <alpha-value>)",
          teal: "rgb(var(--sys-teal, 0 195 208) / <alpha-value>)",
          cyan: "rgb(var(--sys-cyan, 0 192 232) / <alpha-value>)",
          blue: "rgb(var(--sys-blue, 0 136 255) / <alpha-value>)",
          indigo: "rgb(var(--sys-indigo, 97 85 245) / <alpha-value>)",
          purple: "rgb(var(--sys-purple, 203 48 224) / <alpha-value>)",
          pink: "rgb(var(--sys-pink, 255 45 85) / <alpha-value>)",
          brown: "rgb(var(--sys-brown, 172 127 94) / <alpha-value>)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        // Plate editor accent colors (defined as oklch CSS vars in globals.css).
        brand: "var(--brand)",
        highlight: "var(--highlight)",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        // Three-accent system (globals.css defines the HSL vars). <alpha-value>
        // lets `bg-coral/20`, `ring-coral`, `border-teal-accent/40`, … all work.
        // `teal-accent` (not `teal`) avoids clobbering Tailwind's built-in teal
        // scale used for object/icon colors elsewhere.
        coral: {
          DEFAULT: "hsl(var(--accent-coral) / <alpha-value>)",
          foreground: "hsl(var(--accent-coral-foreground))",
        },
        "teal-accent": {
          DEFAULT: "hsl(var(--accent-teal) / <alpha-value>)",
          foreground: "hsl(var(--accent-teal-foreground))",
        },
        aqua: {
          DEFAULT: "hsl(var(--accent-aqua) / <alpha-value>)",
          foreground: "hsl(var(--accent-aqua-foreground))",
        },
        "surface-deep": "hsl(var(--surface-deep))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent: "hsl(var(--sidebar-accent))",
        },
      },
      fontFamily: {
        // Inter en tête, comme Plane. Elms Sans/Vend Sans restent en secours
        // pour les postes où elles sont installées localement.
        sans: [
          "Inter",
          "Elms Sans",
          "Vend Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Les notes s'écrivent à la main : c'est ce qui les distingue d'un work
        // item au premier coup d'œil, avant même de les lire. La pile de secours
        // reste une cursive, jamais Inter — une note en Inter ne se lirait plus
        // comme une note, elle se lirait comme un champ de formulaire.
        hand: [
          "Caveat",
          "Bradley Hand",
          "Segoe Script",
          "Comic Sans MS",
          "cursive",
        ],
        // Les références de work items (PROJ-42) et le code : IBM Plex Mono,
        // dont les chiffres sont nettement plus lisibles en petit corps que
        // ceux d'une mono système.
        mono: [
          "IBM Plex Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // Toute l'échelle dérive du même jeton, y compris `DEFAULT`, `xl` et
      // `2xl`. Sans ça, un `rounded` nu retombait sur le 0,25 rem de Tailwind
      // et rouvrait des angles droits au milieu d'une interface arrondie —
      // exactement ce que le jeton est censé empêcher.
      // Les trois ressorts de SwiftUI, traduits en Bézier. Le choix entre eux
      // se fait sur le REBOND : aucun pour ce qui doit être lu à l'arrivée,
      // léger pour la réponse à un geste, marqué pour ce qui surgit.
      transitionTimingFunction: {
        smooth: "var(--ease-smooth, cubic-bezier(0.32, 0.72, 0, 1))",
        snappy: "var(--ease-snappy, cubic-bezier(0.34, 1.26, 0.64, 1))",
        bouncy: "var(--ease-bouncy, cubic-bezier(0.34, 1.56, 0.64, 1))",
      },
      transitionDuration: {
        instant: "var(--duration-instant, 100ms)",
        quick: "var(--duration-quick, 200ms)",
        standard: "var(--duration-standard, 350ms)",
        slow: "var(--duration-slow, 500ms)",
      },
      // La cible de 44 points, pour la poser à la main là où le sélecteur
      // global de la feuille ne suffit pas.
      minWidth: { tap: "var(--tap-target, 44px)" },
      minHeight: { tap: "var(--tap-target, 44px)" },
      borderRadius: {
        DEFAULT: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 2px)",
        lg: "var(--radius)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
        "3xl": "calc(var(--radius) + 16px)",
      },
      // ── Tokens de Plane ────────────────────────────────────────────────
      // L'échelle est nommée par la TAILLE en pixels et non par un rang
      // abstrait : dans une interface dense on raisonne en « ce libellé fait
      // 11 », et un nom relatif obligerait à retenir une table de
      // correspondance pour arbitrer entre deux valeurs voisines.
      fontSize: {
        // L'échelle NOMMÉE de Tailwind, redirigée vers des variables.
        //
        // Sans ce détour, `text-sm` est compilé en `0.875rem` en dur, et aucune
        // peau ne peut l'atteindre. C'est ce qui rendait le changement de
        // système visuel visible dans le seul module de suivi : lui utilise les
        // crans numériques ci-dessous, les 322 autres fichiers de l'app
        // écrivent `text-sm` / `text-base` / `text-lg`.
        //
        // Les valeurs de repli sont exactement celles de Tailwind : sans peau
        // active, rien ne bouge.
        xs: ["var(--fs-xs, 0.75rem)", { lineHeight: "var(--lh-xs, 1rem)" }],
        sm: ["var(--fs-sm, 0.875rem)", { lineHeight: "var(--lh-sm, 1.25rem)" }],
        base: ["var(--fs-base, 1rem)", { lineHeight: "var(--lh-base, 1.5rem)" }],
        lg: ["var(--fs-lg, 1.125rem)", { lineHeight: "var(--lh-lg, 1.75rem)" }],
        xl: ["var(--fs-xl, 1.25rem)", { lineHeight: "var(--lh-xl, 1.75rem)" }],
        "2xl": ["var(--fs-2xl, 1.5rem)", { lineHeight: "var(--lh-2xl, 2rem)" }],
        "3xl": ["var(--fs-3xl, 1.875rem)", { lineHeight: "var(--lh-3xl, 2.25rem)" }],
        "4xl": ["var(--fs-4xl, 2.25rem)", { lineHeight: "var(--lh-4xl, 2.5rem)" }],
        "5xl": ["var(--fs-5xl, 3rem)", { lineHeight: "var(--lh-5xl, 1)" }],
        "6xl": ["var(--fs-6xl, 3.75rem)", { lineHeight: "var(--lh-6xl, 1)" }],
        "7xl": ["var(--fs-7xl, 4.5rem)", { lineHeight: "var(--lh-7xl, 1)" }],
        9: ["var(--text-9)", { lineHeight: "1.3" }],
        10: ["var(--text-10)", { lineHeight: "1.3" }],
        11: ["var(--text-11)", { lineHeight: "1.35" }],
        12: ["var(--text-12)", { lineHeight: "1.4" }],
        13: ["var(--text-13)", { lineHeight: "1.45" }],
        14: ["var(--text-14)", { lineHeight: "1.5" }],
        16: ["var(--text-16)", { lineHeight: "1.5" }],
        18: ["var(--text-18)", { lineHeight: "1.4" }],
        20: ["var(--text-20)", { lineHeight: "1.3" }],
        24: ["var(--text-24)", { lineHeight: "1.25" }],
        28: ["var(--text-28)", { lineHeight: "1.2" }],
        32: ["var(--text-32)", { lineHeight: "1.2" }],
        40: ["var(--text-40)", { lineHeight: "1.15" }],
        // La grille nommée des HIG. Les interlignes sont ceux publiés par
        // Apple, convertis en ratio : 41/34, 34/28, 28/22… Les reprendre en
        // ratio plutôt qu'en pixels laisse le texte respirer correctement
        // quand quelqu'un grossit la police de son navigateur.
        "large-title": ["var(--text-large-title, 2.125rem)", { lineHeight: "1.206" }],
        "title-1": ["var(--text-title-1, 1.75rem)", { lineHeight: "1.214" }],
        "title-2": ["var(--text-title-2, 1.375rem)", { lineHeight: "1.273" }],
        "title-3": ["var(--text-title-3, 1.25rem)", { lineHeight: "1.25" }],
        headline: ["var(--text-headline, 1.0625rem)", { lineHeight: "1.294", fontWeight: "600" }],
        body: ["var(--text-body, 1.0625rem)", { lineHeight: "1.294" }],
        callout: ["var(--text-callout, 1rem)", { lineHeight: "1.3125" }],
        subhead: ["var(--text-subhead, 0.9375rem)", { lineHeight: "1.333" }],
        footnote: ["var(--text-footnote, 0.8125rem)", { lineHeight: "1.385" }],
        "caption-1": ["var(--text-caption-1, 0.75rem)", { lineHeight: "1.333" }],
        "caption-2": ["var(--text-caption-2, 0.6875rem)", { lineHeight: "1.182" }],
      },
      // Les crans de texte de Plane, utilisables en `text-secondary` /
      // `text-tertiary` / `text-placeholder`. `muted-foreground` reste le
      // raccourci historique et pointe sur le même gris que `tertiary`.
      textColor: {
        secondary: "hsl(var(--text-secondary))",
        tertiary: "hsl(var(--text-tertiary))",
        placeholder: "hsl(var(--text-placeholder))",
      },
      fontWeight: {
        // 450 : le « regular » de Plane, un demi-cran plus dense que 400. Il
        // n'existe que dans une fonte variable — d'où Inter en axe variable.
        regular: "450",
      },
      letterSpacing: {
        "extra-tight": "var(--tracking-extra-tight)",
        tight: "var(--tracking-tight)",
        default: "var(--tracking-default)",
        wide: "var(--tracking-wide)",
      },
      boxShadow: {
        // `raised` = posé sur la page (carte, ligne active).
        // `overlay` = flotte au-dessus (menu, dialogue).
        // Les premières sont presque invisibles : une carte n'a pas à décoller.
        "raised-100": "var(--shadow-raised-100)",
        "raised-200": "var(--shadow-raised-200)",
        "raised-300": "var(--shadow-raised-300)",
        "overlay-100": "var(--shadow-overlay-100)",
        "overlay-200": "var(--shadow-overlay-200)",
      },
      borderWidth: {
        sm: "var(--border-width-sm)",
        md: "var(--border-width-md)",
        lg: "var(--border-width-lg)",
      },
      spacing: {
        page: "var(--padding-page)",
      },
      height: {
        header: "var(--height-header)",
      },
      keyframes: {
        // Pulsing dots on the card-9 family (see components/ui/card-9.tsx).
        // Defined here rather than in a per-instance <style> tag so N cards
        // don't inject N identical stylesheets.
        "promo-card-loader-pulse": {
          "0%, 100%": { opacity: "0.3" },
          "50%": { opacity: "1" },
        },
        "fade-scale": {
          "0%": { opacity: "0", transform: "translateY(-50%) scale(0.95)" },
          "100%": { opacity: "1", transform: "translateY(-50%) scale(1)" },
        },
        // Sweeping highlight used while a routing decision is in flight.
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-scale": "fade-scale 0.2s ease-out",
        shimmer: "shimmer 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("tailwind-scrollbar-hide")],
};

export default config;
