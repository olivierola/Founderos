// rag-widget — serves the embeddable chat widget JavaScript.
// Loaded by the snippet via <script src=".../functions/v1/rag-widget">. Reads
// window.FounderOSAgent config and talks to the public rag-chat endpoint.

const WIDGET_JS = `(function(){
  var A = window.FounderOSAgent || {};
  if (!A.key || !A.endpoint) { console.warn("FounderOSAgent: missing key/endpoint"); return; }
  var c = A.config || {};
  // Resolve config with sensible fallbacks (text-chat widget).
  var accent = c.accent || A.color || "#001BB7";
  var accentText = c.accent_primary || "#ffffff";
  var baseBg = c.base || "#ffffff";
  var baseText = c.base_primary || "#18181b";
  var subtle = c.base_subtle || "#6b7280";
  var border = c.base_border || "#e5e7eb";
  var btnRadius = (c.button_radius != null ? c.button_radius : 12) + "px";
  var inputRadius = (c.input_radius != null ? c.input_radius : 12) + "px";
  var bubbleRadius = (c.bubble_radius != null ? c.bubble_radius : 14) + "px";
  var title = c.text_main_label || c.title || A.title || "Need help?";
  var placeholder = c.text_placeholder || "Type a message…";
  var sendLabel = c.text_send || "Send";
  var pos = (c.placement || A.position) === "bottom-left" ? "left:20px" : "right:20px";
  var convId = null, open = false, accepted = !(c.terms_enabled && c.terms_content);
  var launchers = { chat: "&#128172;", help: "?", sparkle: "&#10024;" };

  var btn = document.createElement("button");
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText = "position:fixed;bottom:20px;"+pos+";z-index:2147483000;width:56px;height:56px;border:none;border-radius:50%;background:"+accent+";color:"+accentText+";cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:24px;line-height:56px";
  btn.innerHTML = launchers[c.launcher_icon] || launchers.chat;

  var panel = document.createElement("div");
  panel.style.cssText = "position:fixed;bottom:88px;"+pos+";z-index:2147483000;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:"+baseBg+";color:"+baseText+";border:1px solid "+border+";border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,sans-serif";

  var head = document.createElement("div");
  head.style.cssText = "background:"+accent+";color:"+accentText+";padding:14px 16px;font-weight:600;font-size:15px";
  head.textContent = title;

  var log = document.createElement("div");
  log.style.cssText = "flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.5";

  function bubble(text, who){
    var b = document.createElement("div");
    b.style.cssText = "max-width:82%;padding:8px 11px;border-radius:"+bubbleRadius+";white-space:pre-wrap;word-wrap:break-word;" + (who==="user" ? "align-self:flex-end;background:"+accent+";color:"+accentText : "align-self:flex-start;background:#f1f1f4;color:"+baseText);
    b.textContent = text;
    log.appendChild(b); log.scrollTop = log.scrollHeight;
    return b;
  }

  var bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;border-top:1px solid "+border+";padding:10px";
  var input = document.createElement("input");
  input.placeholder = placeholder;
  input.style.cssText = "flex:1;border:1px solid "+border+";border-radius:"+inputRadius+";padding:8px 10px;font-size:14px;outline:none;color:"+baseText+";background:"+baseBg;
  var sendBtn = document.createElement("button");
  sendBtn.textContent = sendLabel;
  sendBtn.style.cssText = "border:none;border-radius:"+btnRadius+";background:"+accent+";color:"+accentText+";padding:0 14px;cursor:pointer;font-size:14px";

  function send(){
    var q = (input.value||"").trim(); if(!q) return;
    input.value = ""; bubble(q, "user");
    var thinking = bubble("…", "bot");
    fetch(A.endpoint, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ public_key: A.key, message: q, conversation_id: convId, visitor_id: getVid() })
    }).then(function(r){ return r.json(); }).then(function(d){
      convId = d.conversation_id || convId;
      thinking.textContent = d.answer || (d.error ? ("Error: "+d.error) : "Sorry, no answer.");
      log.scrollTop = log.scrollHeight;
    }).catch(function(){ thinking.textContent = "Network error."; });
  }
  function getVid(){ try{ var k="fos_vid"; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2); localStorage.setItem(k,v);} return v; }catch(e){ return null; } }

  // Optional terms gate before the conversation.
  function showTermsOr(then){
    if (accepted) { then(); return; }
    var box = bubble((c.terms_content||"").replace(/^####\\s*/,"").slice(0,600), "bot");
    var ok = document.createElement("button");
    ok.textContent = "Agree & continue";
    ok.style.cssText = "align-self:flex-start;margin-top:6px;border:none;border-radius:"+btnRadius+";background:"+accent+";color:"+accentText+";padding:6px 12px;cursor:pointer;font-size:13px";
    ok.onclick = function(){ accepted = true; ok.remove(); then(); };
    log.appendChild(ok);
  }

  function suggestions(){
    var raw = (c.suggested_questions||"").split(/\\n+/).map(function(s){return s.trim();}).filter(Boolean);
    if(raw.length===0) return;
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px";
    raw.slice(0,5).forEach(function(q){
      var chip = document.createElement("button");
      chip.textContent = q;
      chip.style.cssText = "border:1px solid "+border+";border-radius:999px;background:transparent;color:"+baseText+";padding:5px 10px;font-size:12px;cursor:pointer";
      chip.onclick = function(){ input.value = q; send(); wrap.remove(); };
      wrap.appendChild(chip);
    });
    log.appendChild(wrap);
  }

  sendBtn.onclick = send;
  input.addEventListener("keydown", function(e){ if(e.key==="Enter") send(); });
  btn.onclick = function(){
    open=!open; panel.style.display = open ? "flex" : "none";
    if(open){ if(log.childElementCount===0){ showTermsOr(function(){ if(A.welcome) bubble(A.welcome,"bot"); suggestions(); }); } input.focus(); }
  };

  bar.appendChild(input); bar.appendChild(sendBtn);
  panel.appendChild(head); panel.appendChild(log); panel.appendChild(bar);
  if (c.show_branding !== false) {
    var brand = document.createElement("div");
    brand.style.cssText = "text-align:center;padding:6px;font-size:10px;color:"+subtle;
    brand.textContent = "Powered by FounderOS";
    panel.appendChild(brand);
  }
  document.body.appendChild(btn); document.body.appendChild(panel);

  // ── Activation engine (proactive) ────────────────────────────────────────
  // Opt-in via config.proactive. Watches behaviour (idle / rage-click / route
  // change), posts ticks to rag-activation-tick, and surfaces a proactive bubble
  // when the backend rules fire. Reuses bubble()/panel/getVid() above.
  if (c.proactive) (function(){
    // Derive the tick / feedback endpoints from A.endpoint (which targets
    // rag-chat) unless overridden explicitly.
    function deriveFn(name){
      try { return A.endpoint.replace(/\\/[a-z0-9-]+\\/?$/i, "/"+name); }
      catch(e){ return null; }
    }
    var tickUrl = A.tick_endpoint || deriveFn("rag-activation-tick");
    var fbUrl   = A.feedback_endpoint || deriveFn("rag-activation-feedback");
    if (!tickUrl) return;

    var idleMs = (c.proactive_idle_seconds != null ? c.proactive_idle_seconds : 90) * 1000;
    var pageEnteredAt = Date.now();
    var idleTimer = null, routeTimer = null;
    var triggeredRoutes = {};          // route → true (don't re-proact same route)
    var clickMap = {};                 // confusion detection
    var proBubble = null;

    function visibleElements(){
      var out = [];
      var els = document.querySelectorAll("button, a[href], [role='button'], [data-fos-onb]");
      for (var i=0; i<els.length && out.length<20; i++){
        var el = els[i];
        var label = el.getAttribute("aria-label") || (el.textContent||"").trim().slice(0,40);
        if (!label) continue;
        var sel = el.id ? "#"+el.id
          : el.getAttribute("data-fos-onb") ? '[data-fos-onb="'+el.getAttribute("data-fos-onb")+'"]'
          : el.getAttribute("data-testid") ? '[data-testid="'+el.getAttribute("data-testid")+'"]'
          : el.tagName.toLowerCase();
        out.push({ label: label, selector: sel });
      }
      return out;
    }

    function ctx(){
      return {
        route: location.pathname,
        page_title: document.title,
        seconds_on_page: Math.round((Date.now()-pageEnteredAt)/1000),
        visible_elements: visibleElements()
      };
    }

    // Execute the orchestrate-schema UI actions the agent returns.
    function runActions(actions){
      (actions||[]).forEach(function(a){
        try {
          if (a.type === "navigate" && a.route) { location.href = a.route; return; }
          var el = a.selector ? document.querySelector(a.selector) : null;
          if ((a.type === "highlight" || a.type === "tooltip" || a.type === "scroll_to") && el) {
            el.scrollIntoView({ behavior:"smooth", block:"center" });
            if (a.type !== "scroll_to") {
              var saved = el.style.outline;
              el.style.outline = "3px solid "+accent; el.style.outlineOffset = "2px";
              setTimeout(function(){ el.style.outline = saved; }, a.duration_ms || 3000);
            }
          }
        } catch(e){}
      });
    }

    function showProBubble(text, actions, interventionId){
      if (proBubble) proBubble.remove();
      var bub = document.createElement("div");
      bub.style.cssText = "position:fixed;bottom:88px;"+pos+";z-index:2147483001;max-width:300px;background:"+baseBg+";color:"+baseText+";border:1px solid "+border+";border-radius:14px;padding:14px 16px;box-shadow:0 8px 32px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif;cursor:pointer";
      var msg = document.createElement("div");
      msg.style.cssText = "font-size:13px;line-height:1.5"; msg.textContent = text;
      var fb = document.createElement("div");
      fb.style.cssText = "display:flex;gap:6px;margin-top:10px";
      var up = document.createElement("button"), down = document.createElement("button");
      up.textContent = "\\uD83D\\uDC4D"; down.textContent = "\\uD83D\\uDC4E";
      [up,down].forEach(function(b){ b.style.cssText = "border:1px solid "+border+";border-radius:6px;background:transparent;cursor:pointer;font-size:12px;padding:2px 8px"; });
      function sendOutcome(outcome, helpful){
        if (!fbUrl || !interventionId) return;
        fetch(fbUrl, { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ public_key: A.key, intervention_id: interventionId, outcome: outcome, helpful: helpful }) }).catch(function(){});
      }
      up.onclick = function(e){ e.stopPropagation(); sendOutcome("accepted", true); bub.remove(); proBubble=null; };
      down.onclick = function(e){ e.stopPropagation(); sendOutcome("dismissed", false); bub.remove(); proBubble=null; };
      bub.onclick = function(){ runActions(actions); sendOutcome("accepted", true); bub.remove(); proBubble=null; };
      fb.appendChild(up); fb.appendChild(down);
      bub.appendChild(msg); bub.appendChild(fb);
      document.body.appendChild(bub); proBubble = bub;
      setTimeout(function(){ if (proBubble === bub) { sendOutcome("ignored"); bub.remove(); proBubble=null; } }, 15000);
    }

    function tick(signal){
      if (open) return;                // don't interrupt an active conversation
      fetch(tickUrl, { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ agent_public_key: A.key, visitor_id: getVid(), signal: signal, context: ctx() }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.proactive && d.proactive.text) {
            triggeredRoutes[location.pathname] = true;
            showProBubble(d.proactive.text, d.proactive.actions, d.proactive.intervention_id);
          }
        }).catch(function(){});
    }

    function resetIdle(){
      if (idleTimer) clearTimeout(idleTimer);
      if (open) return;
      idleTimer = setTimeout(function(){ tick({ type:"idle" }); }, idleMs);
    }

    function onRoute(){
      pageEnteredAt = Date.now(); clickMap = {};
      if (routeTimer) clearTimeout(routeTimer);
      if (!open && !triggeredRoutes[location.pathname]) {
        routeTimer = setTimeout(function(){ tick({ type:"route_change" }); }, 4000);
      }
      resetIdle();
    }

    ["mousemove","keydown","scroll","touchstart"].forEach(function(ev){
      document.addEventListener(ev, resetIdle, { passive:true });
    });
    document.addEventListener("click", function(e){
      resetIdle();
      var t = e.target;
      var key = (t && (t.id || t.getAttribute && t.getAttribute("data-testid"))) ||
                (t && t.tagName ? t.tagName+":"+((t.textContent||"").trim().slice(0,20)) : "");
      if (!key) return;
      var now = Date.now(); var entry = clickMap[key] || { count:0, ts:now };
      if (now-entry.ts > 8000) { entry = { count:1, ts:now }; }
      else { entry.count++; if (entry.count >= 4) { clickMap[key]=null; tick({ type:"rage_click", rage_clicks: entry.count }); return; } }
      clickMap[key] = entry;
    }, { passive:true });

    var op = history.pushState;
    history.pushState = function(){ var r = op.apply(this, arguments); setTimeout(onRoute, 100); return r; };
    window.addEventListener("popstate", function(){ setTimeout(onRoute, 100); });

    // Cancel proactivity while the panel is open; resume on close.
    btn.addEventListener("click", function(){
      if (open) { if (idleTimer) clearTimeout(idleTimer); if (routeTimer) clearTimeout(routeTimer); if (proBubble){ proBubble.remove(); proBubble=null; } }
      else resetIdle();
    });

    tick({ type:"heartbeat" });        // register the session immediately
    resetIdle();
  })();
})();`;

Deno.serve(() => {
  return new Response(WIDGET_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
