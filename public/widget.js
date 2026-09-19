/* Anduran Agent Widget — single embeddable file.
 *
 * Usage (one line, in any HTML):
 *   <script src="https://founderos-peach.vercel.app/widget.js" data-agent="PUBLIC_KEY"></script>
 *
 * Optional attributes:
 *   data-user="<external_user_id>"   bind the visitor to a logged-in user
 *   data-position="bottom-right"     | "bottom-left" (overrides the saved placement)
 *   data-onboarding="off"            chat only — never drive the host page
 *                                    (highlights, tooltips, navigation)
 *   data-preview="1"                 builder preview: mount inline, always open
 *
 * Programmatic API (set after script load):
 *   FounderOSAgent.emit("project.created", { id: "p_123" });
 *   FounderOSAgent.ask("How do I invite my team?");
 *   FounderOSAgent.open();   FounderOSAgent.close();
 *   FounderOSAgent.setUser("user_42");
 *
 * The chat surface here is the embeddable twin of the builder's Playground tab:
 * same card, same bubbles, same "Powered by" line — themed by the agent's saved
 * widget_config so what you configure is what your visitors get.
 */
(function () {
  "use strict";
  if (window.FounderOSAgent) return;

  /* Locate the <script> tag that loaded us — used to read data-* attributes
     and to derive the same-origin endpoints. */
  var SELF = document.currentScript || (function () {
    var ss = document.getElementsByTagName("script");
    return ss[ss.length - 1];
  })();
  var SCRIPT_BASE = (function () {
    try { return new URL(SELF.src).origin; } catch (e) { return ""; }
  })();

  var PUBLIC_KEY = SELF && SELF.getAttribute("data-agent");
  var USER_ID    = SELF && SELF.getAttribute("data-user");
  var POSITION_ATTR = SELF && SELF.getAttribute("data-position");
  var SUPABASE_URL = SELF && SELF.getAttribute("data-endpoint"); // optional override

  /* Preview mode (the builder's Widget tab renders this file in an iframe so the
     configuration panel shows the real widget, not a mock-up). The panel mounts
     inline, opened, with no launcher and no page-driving. */
  var PREVIEW = !!(SELF && SELF.getAttribute("data-preview"));

  /* Onboarding drives the HOST page (highlights, tooltips, navigation) from the
     app structure the agent knows. On any page that isn't that app it has
     nothing to point at, so it is only attempted on http(s) pages, and
     data-onboarding="off" turns it off for a given embed. Chat is unaffected. */
  var ONBOARDING_OPT_OUT = (SELF && (SELF.getAttribute("data-onboarding") || "")).toLowerCase() === "off";
  var CAN_DRIVE_PAGE = !ONBOARDING_OPT_OUT && !PREVIEW
    && (location.protocol === "http:" || location.protocol === "https:");

  if (!PUBLIC_KEY) {
    console.warn("[FounderOSAgent] missing data-agent attribute on script tag.");
    return;
  }

  /* Resolve the Supabase functions URL.
     1. data-endpoint on the script tag wins.
     2. Otherwise we try to read it from a global window.FOUNDEROS_ENDPOINT.
     3. Otherwise we fall back to the project's hard-coded URL (set at build). */
  var FN_BASE = SUPABASE_URL
    || (window.FOUNDEROS_ENDPOINT)
    || "https://scugmxahflsjabglodyv.supabase.co/functions/v1";

  /* Public anon key — the Supabase gateway requires an apikey header even on
     public (verify_jwt=false) functions. This key is anon/public by design. */
  var ANON_KEY = (window.FOUNDEROS_ANON_KEY)
    || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjdWdteGFoZmxzamFiZ2xvZHl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4OTAxMjYsImV4cCI6MjA5NTQ2NjEyNn0.HmmO5unnIPPMqhOzdQAR_HElZaVon_oWkIrDp0GsmGI";
  function fnHeaders() { return { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": "Bearer " + ANON_KEY }; }

  /* ---------------- Config ---------------- */
  /* Miroir de WIDGET_DEFAULTS dans src/features/agent-rag/widget/widgetConfig.ts —
     le studio écrit exactement ces clés-là dans rag_agents.widget_config. Une clé
     ajoutée d'un seul côté est un réglage qui ne fait rien. */
  var DEFAULTS = {
    /* Modèle — la STRUCTURE de la fenêtre : où vit le composeur, comment la
       fenêtre se pose. Changer de modèle ne touche ni les couleurs, ni les
       textes, ni le lanceur : on essaie un modèle sans refaire sa config. */
    layout: "classic",            // classic | detached | sidebar | spotlight | dock
    backdrop: false,              // voile sur la page derrière la fenêtre
    bot_bubble: "bubble",         // bubble | flat — bulle ou texte posé
    close_icon: "cross",          // cross | chevron
    voice_input: false,           // dictée (Web Speech API), bouton masqué si non supportée
    voice_glow: true,             // lueur voice-glow sur le champ (seulement si voice_input)
    voice_glow_palette: "colorful", // colorful | mono | ocean | sunset | forest | candy | ice | gold
    thinking_style: "orb",        // orb | dots — indicateur pendant que l'agent répond
    dock_shortcuts: true,         // pastilles C / V du modèle Dock, actives au clavier
    text_working: "",             // état affiché pendant une réponse (modèle Dock)
    text_hero_greeting: "",       // « Bonjour, » du modèle Accueil — vide = masqué
    text_hero_note: "",           // paragraphe sous le titre d'accueil

    variant: "full",              // tiny | compact | full
    placement: "bottom-right",    // bottom-right | bottom-left
    offset_x: 20,                 // marge au bord, en px
    offset_y: 20,
    collapsible: true,
    feedback: true,

    /* Thème. "auto" suit le réglage du site hôte (prefers-color-scheme) et
       bascule à chaud : un widget blanc posé sur un site en mode nuit est ce
       qui trahit le plus un chat « collé » après coup sur la page. */
    theme_mode: "light",          // light | dark | auto
    base: "#ffffff",
    base_border: "#e5e7eb",
    base_subtle: "#6b7280",
    base_primary: "#18181b",
    dark_base: "#101013",
    dark_border: "#2a2a30",
    dark_subtle: "#a1a1aa",
    dark_primary: "#f4f4f5",
    accent: "",                   // vide → accent_color de l'agent
    /* "auto" : l'encre posée SUR l'accent est calculée pour rester lisible.
       Un accent jaune vif avec du blanc dessus est le défaut qui ruine le plus
       de widgets — et personne ne le remarque avant la mise en ligne. */
    accent_primary: "auto",

    /* Formes & matière */
    panel_radius: 18,
    button_radius: 12,
    input_radius: 12,
    bubble_radius: 16,
    panel_style: "solid",         // solid | glass
    shadow: "soft",               // none | soft | strong
    density: "comfortable",       // comfortable | compact
    font_family: "system",        // system | rounded | serif | mono | custom
    font_family_custom: "",

    /* Fenêtre */
    header_style: "minimal",      // minimal | accent | gradient
    text_subtitle: "",
    status_dot: true,
    avatar_type: "live",          // live (orbe animée) | orb (pastille dégradée) | image
    avatar_shape: "rounded",      // circle | rounded | square
    avatar_first: "",             // vide → l'accent, pour un orbe on-brand
    avatar_second: "",            // vide → avatar_first (orbe plat)
    avatar_url: "",

    /* Lanceur */
    launcher_icon: "chat",        // chat | help | sparkle | bubble | bolt | orb (orbe animée)
    launcher_image_url: "",       // prime sur l'icône
    launcher_size: "md",          // sm | md | lg
    launcher_pulse: false,
    teaser_enabled: false,        // bulle d'accroche au bout de N secondes
    teaser_text: "",
    teaser_delay_seconds: 8,

    /* Contenu */
    terms_enabled: false,
    terms_content: "",
    suggested_questions: "",      // une par ligne
    show_branding: true,
    text_main_label: "Besoin d'aide ?",
    text_start_chat: "Démarrer la discussion",
    text_send: "Envoyer",
    text_placeholder: "Écrivez votre message…",
    text_error: "",               // message affiché quand l'appel échoue

    /* Proactivité — le widget observe le comportement (veille, clics rageurs,
       changement de page) et demande au moteur d'activation s'il a quelque
       chose d'utile à proposer. Coupé par défaut : parler sans qu'on vous
       adresse la parole se mérite. */
    proactive: false,
    proactive_idle_seconds: 90,

    /* Confort */
    send_button_style: "icon",    // icon | label | both
    sound_enabled: false,
    persist_conversation: true,   // la conversation survit au changement de page
    custom_css: "",
    public_stats: false,          // page /stats/<clé> (lue côté serveur, pas par ce script)
  };

  var VARIANT_SIZE = {
    tiny:    { w: 320, h: 460 },
    compact: { w: 372, h: 545 },
    full:    { w: 410, h: 645 },
  };

  var LAUNCHER_SIZE = { sm: 48, md: 58, lg: 68 };

  var LAUNCHER_ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/><circle cx="9" cy="10.5" r="1"/><circle cx="13" cy="10.5" r="1"/><circle cx="17" cy="10.5" r="1"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
  };

  var FONT_STACKS = {
    system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", "Nunito", system-ui, sans-serif',
    serif: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  };

  var DENSITY = {
    comfortable: { pad: "16px", gap: "12px", msgPad: "9px 13px", head: "13px 16px" },
    compact:     { pad: "11px", gap: "7px",  msgPad: "7px 11px", head: "10px 13px" },
  };

  var SHADOWS = {
    none: "none",
    soft: "0 18px 50px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.06)",
    strong: "0 32px 80px rgba(0,0,0,0.30), 0 4px 14px rgba(0,0,0,0.12)",
  };

  /* ---------------- State ---------------- */
  var state = {
    publicKey: PUBLIC_KEY,
    userId: USER_ID || null,
    config: null,                  // fetched from rag-agent-public-config
    cfg: null,                     // merged widget_config (DEFAULTS + saved + preview)
    theme: null,                   // resolved colors/sizes
    open: false,
    visitorId: null,
    conversationId: null,
    messages: [],
    completedIntents: [],
    inFlight: false,
    waitingEvent: null,
    accepted: true,                // terms gate
    seeded: false,
    ratingShown: false,
    restoring: false,              // replay d'un fil sauvegardé : ni son ni pastille
    busy: false,                   // une réponse est en route (état de la barre du Dock)
  };

  function getVisitorId() {
    if (state.visitorId) return state.visitorId;
    try {
      var k = "fos_visitor_id";
      var v = localStorage.getItem(k);
      if (!v) {
        v = "vis_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(k, v);
      }
      state.visitorId = v;
    } catch (e) {
      state.visitorId = "vis_" + Math.random().toString(36).slice(2);
    }
    return state.visitorId;
  }

  /* ---------------- Color helpers ---------------- */

  function hexToRgb(hex) {
    var h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    if (!c) return hex;
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")";
  }

  /* ---------------- Styles ---------------- */
  /* Structure only. Everything themeable is a custom property set on .fosw-root
     from the agent's widget_config, so a config change is one style write. */
  var CSS = `
.fosw-root {
  --fosw-base: #ffffff;
  --fosw-border: #e5e7eb;
  --fosw-subtle: #6b7280;
  --fosw-text: #18181b;
  --fosw-soft: rgba(24,24,27,0.06);
  --fosw-softer: rgba(24,24,27,0.03);
  --fosw-accent: #001BB7;
  --fosw-accent-text: #ffffff;
  --fosw-accent-soft: rgba(0,27,183,0.10);
  --fosw-panel-bg: #ffffff;
  --fosw-panel-blur: none;
  --fosw-panel-radius: 18px;
  --fosw-bubble-radius: 16px;
  --fosw-input-radius: 12px;
  --fosw-button-radius: 12px;
  --fosw-avatar-radius: 9px;
  --fosw-shadow: 0 18px 50px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.06);
  --fosw-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --fosw-pad: 16px;
  --fosw-gap: 12px;
  --fosw-msg-pad: 9px 13px;
  --fosw-head-pad: 13px 16px;
  --fosw-w: 410px;
  --fosw-h: 645px;
  --fosw-launcher: 58px;
  --fosw-off-x: 20px;
  --fosw-off-y: 20px;
}
.fosw-root, .fosw-root * { box-sizing: border-box; }
.fosw-root button { font: inherit; }
.fosw-launcher, .fosw-panel, .fosw-teaser, .fosw-popup, .fosw-tooltip, .fosw-toast {
  font-family: var(--fosw-font); font-size: 14px; line-height: 1.45;
  box-sizing: border-box;
}
.fosw-root :focus-visible { outline: 2px solid var(--fosw-accent); outline-offset: 2px; }

/* ── Lanceur ──────────────────────────────────────────────────────────── */
.fosw-launcher {
  position: fixed; z-index: 2147483000;
  height: var(--fosw-launcher); min-width: var(--fosw-launcher); padding: 0;
  border: 0; border-radius: 999px; cursor: pointer;
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  box-shadow: 0 12px 32px rgba(0,0,0,0.24), 0 2px 6px rgba(0,0,0,0.14);
  display: flex; align-items: center; justify-content: center; gap: 9px;
  transition: transform 220ms cubic-bezier(.34,1.56,.64,1), box-shadow 200ms ease;
}
.fosw-launcher:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 18px 40px rgba(0,0,0,0.28); }
.fosw-launcher:active { transform: translateY(0) scale(0.97); }
.fosw-launcher.fosw-has-label { padding: 0 22px 0 19px; }
.fosw-launcher svg { width: 22px; height: 22px; flex: none; }
.fosw-launcher img { width: 100%; height: 100%; border-radius: 999px; object-fit: cover; }
.fosw-launcher-label { font-size: 14px; font-weight: 600; white-space: nowrap; letter-spacing: -0.01em; }
/* L'icône bascule en croix quand le panneau est ouvert : le lanceur devient le
   bouton de fermeture, comme dans tous les chats que vos visiteurs connaissent. */
.fosw-launcher .fosw-ico { display: flex; transition: transform 220ms ease, opacity 160ms ease; }
.fosw-launcher.fosw-open .fosw-ico-main { transform: rotate(-90deg) scale(0.7); opacity: 0; position: absolute; }
.fosw-launcher .fosw-ico-close { position: absolute; transform: rotate(90deg) scale(0.7); opacity: 0; }
.fosw-launcher.fosw-open .fosw-ico-close { transform: none; opacity: 1; position: static; }
.fosw-launcher.fosw-open .fosw-launcher-label { display: none; }

/* Anneau d'attention — une seule pulsation lente, jamais un clignotement. */
.fosw-pulse::after {
  content: ""; position: absolute; inset: 0; border-radius: 999px;
  box-shadow: 0 0 0 0 var(--fosw-accent); opacity: 0.55;
  animation: fosw-pulse 2.6s ease-out infinite;
}
.fosw-dot {
  position: absolute; top: 2px; right: 2px; width: 12px; height: 12px;
  border-radius: 999px; background: #ef4444; border: 2px solid var(--fosw-base);
}

/* Bulle d'accroche */
.fosw-teaser {
  position: fixed; z-index: 2147483000; max-width: 268px;
  background: var(--fosw-base); color: var(--fosw-text);
  border: 1px solid var(--fosw-border); border-radius: 16px;
  padding: 12px 30px 12px 14px; font-size: 13.5px; line-height: 1.5;
  box-shadow: var(--fosw-shadow); cursor: pointer;
  animation: fosw-pop 320ms cubic-bezier(.34,1.56,.64,1);
}
.fosw-teaser-fb { display: flex; gap: 6px; margin-top: 10px; }
.fosw-teaser-fb button {
  border: 1px solid var(--fosw-border); background: var(--fosw-softer);
  border-radius: 8px; padding: 3px 9px; font-size: 12px; cursor: pointer;
}
.fosw-teaser-fb button:hover { background: var(--fosw-soft); }
.fosw-teaser-x {
  position: absolute; top: 5px; right: 6px; width: 20px; height: 20px;
  border: 0; background: transparent; color: var(--fosw-subtle);
  cursor: pointer; border-radius: 999px; font-size: 15px; line-height: 1;
}
.fosw-teaser-x:hover { background: var(--fosw-soft); color: var(--fosw-text); }

/* ── Panneau ──────────────────────────────────────────────────────────── */
/* .fosw-panel n'est qu'un CADRE de positionnement : la matière (fond, bordure,
   rayon, ombre) est portée par .fosw-win. C'est ce dédoublement qui permet aux
   modèles à composeur détaché de poser deux surfaces distinctes l'une sous
   l'autre, sans dupliquer la moitié de la feuille. */
.fosw-panel {
  position: fixed; z-index: 2147483000;
  width: var(--fosw-w); max-width: calc(100vw - 24px);
  height: var(--fosw-h); max-height: calc(100vh - 108px);
  color: var(--fosw-text);
  background: transparent; border: 0; box-shadow: none;
  display: none; flex-direction: column; gap: 10px;
  transform-origin: bottom right;
  animation: fosw-in 260ms cubic-bezier(.16,1,.3,1);
  /* Le cadre peut dépasser la surface (modèle Dock replié) : sans ça, une
     zone transparente de 400px mangerait les clics de la page hôte. */
  pointer-events: none;
}
.fosw-panel > * { pointer-events: auto; }
.fosw-win {
  flex: 1; min-height: 0; position: relative; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--fosw-panel-bg);
  backdrop-filter: var(--fosw-panel-blur); -webkit-backdrop-filter: var(--fosw-panel-blur);
  border: 1px solid var(--fosw-border);
  border-radius: var(--fosw-panel-radius);
  box-shadow: var(--fosw-shadow);
}
.fosw-panel-pos-bl { transform-origin: bottom left; }
.fosw-closing { animation: fosw-out 160ms ease-in forwards; }

/* Aperçu : panneau posé dans le cadre, sans position fixe. Les plafonds
   relatifs au viewport sautent — ici le « viewport » est la fenêtre d'aperçu,
   pas une page que le panneau doit éviter de recouvrir. */
.fosw-preview .fosw-panel {
  position: relative; inset: auto; margin: 0 auto;
  max-width: 100%; max-height: none; animation: none;
}
/* …sauf en aperçu « lanceur », où l'on veut justement la mise en place réelle. */
.fosw-preview.fosw-preview-fixed .fosw-panel { position: fixed; max-height: calc(100vh - 108px); }

.fosw-header {
  display: flex; align-items: center; gap: 11px;
  padding: var(--fosw-head-pad); border-bottom: 1px solid var(--fosw-border);
  background: transparent;
}
.fosw-head-accent { background: var(--fosw-accent); border-bottom-color: transparent; }
.fosw-head-gradient {
  background: linear-gradient(135deg, var(--fosw-accent), var(--fosw-accent-2, var(--fosw-accent)));
  border-bottom-color: transparent;
}
.fosw-head-accent .fosw-title, .fosw-head-gradient .fosw-title,
.fosw-head-accent .fosw-subtitle, .fosw-head-gradient .fosw-subtitle { color: var(--fosw-accent-text); }
.fosw-head-accent .fosw-iconbtn, .fosw-head-gradient .fosw-iconbtn { color: var(--fosw-accent-text); opacity: 0.75; }
.fosw-head-accent .fosw-iconbtn:hover, .fosw-head-gradient .fosw-iconbtn:hover {
  opacity: 1; background: rgba(255,255,255,0.16);
}

.fosw-avatar-wrap { position: relative; flex: none; }
.fosw-avatar {
  width: 32px; height: 32px; border-radius: var(--fosw-avatar-radius);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.fosw-avatar svg { width: 17px; height: 17px; }
.fosw-avatar img { width: 100%; height: 100%; object-fit: cover; }
.fosw-status {
  position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px;
  border-radius: 999px; background: #22c55e; border: 2px solid var(--fosw-base);
}
.fosw-head-accent .fosw-status, .fosw-head-gradient .fosw-status { border-color: var(--fosw-accent); }
.fosw-headtext { flex: 1; min-width: 0; }
.fosw-title {
  font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--fosw-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fosw-subtitle {
  font-size: 11.5px; color: var(--fosw-subtle); margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fosw-iconbtn {
  background: transparent; border: 0; color: var(--fosw-subtle);
  cursor: pointer; padding: 6px; border-radius: 9px; display: flex;
  line-height: 0; transition: background 140ms ease, color 140ms ease;
}
.fosw-iconbtn:hover { background: var(--fosw-soft); color: var(--fosw-text); }
.fosw-iconbtn svg { width: 15px; height: 15px; }

.fosw-body {
  position: relative; flex: 1; overflow-y: auto; padding: var(--fosw-pad);
  display: flex; flex-direction: column; gap: var(--fosw-gap);
  background: transparent;
  scrollbar-width: thin; scrollbar-color: var(--fosw-soft) transparent;
}
.fosw-body::-webkit-scrollbar { width: 8px; }
.fosw-body::-webkit-scrollbar-thumb { background: var(--fosw-soft); border-radius: 999px; }
.fosw-row { display: flex; animation: fosw-msg-in 260ms cubic-bezier(.16,1,.3,1); }
.fosw-row-user { justify-content: flex-end; }
.fosw-row-bot  { justify-content: flex-start; }
.fosw-msg {
  max-width: 85%; padding: var(--fosw-msg-pad); font-size: 14px; line-height: 1.5;
  border-radius: var(--fosw-bubble-radius);
  word-wrap: break-word; overflow-wrap: anywhere;
}
.fosw-msg p { margin: 0; }
.fosw-msg p + p { margin-top: 6px; }
.fosw-msg a { color: inherit; text-decoration: underline; }
.fosw-msg .fosw-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  background: rgba(127,127,127,0.16); padding: 1px 4px; border-radius: 4px;
}
.fosw-msg .fosw-pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: rgba(127,127,127,0.14); padding: 8px 10px; border-radius: 8px;
  overflow-x: auto; margin: 6px 0 0; white-space: pre;
}
.fosw-msg-bot  { background: var(--fosw-soft); color: var(--fosw-text); border-bottom-left-radius: 6px; }
.fosw-msg-user { background: var(--fosw-accent); color: var(--fosw-accent-text); border-bottom-right-radius: 6px; }
/* Règle neutre plutôt que currentColor : sur une bulle à texte foncé, un
   currentColor pleine force coupe la réponse en deux. */
.fosw-sources {
  margin-top: 7px; padding-top: 5px; font-size: 11px; opacity: 0.6;
  border-top: 1px solid rgba(127,127,127,0.35);
}
.fosw-typing { display: flex; gap: 4px; padding: 4px 2px; }
.fosw-typing span {
  width: 6px; height: 6px; border-radius: 999px; background: var(--fosw-subtle);
  animation: fosw-blink 1.2s infinite ease-in-out;
}
.fosw-typing span:nth-child(2) { animation-delay: 0.18s; }
.fosw-typing span:nth-child(3) { animation-delay: 0.36s; }

/* Retour en bas — n'apparaît que si l'on a remonté le fil. */
.fosw-scrolldown {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
  display: none; align-items: center; gap: 5px;
  border: 1px solid var(--fosw-border); background: var(--fosw-base); color: var(--fosw-subtle);
  border-radius: 999px; padding: 5px 11px; font-size: 12px; cursor: pointer;
  box-shadow: 0 6px 18px rgba(0,0,0,0.14);
}
.fosw-scrolldown.fosw-show { display: flex; }
.fosw-scrolldown svg { width: 13px; height: 13px; }

/* Cartes produit — jumelle immersive de components/ui/destination-card.tsx. */
.fosw-products { display: flex; flex-direction: column; gap: 10px; align-self: stretch; }
.fosw-product {
  position: relative; display: block; height: 150px; overflow: hidden;
  border-radius: var(--fosw-bubble-radius);
  border: 1px solid var(--fosw-border);
  text-decoration: none; color: #fff;
  transform: translateZ(0);
  transition: box-shadow 300ms ease, border-color 300ms ease;
}
.fosw-product:hover { box-shadow: 0 12px 28px rgba(0,0,0,0.22); border-color: var(--fosw-accent); }
.fosw-product:focus-visible { outline: 2px solid var(--fosw-accent); outline-offset: 2px; }
.fosw-product-img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  transition: transform 500ms ease-in-out;
}
.fosw-product:hover .fosw-product-img { transform: scale(1.1); }
.fosw-product-fallback {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, var(--fosw-accent), rgba(0,0,0,0.55));
}
.fosw-product-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0.28) 48%, rgba(0,0,0,0));
}
.fosw-product-body {
  position: relative; z-index: 1;
  display: flex; height: 100%; flex-direction: column; justify-content: flex-end;
  padding: 14px 15px;
  transition: transform 500ms ease-in-out;
}
.fosw-product:hover .fosw-product-body { transform: translateY(-4px); }
.fosw-product-cat {
  font-size: 10px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
  color: rgba(255,255,255,0.8);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fosw-product-title {
  margin-top: 3px; font-size: 17px; font-weight: 700; line-height: 1.18;
  letter-spacing: -0.01em; color: #fff;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.fosw-product-foot { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.fosw-product-price { font-size: 13.5px; font-weight: 700; color: #fff; }
.fosw-product-oos {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 7px; border-radius: 999px;
  background: rgba(255,255,255,0.18); color: #fff; backdrop-filter: blur(4px);
}
.fosw-product-like {
  position: absolute; top: 10px; right: 10px; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 999px; cursor: pointer;
  background: rgba(255,255,255,0.2); backdrop-filter: blur(4px);
  transition: background 200ms ease, transform 120ms ease;
}
.fosw-product-like:hover { background: rgba(255,255,255,0.32); }
.fosw-product-like:active { transform: scale(0.95); }
.fosw-product-like svg { width: 17px; height: 17px; fill: none; stroke: #fff; stroke-width: 2; }
.fosw-product-like.fosw-liked svg { fill: #ef4444; stroke: #ef4444; }

.fosw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fosw-chip {
  border: 1px solid var(--fosw-border); background: var(--fosw-softer); color: var(--fosw-text);
  border-radius: 999px; padding: 6px 12px; font-size: 12.5px; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.fosw-chip:hover { background: var(--fosw-accent-soft); border-color: var(--fosw-accent); transform: translateY(-1px); }

.fosw-rate { display: flex; align-items: center; gap: 5px; margin-top: 2px; align-self: flex-start; }
.fosw-rate-label { font-size: 11.5px; color: var(--fosw-subtle); margin-right: 2px; }
.fosw-rate button {
  border: 1px solid var(--fosw-border); background: var(--fosw-softer); cursor: pointer;
  border-radius: 8px; padding: 3px 8px; font-size: 12px; line-height: 1.5;
  opacity: 0.75; transition: opacity 140ms ease, background 140ms ease, transform 120ms ease;
}
.fosw-rate button:hover { opacity: 1; background: var(--fosw-soft); transform: translateY(-1px); }
.fosw-rate.fosw-rated button { pointer-events: none; opacity: 0.35; }
.fosw-rate.fosw-rated button.fosw-picked { opacity: 1; border-color: var(--fosw-accent); background: var(--fosw-accent-soft); }

.fosw-cta {
  align-self: flex-start; border: 0; cursor: pointer;
  border-radius: var(--fosw-button-radius);
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  padding: 8px 14px; font-size: 13px; font-weight: 600;
  transition: transform 140ms ease, filter 140ms ease;
}
.fosw-cta:hover { transform: translateY(-1px); filter: brightness(1.06); }

.fosw-brand {
  text-align: center; font-size: 10.5px; padding: 0 16px 8px;
  color: var(--fosw-subtle); background: transparent; letter-spacing: 0.01em;
}
.fosw-brand strong { font-weight: 600; }
.fosw-brand a { color: inherit; text-decoration: none; border-radius: 6px; padding: 1px 4px; transition: color 140ms ease; }
.fosw-brand a:hover { color: var(--fosw-text); }
.fosw-brand a:hover strong { text-decoration: underline; text-underline-offset: 2px; }
.fosw-composer {
  display: flex; align-items: flex-end; gap: 8px; padding: 11px 12px;
  border-top: 1px solid var(--fosw-border); background: transparent;
}
.fosw-composer textarea {
  flex: 1; min-width: 0; min-height: 40px; max-height: 118px; resize: none;
  border: 1px solid var(--fosw-border);
  background: var(--fosw-softer); color: var(--fosw-text);
  padding: 10px 14px; border-radius: var(--fosw-input-radius);
  font: inherit; line-height: 1.4; outline: none; overflow-y: auto;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.fosw-composer textarea:focus { border-color: var(--fosw-accent); box-shadow: 0 0 0 3px var(--fosw-accent-soft); }
.fosw-composer textarea::placeholder { color: var(--fosw-subtle); }
.fosw-send {
  height: 40px; min-width: 40px; padding: 0 13px; flex: none;
  border: 0; border-radius: var(--fosw-button-radius);
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  cursor: pointer; font-weight: 600; font-size: 13px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: filter 140ms ease, transform 120ms ease;
}
.fosw-send:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.fosw-send svg { width: 16px; height: 16px; }
.fosw-send:disabled { opacity: 0.45; cursor: not-allowed; }
.fosw-composer-actions { display: flex; align-items: flex-end; gap: 8px; flex: none; }


/* ── Modèles ──────────────────────────────────────────────────────────────
   Un modèle ne décrit qu'une structure. Les couleurs, les formes, la densité
   et les textes viennent des autres onglets et s'appliquent par-dessus : c'est
   la règle qui permet d'essayer un modèle sans perdre sa configuration. */

/* Messages à plat — le texte de l'agent posé sur la surface, sans bulle.
   La bulle ne subsiste que côté visiteur, qui a besoin de voir ce qu'il a dit. */
.fosw-flat .fosw-msg-bot {
  background: transparent; border-radius: 0; max-width: 100%;
  padding-left: 0; padding-right: 0;
}

/* Détaché — la barre de saisie flotte sous la fenêtre, comme une surface à
   part entière. Le composeur n'est plus « dans » la conversation : il en est
   l'outil, posé à côté. */
.fosw-lay-detached .fosw-composer {
  flex: none; align-items: center;
  border: 1px solid var(--fosw-border); border-radius: 999px;
  background: var(--fosw-panel-bg);
  backdrop-filter: var(--fosw-panel-blur); -webkit-backdrop-filter: var(--fosw-panel-blur);
  box-shadow: var(--fosw-shadow); padding: 7px 7px 7px 6px;
}
.fosw-lay-detached .fosw-composer textarea {
  border: 1px solid transparent; background: transparent; padding: 9px 12px; min-height: 38px;
}
.fosw-lay-detached .fosw-composer textarea:focus { border-color: transparent; box-shadow: none; }
.fosw-lay-detached .fosw-send, .fosw-lay-detached .fosw-mic { border-radius: 999px; }
.fosw-lay-detached .fosw-mic { border-color: transparent; }

/* Volet latéral — collé au bord, pleine hauteur. Pour une aide qui accompagne
   la navigation au lieu de la recouvrir. */
.fosw-lay-sidebar {
  height: 100vh; max-height: 100vh; gap: 0;
  animation: fosw-slide-in 280ms cubic-bezier(.16,1,.3,1);
}
.fosw-lay-sidebar .fosw-win { border-radius: 0; border-top: 0; border-bottom: 0; }
.fosw-lay-sidebar.fosw-panel-pos-br { transform-origin: right center; }
.fosw-lay-sidebar.fosw-panel-pos-bl { transform-origin: left center; }
.fosw-lay-sidebar.fosw-closing { animation: fosw-slide-out 180ms ease-in forwards; }

/* Projecteur — fenêtre centrée sur la page voilée. La conversation devient la
   tâche en cours, pas un à-côté. */
.fosw-lay-spotlight {
  max-height: calc(100vh - 48px); transform: translate(-50%, -50%);
  transform-origin: center;
  animation: fosw-in-center 240ms cubic-bezier(.16,1,.3,1);
}
.fosw-lay-spotlight.fosw-closing { animation: fosw-out-center 170ms ease-in forwards; }
.fosw-backdrop {
  position: fixed; inset: 0; z-index: 2147482990;
  background: rgba(0,0,0,0.45); animation: fosw-fade 200ms ease-out;
}
.fosw-backdrop.fosw-closing { animation: fosw-fade-out 170ms ease-in forwards; }

/* Dock — la barre d'agent est toujours posée : avatar, nom, état, deux
   actions. Elle remplace le lanceur rond (la barre EST le lanceur) et la
   fenêtre de conversation s'ouvre au-dessus d'elle. */
.fosw-lay-dock { height: auto; }
.fosw-lay-dock.fosw-dock-open { height: var(--fosw-h); }
.fosw-lay-dock .fosw-win { animation: fosw-in 240ms cubic-bezier(.16,1,.3,1); }
.fosw-dock {
  position: relative; flex: none;
  display: flex; flex-direction: column; gap: 4px; padding: 8px;
  border: 1px solid var(--fosw-border); border-radius: var(--fosw-panel-radius);
  background: var(--fosw-panel-bg);
  backdrop-filter: var(--fosw-panel-blur); -webkit-backdrop-filter: var(--fosw-panel-blur);
  box-shadow: var(--fosw-shadow);
}
.fosw-dock-row { display: flex; align-items: center; gap: 10px; }
.fosw-dock-text { flex: 1; min-width: 0; }
.fosw-dock-name {
  font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fosw-dock-status {
  font-size: 11.5px; color: var(--fosw-subtle); margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fosw-dock-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.fosw-dock-btn {
  display: flex; align-items: center; gap: 6px; flex: none;
  height: 34px; padding: 0 8px; border: 0; cursor: pointer;
  border-radius: var(--fosw-button-radius); background: transparent;
  color: var(--fosw-text); font-size: 13px; font-weight: 500;
  transition: background 140ms ease, filter 140ms ease;
}
.fosw-dock-btn:hover { background: var(--fosw-soft); }
.fosw-dock-btn svg { width: 16px; height: 16px; }
.fosw-dock-btn .fosw-ico { display: flex; line-height: 0; }
.fosw-dock-btn.fosw-primary { background: var(--fosw-accent); color: var(--fosw-accent-text); }
.fosw-dock-btn.fosw-primary:hover { filter: brightness(1.08); background: var(--fosw-accent); }
.fosw-dock-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fosw-kbd {
  display: flex; align-items: center; justify-content: center;
  min-width: 21px; height: 21px; padding: 0 4px; border-radius: 6px;
  background: var(--fosw-soft); color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
}
.fosw-dock-btn.fosw-primary .fosw-kbd { background: rgba(255,255,255,0.22); }
.fosw-dock-field { position: relative; display: none; }
.fosw-dock.fosw-composing .fosw-dock-field { display: block; animation: fosw-grow 240ms cubic-bezier(.16,1,.3,1); }
.fosw-dock-field textarea {
  width: 100%; min-height: 78px; max-height: 150px; resize: none;
  border: 0; outline: none; background: transparent; color: var(--fosw-text);
  font: inherit; line-height: 1.5; padding: 8px 32px 6px 10px;
}
.fosw-dock-field textarea::placeholder { color: var(--fosw-subtle); }
.fosw-dock-x {
  position: absolute; top: 4px; right: 4px; width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--fosw-subtle); cursor: pointer;
}
.fosw-dock-x:hover { background: var(--fosw-soft); color: var(--fosw-text); }
.fosw-dock-x svg { width: 13px; height: 13px; }

/* Dictée — le bouton n'est monté que si le navigateur sait l'honorer : un
   micro qui ne fait rien coûte plus de confiance qu'il n'en rapporte. */
.fosw-mic {
  height: 40px; width: 40px; flex: none; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--fosw-border); border-radius: var(--fosw-button-radius);
  background: transparent; color: var(--fosw-subtle); cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.fosw-mic:hover { background: var(--fosw-soft); color: var(--fosw-text); }
.fosw-mic svg { width: 16px; height: 16px; }
.fosw-rec, .fosw-dock-btn.fosw-rec { color: #ef4444; border-color: #ef4444; }
.fosw-rec svg { animation: fosw-rec 1.4s ease-in-out infinite; }


/* Accueil — l'écran vide comme page d'accueil : marque, salutation, phrase de
   l'agent, raccourcis. Le champ devient un bloc avec sa barre d'outils. */
.fosw-hero {
  display: flex; flex-direction: column; align-items: center; gap: 18px;
  margin: auto 0; padding: 18px 4px 6px; text-align: center;
}
.fosw-hero-mark .fosw-avatar { border-radius: calc(var(--fosw-avatar-radius) + 3px); }
.fosw-hero-mark .fosw-avatar svg { width: 26px; height: 26px; }
.fosw-hero-greet { font-size: 17px; font-weight: 500; color: var(--fosw-subtle); letter-spacing: -0.01em; }
.fosw-hero-title { font-size: 16.5px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.35; }
.fosw-hero-note { margin-top: 9px; font-size: 13px; line-height: 1.55; color: var(--fosw-subtle); }
.fosw-lay-hero .fosw-chips { justify-content: center; }
.fosw-lay-hero .fosw-chip { border-radius: 8px; font-size: 12px; padding: 5px 10px; }
.fosw-lay-hero .fosw-composer {
  flex-direction: column; align-items: stretch; gap: 0; padding: 0; overflow: hidden;
  margin: 0 var(--fosw-pad) var(--fosw-pad);
  border: 1px solid var(--fosw-border); border-radius: var(--fosw-input-radius);
}
.fosw-lay-hero .fosw-composer textarea {
  border: 0; border-radius: 0; background: transparent;
  min-height: 86px; max-height: 160px; padding: 12px 14px;
}
.fosw-lay-hero .fosw-composer textarea:focus { box-shadow: none; }
.fosw-lay-hero .fosw-composer-actions {
  align-items: center; padding: 7px 8px;
  border-top: 1px solid var(--fosw-border); background: var(--fosw-softer);
}
/* Le vide à gauche pousse les outils à droite sans nœud supplémentaire. */
.fosw-lay-hero .fosw-composer-actions::before { content: ""; flex: 1; }
.fosw-lay-hero .fosw-mic { height: 30px; width: 30px; border: 0; }
.fosw-lay-hero .fosw-send { height: 30px; min-width: 30px; padding: 0 11px; }

/* Aperçu — les modèles posés par rapport au viewport gardent leurs plafonds :
   la règle générique de l'aperçu réserve la place d'un lanceur qu'ils n'ont
   pas forcément. */
.fosw-preview.fosw-preview-fixed .fosw-panel.fosw-lay-sidebar { max-height: 100vh; }
.fosw-preview.fosw-preview-fixed .fosw-panel.fosw-lay-spotlight { max-height: calc(100vh - 48px); }

/* Le témoin de focus se pose sur la surface qui porte le champ, jamais sur le
   champ nu : dans une pilule ou une barre d'outils, un liseré autour du seul
   textarea déborde du dessin — et le supprimer sans le remplacer laisserait un
   visiteur au clavier sans repère. */
.fosw-lay-detached .fosw-composer textarea:focus-visible,
.fosw-lay-hero .fosw-composer textarea:focus-visible,
.fosw-dock-field textarea:focus-visible { outline: none; }
.fosw-lay-detached .fosw-composer:focus-within,
.fosw-dock.fosw-composing:focus-within {
  border-color: var(--fosw-accent);
  box-shadow: var(--fosw-shadow), 0 0 0 3px var(--fosw-accent-soft);
}
.fosw-lay-hero .fosw-composer:focus-within {
  border-color: var(--fosw-accent); box-shadow: 0 0 0 3px var(--fosw-accent-soft);
}

/* Superpositions d'onboarding (niveau page) */
.fosw-highlight {
  position: relative; z-index: 2147482000 !important;
  box-shadow: 0 0 0 4px rgba(0,27,183,0.55), 0 0 0 9999px rgba(0,0,0,0.35) !important;
  border-radius: 6px !important;
  transition: box-shadow 200ms ease;
}
.fosw-popup, .fosw-tooltip, .fosw-toast {
  position: fixed; z-index: 2147483001; max-width: 320px;
  background: #18181b; color: #f4f4f5;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px; padding: 12px 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.35);
  animation: fosw-in 180ms ease-out;
}
.fosw-popup .fosw-pop-title { font-weight: 600; margin-bottom: 4px; }
.fosw-popup .fosw-pop-body  { opacity: 0.9; font-size: 13px; }
.fosw-popup .fosw-pop-close, .fosw-tooltip .fosw-pop-close {
  position: absolute; top: 6px; right: 8px; background: transparent;
  border: 0; color: #a1a1aa; cursor: pointer; font-size: 16px;
}
.fosw-tooltip { padding: 8px 10px; font-size: 12px; }
.fosw-toast { right: 16px; bottom: 90px; background: #16a34a; border-color: #16a34a; color: #fff; }

/* ── Orbes (thinking-orbs) ────────────────────────────────────────────────
   Le canvas est posé tout de suite et apparaît en fondu quand le moteur a
   peint sa première image : jamais un carré vide qui clignote. */
.fosw-orb { display: block; flex: none; opacity: 0; transition: opacity 280ms ease; }
.fosw-orb.fosw-orb-ready { opacity: 1; }
.fosw-orb.fosw-orb-failed { display: none; }

/* Avatar « orbe animée » : une pastille à peine teintée de l'accent, pour que
   l'orbe monochrome reste à la marque sans se colorer elle-même. */
.fosw-avatar-live {
  background: radial-gradient(120% 120% at 28% 18%, var(--fosw-accent-soft), var(--fosw-softer) 72%);
  box-shadow: inset 0 0 0 1px var(--fosw-border);
}
.fosw-avatar-live.fosw-on-accent {
  background: rgba(255,255,255,0.14);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.24);
}

/* Indicateur de réflexion : l'orbe + ce que fait l'agent, sous un reflet
   lent. Les trois points restent le repli tant que l'orbe n'est pas là. */
.fosw-thinking { display: flex; align-items: center; gap: 9px; padding: 7px 14px 7px 9px; }
.fosw-thinking .fosw-typing { padding: 0 2px; }
.fosw-thinking.fosw-orb-on .fosw-typing { display: none; }
.fosw-flat .fosw-thinking { padding-left: 0; }
.fosw-thinking-label {
  font-size: 13px; line-height: 1.3; color: var(--fosw-subtle);
  background: linear-gradient(90deg, var(--fosw-subtle) 0%, var(--fosw-subtle) 35%, var(--fosw-text) 50%, var(--fosw-subtle) 65%, var(--fosw-subtle) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  animation: fosw-sheen 2.6s linear infinite;
}

/* ── Finition ─────────────────────────────────────────────────────────────
   Le champ a son propre anneau de focus : l'outline globale par-dessus
   dessinait un double contour. */
.fosw-root textarea:focus-visible { outline: none; }
.fosw-ico-orb { display: flex; align-items: center; justify-content: center; }
/* Les points de l'orbe sont des gris ; sur un accent saturé, ils se
   fondaient. Un léger éclaircissement les ramène à la lumière. */
.fosw-ico-orb .fosw-orb { filter: brightness(1.9) contrast(1.15); }
.fosw-avatar-live.fosw-on-accent .fosw-orb { filter: brightness(1.7) contrast(1.1); }
/* Lanceur : un reflet en haut à gauche et un filet de lumière — la matière
   d'un bouton, plus seulement un disque de couleur. */
.fosw-launcher {
  background:
    radial-gradient(circle at 30% 22%, rgba(255,255,255,0.22), rgba(255,255,255,0) 58%),
    var(--fosw-accent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 12px 32px rgba(0,0,0,0.24), 0 2px 6px rgba(0,0,0,0.14);
}
.fosw-send, .fosw-cta { box-shadow: inset 0 1px 0 rgba(255,255,255,0.18); }
.fosw-msg-user {
  background: linear-gradient(180deg, color-mix(in srgb, var(--fosw-accent) 86%, #ffffff), var(--fosw-accent));
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}
.fosw-header:not(.fosw-head-accent):not(.fosw-head-gradient) {
  border-bottom-color: color-mix(in srgb, var(--fosw-border) 70%, transparent);
}
.fosw-title { font-size: 15px; }

@keyframes fosw-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes fosw-out { to { opacity: 0; transform: translateY(8px) scale(0.98); } }
@keyframes fosw-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fosw-pop { from { opacity: 0; transform: translateY(8px) scale(0.94); } to { opacity: 1; transform: none; } }
@keyframes fosw-blink { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
@keyframes fosw-in-center { from { opacity: 0; transform: translate(-50%, -46%) scale(0.97); } to { opacity: 1; transform: translate(-50%, -50%); } }
@keyframes fosw-out-center { to { opacity: 0; transform: translate(-50%, -48%) scale(0.98); } }
@keyframes fosw-slide-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
@keyframes fosw-slide-out { to { opacity: 0; transform: translateX(18px); } }
@keyframes fosw-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes fosw-fade-out { to { opacity: 0; } }
@keyframes fosw-grow { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fosw-rec { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes fosw-sheen { from { background-position: 125% 0; } to { background-position: -125% 0; } }
@keyframes fosw-pulse {
  0%   { box-shadow: 0 0 0 0 var(--fosw-accent); opacity: 0.5; }
  70%  { box-shadow: 0 0 0 16px var(--fosw-accent); opacity: 0; }
  100% { box-shadow: 0 0 0 0 var(--fosw-accent); opacity: 0; }
}

/* Le visiteur qui a demandé moins d'animation est servi d'abord — un chat qui
   surgit en rebondissant sur un site accessible est un défaut, pas du soin. */
@media (prefers-reduced-motion: reduce) {
  .fosw-panel, .fosw-row, .fosw-teaser, .fosw-win, .fosw-backdrop,
  .fosw-dock .fosw-dock-field { animation: none !important; }
  .fosw-rec svg { animation: none; }
  .fosw-launcher, .fosw-chip, .fosw-send, .fosw-cta { transition: none !important; }
  .fosw-pulse::after { animation: none; opacity: 0; }
  .fosw-thinking-label { animation: none; background: none; -webkit-text-fill-color: currentColor; }
}
`;

  function injectStyle() {
    if (document.getElementById("fosw-style")) return;
    var s = document.createElement("style");
    s.id = "fosw-style"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* Escape first, then apply a deliberately small markdown subset. RAG answers
     routinely contain **bold**, `code` and links; rendering them as literal
     asterisks is what made the embed look cheaper than the playground. */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function mdToHtml(text) {
    var out = esc(text);
    out = out.replace(/```[a-z]*\n?([\s\S]*?)```/gi, function (_, code) {
      return '<pre class="fosw-pre">' + code.replace(/\n$/, "") + "</pre>";
    });
    out = out.replace(/`([^`\n]+)`/g, '<code class="fosw-code">$1</code>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
    return out.split(/\n{2,}/).map(function (p) {
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  /* ---------------- API calls ---------------- */

  async function fetchConfig() {
    var res = await fetch(FN_BASE + "/rag-agent-public-config", {
      method: "POST",
      headers: fnHeaders(),
      body: JSON.stringify({ public_key: state.publicKey }),
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || "config " + res.status);
    return data;
  }

  /* Contexte d'audience joint à chaque message (migration 0216) : le fuseau
     sert de repli au pays quand aucun CDN ne pose d'en-tête géo, et l'URL est
     nettoyée de sa query côté serveur. Aucune IP, aucun cookie tiers, rien qui
     suive le visiteur d'un site à l'autre. */
  function clientContext() {
    try {
      var w = window.innerWidth || 1024;
      return {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        locale: navigator.language || null,
        device: w < 640 ? "mobile" : (w < 1024 ? "tablet" : "desktop"),
        referrer: document.referrer || location.origin,
        page_url: location.href,
      };
    } catch (e) { return {}; }
  }

  async function sendChat(message) {
    var body = {
      public_key: state.publicKey, message: message,
      visitor_id: getVisitorId(), client_context: clientContext(),
    };
    if (state.conversationId) body.conversation_id = state.conversationId;
    var res = await fetch(FN_BASE + "/rag-chat", {
      method: "POST",
      headers: fnHeaders(),
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return null; });
    // rag-chat answers { ok, answer, conversation_id, sources } and reports
    // failures as { error } — surface the real message instead of swallowing it.
    if (!res.ok || !data) throw new Error((data && data.error) || "rag-chat " + res.status);
    if (data.error) throw new Error(data.error);
    return data;
  }

  function rateConversation(rating) {
    if (!state.conversationId) return;
    fetch(FN_BASE + "/rag-chat", {
      method: "POST",
      headers: fnHeaders(),
      body: JSON.stringify({ public_key: state.publicKey, conversation_id: state.conversationId, rating: rating }),
    }).catch(function () {});
  }

  async function orchestrate(extraContext) {
    if (!state.config || !state.config.onboarding_enabled) return null;
    if (!CAN_DRIVE_PAGE) return null;
    if (state.inFlight) return null;
    state.inFlight = true;
    try {
      var body = {
        agent_public_key: state.publicKey,
        context: Object.assign(
          { route: location.pathname + location.search, completed_intents: state.completedIntents.slice(-10) },
          extraContext || {},
        ),
      };
      if (state.userId) body.external_user_id = state.userId;
      else body.visitor_id = getVisitorId();
      var res = await fetch(FN_BASE + "/rag-onboarding-orchestrate", {
        method: "POST",
        headers: fnHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return res.json();
    } catch (e) {
      return null;
    } finally {
      state.inFlight = false;
    }
  }

  /* ---------------- Onboarding action runners ---------------- */

  function findEl(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  function clearOverlays() {
    document.querySelectorAll(".fosw-popup, .fosw-tooltip, .fosw-toast").forEach(function (n) { n.remove(); });
    document.querySelectorAll(".fosw-highlight").forEach(function (n) { n.classList.remove("fosw-highlight"); });
  }

  function actHighlight(a) {
    var t = findEl(a.selector); if (!t) return;
    t.classList.add("fosw-highlight");
    t.scrollIntoView({ behavior: "smooth", block: "center" });
    var ms = Math.min(a.duration_ms || 6000, 20000);
    setTimeout(function () { t.classList.remove("fosw-highlight"); }, ms);
    if (a.message) showToast(a.message);
  }
  function actPopup(a) {
    var anchor = a.anchor_selector ? findEl(a.anchor_selector) : null;
    var pop = el("div", "fosw-popup");
    if (a.title) pop.appendChild(el("div", "fosw-pop-title", esc(a.title)));
    var body = el("div", "fosw-pop-body"); body.textContent = a.body || ""; pop.appendChild(body);
    var close = el("button", "fosw-pop-close", "×"); close.onclick = function () { pop.remove(); }; pop.appendChild(close);
    document.body.appendChild(pop); positionNear(pop, anchor);
  }
  function actScroll(a) { var t = findEl(a.selector); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }

  /* The onboarding routes come from the SaaS structure the agent was trained
     on, so they only mean anything on that app. Anywhere else — a static page
     opened from disk, someone's marketing site — following them takes the
     visitor off the page they were reading. Hence the two gates below.

     The file:// case used to be actively destructive: pushState throws a
     SecurityError there, and the catch called location.assign("/route"), which
     resolves against the filesystem root and left the browser on
     file:///C:/route with the page gone. */
  function canNavigateTo(route) {
    if (!route) return null;
    // A route is a path inside an app; only http(s) pages have those.
    if (location.protocol !== "http:" && location.protocol !== "https:") return null;
    var url;
    try { url = new URL(route, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;   // never leave this site
    return url;
  }

  function actNavigate(a) {
    var url = canNavigateTo(a && a.route);
    if (!url) return;
    var target = url.pathname + url.search;
    if (target === location.pathname + location.search) return;
    // Announce the route to the host router (the app this agent guides is a
    // SPA). If pushState is unavailable we simply stay put — a hard navigation
    // here is what used to eject the visitor from the page.
    try {
      history.pushState({}, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) { /* stay put */ }
  }
  function actTooltip(a) {
    var t = findEl(a.selector); if (!t) return;
    var tip = el("div", "fosw-tooltip");
    var span = el("span", null); span.textContent = a.text || ""; tip.appendChild(span);
    var c = el("button", "fosw-pop-close", "×"); c.onclick = function () { tip.remove(); }; tip.appendChild(c);
    document.body.appendChild(tip); positionNear(tip, t);
  }
  function actCelebrate(a) { showToast((a && a.message) || "🎉 Nice!"); }
  function actWaitEvent(a) { state.waitingEvent = a.event; }
  function positionNear(node, anchor) {
    if (!anchor) { node.style.left = "50%"; node.style.bottom = "32px"; node.style.transform = "translateX(-50%)"; return; }
    var r = anchor.getBoundingClientRect();
    node.style.top = (r.bottom + 8) + "px";
    node.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left)) + "px";
  }
  function showToast(text) {
    var t = el("div", "fosw-toast"); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  var RUNNERS = {
    highlight: actHighlight,
    popup: actPopup,
    scroll_to: actScroll,
    navigate: actNavigate,
    tooltip: actTooltip,
    celebrate: actCelebrate,
    wait_event: actWaitEvent,
  };

  function applyOnboarding(resp) {
    if (!resp) return;
    clearOverlays();
    if (resp.text) showToast(resp.text);
    (resp.actions || []).forEach(function (a) { try { (RUNNERS[a.type] || function () {})(a); } catch (e) {} });
  }

  /* ---------------- Theme ---------------- */

  /* Luminance relative — sert à choisir une encre lisible sur l'accent et à
     décider si un accent peut porter du blanc. Formule WCAG, pas une
     approximation à l'œil. */
  function relLuminance(hex) {
    var c = hexToRgb(hex);
    if (!c) return 1;
    var f = [c.r, c.g, c.b].map(function (v) {
      var x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }
  function contrastRatio(a, b) {
    var la = relLuminance(a), lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /* Encre à poser SUR une couleur. On teste réellement les deux candidats au
     lieu de trancher sur un seuil de luminance : sur les accents moyens (bleus
     saturés, verts), le résultat n'est pas celui qu'un seuil donnerait. */
  function readableInk(bg, lightInk, darkInk) {
    var light = lightInk || "#ffffff", dark = darkInk || "#111114";
    return contrastRatio(bg, light) >= contrastRatio(bg, dark) ? light : dark;
  }
  function mixHex(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    if (!x || !y) return a;
    function p(k) { return Math.round(x[k] + (y[k] - x[k]) * t); }
    return "rgb(" + p("r") + "," + p("g") + "," + p("b") + ")";
  }

  function hostPrefersDark() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
    catch (e) { return false; }
  }

  /* Le mode effectif : "auto" suit le site hôte et se réévalue à chaque
     application, ce qui rend la bascule gratuite quand le visiteur change de
     thème sans recharger. */
  function effectiveDark() {
    var m = (state.cfg && state.cfg.theme_mode) || "light";
    return m === "dark" || (m === "auto" && hostPrefersDark());
  }

  function resolveTheme() {
    var c = state.cfg;
    var size = VARIANT_SIZE[c.variant] || VARIANT_SIZE.full;
    var dark = effectiveDark();
    var base = dark ? (c.dark_base || DEFAULTS.dark_base) : (c.base || DEFAULTS.base);
    var border = dark ? (c.dark_border || DEFAULTS.dark_border) : (c.base_border || DEFAULTS.base_border);
    var subtle = dark ? (c.dark_subtle || DEFAULTS.dark_subtle) : (c.base_subtle || DEFAULTS.base_subtle);
    var text = dark ? (c.dark_primary || DEFAULTS.dark_primary) : (c.base_primary || DEFAULTS.base_primary);

    // L'accent du panneau de configuration prime ; à défaut, la couleur de
    // marque de l'agent (onglet Réglages) — les deux se contredisaient en silence.
    var accent = c.accent || (state.config && state.config.accent_color) || "#001BB7";
    var accentText = (!c.accent_primary || c.accent_primary === "auto")
      ? readableInk(accent)
      : c.accent_primary;

    var density = DENSITY[c.density] || DENSITY.comfortable;
    var font = c.font_family === "custom"
      ? (c.font_family_custom || FONT_STACKS.system)
      : (FONT_STACKS[c.font_family] || FONT_STACKS.system);
    var launcher = LAUNCHER_SIZE[c.launcher_size] || LAUNCHER_SIZE.md;
    var radiusOf = { circle: "999px", square: "0px", rounded: "9px" };

    return {
      dark: dark,
      base: base, border: border, subtle: subtle, text: text,
      accent: accent, accentText: accentText,
      accentSoft: rgba(accent, dark ? 0.22 : 0.10),
      // Le voile « verre » est tiré de la couleur de base, pas d'un blanc en
      // dur : sur un thème sombre, un verre blanchâtre ferait une tache.
      panelBg: c.panel_style === "glass" ? rgba(base, dark ? 0.72 : 0.78) : base,
      panelBlur: c.panel_style === "glass" ? "blur(22px) saturate(180%)" : "none",
      soft: rgba(text, dark ? 0.10 : 0.06),
      softer: rgba(text, dark ? 0.05 : 0.03),
      shadow: SHADOWS[c.shadow] || SHADOWS.soft,
      font: font,
      pad: density.pad, gap: density.gap, msgPad: density.msgPad, headPad: density.head,
      panelRadius: (c.panel_radius != null ? c.panel_radius : DEFAULTS.panel_radius) + "px",
      bubbleRadius: (c.bubble_radius != null ? c.bubble_radius : DEFAULTS.bubble_radius) + "px",
      inputRadius: (c.input_radius != null ? c.input_radius : DEFAULTS.input_radius) + "px",
      buttonRadius: (c.button_radius != null ? c.button_radius : DEFAULTS.button_radius) + "px",
      avatarRadius: radiusOf[c.avatar_shape] || radiusOf.rounded,
      launcher: launcher + "px",
      offX: (c.offset_x != null ? c.offset_x : DEFAULTS.offset_x) + "px",
      offY: (c.offset_y != null ? c.offset_y : DEFAULTS.offset_y) + "px",
      w: size.w + "px",
      h: size.h + "px",
    };
  }

  function applyTheme(root) {
    var t = state.theme;
    var vars = {
      "--fosw-base": t.base, "--fosw-border": t.border, "--fosw-subtle": t.subtle,
      "--fosw-text": t.text, "--fosw-soft": t.soft, "--fosw-softer": t.softer,
      "--fosw-accent": t.accent, "--fosw-accent-text": t.accentText,
      "--fosw-accent-soft": t.accentSoft, "--fosw-accent-2": mixHex(t.accent, t.dark ? "#000000" : "#ffffff", 0.28),
      "--fosw-panel-bg": t.panelBg, "--fosw-panel-blur": t.panelBlur,
      "--fosw-panel-radius": t.panelRadius, "--fosw-bubble-radius": t.bubbleRadius,
      "--fosw-input-radius": t.inputRadius, "--fosw-button-radius": t.buttonRadius,
      "--fosw-avatar-radius": t.avatarRadius, "--fosw-shadow": t.shadow, "--fosw-font": t.font,
      "--fosw-pad": t.pad, "--fosw-gap": t.gap, "--fosw-msg-pad": t.msgPad, "--fosw-head-pad": t.headPad,
      "--fosw-w": t.w, "--fosw-h": t.h, "--fosw-launcher": t.launcher,
      "--fosw-off-x": t.offX, "--fosw-off-y": t.offY,
    };
    Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
    applyPlacementVars();
    applyCustomCss();
  }

  /* Le placement lit les décalages configurés : un site avec déjà un bandeau
     cookies ou un autre chat a besoin de pousser le lanceur, sinon les deux se
     recouvrent et le visiteur ne peut plus fermer ni l'un ni l'autre. */
  function applyPlacementVars() {
    if (!dom.root) return;
    var left = (POSITION_ATTR || (state.cfg && state.cfg.placement) || "bottom-right") === "bottom-left";
    var side = left ? "left" : "right";
    var other = left ? "right" : "left";
    [dom.launcher, dom.teaser].forEach(function (n) {
      if (!n) return;
      n.style[side] = "var(--fosw-off-x)";
      n.style[other] = "auto";
    });
    if (dom.launcher) dom.launcher.style.bottom = "var(--fosw-off-y)";
    var lift = "calc(var(--fosw-off-y) + var(--fosw-launcher) + 14px)";
    if (dom.teaser) dom.teaser.style.bottom = lift;

    if (!dom.panel) return;
    var p = dom.panel;
    p.style.left = ""; p.style.right = ""; p.style.top = ""; p.style.bottom = "";
    var layout = layoutOf();
    if (layout === "sidebar") {
      // Collé au bord : le décalage horizontal n'a plus de sens, un volet
      // « presque » collé laisse une bande de page inutilisable derrière lui.
      p.style[side] = "0px"; p.style[other] = "auto";
      p.style.top = "0px"; p.style.bottom = "0px";
    } else if (layout === "spotlight") {
      p.style.left = "50%"; p.style.right = "auto"; p.style.top = "50%";
    } else {
      p.style[side] = "var(--fosw-off-x)"; p.style[other] = "auto";
      // Le modèle Dock n'a pas de lanceur à enjamber : sa barre EST le lanceur.
      p.style.bottom = layout === "dock" ? "var(--fosw-off-y)" : lift;
    }
  }

  /* CSS libre du marchand. Injecté dans sa propre balise pour pouvoir être
     remplacé à chaque édition de l'aperçu sans reconstruire la feuille. */
  function applyCustomCss() {
    var css = (state.cfg && state.cfg.custom_css) || "";
    var tag = document.getElementById("fosw-custom");
    if (!css) { if (tag) tag.remove(); return; }
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "fosw-custom";
      document.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  /* ---------------- UI ---------------- */

  var dom = {
    root: null, launcher: null, panel: null, body: null, input: null, sendBtn: null,
    teaser: null, scrollBtn: null, unread: null,
    // Modèles : .fosw-win porte la surface, le dock et le voile sont des
    // surfaces sœurs posées dans le même cadre.
    win: null, dock: null, dockStatus: null, mic: null, backdrop: null,
  };

  /* Les modèles. Chacun ne décrit qu'une structure — où vit le composeur et
     comment la fenêtre se pose. Le reste de la configuration s'applique
     par-dessus, sans quoi changer de modèle voudrait dire tout refaire. */
  var LAYOUTS = {
    classic:   { composer: "in" },
    detached:  { composer: "out" },
    hero:      { composer: "in", hero: true },
    sidebar:   { composer: "in" },
    spotlight: { composer: "in" },
    dock:      { composer: "dock" },
  };

  function layoutOf() {
    var l = (state.cfg && state.cfg.layout) || "classic";
    return LAYOUTS[l] ? l : "classic";
  }

  function agentName() { return (state.config && state.config.name) || "Assistant"; }

  /* État d'aperçu piloté par l'onglet Widget du builder : "open" montre la
     fenêtre ouverte SUR une page hôte, "launcher" ce que le visiteur voit
     d'abord — le bouton, sa pastille, son accroche. Sans ce second état, la
     moitié des réglages du lanceur n'était vérifiable qu'en production.
     "panel" (posé dans le cadre, sans lanceur) reste pour les intégrations qui
     l'utilisaient déjà. */
  var previewState = "open";
  var teaserTimer = null;
  var audioCtx = null;

  function placementClass(suffix) {
    var placement = POSITION_ATTR || (state.cfg && state.cfg.placement) || "bottom-right";
    return suffix + (placement === "bottom-left" ? "bl" : "br");
  }

  function avatarNode(size, onAccent) {
    var c = state.cfg, t = state.theme;
    var wrap = el("div", "fosw-avatar-wrap");
    var a = el("div", "fosw-avatar");
    var box = size || 32;
    if (size) { a.style.width = size + "px"; a.style.height = size + "px"; }
    if (c.avatar_type === "live") {
      // Orbe animée (thinking-orbs) : l'identité de l'agent EST son état. Elle
      // respire au repos, écoute pendant la dictée, cherche puis rédige pendant
      // la réponse. L'encre suit la surface : claire sur un fond sombre ou sur
      // un en-tête d'accent foncé, sombre ailleurs.
      a.className = "fosw-avatar fosw-avatar-live" + (onAccent ? " fosw-on-accent" : "");
      var inkDark = onAccent ? readableInk(t.accent) === "#ffffff" : !!t.dark;
      a.appendChild(orbCanvas(Math.round(box * 0.86), null, inkDark));
    } else if (c.avatar_type === "image" && c.avatar_url) {
      var img = document.createElement("img");
      img.src = c.avatar_url; img.alt = "";
      a.appendChild(img);
    } else {
      // « orbe » — les deux couleurs configurées en dégradé doux, avec le glyphe
      // de l'agent par-dessus. Non configuré, il retombe sur l'accent : le chip
      // est donc à la marque au lieu du bleu arbitraire d'avant.
      var a1 = c.avatar_first || t.accent;
      var a2 = c.avatar_second || a1;
      a.style.background = "linear-gradient(135deg," + a1 + "," + a2 + ")";
      a.style.color = readableInk(a1);
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8.5 13v1.5M15.5 13v1.5"/></svg>';
    }
    wrap.appendChild(a);
    if (c.status_dot !== false) wrap.appendChild(el("div", "fosw-status"));
    return wrap;
  }

  var CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function renderLauncher() {
    var c = state.cfg;
    var label = (c.text_main_label || "").trim();
    var b = el("button", "fosw-launcher" + (label ? " fosw-has-label" : "") + (c.launcher_pulse ? " fosw-pulse" : ""));
    b.type = "button";
    b.setAttribute("aria-label", label || "Ouvrir le chat");
    b.setAttribute("aria-expanded", "false");

    if (c.launcher_image_url) {
      var img = document.createElement("img");
      img.src = c.launcher_image_url; img.alt = "";
      b.appendChild(img);
    } else {
      var main;
      if (c.launcher_icon === "orb") {
        // L'orbe vit sur l'accent : son encre est celle qui s'y lit.
        var t = state.theme;
        var px = parseInt(t.launcher, 10) || 58;
        main = el("span", "fosw-ico fosw-ico-main fosw-ico-orb");
        main.appendChild(orbCanvas(Math.round(px * 0.66), null, readableInk(t.accent) === "#ffffff"));
      } else {
        main = el("span", "fosw-ico fosw-ico-main", LAUNCHER_ICON[c.launcher_icon] || LAUNCHER_ICON.chat);
      }
      var close = el("span", "fosw-ico fosw-ico-close", CLOSE_SVG);
      b.appendChild(main); b.appendChild(close);
      if (label) {
        var span = el("span", "fosw-launcher-label");
        span.textContent = label;
        b.appendChild(span);
      }
    }
    b.onclick = function () { state.open ? closePanel() : openPanel(); };
    return b;
  }

  /* Pastille « non lu » : posée quand une réponse arrive alors que la fenêtre
     est fermée. Sans elle, une réponse proactive passe totalement inaperçue. */
  function setUnread(on) {
    // Le modèle Dock n'a pas de lanceur rond : la pastille se pose sur la
    // barre, seule chose visible quand la fenêtre est repliée.
    var host = dom.launcher || dom.dock;
    if (!host) return;
    if (on && !dom.unread) {
      dom.unread = el("span", "fosw-dot");
      host.appendChild(dom.unread);
    } else if (!on && dom.unread) {
      dom.unread.remove(); dom.unread = null;
    }
  }

  /* ── Accroche ─────────────────────────────────────────────────────────
     Une bulle, une fois par session, refusable. Le refus est mémorisé : rien
     n'agace autant qu'une accroche qui revient à chaque page. */
  function teaserDismissKey() { return "fos_teaser_" + state.publicKey; }

  function showTeaser() {
    var c = state.cfg;
    var text = String(c.teaser_text || "").trim();
    if (!text || state.open || dom.teaser) return;
    var t = el("div", "fosw-teaser");
    var msg = el("div", null); msg.textContent = text; t.appendChild(msg);
    var x = el("button", "fosw-teaser-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Fermer");
    x.onclick = function (e) {
      e.stopPropagation();
      dismissTeaser(true);
    };
    t.appendChild(x);
    t.onclick = function () { dismissTeaser(true); openPanel(); };
    dom.teaser = t;
    dom.root.appendChild(t);
    applyPlacementVars();
    setUnread(true);
  }

  function dismissTeaser(remember) {
    if (teaserTimer) { clearTimeout(teaserTimer); teaserTimer = null; }
    if (dom.teaser) { dom.teaser.remove(); dom.teaser = null; }
    if (remember && !PREVIEW) {
      try { sessionStorage.setItem(teaserDismissKey(), "1"); } catch (e) {}
    }
  }

  function scheduleTeaser() {
    var c = state.cfg;
    dismissTeaser(false);
    if (!c.teaser_enabled || !String(c.teaser_text || "").trim()) return;
    if (state.open || !dom.launcher) return;
    if (!PREVIEW) {
      try { if (sessionStorage.getItem(teaserDismissKey())) return; } catch (e) {}
    }
    var secs = c.teaser_delay_seconds != null ? Number(c.teaser_delay_seconds) : 8;
    if (!isFinite(secs) || secs < 0) secs = 8;
    // En aperçu, l'attente est écourtée : personne ne va regarder un cadre
    // pendant trente secondes pour vérifier une accroche.
    teaserTimer = setTimeout(showTeaser, PREVIEW ? Math.min(secs, 2) * 1000 : secs * 1000);
  }

  var CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  var SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>';
  var CHAT_SVG = LAUNCHER_ICON.bubble;
  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg>';

  /* En-tête — avatar + nom (+ sous-titre) + actions. Commun à tous les
     modèles : ce qui change d'un modèle à l'autre, c'est ce qu'il y a en
     dessous, pas l'identité de l'agent. */
  function renderHeader() {
    var c = state.cfg;
    var headStyle = c.header_style === "accent" ? " fosw-head-accent"
      : c.header_style === "gradient" ? " fosw-head-gradient" : "";
    var header = el("div", "fosw-header" + headStyle);
    header.appendChild(avatarNode(34, !!headStyle));

    var htext = el("div", "fosw-headtext");
    var title = el("div", "fosw-title");
    title.textContent = agentName();
    htext.appendChild(title);
    var sub = String(c.text_subtitle || "").trim();
    if (sub) {
      var subtitle = el("div", "fosw-subtitle");
      subtitle.textContent = sub;
      htext.appendChild(subtitle);
    }
    header.appendChild(htext);

    var reset = el("button", "fosw-iconbtn",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>');
    reset.type = "button";
    reset.title = "Nouvelle conversation";
    reset.setAttribute("aria-label", "Nouvelle conversation");
    reset.onclick = resetConversation;
    header.appendChild(reset);

    var closable = layoutOf() === "dock"
      || (c.collapsible !== false && (!PREVIEW || previewState !== "panel"));
    if (closable) {
      // Le chevron dit « je replie », la croix dit « je ferme ». Sur un modèle
      // dont la barre reste posée, la croix ment.
      var x = el("button", "fosw-iconbtn", c.close_icon === "chevron" ? CHEVRON_SVG : CLOSE_SVG);
      x.type = "button";
      x.title = "Fermer";
      x.setAttribute("aria-label", "Fermer le chat");
      x.onclick = closePanel;
      header.appendChild(x);
    }
    return header;
  }

  /* « Powered by » — un lien, pas une mention : chaque agent embarqué montre
     le produit sur le site d'un client, et ce lien dit lequel nous a amené
     l'inscription (ref=widget + clé publique de l'agent + hôte, lus par
     src/lib/attribution.ts à l'arrivée). Il s'ouvre dans un nouvel onglet :
     on ne sort jamais le visiteur du site de notre client. */
  function renderBrand() {
    var wrap = el("div", "fosw-brand");
    if (!SCRIPT_BASE || PREVIEW) {
      wrap.innerHTML = "Powered by <strong>Anduran</strong>";
      return wrap;
    }
    var a = document.createElement("a");
    var host = "";
    try { host = location.hostname || ""; } catch (e) {}
    a.href = SCRIPT_BASE + "/?ref=widget&agent=" + encodeURIComponent(state.publicKey || "")
      + "&utm_source=widget&utm_medium=powered_by&utm_campaign=" + encodeURIComponent(host);
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = "Powered by <strong>Anduran</strong>";
    wrap.appendChild(a);
    return wrap;
  }

  /* Composeur classique — dans la fenêtre (modèles Classique, Volet,
     Projecteur) ou détaché sous elle (modèle Détaché) : même nœud, la feuille
     de style fait le reste. */
  function renderComposer() {
    var c = state.cfg;
    var composer = el("div", "fosw-composer");
    dom.input = document.createElement("textarea");
    dom.input.rows = 1;
    dom.input.placeholder = c.text_placeholder || DEFAULTS.text_placeholder;
    dom.input.setAttribute("aria-label", c.text_placeholder || "Message");
    // Entrée envoie, Maj+Entrée passe à la ligne : la convention de toutes les
    // messageries, et la raison pour laquelle un <input> ne suffisait plus.
    dom.input.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    };
    dom.input.oninput = autoGrow;
    composer.appendChild(dom.input);

    // Micro et envoi vivent dans un même groupe : le modèle Accueil en fait
    // une barre d'outils sous le champ, les autres les laissent côte à côte.
    var actions = el("div", "fosw-composer-actions");
    var mic = renderMic(false);
    if (mic) actions.appendChild(mic);

    var style = c.send_button_style || "icon";
    var sendLabel = (c.text_send || "").trim();
    dom.sendBtn = el("button", "fosw-send", style === "label" ? "" : SEND_SVG);
    dom.sendBtn.type = "button";
    dom.sendBtn.setAttribute("aria-label", sendLabel || "Envoyer");
    if (sendLabel && style !== "icon") {
      var l = document.createElement("span");
      l.textContent = sendLabel;
      dom.sendBtn.appendChild(l);
    }
    dom.sendBtn.onclick = send;
    actions.appendChild(dom.sendBtn);
    composer.appendChild(actions);
    return composer;
  }

  /* ── Modèle Dock ──────────────────────────────────────────────────────
     Une barre d'agent toujours posée : avatar, nom, état, et deux actions à
     raccourci. Elle remplace le lanceur rond — la barre EST le lanceur — et le
     champ se déplie vers le haut, la fenêtre de conversation au-dessus. */
  function dockIdleStatus() {
    return String(state.cfg.text_subtitle || "").trim() || "En ligne";
  }

  function renderDock() {
    var c = state.cfg;
    var d = el("div", "fosw-dock");
    dom.dock = d;

    var field = el("div", "fosw-dock-field");
    dom.input = document.createElement("textarea");
    dom.input.rows = 1;
    dom.input.placeholder = c.text_placeholder || DEFAULTS.text_placeholder;
    dom.input.setAttribute("aria-label", c.text_placeholder || "Message");
    dom.input.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      // Échap replie la saisie sans fermer la conversation : on n'annule pas
      // une lecture en cours parce qu'on renonce à écrire.
      if (e.key === "Escape") { e.stopPropagation(); setComposing(false); }
    };
    dom.input.oninput = autoGrow;
    field.appendChild(dom.input);

    var x = el("button", "fosw-dock-x", CLOSE_SVG);
    x.type = "button";
    x.setAttribute("aria-label", "Fermer la saisie");
    x.onclick = function () { setComposing(false); };
    field.appendChild(x);
    d.appendChild(field);

    var row = el("div", "fosw-dock-row");
    row.appendChild(avatarNode(36));

    var txt = el("div", "fosw-dock-text");
    var name = el("div", "fosw-dock-name");
    name.textContent = agentName();
    dom.dockStatus = el("div", "fosw-dock-status");
    dom.dockStatus.textContent = dockIdleStatus();
    txt.appendChild(name); txt.appendChild(dom.dockStatus);
    row.appendChild(txt);

    var actions = el("div", "fosw-dock-actions");
    var mic = renderMic(true);
    if (mic) actions.appendChild(mic);

    dom.sendBtn = el("button", "fosw-dock-btn fosw-primary");
    dom.sendBtn.type = "button";
    dom.sendBtn.onclick = function () {
      if (!state.open) { openPanel(); return; }
      if ((dom.input.value || "").trim()) { send(); return; }
      setComposing(!isComposing());
    };
    actions.appendChild(dom.sendBtn);
    row.appendChild(actions);
    d.appendChild(row);
    updateDockButton();
    return d;
  }

  function isComposing() {
    return !!(dom.dock && dom.dock.classList.contains("fosw-composing"));
  }

  function setComposing(on) {
    if (!dom.dock) return;
    if (on) dom.dock.classList.add("fosw-composing");
    else dom.dock.classList.remove("fosw-composing");
    updateDockButton();
    if (on) setTimeout(function () { if (dom.input) dom.input.focus(); }, 30);
  }

  /* Le bouton dit ce qu'il va faire : « Discuter » tant qu'il ouvre, « Envoyer »
     dès que le champ est ouvert. Un bouton d'envoi permanent sur une barre
     repliée promet un envoi qui n'existe pas encore. */
  function updateDockButton() {
    if (!dom.dock || !dom.sendBtn) return;
    var c = state.cfg;
    var composing = isComposing();
    var label = composing
      ? ((c.text_send || "").trim() || "Envoyer")
      : ((c.text_main_label || "").trim() || "Discuter");
    dom.sendBtn.innerHTML = "";
    dom.sendBtn.appendChild(el("span", "fosw-ico", composing ? SEND_SVG : CHAT_SVG));
    var l = document.createElement("span");
    l.textContent = label;
    dom.sendBtn.appendChild(l);
    if (c.dock_shortcuts !== false) dom.sendBtn.appendChild(el("kbd", "fosw-kbd", "C"));
    dom.sendBtn.setAttribute("aria-label", label);
  }

  function setBusy(on) {
    state.busy = !!on;
    clearTimeout(orbs.phaseTimer);
    if (on) {
      setActivity("searching");
      orbs.phaseTimer = setTimeout(function () { if (state.busy) setActivity("composing"); }, 1600);
    } else {
      setActivity(restActivity());
    }
    refreshGlow();
    if (!dom.dockStatus) return;
    dom.dockStatus.textContent = on
      ? ((state.cfg.text_working || "").trim() || "Réflexion en cours…")
      : dockIdleStatus();
  }

  /* ── Dictée ───────────────────────────────────────────────────────────
     Reconnaissance vocale du navigateur (Web Speech API). Aucun appel réseau
     de notre part, aucune clé : là où le navigateur ne la porte pas, le bouton
     n'est pas monté du tout plutôt que monté et inerte. */
  var recognizer = null;

  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function renderMic(dockStyle) {
    if (!state.cfg.voice_input) return null;
    if (!speechCtor()) return null;
    var b = el("button", dockStyle ? "fosw-dock-btn" : "fosw-mic");
    b.type = "button";
    b.title = "Dicter";
    b.setAttribute("aria-label", "Dicter un message");
    b.appendChild(el("span", "fosw-ico", MIC_SVG));
    if (dockStyle) {
      var l = document.createElement("span");
      l.textContent = "Voix";
      b.appendChild(l);
      if (state.cfg.dock_shortcuts !== false) b.appendChild(el("kbd", "fosw-kbd", "V"));
    }
    b.onclick = function () { toggleDictation(b); };
    dom.mic = b;
    return b;
  }

  function toggleDictation(btn) {
    var Ctor = speechCtor();
    if (!Ctor) return;
    if (recognizer) { try { recognizer.stop(); } catch (e) {} return; }
    var r = new Ctor();
    r.lang = navigator.language || "fr-FR";
    r.interimResults = true;
    r.continuous = false;
    // Le dicté s'ajoute à ce qui est déjà écrit : on ne perd pas la phrase
    // commencée au clavier parce qu'on finit à la voix.
    var basis = dom.input ? dom.input.value : "";
    r.onresult = function (e) {
      var txt = "";
      for (var i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      if (!dom.input) return;
      dom.input.value = (basis ? basis.replace(/\s*$/, "") + " " : "") + txt;
      autoGrow();
    };
    function done() {
      recognizer = null;
      releaseGlowStream();
      if (!state.busy) setActivity("breathing");
      btn.classList.remove("fosw-rec");
      if (dom.input) dom.input.focus();
    }
    r.onend = done; r.onerror = done;
    try {
      r.start();
      recognizer = r;
      acquireGlowStream();
      if (!state.busy) setActivity("listening");
      btn.classList.add("fosw-rec");
      if (dom.dock) setComposing(true);
    } catch (e) { recognizer = null; }
  }

  function stopDictation() {
    releaseGlowStream();
    if (!recognizer) return;
    try { recognizer.stop(); } catch (e) {}
    recognizer = null;
  }

  /* ── Lueur vocale ─────────────────────────────────────────────────────
     Le faisceau voice-glow fait partie du champ, comme dans l'app : il respire
     au repos, monte avec la voix pendant la dictée et balaie le champ pendant
     que l'agent réfléchit. React n'a rien à faire ici : le composant vit dans
     widget-voice.js (voice-glow + Preact, ~21 ko gzip), chargé avec
     l'interface. Il est posé EN CALQUE sur le champ, pointeur désactivé : il
     ne touche pas à la mise en page. Si le chargement échoue, le widget
     fonctionne exactement comme avant, sans lueur.

     La reconnaissance du navigateur n'expose pas son flux audio : la lueur
     ouvre donc le micro de son côté, pour la seule durée de la dictée. */
  var glow = { api: null, loading: null, inst: null, layer: null, target: null, stream: null, ro: null };

  function loadGlow() {
    if (window.FounderOSWidgetVoice) return Promise.resolve(window.FounderOSWidgetVoice);
    if (glow.loading) return glow.loading;
    if (!SCRIPT_BASE) return Promise.reject(new Error("no base"));
    glow.loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SCRIPT_BASE + "/widget-voice.js";
      s.async = true;
      s.onload = function () {
        if (window.FounderOSWidgetVoice) resolve(window.FounderOSWidgetVoice);
        else reject(new Error("no api"));
      };
      s.onerror = function () { glow.loading = null; reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
    return glow.loading;
  }

  /* Ce qui dessine le cadre du champ : le textarea s'il porte une bordure
     visible (Classique, Volet, Projecteur), sinon son conteneur (la pilule du
     modèle Détaché, le champ du Dock). */
  function glowTarget() {
    if (!dom.input || !dom.input.parentNode) return null;
    var cs = window.getComputedStyle(dom.input);
    var col = cs.borderTopColor;
    var framed = parseFloat(cs.borderTopWidth) > 0 && col !== "transparent" && col !== "rgba(0, 0, 0, 0)";
    return framed ? dom.input : dom.input.parentNode;
  }

  function placeGlow() {
    var t = glow.target, layer = glow.layer;
    if (!t || !layer) return;
    var r = parseFloat(window.getComputedStyle(t).borderTopLeftRadius) || 0;
    var h = t.offsetHeight;
    glow.radius = Math.min(r, h / 2);
    if (t === dom.input) {
      layer.style.left = t.offsetLeft + "px";
      layer.style.top = t.offsetTop + "px";
      layer.style.width = t.offsetWidth + "px";
      layer.style.height = h + "px";
    } else {
      layer.style.left = "0"; layer.style.top = "0";
      layer.style.width = "100%"; layer.style.height = "100%";
    }
    layer.style.borderRadius = glow.radius + "px";
  }

  function glowProps() {
    var t = glow.target;
    return {
      stream: glow.stream,
      processing: !!state.busy,
      dark: effectiveDark(),
      radius: glow.radius || 0,
      // Le préréglage « pill » est taillé pour un champ bas et large ; une
      // zone de saisie plus haute garde la géométrie par défaut.
      pill: !!t && t.offsetHeight <= 52,
      palette: (state.cfg && state.cfg.voice_glow_palette) || "colorful",
      always: true,
    };
  }

  function unmountGlow() {
    if (glow.ro) { try { glow.ro.disconnect(); } catch (e) {} glow.ro = null; }
    if (glow.inst) { try { glow.inst.unmount(); } catch (e) {} glow.inst = null; }
    if (glow.layer && glow.layer.parentNode) glow.layer.parentNode.removeChild(glow.layer);
    glow.layer = null; glow.target = null;
  }

  /* Réconcilie la lueur avec l'état courant. Appelée quand la dictée démarre
     ou s'arrête et quand l'agent commence ou finit de répondre. */
  function refreshGlow() {
    var wanted = glowEnabled() && !!dom.input;
    if (!wanted) { unmountGlow(); return; }
    loadGlow().then(function (api) {
      var t = glowTarget();
      if (!t) { unmountGlow(); return; }
      // Monté sur un champ encore caché (largeur 0), voice-glow centrerait son
      // faisceau sur x = 0 : on attend que le champ ait une taille.
      if (!t.offsetWidth) { unmountGlow(); return; }
      // Le panneau a pu être reconstruit (changement de modèle, réouverture) :
      // un calque accroché à l'ancien champ est remonté sur le nouveau.
      if (glow.target !== t || !glow.layer || !document.contains(glow.layer)) {
        unmountGlow();
        var container = t === dom.input ? t.parentNode : t;
        if (window.getComputedStyle(container).position === "static") container.style.position = "relative";
        var layer = document.createElement("div");
        layer.setAttribute("aria-hidden", "true");
        layer.style.cssText = "position:absolute;pointer-events:none;z-index:2;";
        container.appendChild(layer);
        glow.layer = layer; glow.target = t;
        placeGlow();
        glow.inst = api.mount(layer, glowProps());
        glow.width = t.offsetWidth;
        if (window.ResizeObserver) {
          glow.ro = new ResizeObserver(function () {
            // voice-glow mesure sa géométrie au montage : un champ qui change
            // vraiment de largeur (fenêtre ouverte, mobile qui pivote) est
            // remonté, pas seulement re-rendu.
            if (!t.offsetWidth || Math.abs(t.offsetWidth - (glow.width || 0)) > 4) {
              unmountGlow();
              refreshGlow();
              return;
            }
            placeGlow();
            if (glow.inst) glow.inst.update(glowProps());
          });
          glow.ro.observe(t);
        }
        return;
      }
      placeGlow();
      glow.inst.update(glowProps());
    }, function () { /* pas de lueur : le widget reste entier */ });
  }

  function acquireGlowStream() {
    if (!glowEnabled()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      // La dictée a pu s'arrêter pendant que le navigateur demandait l'accès.
      if (!recognizer) { s.getTracks().forEach(function (tr) { tr.stop(); }); return; }
      glow.stream = s;
      refreshGlow();
    }, function () { /* micro refusé pour la lueur : la dictée continue sans */ });
  }

  function releaseGlowStream() {
    if (!glow.stream) return;
    try { glow.stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    glow.stream = null;
    refreshGlow();
  }

  /* La lueur fait partie du champ de saisie : elle respire au repos, suit la
     voix pendant la dictée et balaie le champ pendant la réponse. Seul le
     réglage « Lueur du champ » du studio la retire. */
  function glowEnabled() {
    var c = state.cfg || {};
    return c.voice_glow !== false;
  }

  /* ── Orbes de réflexion ───────────────────────────────────────────────
     thinking-orbs, par son moteur sans React (widget-orb.js, ~6 ko gzip) :
     l'avatar « orbe animée », le lanceur « orbe » et l'indicateur pendant la
     réponse. Toutes les orbes non figées suivent la même activité :

       breathing  au repos
       listening  pendant la dictée
       searching  la question part : l'agent fouille sa base
       composing  un instant plus tard : il rédige

     rag-chat ne diffuse pas ses étapes, d'où ce découpage dans le temps —
     c'est l'ordre réel du travail d'un agent RAG, pas une promesse de plus. */
  var orbs = { loading: null, live: [], activity: "breathing", phaseTimer: null };

  var THINKING_LABELS = {
    breathing: "Réflexion…",
    listening: "Je vous écoute…",
    searching: "Je cherche dans mes connaissances…",
    composing: "Je rédige la réponse…",
  };

  function thinkingLabel(activity) {
    var custom = String((state.cfg && state.cfg.text_working) || "").trim();
    if (custom) return custom;
    return THINKING_LABELS[activity] || THINKING_LABELS.breathing;
  }

  function loadOrbs() {
    if (window.FounderOSWidgetOrb) return Promise.resolve(window.FounderOSWidgetOrb);
    if (orbs.loading) return orbs.loading;
    if (!SCRIPT_BASE) return Promise.reject(new Error("no base"));
    orbs.loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SCRIPT_BASE + "/widget-orb.js";
      s.async = true;
      s.onload = function () {
        if (window.FounderOSWidgetOrb) resolve(window.FounderOSWidgetOrb);
        else reject(new Error("no api"));
      };
      s.onerror = function () { orbs.loading = null; reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
    return orbs.loading;
  }

  /* Un canvas prêt à poser tout de suite ; l'orbe s'y peint dès que le
     moteur est là. `fixed` fige l'état (sinon il suit l'activité). */
  function orbCanvas(size, fixed, dark, onReady) {
    var cv = document.createElement("canvas");
    cv.className = "fosw-orb";
    cv.style.width = size + "px";
    cv.style.height = size + "px";
    cv.setAttribute("aria-hidden", "true");
    var rec = { canvas: cv, fixed: fixed || null, handle: null };
    orbs.live.push(rec);
    loadOrbs().then(function (api) {
      rec.handle = api.mount(cv, { state: rec.fixed || orbs.activity, size: size, dark: dark });
      cv.classList.add("fosw-orb-ready");
      if (onReady) onReady();
    }, function () { cv.classList.add("fosw-orb-failed"); });
    return cv;
  }

  /* Les orbes d'une interface démontée ne doivent plus tourner. */
  function pruneOrbs() {
    orbs.live = orbs.live.filter(function (r) {
      if (r.canvas.isConnected) return true;
      if (r.handle) { try { r.handle.destroy(); } catch (e) {} }
      return false;
    });
  }

  function setActivity(a) {
    orbs.activity = a;
    pruneOrbs();
    orbs.live.forEach(function (r) { if (!r.fixed && r.handle) r.handle.update({ state: a }); });
    if (dom.thinkingLabel && dom.thinkingLabel.isConnected) dom.thinkingLabel.textContent = thinkingLabel(a);
  }

  function restActivity() {
    return recognizer ? "listening" : "breathing";
  }

  /* ── Voile ────────────────────────────────────────────────────────────
     Le modèle Projecteur en pose un par défaut : une fenêtre centrée sans
     voile flotte au milieu de la page sans qu'on sache laquelle des deux
     répond au clavier. */
  function wantsBackdrop() {
    var c = state.cfg || {};
    if (c.backdrop === true) return true;
    return layoutOf() === "spotlight" && c.backdrop !== false;
  }

  function showBackdrop() {
    if (dom.backdrop || !dom.root) return;
    var b = el("div", "fosw-backdrop");
    b.onclick = function () { closePanel(); };
    dom.backdrop = b;
    dom.root.insertBefore(b, dom.root.firstChild);
  }

  function hideBackdrop() {
    if (!dom.backdrop) return;
    var b = dom.backdrop;
    dom.backdrop = null;
    b.classList.add("fosw-closing");
    setTimeout(function () { b.remove(); }, 180);
  }

  /* Modèle Accueil — l'écran vide devient un accueil : la marque, une
     salutation, la phrase d'accueil de l'agent, puis ses raccourcis. Il ne
     survit pas au premier message : un écran d'accueil qui reste coincé en
     haut d'une conversation n'est plus qu'un décor. */
  function renderHero() {
    var c = state.cfg;
    var h = el("div", "fosw-hero");
    var mark = avatarNode(48);
    mark.className = "fosw-avatar-wrap fosw-hero-mark";
    h.appendChild(mark);

    var t = el("div", "fosw-hero-text");
    var greet = String(c.text_hero_greeting || "").trim();
    if (greet) {
      var g = el("div", "fosw-hero-greet");
      g.textContent = greet;
      t.appendChild(g);
    }
    var title = el("div", "fosw-hero-title");
    title.textContent = (state.config && state.config.welcome_message)
      || "Comment puis-je vous aider ?";
    t.appendChild(title);
    var note = String(c.text_hero_note || "").trim();
    if (note) {
      var n = el("div", "fosw-hero-note");
      n.textContent = note;
      t.appendChild(n);
    }
    h.appendChild(t);
    return h;
  }

  function clearHero() {
    if (!dom.body) return;
    var h = dom.body.querySelector(".fosw-hero");
    if (!h) return;
    h.remove();
    var chips = dom.body.querySelector(".fosw-chips");
    if (chips) chips.remove();
  }

  function renderPanel() {
    var c = state.cfg;
    var layout = layoutOf();
    var mode = LAYOUTS[layout].composer;
    var p = el("div", "fosw-panel fosw-lay-" + layout + " " + placementClass("fosw-panel-pos-"));

    var win = el("div", "fosw-win" + (c.bot_bubble === "flat" ? " fosw-flat" : ""));
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", agentName());
    dom.win = win;

    win.appendChild(renderHeader());

    dom.body = el("div", "fosw-body");
    // Les réponses arrivent après coup : sans région live, un lecteur d'écran
    // ne sait jamais que l'agent a répondu.
    dom.body.setAttribute("role", "log");
    dom.body.setAttribute("aria-live", "polite");
    dom.body.onscroll = updateScrollButton;
    win.appendChild(dom.body);

    dom.scrollBtn = el("button", "fosw-scrolldown",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg><span>Derniers messages</span>');
    dom.scrollBtn.type = "button";
    dom.scrollBtn.onclick = function () { scrollToEnd(true); };
    win.appendChild(dom.scrollBtn);

    // Le filet de marque passe SOUS le composeur : au-dessus, il coupait la
    // conversation de son champ de saisie.
    if (mode === "in") win.appendChild(renderComposer());
    if (c.show_branding !== false) win.appendChild(renderBrand());

    p.appendChild(win);
    if (mode === "out") p.appendChild(renderComposer());
    if (mode === "dock") p.appendChild(renderDock());
    return p;
  }

  function autoGrow() {
    if (!dom.input) return;
    dom.input.style.height = "auto";
    dom.input.style.height = Math.min(dom.input.scrollHeight, 118) + "px";
  }

  function scrollToEnd(smooth) {
    if (!dom.body) return;
    try { dom.body.scrollTo({ top: dom.body.scrollHeight, behavior: smooth ? "smooth" : "auto" }); }
    catch (e) { dom.body.scrollTop = dom.body.scrollHeight; }
    updateScrollButton();
  }

  function updateScrollButton() {
    if (!dom.body || !dom.scrollBtn) return;
    var far = dom.body.scrollHeight - dom.body.scrollTop - dom.body.clientHeight > 90;
    dom.scrollBtn.classList.toggle("fosw-show", far);
  }

  /* Petit signal sonore à la réponse. Synthétisé (pas de fichier à charger, pas
     de requête vers un tiers) et coupé par défaut. */
  function ping() {
    if (!state.cfg || !state.cfg.sound_enabled || state.restoring) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime;
      o.type = "sine"; o.frequency.setValueAtTime(680, t0);
      o.frequency.exponentialRampToValueAtTime(880, t0 + 0.12);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.32);
    } catch (e) { /* pas de son, pas de drame */ }
  }

  /* ── Persistance de la conversation ───────────────────────────────────
     sessionStorage : le fil suit le visiteur de page en page (le cas normal
     sur une boutique), mais ne le suit pas d'un jour à l'autre — un historique
     ressorti une semaine plus tard met mal à l'aise plus qu'il n'aide. */
  function threadKey() { return "fos_thread_" + state.publicKey; }

  function saveThread() {
    if (!state.cfg || state.cfg.persist_conversation === false || PREVIEW) return;
    try {
      sessionStorage.setItem(threadKey(), JSON.stringify({
        c: state.conversationId,
        m: state.messages.slice(-40),
        r: state.ratingShown,
        t: Date.now(),
      }));
    } catch (e) {}
  }

  function loadThread() {
    if (!state.cfg || state.cfg.persist_conversation === false || PREVIEW) return null;
    try {
      var raw = sessionStorage.getItem(threadKey());
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.m || !d.m.length) return null;
      if (Date.now() - (d.t || 0) > 6 * 3600 * 1000) return null;
      return d;
    } catch (e) { return null; }
  }

  function clearThread() {
    try { sessionStorage.removeItem(threadKey()); } catch (e) {}
  }

  /* Une ligne de message. `sources` rend la même note de bas de bulle que le
     playground sous une réponse sourcée. */
  function appendMessage(role, text, sources) {
    if (!dom.body) return; // panneau non monté (appel copilot() programmatique)
    var row = el("div", "fosw-row fosw-row-" + (role === "user" ? "user" : "bot"));
    var msg = el("div", "fosw-msg fosw-msg-" + (role === "user" ? "user" : "bot"));
    if (role === "user") msg.textContent = text;
    else msg.innerHTML = mdToHtml(text);

    if (sources && sources.length) {
      var top = sources[0] && sources[0].similarity;
      var line = sources.length + " source(s)" + (top ? " · top " + Math.round(top * 100) + "%" : "");
      msg.appendChild(el("div", "fosw-sources", esc(line)));
    }
    row.appendChild(msg);
    dom.body.appendChild(row);
    scrollToEnd(false);
    if (role !== "user" && !state.restoring) { ping(); if (!state.open) setUnread(true); }
    return row;
  }

  /* Un seul contrôle de note par conversation — le score se pose sur la ligne
     de conversation, un widget qui le proposerait après chaque réponse ne
     ferait que s'écraser lui-même. */
  function appendRating() {
    if (!dom.body || state.cfg.feedback === false || state.ratingShown) return;
    state.ratingShown = true;
    var wrap = el("div", "fosw-rate");
    var label = el("span", "fosw-rate-label");
    label.textContent = "Cette réponse vous a aidé ?";
    var up = el("button", null, "👍"), down = el("button", null, "👎");
    up.type = "button"; down.type = "button";
    function pick(btn, rating) {
      return function () {
        rateConversation(rating);
        wrap.classList.add("fosw-rated");
        btn.classList.add("fosw-picked");
      };
    }
    up.onclick = pick(up, 5); down.onclick = pick(down, 1);
    up.title = "Utile"; down.title = "Pas utile";
    up.setAttribute("aria-label", "Utile"); down.setAttribute("aria-label", "Pas utile");
    wrap.appendChild(label); wrap.appendChild(up); wrap.appendChild(down);
    dom.body.appendChild(wrap);
    scrollToEnd(false);
  }

  function appendTyping() {
    var row = el("div", "fosw-row fosw-row-bot");
    var msg = el("div", "fosw-msg fosw-msg-bot");
    if ((state.cfg.thinking_style || "orb") === "orb") {
      // L'orbe dit CE QUE fait l'agent (il cherche, puis il rédige) et la
      // phrase le redit en mots. Tant que l'orbe n'est pas chargée — ou si
      // elle ne se charge pas — les trois points font le travail.
      msg.className += " fosw-thinking";
      var cv = orbCanvas(22, null, !!state.theme.dark, function () { msg.classList.add("fosw-orb-on"); });
      msg.appendChild(cv);
      msg.appendChild(el("div", "fosw-typing", "<span></span><span></span><span></span>"));
      var label = el("span", "fosw-thinking-label");
      label.textContent = thinkingLabel(orbs.activity);
      msg.appendChild(label);
      dom.thinkingLabel = label;
    } else {
      msg.appendChild(el("div", "fosw-typing", "<span></span><span></span><span></span>"));
    }
    row.appendChild(msg);
    dom.body.appendChild(row);
    scrollToEnd(false);
    return row;
  }

  /* Wishlist — purely client-side. The heart gives the visitor a way to mark a
     product while they browse; there is no favourites backend, so it lives in
     localStorage keyed by agent and never leaves the browser. */
  function wishlistKey() { return "fos_wish_" + state.publicKey; }
  function readWishlist() {
    try { return JSON.parse(localStorage.getItem(wishlistKey()) || "[]") || []; }
    catch (e) { return []; }
  }
  function toggleWish(id) {
    var list = readWishlist();
    var i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    try { localStorage.setItem(wishlistKey(), JSON.stringify(list.slice(-200))); } catch (e) {}
    return i < 0;
  }

  var HEART_SVG = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21.2l7.7-7.7 1.1-1a5.5 5.5 0 0 0 0-7.9z"/></svg>';

  /* Catalogue products returned alongside the answer, drawn as immersive cards
     (the vanilla twin of components/ui/destination-card.tsx). The model is told
     these are already on screen, so it introduces them rather than re-listing
     prices. */
  function appendProducts(products) {
    if (!dom.body || !products || !products.length) return;
    var wished = readWishlist();
    var wrap = el("div", "fosw-products");

    products.forEach(function (p) {
      var card = document.createElement(p.url ? "a" : "div");
      card.className = "fosw-product";
      if (p.url) {
        card.href = p.url;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
      }
      card.setAttribute("aria-label", p.title);

      if (p.image_url) {
        var img = document.createElement("img");
        img.className = "fosw-product-img";
        img.src = p.image_url;
        img.alt = "";
        img.loading = "lazy";
        // No third-party placeholder fetch on error — swap to the tinted panel.
        img.onerror = function () {
          img.remove();
          card.insertBefore(el("div", "fosw-product-fallback"), card.firstChild);
        };
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "fosw-product-fallback"));
      }

      card.appendChild(el("div", "fosw-product-scrim"));

      var like = el("button", "fosw-product-like" + (wished.indexOf(p.id) >= 0 ? " fosw-liked" : ""), HEART_SVG);
      like.type = "button";
      like.setAttribute("aria-label", "Ajouter aux favoris");
      like.setAttribute("aria-pressed", wished.indexOf(p.id) >= 0 ? "true" : "false");
      like.onclick = function (e) {
        // The card is a link; without this the heart would navigate away.
        e.preventDefault();
        e.stopPropagation();
        var on = toggleWish(p.id);
        like.classList.toggle("fosw-liked", on);
        like.setAttribute("aria-pressed", on ? "true" : "false");
      };
      card.appendChild(like);

      var body = el("div", "fosw-product-body");
      if (p.category) {
        var cat = el("div", "fosw-product-cat");
        cat.textContent = "- " + p.category + " -";
        body.appendChild(cat);
      }
      var title = el("div", "fosw-product-title");
      title.textContent = p.title;
      body.appendChild(title);

      var foot = el("div", "fosw-product-foot");
      if (p.price != null) {
        var price = el("span", "fosw-product-price");
        price.textContent = p.price + (p.currency ? " " + p.currency : "");
        foot.appendChild(price);
      }
      if (!p.in_stock) {
        var oos = el("span", "fosw-product-oos");
        oos.textContent = "Rupture";
        foot.appendChild(oos);
      }
      if (foot.childNodes.length) body.appendChild(foot);

      card.appendChild(body);
      wrap.appendChild(card);
    });

    dom.body.appendChild(wrap);
    dom.body.scrollTop = dom.body.scrollHeight;
  }


  function appendSuggestions() {
    var raw = String(state.cfg.suggested_questions || "")
      .split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!raw.length || !dom.body) return;
    var wrap = el("div", "fosw-chips");
    raw.slice(0, 5).forEach(function (q) {
      var chip = el("button", "fosw-chip");
      chip.textContent = q;
      chip.onclick = function () { wrap.remove(); dom.input.value = q; send(); };
      wrap.appendChild(chip);
    });
    dom.body.appendChild(wrap);
  }

  /* Amorçage du fil : reprise de la conversation en cours si elle existe,
     sinon porte des conditions puis message d'accueil. */
  function seedMessages() {
    if (state.seeded) return;
    state.seeded = true;

    var saved = loadThread();
    if (saved) {
      state.conversationId = saved.c || null;
      state.messages = saved.m || [];
      state.ratingShown = !!saved.r;
      // Replay silencieux : ni son ni pastille pour des messages déjà lus.
      state.restoring = true;
      state.messages.forEach(function (m) {
        appendMessage(m.role === "user" ? "user" : "bot", m.content);
      });
      state.restoring = false;
      if (state.cfg.onboarding_copilot_ui) mountCopilotButton();
      return;
    }

    function startConversation() {
      var welcome = (state.config && state.config.welcome_message) || "Bonjour ! Comment puis-je vous aider ?";
      if (LAYOUTS[layoutOf()].hero) {
        // La phrase d'accueil EST le titre de l'écran d'accueil : la pousser
        // aussi dans le fil la ferait réapparaître en double à la reprise.
        dom.body.appendChild(renderHero());
        appendSuggestions();
        if (state.cfg.onboarding_copilot_ui) mountCopilotButton();
        return;
      }
      state.messages.push({ role: "bot", content: welcome });
      state.restoring = true;
      appendMessage("bot", welcome);
      state.restoring = false;
      appendSuggestions();
      if (state.cfg.onboarding_copilot_ui) mountCopilotButton();
    }

    if (!state.accepted) {
      state.restoring = true;
      appendMessage("bot", String(state.cfg.terms_content || "").replace(/^#+\s*/gm, ""));
      state.restoring = false;
      var ok = el("button", "fosw-cta");
      ok.type = "button";
      ok.textContent = state.cfg.text_start_chat || DEFAULTS.text_start_chat;
      ok.onclick = function () { state.accepted = true; ok.remove(); startConversation(); };
      dom.body.appendChild(ok);
      return;
    }
    startConversation();
  }

  function mountCopilotButton() {
    var cp = el("button", "fosw-cta");
    cp.type = "button";
    cp.textContent = "✨ Faire pour moi";
    cp.onclick = function () { startCopilot(); };
    dom.body.appendChild(cp);
  }

  function resetConversation() {
    clearThread();
    state.messages = [];
    state.conversationId = null;
    state.seeded = false;
    state.ratingShown = false;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    if (dom.body) dom.body.innerHTML = "";
    seedMessages();
    if (dom.input) { dom.input.value = ""; autoGrow(); }
  }

  /* ---------------- Live co-pilot (page-agent) ---------------- */
  // When the agent has copilot onboarding enabled, we can hand control to the
  // live GUI agent (page-agent) which reads the real DOM and drives the UI
  // toward the onboarding goal. It loads as a separate self-contained bundle,
  // same origin as this widget, and proxies its LLM calls server-side.
  var copilotLoading = false;
  function loadCopilotBundle() {
    return new Promise(function (resolve, reject) {
      if (window.FounderOSOnboardingAgent) return resolve();
      if (copilotLoading) {
        var iv = setInterval(function () {
          if (window.FounderOSOnboardingAgent) { clearInterval(iv); resolve(); }
        }, 100);
        return;
      }
      copilotLoading = true;
      var s = document.createElement("script");
      s.src = (SCRIPT_BASE || "") + "/onboarding-agent.js";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { copilotLoading = false; reject(new Error("failed to load onboarding-agent bundle")); };
      document.head.appendChild(s);
    });
  }

  async function startCopilot(task) {
    if (!state.config || !state.config.onboarding_copilot_enabled) {
      appendMessage("bot", "Le mode co-pilote n'est pas activé pour cet agent.");
      return;
    }
    try {
      appendMessage("bot", "Ok, je m'en occupe — je pilote l'écran pour vous. 👀");
      closePanel();
      await loadCopilotBundle();
      await window.FounderOSOnboardingAgent.start({
        publicKey: state.publicKey,
        endpoint: FN_BASE + "/onboarding-agent",
        anonKey: ANON_KEY,
        userId: state.userId || undefined,
        visitorId: state.userId ? undefined : getVisitorId(),
        task: task || undefined,
      });
    } catch (e) {
      appendMessage("bot", "Impossible de démarrer le co-pilote : " + (e && e.message ? e.message : "erreur"));
    }
  }

  /* (Re)construit toute l'interface depuis `state.cfg`. Un seul chemin de
     rendu partagé par le boot et par l'aperçu du builder : c'est ce qui
     garantit que ce que le marchand règle est exactement ce que le visiteur
     reçoit — l'aperçu ne peut pas diverger, il n'a pas son propre code. */
  function rebuildUI() {
    if (!dom.root) return;
    dismissTeaser(false);
    stopDictation();
    unmountGlow();
    dom.root.innerHTML = "";
    dom.launcher = null; dom.unread = null; dom.teaser = null;
    dom.win = null; dom.dock = null; dom.dockStatus = null; dom.mic = null; dom.backdrop = null;

    var layout = layoutOf();
    // En aperçu « panel » la fenêtre est posée dans le cadre, ouverte, sans
    // lanceur ; en aperçu « launcher » on montre la vraie mise en place. Les
    // modèles qui se posent par rapport au viewport (volet, projecteur, dock)
    // n'ont de sens qu'en position réelle : l'iframe leur sert de page.
    var freeStanding = layout === "sidebar" || layout === "spotlight" || layout === "dock";
    var inlinePanel = PREVIEW && previewState === "panel" && !freeStanding;
    dom.root.className = "fosw-root"
      + (PREVIEW ? " fosw-preview" : "")
      + (PREVIEW && !inlinePanel ? " fosw-preview-fixed" : "");

    dom.panel = renderPanel();
    dom.root.appendChild(dom.panel);

    // Le dock remplace le lanceur : deux boutons d'ouverture superposés, dont
    // un rond qui recouvre la barre, c'est le défaut que personne n'excuse.
    var wantsLauncher = !inlinePanel && layout !== "dock" && state.cfg.collapsible !== false;
    if (wantsLauncher) {
      dom.launcher = renderLauncher();
      dom.root.appendChild(dom.launcher);
    }
    applyTheme(dom.root);

    var startsClosed = layout === "dock"
      ? !(PREVIEW && previewState === "open")
      : (wantsLauncher && !(PREVIEW && previewState === "open"));

    // En aperçu « open » le lanceur reste monté ET la fenêtre s'ouvre : c'est
    // ce que voit un visiteur en pleine conversation, pas une maquette.
    if (startsClosed) {
      state.open = false;
      if (layout === "dock") {
        // La barre reste posée, seule la fenêtre est repliée.
        dom.panel.style.display = "flex";
        if (dom.win) dom.win.style.display = "none";
      } else {
        dom.panel.style.display = "none";
        scheduleTeaser();
      }
    } else {
      openPanel();
    }
    // Les orbes de l'interface précédente s'arrêtent ; celles de la nouvelle
    // repartent sur l'activité courante.
    dom.thinkingLabel = null;
    pruneOrbs();
    refreshGlow();
  }

  /* Aperçu du builder : re-thème et reconstruit la fenêtre sur place quand
     l'onglet Widget publie une configuration éditée. Moins cher et bien moins
     clignotant que remonter l'iframe à chaque cran de sélecteur de couleur. */
  function applyPreviewConfig(next, opts) {
    if (!dom.root) return;
    // « thinking » : la fenêtre ouverte, une question posée et l'agent en train
    // de répondre — le seul moyen de juger l'indicateur de réflexion et la
    // lueur sans envoyer un vrai message.
    var thinking = !!(opts && opts.state === "thinking");
    if (opts && opts.state) {
      previewState = opts.state === "launcher" ? "launcher"
        : opts.state === "panel" ? "panel" : "open";
    }
    state.busy = false;
    clearTimeout(orbs.phaseTimer);
    orbs.activity = "breathing";
    state.cfg = Object.assign({}, DEFAULTS, (state.config && state.config.widget_config) || {}, next || {});
    state.cfg.onboarding_copilot_ui = !!(state.config && state.config.onboarding_copilot_enabled);
    state.theme = resolveTheme();
    state.seeded = false;
    state.messages = [];
    state.conversationId = null;
    state.ratingShown = false;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    rebuildUI();
    if (thinking && dom.body) {
      clearHero();
      appendMessage("user", "Quels sont vos délais de livraison ?");
      appendTyping();
      setBusy(true);
    }
  }

  function openPanel() {
    if (!dom.panel) return;
    dismissTeaser(false);
    setUnread(false);
    dom.panel.classList.remove("fosw-closing");
    dom.panel.style.display = "flex";
    if (dom.win) dom.win.style.display = "flex";
    if (layoutOf() === "dock") {
      dom.panel.classList.add("fosw-dock-open");
      setComposing(true);
    }
    if (wantsBackdrop()) showBackdrop();
    // Le volet occupe le bord jusqu'en bas : le lanceur rond viendrait se poser
    // PAR-DESSUS son champ de saisie. L'en-tête porte déjà la fermeture.
    if (dom.launcher) dom.launcher.style.display = layoutOf() === "sidebar" ? "none" : "";
    state.open = true;
    if (dom.launcher) {
      dom.launcher.classList.add("fosw-open");
      dom.launcher.setAttribute("aria-expanded", "true");
    }
    seedMessages();
    setTimeout(function () { if (dom.input) dom.input.focus(); scrollToEnd(false); refreshGlow(); }, 60);
  }

  function closePanel() {
    // Une fenêtre épinglée n'a pas d'état fermé — c'est ce que veut dire le
    // réglage « repliable ». Idem pour l'aperçu posé dans le cadre.
    if (PREVIEW && previewState === "panel" && layoutOf() !== "dock") return;
    if (state.cfg && state.cfg.collapsible === false && layoutOf() !== "dock") return;
    if (!dom.panel) return;
    hideBackdrop();
    stopDictation();
    // Dock : la barre ne se ferme pas, elle se replie — c'est tout l'intérêt
    // d'un modèle qui reste à portée de clic.
    if (layoutOf() === "dock") {
      state.open = false;
      setComposing(false);
      dom.panel.classList.remove("fosw-dock-open");
      if (dom.win) dom.win.style.display = "none";
      return;
    }
    var p = dom.panel;
    state.open = false;
    p.classList.add("fosw-closing");
    setTimeout(function () {
      if (p === dom.panel && !state.open) p.style.display = "none";
      p.classList.remove("fosw-closing");
    }, 170);
    if (dom.launcher) {
      dom.launcher.style.display = "";
      dom.launcher.classList.remove("fosw-open");
      dom.launcher.setAttribute("aria-expanded", "false");
      dom.launcher.focus();
    }
  }

  async function send() {
    var v = (dom.input.value || "").trim();
    if (!v || dom.sendBtn.disabled) return;
    dom.input.value = "";
    autoGrow();
    stopDictation();
    clearHero();
    appendMessage("user", v);
    state.messages.push({ role: "user", content: v });

    var typing = appendTyping();
    dom.sendBtn.disabled = true;
    setBusy(true);
    try {
      var res = await sendChat(v);
      typing.remove();
      var reply = res.answer || "Je n'ai pas trouvé de réponse à cette question.";
      if (res.conversation_id) state.conversationId = res.conversation_id;
      appendMessage("bot", reply, res.sources);
      state.messages.push({ role: "bot", content: reply });
      appendProducts(res.products);
      appendRating();
      saveThread();

      // Si l'onboarding est activé, on demande aussi une action à l'orchestrateur.
      if (state.config && state.config.onboarding_enabled) {
        var orch = await orchestrate({ question: v });
        if (orch) applyOnboarding(orch);
      }
    } catch (e) {
      typing.remove();
      var msg = String(state.cfg.text_error || "").trim()
        || ("⚠️ " + (e && e.message ? e.message : "Une erreur est survenue."));
      appendMessage("bot", msg);
    } finally {
      dom.sendBtn.disabled = false;
      setBusy(false);
    }
  }

  /* ---------------- Moteur proactif ---------------- */
  /* Porté de la fonction edge rag-widget, qui était le seul endroit à le
     porter. Il réutilise ici la bulle d'accroche et les exécuteurs d'action
     déjà présents, au lieu de redessiner ses propres overlays.

     Trois signaux, tous locaux : le visiteur ne bouge plus, il s'acharne sur un
     élément, il vient de changer de page. Rien n'est envoyé pendant une
     conversation ouverte — interrompre quelqu'un qui vous parle déjà est le
     meilleur moyen de faire fermer le chat. */
  function startActivation() {
    function deriveFn(name) {
      try { return FN_BASE.replace(/\/$/, "") + "/" + name; } catch (e) { return null; }
    }
    var tickUrl = deriveFn("rag-activation-tick");
    var fbUrl = deriveFn("rag-activation-feedback");
    if (!tickUrl) return;

    var idleMs = Math.max(10, Number(state.cfg.proactive_idle_seconds) || 90) * 1000;
    var pageEnteredAt = Date.now();
    var idleTimer = null, routeTimer = null;
    var triggeredRoutes = {};
    var clickMap = {};

    function visibleElements() {
      var out = [];
      var els = document.querySelectorAll("button, a[href], [role='button'], [data-fos-onb]");
      for (var i = 0; i < els.length && out.length < 20; i++) {
        var e = els[i];
        var label = e.getAttribute("aria-label") || (e.textContent || "").trim().slice(0, 40);
        if (!label) continue;
        var sel = e.id ? "#" + e.id
          : e.getAttribute("data-fos-onb") ? '[data-fos-onb="' + e.getAttribute("data-fos-onb") + '"]'
          : e.getAttribute("data-testid") ? '[data-testid="' + e.getAttribute("data-testid") + '"]'
          : e.tagName.toLowerCase();
        out.push({ label: label, selector: sel });
      }
      return out;
    }

    function ctx() {
      return {
        route: location.pathname,
        page_title: document.title,
        seconds_on_page: Math.round((Date.now() - pageEnteredAt) / 1000),
        visible_elements: visibleElements(),
      };
    }

    function sendOutcome(interventionId, outcome, helpful) {
      if (!fbUrl || !interventionId) return;
      fetch(fbUrl, {
        method: "POST", headers: fnHeaders(),
        body: JSON.stringify({
          public_key: state.publicKey, intervention_id: interventionId,
          outcome: outcome, helpful: helpful,
        }),
      }).catch(function () {});
    }

    /* La proposition emprunte la bulle d'accroche : même forme, même place,
       même façon de la refuser. Un second style de bulle n'apprendrait rien de
       plus au visiteur. */
    function showProposal(text, actions, interventionId) {
      dismissTeaser(false);
      var bub = el("div", "fosw-teaser");
      var msg = el("div", null); msg.textContent = text; bub.appendChild(msg);

      var fb = el("div", "fosw-teaser-fb");
      var up = el("button", null, "👍"), down = el("button", null, "👎");
      up.type = "button"; down.type = "button";
      up.setAttribute("aria-label", "Utile"); down.setAttribute("aria-label", "Pas utile");
      up.onclick = function (e) { e.stopPropagation(); sendOutcome(interventionId, "accepted", true); close(); };
      down.onclick = function (e) { e.stopPropagation(); sendOutcome(interventionId, "dismissed", false); close(); };
      fb.appendChild(up); fb.appendChild(down);
      bub.appendChild(fb);

      var x = el("button", "fosw-teaser-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Fermer");
      x.onclick = function (e) { e.stopPropagation(); sendOutcome(interventionId, "dismissed", false); close(); };
      bub.appendChild(x);

      bub.onclick = function () {
        (actions || []).forEach(function (a) {
          try { (RUNNERS[a.type] || function () {})(a); } catch (err) {}
        });
        sendOutcome(interventionId, "accepted", true);
        close();
      };

      function close() { if (dom.teaser === bub) { bub.remove(); dom.teaser = null; } setUnread(false); }

      dom.teaser = bub;
      dom.root.appendChild(bub);
      applyPlacementVars();
      setUnread(true);
      // Une proposition non traitée s'efface d'elle-même : elle vaut pour
      // l'instant où elle arrive, pas pour le reste de la session.
      setTimeout(function () { if (dom.teaser === bub) { sendOutcome(interventionId, "ignored"); close(); } }, 15000);
    }

    function tick(signal) {
      if (state.open) return;
      fetch(tickUrl, {
        method: "POST", headers: fnHeaders(),
        body: JSON.stringify({
          agent_public_key: state.publicKey, visitor_id: getVisitorId(),
          signal: signal, context: ctx(),
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.proactive && d.proactive.text) {
            triggeredRoutes[location.pathname] = true;
            showProposal(d.proactive.text, d.proactive.actions, d.proactive.intervention_id);
          }
        })
        .catch(function () {});
    }

    function resetIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      if (state.open) return;
      idleTimer = setTimeout(function () { tick({ type: "idle" }); }, idleMs);
    }

    function onRoute() {
      pageEnteredAt = Date.now(); clickMap = {};
      if (routeTimer) clearTimeout(routeTimer);
      if (!state.open && !triggeredRoutes[location.pathname]) {
        routeTimer = setTimeout(function () { tick({ type: "route_change" }); }, 4000);
      }
      resetIdle();
    }

    ["mousemove", "keydown", "scroll", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, resetIdle, { passive: true });
    });

    document.addEventListener("click", function (e) {
      resetIdle();
      var t = e.target;
      var key = (t && (t.id || (t.getAttribute && t.getAttribute("data-testid"))))
        || (t && t.tagName ? t.tagName + ":" + ((t.textContent || "").trim().slice(0, 20)) : "");
      if (!key) return;
      var now = Date.now();
      var entry = clickMap[key] || { count: 0, ts: now };
      if (now - entry.ts > 8000) { entry = { count: 1, ts: now }; }
      else {
        entry.count++;
        if (entry.count >= 4) { clickMap[key] = null; tick({ type: "rage_click", rage_clicks: entry.count }); return; }
      }
      clickMap[key] = entry;
    }, { passive: true });

    var origPush = history.pushState;
    history.pushState = function () {
      var r = origPush.apply(this, arguments);
      setTimeout(onRoute, 100);
      return r;
    };
    window.addEventListener("popstate", function () { setTimeout(onRoute, 100); });

    resetIdle();
  }

  /* ---------------- Bootstrap ---------------- */

  async function boot() {
    injectStyle();
    try {
      state.config = await fetchConfig();
    } catch (e) {
      console.warn("[FounderOSAgent] could not fetch config:", e);
      return;
    }

    // La `widget_config` enregistrée fait foi ; l'override d'aperçu laisse le
    // builder montrer les modifications non sauvegardées.
    state.cfg = Object.assign({}, DEFAULTS, state.config.widget_config || {});
    if (PREVIEW && window.FOUNDEROS_PREVIEW_CONFIG) {
      state.cfg = Object.assign(state.cfg, window.FOUNDEROS_PREVIEW_CONFIG);
    }
    state.cfg.onboarding_copilot_ui = !!state.config.onboarding_copilot_enabled;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    state.theme = resolveTheme();

    dom.root = el("div", "fosw-root");
    document.body.appendChild(dom.root);
    rebuildUI();

    // Thème « auto » : le site hôte peut basculer sans rechargement (bouton de
    // thème, réglage système). On suit, sinon le widget reste le seul élément
    // clair d'une page passée en nuit.
    try {
      var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
      if (mq && mq.addEventListener) {
        mq.addEventListener("change", function () {
          if ((state.cfg.theme_mode || "light") !== "auto") return;
          state.theme = resolveTheme();
          applyTheme(dom.root);
        });
      }
    } catch (e) {}

    // Échap ferme — un panneau qu'on ne peut fermer qu'à la souris est un
    // piège au clavier.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) { closePanel(); return; }
      // Raccourcis du modèle Dock. Une lettre nue ne se capte que si personne
      // d'autre n'écrit : voler le « c » de quelqu'un qui remplit un
      // formulaire ferait plus de dégâts que le raccourci n'apporte.
      if (layoutOf() !== "dock" || state.cfg.dock_shortcuts === false) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      var k = String(e.key || "").toLowerCase();
      if (k === "c") { e.preventDefault(); state.open ? setComposing(true) : openPanel(); }
      else if (k === "v" && dom.mic) { e.preventDefault(); if (!state.open) openPanel(); dom.mic.click(); }
    });

    if (PREVIEW) {
      window.addEventListener("message", function (e) {
        if (!e.data || e.data.type !== "founderos:preview-config") return;
        applyPreviewConfig(e.data.config, e.data.preview);
      });
      // On signale au builder qu'on est monté pour qu'il pousse l'état courant
      // (non sauvegardé) du formulaire — sinon l'aperçu ne verrait que la
      // modification suivante.
      try { window.parent.postMessage({ type: "founderos:preview-ready" }, "*"); } catch (err) { /* ignore */ }
    }

    // Proactivité — jamais en aperçu, jamais hors d'une page web réelle.
    if (state.cfg.proactive && CAN_DRIVE_PAGE) startActivation();

    // Démarrage de l'onboarding s'il est activé — et seulement là où il peut
    // vouloir dire quelque chose (voir CAN_DRIVE_PAGE) : sur une page file:// ou
    // un embed qui s'en est exclu, le widget reste un chat et ne touche jamais
    // la page hôte.
    if (state.config.onboarding_enabled && CAN_DRIVE_PAGE) {
      var origPush = history.pushState;
      history.pushState = function () {
        origPush.apply(this, arguments);
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }).then(applyOnboarding); }, 50);
      };
      window.addEventListener("popstate", function () {
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }).then(applyOnboarding); }, 50);
      });
      // Premier tour proactif une fois la page posée.
      setTimeout(function () { orchestrate().then(applyOnboarding); }, 800);
    }
    void SCRIPT_BASE; // référence conservée, utile au débogage
  }

  if (document.readyState === "complete" || document.readyState === "interactive") boot();
  else document.addEventListener("DOMContentLoaded", boot);

  /* ---------------- Public API ---------------- */

  window.FounderOSAgent = {
    open: openPanel,
    close: closePanel,
    setUser: function (id) { state.userId = id; },
    ask: function (q) {
      openPanel();
      // Wait a frame for the panel to mount.
      setTimeout(function () { if (dom.input) { dom.input.value = q; send(); } }, 50);
    },
    emit: function (type, data) {
      state.completedIntents.push(type);
      if (state.waitingEvent && state.waitingEvent === type) state.waitingEvent = null;
      orchestrate({ recent_event: { type: type, data: data } }).then(applyOnboarding);
    },
    // Hand control to the live GUI co-pilot (page-agent). Optional explicit
    // task; otherwise it pursues the agent's active onboarding goal.
    copilot: function (task) { return startCopilot(task); },
  };
})();
