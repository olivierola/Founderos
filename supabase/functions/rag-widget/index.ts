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

  var btn = document.createElement("button");
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText = "position:fixed;bottom:20px;"+pos+";z-index:2147483000;width:56px;height:56px;border:none;border-radius:50%;background:"+accent+";color:"+accentText+";cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:24px;line-height:56px";
  btn.innerHTML = "&#128172;";

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

  sendBtn.onclick = send;
  input.addEventListener("keydown", function(e){ if(e.key==="Enter") send(); });
  btn.onclick = function(){
    open=!open; panel.style.display = open ? "flex" : "none";
    if(open){ if(log.childElementCount===0){ showTermsOr(function(){ if(A.welcome) bubble(A.welcome,"bot"); }); } input.focus(); }
  };

  bar.appendChild(input); bar.appendChild(sendBtn);
  panel.appendChild(head); panel.appendChild(log); panel.appendChild(bar);
  document.body.appendChild(btn); document.body.appendChild(panel);
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
