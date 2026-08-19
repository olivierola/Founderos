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
  /* Mirrors WIDGET_DEFAULTS in src/features/agent-rag/AgentBuilder.tsx — the
     Widget tab writes exactly these keys into rag_agents.widget_config. Keep the
     two lists in sync. */
  var DEFAULTS = {
    variant: "full",              // tiny | compact | full
    placement: "bottom-right",    // bottom-right | bottom-left
    collapsible: true,
    feedback: true,
    base: "#ffffff",
    base_border: "#e5e7eb",
    base_subtle: "#6b7280",
    base_primary: "#18181b",
    accent: "",                   // empty → agent.accent_color
    accent_primary: "#ffffff",
    button_radius: 12,
    input_radius: 12,
    bubble_radius: 14,
    avatar_type: "orb",           // orb | image
    avatar_first: "",             // empty → the accent, so the orb is on-brand
    avatar_second: "",            // empty → avatar_first (flat orb)
    avatar_url: "",
    terms_enabled: false,
    terms_content: "",
    launcher_icon: "chat",        // chat | help | sparkle
    suggested_questions: "",      // newline-separated quick replies
    show_branding: true,
    text_main_label: "Need help?",
    text_start_chat: "Start a chat",
    text_send: "Send",
    text_placeholder: "Type a message…",
  };

  var VARIANT_SIZE = {
    tiny:    { w: 320, h: 440 },
    compact: { w: 360, h: 520 },
    full:    { w: 400, h: 620 },
  };

  var LAUNCHER_ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>',
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
  --fosw-accent: #001BB7;
  --fosw-accent-text: #ffffff;
  --fosw-bubble-radius: 14px;
  --fosw-input-radius: 12px;
  --fosw-button-radius: 12px;
  --fosw-w: 400px;
  --fosw-h: 620px;
}
.fosw-root, .fosw-root * { box-sizing: border-box; }
.fosw-root button { font: inherit; }
.fosw-launcher, .fosw-panel, .fosw-popup, .fosw-tooltip, .fosw-toast {
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-sizing: border-box;
}

/* ── Launcher ─────────────────────────────────────────────────────────── */
.fosw-launcher {
  position: fixed; z-index: 2147483000;
  height: 56px; min-width: 56px; padding: 0;
  border: 0; border-radius: 999px; cursor: pointer;
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  box-shadow: 0 10px 30px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12);
  display: flex; align-items: center; justify-content: center; gap: 9px;
  transition: transform 160ms ease, box-shadow 160ms ease;
}
.fosw-launcher:hover { transform: translateY(-1px) scale(1.03); }
.fosw-launcher.fosw-has-label { padding: 0 20px 0 18px; }
.fosw-launcher svg { width: 22px; height: 22px; flex: none; }
.fosw-launcher-label { font-size: 14px; font-weight: 600; white-space: nowrap; }
.fosw-pos-br { right: 20px; bottom: 20px; }
.fosw-pos-bl { left: 20px;  bottom: 20px; }

/* ── Panel — the Playground card, embeddable ──────────────────────────── */
.fosw-panel {
  position: fixed; z-index: 2147483000;
  width: var(--fosw-w); max-width: calc(100vw - 32px);
  height: var(--fosw-h); max-height: calc(100vh - 110px);
  background: var(--fosw-base); color: var(--fosw-text);
  border: 1px solid var(--fosw-border);
  border-radius: 16px; overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.06);
  display: none; flex-direction: column;
  animation: fosw-in 180ms ease-out;
}
.fosw-panel-pos-br { right: 20px; bottom: 88px; }
.fosw-panel-pos-bl { left: 20px;  bottom: 88px; }
/* Preview: inline, no launcher, no fixed positioning. The viewport-relative
   caps are dropped — the "viewport" is the builder's preview frame, not a page
   the panel has to avoid covering. */
.fosw-preview .fosw-panel {
  position: relative; inset: auto; margin: 0 auto;
  max-width: 100%; max-height: none; animation: none;
}

