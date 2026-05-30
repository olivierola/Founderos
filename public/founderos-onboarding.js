/* FounderOS Onboarding SDK — dynamic in-product guidance driven by your RAG agent.
 *
 * Usage (in your SaaS app):
 *   <script src="https://founderos-peach.vercel.app/founderos-onboarding.js"></script>
 *   <script>
 *     FounderOS.init({
 *       agentPublicKey: "YOUR_AGENT_PUBLIC_KEY",
 *       endpoint: "https://YOUR_SUPABASE.functions.supabase.co/rag-onboarding-orchestrate",
 *       userId: window.currentUser?.id,   // optional, for server-side identification
 *       getRoute: () => location.pathname, // default
 *     });
 *
 *     // When something happens in your app:
 *     FounderOS.emit("project.created", { id: "p_123" });
 *     // Or ask explicitly:
 *     FounderOS.ask("How do I invite a teammate?");
 *   </script>
 */
(function () {
  "use strict";

  if (window.FounderOS) return; // already loaded

  var STYLE = `
.fos-highlight {
  position: relative;
  z-index: 999999 !important;
  box-shadow: 0 0 0 4px hsl(220 90% 60% / 0.5), 0 0 0 9999px rgba(0,0,0,0.35) !important;
  border-radius: 6px !important;
  transition: box-shadow 200ms ease;
}
.fos-popup, .fos-tooltip, .fos-toast {
  position: fixed; z-index: 1000000; max-width: 320px;
  background: #18181b; color: #f4f4f5;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px; padding: 12px 14px;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,0.35);
  animation: fos-pop 200ms ease-out;
}
.fos-popup .fos-title { font-weight: 600; margin-bottom: 4px; font-size: 13px; }
.fos-popup .fos-body { opacity: 0.9; }
.fos-popup .fos-close, .fos-tooltip .fos-close {
  position: absolute; top: 6px; right: 8px;
  background: transparent; border: 0; color: #a1a1aa;
  cursor: pointer; font-size: 16px; padding: 0; line-height: 1;
}
.fos-tooltip { padding: 8px 10px; font-size: 12px; }
.fos-toast { right: 16px; bottom: 16px; background: #16a34a; border-color: #16a34a; color: #fff; }
@keyframes fos-pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
`;

  function injectStyle() {
    if (document.getElementById("fos-onboarding-style")) return;
    var el = document.createElement("style");
    el.id = "fos-onboarding-style";
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  var state = {
    agentPublicKey: null,
    endpoint: null,
    userId: null,        // for external_user_id (server-side identification)
    visitorId: null,     // for anonymous identification
    getRoute: function () { return location.pathname + location.search; },
    debug: false,
    completedIntents: [],
    waitingForEvent: null,
    listeners: [],
    inFlight: false,
  };

  function log() {
    if (state.debug) console.log.apply(console, ["[FounderOS]"].concat([].slice.call(arguments)));
  }

  function ensureVisitorId() {
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

  function findEl(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function closeAllOverlays() {
    document.querySelectorAll(".fos-popup, .fos-tooltip, .fos-toast").forEach(function (n) { n.remove(); });
    document.querySelectorAll(".fos-highlight").forEach(function (n) { n.classList.remove("fos-highlight"); });
  }

  /* ---------------- Action runners ---------------- */

  function actHighlight(a) {
    var el = findEl(a.selector);
    if (!el) { log("highlight: not found", a.selector); return; }
    el.classList.add("fos-highlight");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    var ms = Math.min(a.duration_ms || 6000, 20000);
    setTimeout(function () { el.classList.remove("fos-highlight"); }, ms);
    if (a.message) toast(a.message);
  }

  function actPopup(a) {
    var anchor = a.anchor_selector ? findEl(a.anchor_selector) : null;
    var pop = document.createElement("div");
    pop.className = "fos-popup";
    pop.innerHTML =
      (a.title ? '<div class="fos-title"></div>' : "") +
      '<div class="fos-body"></div>' +
      '<button class="fos-close" aria-label="Close">×</button>';
    if (a.title) pop.querySelector(".fos-title").textContent = a.title;
    pop.querySelector(".fos-body").textContent = a.body || "";
    pop.querySelector(".fos-close").onclick = function () { pop.remove(); };
    document.body.appendChild(pop);
    positionNear(pop, anchor);
  }

  function actScrollTo(a) {
    var el = findEl(a.selector);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function actNavigate(a) {
    if (!a.route) return;
    try {
      // Try History API first (SPA-friendly).
      window.history.pushState({}, "", a.route);
      window.dispatchEvent(new PopStateEvent("popstate"));
      setTimeout(function () {
        if (location.pathname + location.search !== a.route) location.assign(a.route);
      }, 200);
    } catch (e) {
      location.assign(a.route);
    }
  }

  function actTooltip(a) {
    var el = findEl(a.selector);
    if (!el) return;
    var tip = document.createElement("div");
    tip.className = "fos-tooltip";
    tip.innerHTML = '<button class="fos-close">×</button><span></span>';
    tip.querySelector("span").textContent = a.text || "";
    tip.querySelector(".fos-close").onclick = function () { tip.remove(); };
    document.body.appendChild(tip);
    positionNear(tip, el);
  }

  function actCelebrate(a) {
    var toastEl = document.createElement("div");
    toastEl.className = "fos-toast";
    toastEl.textContent = (a && a.message) || "🎉 Nice work!";
    document.body.appendChild(toastEl);
    setTimeout(function () { toastEl.remove(); }, 3500);
  }

  function actWaitEvent(a) {
    state.waitingForEvent = a.event;
    log("waiting for event", a.event);
  }

  var RUNNERS = {
    highlight: actHighlight,
    popup: actPopup,
    scroll_to: actScrollTo,
    navigate: actNavigate,
    tooltip: actTooltip,
    celebrate: actCelebrate,
    wait_event: actWaitEvent,
  };

  function positionNear(node, anchor) {
    if (!anchor) {
      // Center bottom
      node.style.left = "50%";
      node.style.bottom = "32px";
      node.style.transform = "translateX(-50%)";
      return;
    }
    var rect = anchor.getBoundingClientRect();
    var top = rect.bottom + 8;
    var left = Math.max(8, Math.min(window.innerWidth - 340, rect.left));
    node.style.top = top + "px";
    node.style.left = left + "px";
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "fos-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  /* ---------------- Orchestrate call ---------------- */

  async function orchestrate(extraContext) {
    if (!state.endpoint || !state.agentPublicKey) {
      log("not initialised");
      return;
    }
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      var ctx = Object.assign(
        {
          route: state.getRoute(),
          completed_intents: state.completedIntents.slice(-10),
        },
        extraContext || {},
      );
      var body = {
        agent_public_key: state.agentPublicKey,
        context: ctx,
      };
      if (state.userId) body.external_user_id = state.userId;
      else body.visitor_id = ensureVisitorId();

      var res = await fetch(state.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { log("orchestrate failed", res.status); return; }
      var data = await res.json();
      log("response", data);
      runResponse(data);
    } catch (e) {
      log("orchestrate error", e);
    } finally {
      state.inFlight = false;
    }
  }

  function runResponse(data) {
    closeAllOverlays();
    if (data.text) toast(data.text);
    (data.actions || []).forEach(function (a) {
      var fn = RUNNERS[a.type];
      if (fn) try { fn(a); } catch (e) { log("action error", a.type, e); }
    });
    if (data.next_intent) state.completedIntents.push("expected:" + data.next_intent);
  }

  /* ---------------- Public API ---------------- */

  window.FounderOS = {
    init: function (cfg) {
      injectStyle();
      Object.assign(state, cfg || {});
      if (!state.agentPublicKey || !state.endpoint) {
        console.warn("[FounderOS] init requires agentPublicKey + endpoint");
        return;
      }
      ensureVisitorId();
      // Watch SPA route changes.
      var origPush = history.pushState;
      history.pushState = function () {
        origPush.apply(this, arguments);
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }); }, 50);
      };
      window.addEventListener("popstate", function () {
        setTimeout(function () { orchestrate({ recent_event: { type: "route.changed" } }); }, 50);
      });
      // Initial kick-off after first paint.
      if (document.readyState === "complete") orchestrate();
      else window.addEventListener("load", function () { orchestrate(); });
    },

    emit: function (eventType, data) {
      state.completedIntents.push(eventType);
      var ev = { type: eventType, data: data };
      if (state.waitingForEvent && state.waitingForEvent === eventType) {
        state.waitingForEvent = null;
      }
      orchestrate({ recent_event: ev });
    },

    ask: function (question) {
      orchestrate({ question: question });
    },

    setUser: function (userId) {
      state.userId = userId;
    },

    debug: function (on) { state.debug = !!on; },

    /** Allow consumers to subscribe to actions if they want to build their own UI. */
    onActions: function (cb) {
      var wrap = function (data) { try { cb(data); } catch (e) {} };
      state.listeners.push(wrap);
    },
  };
})();
