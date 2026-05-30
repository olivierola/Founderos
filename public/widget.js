/* FounderOS Agent Widget — single embeddable file.
 *
 * Usage (one line, in any HTML):
 *   <script src="https://founderos-peach.vercel.app/widget.js" data-agent="PUBLIC_KEY"></script>
 *
 * Optional attributes:
 *   data-user="<external_user_id>"   bind the visitor to a logged-in user
 *   data-position="bottom-right"     | "bottom-left" (default bottom-right)
 *
 * Programmatic API (set after script load):
 *   FounderOSAgent.emit("project.created", { id: "p_123" });
 *   FounderOSAgent.ask("How do I invite my team?");
 *   FounderOSAgent.open();   FounderOSAgent.close();
 *   FounderOSAgent.setUser("user_42");
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
  var POSITION   = (SELF && SELF.getAttribute("data-position")) || "bottom-right";
  var SUPABASE_URL = SELF && SELF.getAttribute("data-endpoint"); // optional override

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

  /* ---------------- State ---------------- */
  var state = {
    publicKey: PUBLIC_KEY,
    userId: USER_ID || null,
    config: null,                  // fetched from rag-agent-public-config
    open: false,
    visitorId: null,
    conversationId: null,
    messages: [],
    completedIntents: [],
    inFlight: false,
    waitingEvent: null,
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

  /* ---------------- Styles ---------------- */
  var CSS = `
.fosw-bubble, .fosw-panel, .fosw-popup, .fosw-tooltip, .fosw-toast {
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  box-sizing: border-box;
}
.fosw-bubble {
  position: fixed; z-index: 999998;
  width: 52px; height: 52px; border-radius: 999px;
  background: var(--fosw-accent, #001BB7); color: #fff;
  border: 0; cursor: pointer;
  box-shadow: 0 10px 30px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.12);
  display: flex; align-items: center; justify-content: center;
  transition: transform 200ms ease;
}
.fosw-bubble:hover { transform: scale(1.05); }
.fosw-bubble svg { width: 22px; height: 22px; }
.fosw-pos-br { right: 20px; bottom: 20px; }
.fosw-pos-bl { left: 20px;  bottom: 20px; }

.fosw-panel {
  position: fixed; z-index: 999999;
  width: 360px; max-width: calc(100vw - 32px);
  height: 540px; max-height: calc(100vh - 100px);
  background: #18181b; color: #f4f4f5;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  display: flex; flex-direction: column;
  animation: fosw-in 180ms ease-out;
}
.fosw-panel-pos-br { right: 20px; bottom: 86px; }
.fosw-panel-pos-bl { left: 20px;  bottom: 86px; }

.fosw-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; background: var(--fosw-accent, #001BB7); color: #fff;
}
.fosw-header h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
.fosw-iconbtn {
  background: transparent; border: 0; color: inherit;
  cursor: pointer; padding: 4px; border-radius: 6px; opacity: 0.85;
}
.fosw-iconbtn:hover { opacity: 1; background: rgba(255,255,255,0.1); }

.fosw-body {
  flex: 1; overflow-y: auto; padding: 14px;
  background: #1f1f23;
  display: flex; flex-direction: column; gap: 10px;
}
.fosw-msg {
  max-width: 85%; padding: 8px 12px; border-radius: 12px;
  white-space: pre-wrap; word-wrap: break-word;
}
.fosw-msg-bot   { background: #27272a; color: #f4f4f5; align-self: flex-start; border-bottom-left-radius: 4px; }
.fosw-msg-user  { background: var(--fosw-accent, #001BB7); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
.fosw-msg-typing { color: #a1a1aa; font-style: italic; }

.fosw-input {
  display: flex; gap: 8px; padding: 10px 12px;
  border-top: 1px solid rgba(255,255,255,0.08); background: #18181b;
}
.fosw-input input {
  flex: 1; background: #27272a; border: 0; color: #f4f4f5;
  padding: 9px 12px; border-radius: 999px; font: inherit; outline: none;
}
.fosw-input input::placeholder { color: #71717a; }
.fosw-input button {
  background: var(--fosw-accent, #001BB7); color: #fff;
  border: 0; border-radius: 999px; padding: 0 14px;
  cursor: pointer; font-weight: 600;
}
.fosw-input button:disabled { opacity: 0.45; cursor: not-allowed; }

.fosw-credit {
  text-align: center; font-size: 10px; padding: 6px;
  background: #18181b; color: #71717a;
  border-top: 1px solid rgba(255,255,255,0.05);
}

/* Onboarding overlays (page-level) */
.fosw-highlight {
  position: relative; z-index: 999997 !important;
  box-shadow: 0 0 0 4px rgba(0,27,183,0.55), 0 0 0 9999px rgba(0,0,0,0.35) !important;
  border-radius: 6px !important;
  transition: box-shadow 200ms ease;
}
.fosw-popup, .fosw-tooltip, .fosw-toast {
  position: fixed; z-index: 999998; max-width: 320px;
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

  /* ---------------- API calls ---------------- */

  async function fetchConfig() {
    var res = await fetch(FN_BASE + "/rag-agent-public-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: state.publicKey }),
    });
    if (!res.ok) throw new Error("config " + res.status);
    return res.json();
  }

  async function sendChat(message) {
    var body = { public_key: state.publicKey, message: message, visitor_id: getVisitorId() };
    if (state.conversationId) body.conversation_id = state.conversationId;
    var res = await fetch(FN_BASE + "/rag-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("rag-chat " + res.status);
    return res.json();
  }

  async function orchestrate(extraContext) {
    if (!state.config || !state.config.onboarding_enabled) return null;
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
        headers: { "Content-Type": "application/json" },
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
    if (a.title) pop.appendChild(el("div", "fosw-pop-title", a.title));
    var body = el("div", "fosw-pop-body"); body.textContent = a.body || ""; pop.appendChild(body);
    var close = el("button", "fosw-pop-close", "×"); close.onclick = function () { pop.remove(); }; pop.appendChild(close);
    document.body.appendChild(pop); positionNear(pop, anchor);
  }
  function actScroll(a) { var t = findEl(a.selector); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }
  function actNavigate(a) {
    if (!a.route) return;
    try {
      history.pushState({}, "", a.route);
      window.dispatchEvent(new PopStateEvent("popstate"));
      setTimeout(function () {
        if (location.pathname + location.search !== a.route) location.assign(a.route);
      }, 200);
    } catch (e) { location.assign(a.route); }
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

  /* ---------------- UI ---------------- */

  var dom = { bubble: null, panel: null, body: null, input: null, sendBtn: null };

  function renderBubble() {
    var b = el("button", "fosw-bubble fosw-pos-" + (POSITION === "bottom-left" ? "bl" : "br"));
    b.setAttribute("aria-label", "Open chat");
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
    b.onclick = function () { state.open ? closePanel() : openPanel(); };
    return b;
  }

  function renderPanel() {
    var p = el("div", "fosw-panel fosw-panel-pos-" + (POSITION === "bottom-left" ? "bl" : "br"));
    var header = el("div", "fosw-header");
    header.appendChild(el("h3", null, (state.config && state.config.name) || "Assistant"));
    var x = el("button", "fosw-iconbtn", "✕");
    x.onclick = closePanel; header.appendChild(x);
    p.appendChild(header);

    dom.body = el("div", "fosw-body");
    p.appendChild(dom.body);

    var inputWrap = el("div", "fosw-input");
    dom.input = el("input"); dom.input.placeholder = "Type a message…";
    dom.input.onkeydown = function (e) { if (e.key === "Enter") send(); };
    dom.sendBtn = el("button", null, "Send");
    dom.sendBtn.onclick = send;
    inputWrap.appendChild(dom.input); inputWrap.appendChild(dom.sendBtn);
    p.appendChild(inputWrap);

    p.appendChild(el("div", "fosw-credit", "Powered by FounderOS"));
    return p;
  }

  function appendMessage(role, text) {
    var msg = el("div", "fosw-msg fosw-msg-" + role);
    msg.textContent = text;
    dom.body.appendChild(msg);
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  function openPanel() {
    if (!dom.panel) { dom.panel = renderPanel(); document.body.appendChild(dom.panel); seedMessages(); }
    dom.panel.style.display = "flex";
    state.open = true;
    setTimeout(function () { dom.input && dom.input.focus(); }, 50);
  }
  function closePanel() {
    if (dom.panel) dom.panel.style.display = "none";
    state.open = false;
  }

  function seedMessages() {
    var welcome = state.config && state.config.welcome_message;
    if (welcome && state.messages.length === 0) {
      state.messages.push({ role: "bot", content: welcome });
      appendMessage("bot", welcome);
    }
  }

  async function send() {
    var v = (dom.input.value || "").trim();
    if (!v) return;
    dom.input.value = "";
    appendMessage("user", v);
    state.messages.push({ role: "user", content: v });

    var typing = el("div", "fosw-msg fosw-msg-bot fosw-msg-typing"); typing.textContent = "…";
    dom.body.appendChild(typing); dom.body.scrollTop = dom.body.scrollHeight;
    dom.sendBtn.disabled = true;
    try {
      var res = await sendChat(v);
      typing.remove();
      var reply = (res && res.message && res.message.content) || res.text || "I couldn't answer this one.";
      if (res.conversation_id) state.conversationId = res.conversation_id;
      appendMessage("bot", reply);
      state.messages.push({ role: "bot", content: reply });

      // If onboarding is enabled, also ask the orchestrator for an action.
      if (state.config && state.config.onboarding_enabled) {
        var orch = await orchestrate({ question: v });
        if (orch) applyOnboarding(orch);
      }
    } catch (e) {
      typing.remove();
      appendMessage("bot", "Error: " + (e && e.message ? e.message : "unknown"));
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
    // Apply accent color.
    document.documentElement.style.setProperty("--fosw-accent", state.config.accent_color || "#001BB7");

    // Mount bubble.
    dom.bubble = renderBubble();
    document.body.appendChild(dom.bubble);

    // Onboarding kick-off if enabled.
    if (state.config.onboarding_enabled) {
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
      setTimeout(function () { dom.input.value = q; send(); }, 50);
    },
    emit: function (type, data) {
      state.completedIntents.push(type);
      if (state.waitingEvent && state.waitingEvent === type) state.waitingEvent = null;
      orchestrate({ recent_event: { type: type, data: data } }).then(applyOnboarding);
    },
  };
})();