.fosw-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--fosw-border);
  background: var(--fosw-base);
}
.fosw-avatar {
  width: 28px; height: 28px; border-radius: 8px; flex: none;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.fosw-avatar svg { width: 16px; height: 16px; }
.fosw-avatar img { width: 100%; height: 100%; object-fit: cover; }
.fosw-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 500; color: var(--fosw-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fosw-iconbtn {
  background: transparent; border: 0; color: var(--fosw-subtle);
  cursor: pointer; padding: 5px; border-radius: 8px; display: flex;
  line-height: 0; transition: background 140ms ease, color 140ms ease;
}
.fosw-iconbtn:hover { background: var(--fosw-soft); color: var(--fosw-text); }
.fosw-iconbtn svg { width: 15px; height: 15px; }

.fosw-body {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--fosw-base);
}
.fosw-row { display: flex; }
.fosw-row-user { justify-content: flex-end; }
.fosw-row-bot  { justify-content: flex-start; }
.fosw-msg {
  max-width: 85%; padding: 8px 12px; font-size: 14px; line-height: 1.5;
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
.fosw-msg-bot  { background: var(--fosw-soft); color: var(--fosw-text); }
.fosw-msg-user { background: var(--fosw-accent); color: var(--fosw-accent-text); }
/* Neutral rule rather than currentColor: on a dark-text bubble a full-strength
   currentColor border reads as a hard divider cutting the answer in two. */
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

/* Product cards — immersive twin of components/ui/destination-card.tsx.
   Full-bleed photo, gradient scrim, overline + title, wishlist heart. Sized for
   a 320-400px panel, so the card is a 150px band rather than the 500px hero the
   React version draws: three of them still have to fit above the composer. */
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
/* A broken or absent photo falls back to a tinted panel rather than fetching a
   placeholder from a third-party host on every render. */
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
  border: 1px solid var(--fosw-border); background: transparent; color: var(--fosw-text);
  border-radius: 999px; padding: 5px 11px; font-size: 12.5px; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.fosw-chip:hover { background: var(--fosw-soft); border-color: var(--fosw-accent); }

.fosw-rate { display: flex; gap: 4px; margin-top: 6px; align-self: flex-start; }
.fosw-rate button {
  border: 1px solid var(--fosw-border); background: transparent; cursor: pointer;
  border-radius: 7px; padding: 2px 7px; font-size: 12px; line-height: 1.5;
  opacity: 0.7; transition: opacity 140ms ease, background 140ms ease;
}
.fosw-rate button:hover { opacity: 1; background: var(--fosw-soft); }
.fosw-rate.fosw-rated button { pointer-events: none; opacity: 0.35; }
.fosw-rate.fosw-rated button.fosw-picked { opacity: 1; border-color: var(--fosw-accent); }

.fosw-cta {
  align-self: flex-start; border: 0; cursor: pointer;
  border-radius: var(--fosw-button-radius);
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  padding: 7px 13px; font-size: 13px; font-weight: 600;
}

.fosw-brand {
  text-align: center; font-size: 10px; padding: 0 16px 4px;
  color: var(--fosw-subtle); background: var(--fosw-base);
}
.fosw-composer {
  display: flex; align-items: center; gap: 8px; padding: 12px;
  border-top: 1px solid var(--fosw-border); background: var(--fosw-base);
}
.fosw-composer input {
  flex: 1; min-width: 0; height: 38px; border: 1px solid var(--fosw-border);
  background: var(--fosw-soft); color: var(--fosw-text);
  padding: 0 14px; border-radius: var(--fosw-input-radius); font: inherit; outline: none;
  transition: border-color 140ms ease;
}
.fosw-composer input:focus { border-color: var(--fosw-accent); }
.fosw-composer input::placeholder { color: var(--fosw-subtle); }
.fosw-send {
  height: 38px; min-width: 38px; padding: 0 12px; flex: none;
  border: 0; border-radius: var(--fosw-button-radius);
  background: var(--fosw-accent); color: var(--fosw-accent-text);
  cursor: pointer; font-weight: 600; font-size: 13px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.fosw-send svg { width: 15px; height: 15px; }
.fosw-send:disabled { opacity: 0.45; cursor: not-allowed; }

/* Onboarding overlays (page-level) */
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

@keyframes fosw-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fosw-blink { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
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

  async function sendChat(message) {
    var body = { public_key: state.publicKey, message: message, visitor_id: getVisitorId() };
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

  function resolveTheme() {
    var c = state.cfg;
    var size = VARIANT_SIZE[c.variant] || VARIANT_SIZE.full;
    return {
      base: c.base || DEFAULTS.base,
      border: c.base_border || DEFAULTS.base_border,
      subtle: c.base_subtle || DEFAULTS.base_subtle,
      text: c.base_primary || DEFAULTS.base_primary,
      // The Widget tab's accent wins; unset, the agent's brand colour (Settings
      // tab) is what the visitor sees — the two used to disagree silently.
      accent: c.accent || (state.config && state.config.accent_color) || "#001BB7",
      accentText: c.accent_primary || DEFAULTS.accent_primary,
      soft: rgba(c.base_primary || DEFAULTS.base_primary, 0.06),
      bubbleRadius: (c.bubble_radius != null ? c.bubble_radius : DEFAULTS.bubble_radius) + "px",
      inputRadius: (c.input_radius != null ? c.input_radius : DEFAULTS.input_radius) + "px",
      buttonRadius: (c.button_radius != null ? c.button_radius : DEFAULTS.button_radius) + "px",
      w: size.w + "px",
      h: size.h + "px",
    };
  }

  function applyTheme(root) {
    var t = state.theme;
    var vars = {
      "--fosw-base": t.base, "--fosw-border": t.border, "--fosw-subtle": t.subtle,
      "--fosw-text": t.text, "--fosw-soft": t.soft, "--fosw-accent": t.accent,
      "--fosw-accent-text": t.accentText, "--fosw-bubble-radius": t.bubbleRadius,
      "--fosw-input-radius": t.inputRadius, "--fosw-button-radius": t.buttonRadius,
      "--fosw-w": t.w, "--fosw-h": t.h,
    };
    Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
  }

  /* ---------------- UI ---------------- */

  var dom = { root: null, launcher: null, panel: null, body: null, input: null, sendBtn: null };

  function placementClass(suffix) {
    var placement = POSITION_ATTR || (state.cfg && state.cfg.placement) || "bottom-right";
    return suffix + (placement === "bottom-left" ? "bl" : "br");
  }

  function avatarNode() {
    var c = state.cfg, t = state.theme;
    var a = el("div", "fosw-avatar");
    if (c.avatar_type === "image" && c.avatar_url) {
      var img = document.createElement("img");
      img.src = c.avatar_url; img.alt = "";
      a.appendChild(img);
      return a;
    }
    // "orb" — the two configured colours as a soft gradient with the agent glyph
    // on top. Unconfigured, it falls back to the accent so the chip is on-brand
    // instead of the arbitrary blue it used to be.
    var a1 = c.avatar_first || t.accent;
    var a2 = c.avatar_second || a1;
    a.style.background = "linear-gradient(135deg," + a1 + "," + a2 + ")";
    a.style.color = t.accentText;
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8.5 13v1.5M15.5 13v1.5"/></svg>';
    return a;
  }

  function renderLauncher() {
    var c = state.cfg;
    var label = (c.text_main_label || "").trim();
    var b = el("button", "fosw-launcher " + placementClass("fosw-pos-") + (label ? " fosw-has-label" : ""));
    b.setAttribute("aria-label", label || "Open chat");
    b.innerHTML = LAUNCHER_ICON[c.launcher_icon] || LAUNCHER_ICON.chat;
    if (label) {
      var span = el("span", "fosw-launcher-label");
      span.textContent = label;
      b.appendChild(span);
    }
    b.onclick = function () { state.open ? closePanel() : openPanel(); };
    return b;
  }

  function renderPanel() {
    var c = state.cfg;
    var p = el("div", "fosw-panel " + placementClass("fosw-panel-pos-"));

    /* Header — avatar + agent name + reset, exactly like the Playground card. */
    var header = el("div", "fosw-header");
    header.appendChild(avatarNode());
    var title = el("div", "fosw-title");
    title.textContent = (state.config && state.config.name) || "Assistant";
    header.appendChild(title);

    var reset = el("button", "fosw-iconbtn",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>');
    reset.title = "Reset conversation";
    reset.onclick = resetConversation;
    header.appendChild(reset);

    if (c.collapsible !== false && !PREVIEW) {
      var x = el("button", "fosw-iconbtn",
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
      x.title = "Close";
      x.onclick = closePanel;
      header.appendChild(x);
    }
    p.appendChild(header);

    dom.body = el("div", "fosw-body");
    p.appendChild(dom.body);

    if (c.show_branding !== false) p.appendChild(el("div", "fosw-brand", "Powered by Anduran"));

    var composer = el("div", "fosw-composer");
    dom.input = el("input");
    dom.input.placeholder = c.text_placeholder || DEFAULTS.text_placeholder;
    dom.input.onkeydown = function (e) { if (e.key === "Enter") send(); };
    dom.sendBtn = el("button", "fosw-send",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>');
    if ((c.text_send || "").trim()) {
      var l = document.createElement("span");
      l.textContent = c.text_send;
      dom.sendBtn.appendChild(l);
    }
    dom.sendBtn.onclick = send;
    composer.appendChild(dom.input); composer.appendChild(dom.sendBtn);
    p.appendChild(composer);
    return p;
  }

  /* A message row. `sources` renders the same footnote the playground shows
     under grounded answers. */
  function appendMessage(role, text, sources) {
    if (!dom.body) return; // panel not mounted (e.g. programmatic copilot() call)
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
    dom.body.scrollTop = dom.body.scrollHeight;
    return row;
  }

  /* One rating control per conversation — the score lands on the conversation
     row, so a widget offering it after every answer would just overwrite itself. */
  function appendRating() {
    if (!dom.body || state.cfg.feedback === false || state.ratingShown) return;
    state.ratingShown = true;
    var wrap = el("div", "fosw-rate");
    var up = el("button", null, "👍"), down = el("button", null, "👎");
    function pick(btn, rating) {
      return function () {
        rateConversation(rating);
        wrap.classList.add("fosw-rated");
        btn.classList.add("fosw-picked");
      };
    }
    up.onclick = pick(up, 5); down.onclick = pick(down, 1);
    up.title = "Helpful"; down.title = "Not helpful";
    wrap.appendChild(up); wrap.appendChild(down);
    dom.body.appendChild(wrap);
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  function appendTyping() {
    var row = el("div", "fosw-row fosw-row-bot");
    var msg = el("div", "fosw-msg fosw-msg-bot");
    msg.appendChild(el("div", "fosw-typing", "<span></span><span></span><span></span>"));
    row.appendChild(msg);
    dom.body.appendChild(row);
    dom.body.scrollTop = dom.body.scrollHeight;
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

  /* Terms gate — the conversation only starts once the visitor agrees. */
  function seedMessages() {
    if (state.seeded) return;
    state.seeded = true;

    function startConversation() {
      var welcome = (state.config && state.config.welcome_message) || "Hi! What can I help you with?";
      state.messages.push({ role: "bot", content: welcome });
      appendMessage("bot", welcome);
      appendSuggestions();
      if (state.cfg.onboarding_copilot_ui) mountCopilotButton();
    }

    if (!state.accepted) {
      appendMessage("bot", String(state.cfg.terms_content || "").replace(/^#+\s*/gm, ""));
      var ok = el("button", "fosw-cta");
      ok.textContent = state.cfg.text_start_chat || DEFAULTS.text_start_chat;
      ok.onclick = function () { state.accepted = true; ok.remove(); startConversation(); };
      dom.body.appendChild(ok);
      return;
    }
    startConversation();
  }

  function mountCopilotButton() {
    var cp = el("button", "fosw-cta");
    cp.textContent = "✨ Faire pour moi";
    cp.onclick = function () { startCopilot(); };
    dom.body.appendChild(cp);
  }

  function resetConversation() {
    state.messages = [];
    state.conversationId = null;
    state.seeded = false;
    state.ratingShown = false;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    if (dom.body) dom.body.innerHTML = "";
    seedMessages();
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

  /* Builder preview: re-theme and rebuild the panel in place when the Widget tab
     posts an edited config. Cheaper and far less flickery than remounting the
     iframe on every colour-picker tick. */
  function applyPreviewConfig(next) {
    if (!dom.root || !dom.panel) return;
    state.cfg = Object.assign({}, DEFAULTS, (state.config && state.config.widget_config) || {}, next || {});
    state.cfg.onboarding_copilot_ui = !!(state.config && state.config.onboarding_copilot_enabled);
    state.theme = resolveTheme();
    applyTheme(dom.root);

    var old = dom.panel;
    dom.panel = renderPanel();
    dom.root.replaceChild(dom.panel, old);
    state.seeded = false;
    state.messages = [];
    state.conversationId = null;
    state.ratingShown = false;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    openPanel();
  }

  function openPanel() {
    if (!dom.panel) return;
    dom.panel.style.display = "flex";
    state.open = true;
    seedMessages();
    setTimeout(function () { dom.input && dom.input.focus(); }, 50);
  }
  function closePanel() {
    // A non-collapsible widget has no closed state — that is what the toggle means.
    if (state.cfg && state.cfg.collapsible === false && !PREVIEW) return;
    if (dom.panel) dom.panel.style.display = "none";
    state.open = false;
  }

  async function send() {
    var v = (dom.input.value || "").trim();
    if (!v || dom.sendBtn.disabled) return;
    dom.input.value = "";
    appendMessage("user", v);
    state.messages.push({ role: "user", content: v });

    var typing = appendTyping();
    dom.sendBtn.disabled = true;
    try {
      var res = await sendChat(v);
      typing.remove();
      var reply = res.answer || "Je n'ai pas trouvé de réponse à cette question.";
      if (res.conversation_id) state.conversationId = res.conversation_id;
      appendMessage("bot", reply, res.sources);
      state.messages.push({ role: "bot", content: reply });
      appendProducts(res.products);
      appendRating();

      // If onboarding is enabled, also ask the orchestrator for an action.
      if (state.config && state.config.onboarding_enabled) {
        var orch = await orchestrate({ question: v });
        if (orch) applyOnboarding(orch);
      }
    } catch (e) {
      typing.remove();
      appendMessage("bot", "⚠️ " + (e && e.message ? e.message : "Une erreur est survenue."));
    } finally {
      dom.sendBtn.disabled = false;
    }
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

    // The saved widget_config is the source of truth for how this renders; the
    // preview override lets the builder show unsaved edits live.
    state.cfg = Object.assign({}, DEFAULTS, state.config.widget_config || {});
    if (PREVIEW && window.FOUNDEROS_PREVIEW_CONFIG) {
      state.cfg = Object.assign(state.cfg, window.FOUNDEROS_PREVIEW_CONFIG);
    }
    state.cfg.onboarding_copilot_ui = !!state.config.onboarding_copilot_enabled;
    state.accepted = !(state.cfg.terms_enabled && state.cfg.terms_content);
    state.theme = resolveTheme();

    dom.root = el("div", "fosw-root" + (PREVIEW ? " fosw-preview" : ""));
    applyTheme(dom.root);
    document.body.appendChild(dom.root);

    dom.panel = renderPanel();
    dom.root.appendChild(dom.panel);

    // Collapsible widgets get a launcher and start closed; a pinned one is just
    // the panel. The preview is always the open panel, on its own.
    if (!PREVIEW && state.cfg.collapsible !== false) {
      dom.launcher = renderLauncher();
      dom.root.appendChild(dom.launcher);
    } else {
      openPanel();
    }

    if (PREVIEW) {
      window.addEventListener("message", function (e) {
        if (!e.data || e.data.type !== "founderos:preview-config") return;
        applyPreviewConfig(e.data.config);
      });
      // Tell the builder we're mounted so it can push the current (unsaved) form
      // state — otherwise the preview would only catch the next edit.
      try { window.parent.postMessage({ type: "founderos:preview-ready" }, "*"); } catch (err) { /* ignore */ }
    }

    // Onboarding kick-off if enabled — and only where it can mean something
    // (see CAN_DRIVE_PAGE): on a file:// page or an opted-out embed the widget
    // stays a chat bubble and never touches the host page.
    if (state.config.onboarding_enabled && CAN_DRIVE_PAGE) {
      var origPush = history.pushState;
      history.pushState = function () {
        origPush.apply(this, arguments);
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }).then(applyOnboarding); }, 50);
      };
      window.addEventListener("popstate", function () {
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }).then(applyOnboarding); }, 50);
      });
      // First proactive turn after the page settles.
      setTimeout(function () { orchestrate().then(applyOnboarding); }, 800);
    }
    void SCRIPT_BASE; // keep reference, helps debugging
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
