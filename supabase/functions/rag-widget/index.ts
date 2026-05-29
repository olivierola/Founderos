// rag-widget — serves the embeddable chat widget JavaScript.
// Loaded by the snippet via <script src=".../functions/v1/rag-widget">. Reads
// window.FounderOSAgent config and talks to the public rag-chat endpoint.

const WIDGET_JS = `(function(){
  var cfg = window.FounderOSAgent || {};
  if (!cfg.key || !cfg.endpoint) { console.warn("FounderOSAgent: missing key/endpoint"); return; }
  var color = cfg.color || "#2F2FE4";
  var title = cfg.title || "Assistant";
  var pos = cfg.position === "bottom-left" ? "left:20px" : "right:20px";
  var convId = null, open = false;

  var btn = document.createElement("button");
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText = "position:fixed;bottom:20px;"+pos+";z-index:2147483000;width:56px;height:56px;border:none;border-radius:50%;background:"+color+";color:#fff;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:24px;line-height:56px";
  btn.innerHTML = "&#128172;";

  var panel = document.createElement("div");
  panel.style.cssText = "position:fixed;bottom:88px;"+pos+";z-index:2147483000;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:#fff;color:#18181b;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,sans-serif";

  var head = document.createElement("div");
  head.style.cssText = "background:"+color+";color:#fff;padding:14px 16px;font-weight:600;font-size:15px";
  head.textContent = title;

  var log = document.createElement("div");
  log.style.cssText = "flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.5";

  function bubble(text, who){
    var b = document.createElement("div");
    b.style.cssText = "max-width:82%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;" + (who==="user" ? "align-self:flex-end;background:"+color+";color:#fff" : "align-self:flex-start;background:#f1f1f4;color:#18181b");
    b.textContent = text;
    log.appendChild(b); log.scrollTop = log.scrollHeight;
    return b;
  }
  if (cfg.welcome) bubble(cfg.welcome, "bot");

  var bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;border-top:1px solid #eee;padding:10px";
  var input = document.createElement("input");
  input.placeholder = "Type a message…";
  input.style.cssText = "flex:1;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:14px;outline:none";
  var sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  sendBtn.style.cssText = "border:none;border-radius:8px;background:"+color+";color:#fff;padding:0 14px;cursor:pointer;font-size:14px";

  function send(){
    var q = (input.value||"").trim(); if(!q) return;
    input.value = ""; bubble(q, "user");
    var thinking = bubble("…", "bot");
    fetch(cfg.endpoint, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ public_key: cfg.key, message: q, conversation_id: convId, visitor_id: getVid() })
    }).then(function(r){ return r.json(); }).then(function(d){
      convId = d.conversation_id || convId;
      thinking.textContent = d.answer || (d.error ? ("Error: "+d.error) : "Sorry, no answer.");
      log.scrollTop = log.scrollHeight;
    }).catch(function(){ thinking.textContent = "Network error."; });
  }
  function getVid(){ try{ var k="fos_vid"; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2); localStorage.setItem(k,v);} return v; }catch(e){ return null; } }

  sendBtn.onclick = send;
  input.addEventListener("keydown", function(e){ if(e.key==="Enter") send(); });
  btn.onclick = function(){ open=!open; panel.style.display = open ? "flex" : "none"; if(open) input.focus(); };

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
