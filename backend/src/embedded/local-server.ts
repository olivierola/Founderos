// L'entrée locale d'un agent embarqué isolé : sur le site, sans FounderOS, on
// lui parle par cette page ou par son API. Le jeton (LOCAL_TOKEN) protège
// l'API ; la page ne contient rien de secret, elle le demande.
//
//   GET  /                                   la page de conversation
//   GET  /api/conversations                  les conversations
//   POST /api/conversations                  en ouvrir une { title? }
//   GET  /api/conversations/:id/messages     ses messages, et le run en cours
//   POST /api/conversations/:id/messages     écrire { text } : un tour de l'agent
//   GET  /api/journal                        le journal, à importer dans FounderOS

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { LocalStore } from "./local-store.ts";

export interface LocalServerDeps {
  agentName: string;
  token: string;
  local: LocalStore;
  /** Un tour de l'agent sur cette conversation (le message de la personne y est déjà). */
  turn(conversationId: string): Promise<{ run_id: string }>;
  log?: (m: string) => void;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("message trop long");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

export function startLocalServer(deps: LocalServerDeps, port: number): Server {
  const { local } = deps;
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        return res.end(page(deps.agentName));
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "introuvable" });
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!auth || !sameToken(auth, deps.token)) return json(res, 401, { error: "jeton invalide" });

      const parts = url.pathname.split("/").filter(Boolean); // api, conversations, :id, messages
      if (parts[1] === "journal" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="journal-${Date.now()}.jsonl"` });
        return res.end(await local.journal());
      }
      if (parts[1] !== "conversations") return json(res, 404, { error: "introuvable" });
      if (parts.length === 2 && req.method === "GET") {
        const list = [...local.state.conversations.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return json(res, 200, { conversations: list.map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at })) });
      }
      if (parts.length === 2 && req.method === "POST") {
        const b = await body(req);
        return json(res, 200, { id: await local.createConversation(String(b.title ?? "Conversation")) });
      }
      const id = parts[2];
      if (!id || !local.state.conversations.has(id) || parts[3] !== "messages") return json(res, 404, { error: "conversation introuvable" });
      if (req.method === "GET") {
        const runs = [...local.state.runs.values()].filter((r) => r.conversation_id === id);
        const last = runs[runs.length - 1];
        return json(res, 200, {
          messages: local.state.messages.filter((m) => m.conversation_id === id).map((m) => ({ id: m.id, role: m.role, content: m.content, at: m.at })),
          run: last ? { id: last.id, status: last.status, live: typeof last.live_output === "string" ? last.live_output : null } : null,
        });
      }
      if (req.method === "POST") {
        const text = String((await body(req)).text ?? "").trim();
        if (!text) return json(res, 400, { error: "message vide" });
        await local.addUserMessage(id, text.slice(0, 50_000));
        return json(res, 200, await deps.turn(id));
      }
      return json(res, 405, { error: "méthode non permise" });
    } catch (e) {
      deps.log?.(`entrée locale : ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, () => deps.log?.(`entrée locale sur le port ${port}`));
  return server;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** La page : sobre, sans dépendance, le jeton gardé dans le navigateur de la personne. */
function page(agentName: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(agentName)}</title>
<style>
:root{--bg:#fafafa;--fg:#1c1c1e;--mut:#6b6b70;--bd:#e4e4e7;--card:#fff;--acc:#5b4fd6}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#ececee;--mut:#9a9aa0;--bd:#333336;--card:#252528;--acc:#8b80f0}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 Inter,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
.app{display:grid;grid-template-columns:240px 1fr;height:100vh}@media (max-width:700px){.app{grid-template-columns:1fr}aside{display:none}}
aside{border-right:1px solid var(--bd);padding:16px;overflow:auto}aside h1{font-size:15px;margin:0 0 12px}
aside button{display:block;width:100%;text-align:left;border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:8px;padding:8px 10px;margin-bottom:6px;cursor:pointer;font:inherit}
aside button.on{border-color:var(--acc)}main{display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow:auto;padding:20px 16px}.m{max-width:760px;margin:0 auto 14px;white-space:pre-wrap}.m.user{text-align:right}
.m span{display:inline-block;padding:8px 12px;border-radius:10px;background:var(--card);border:1px solid var(--bd);text-align:left}
.m.user span{background:var(--acc);border-color:var(--acc);color:#fff}.st{max-width:760px;margin:0 auto;color:var(--mut);font-size:12px;min-height:18px;padding:0 16px}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bd);max-width:792px;width:100%;margin:0 auto}
textarea,input{flex:1;font:inherit;padding:10px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg);resize:none}
form button{border:0;border-radius:8px;background:var(--acc);color:#fff;padding:0 16px;font:inherit;cursor:pointer}
#gate{max-width:360px;margin:20vh auto;padding:0 16px}#gate p{color:var(--mut)}
</style></head><body>
<div id="gate" hidden><h1>${esc(agentName)}</h1><p>Le jeton d'accès de cet agent (LOCAL_TOKEN).</p><form id="tf"><input id="tk" type="password" autocomplete="off"><button>Entrer</button></form></div>
<div class="app" id="app" hidden><aside><h1>${esc(agentName)}</h1><button id="new">Nouvelle conversation</button><div id="convs"></div></aside>
<main><div id="log"></div><div class="st" id="st"></div><form id="f"><textarea id="t" rows="2" placeholder="Votre message"></textarea><button>Envoyer</button></form></main></div>
<script>
let token=localStorage.getItem("fos_local_token")||"",conv=null;
const $=(id)=>document.getElementById(id);
const api=async(p,o={})=>{const r=await fetch("/api"+p,{...o,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}});if(r.status===401){localStorage.removeItem("fos_local_token");gate();throw new Error("jeton")}return r.json()};
function gate(){$("gate").hidden=false;$("app").hidden=true}
async function start(){$("gate").hidden=true;$("app").hidden=false;await convs();tick()}
async function convs(){const d=await api("/conversations");$("convs").innerHTML="";d.conversations.forEach(c=>{const b=document.createElement("button");b.textContent=c.title;b.className=c.id===conv?"on":"";b.onclick=()=>{conv=c.id;convs();load()};$("convs").appendChild(b)});if(!conv&&d.conversations[0]){conv=d.conversations[0].id;load()}}
async function load(){if(!conv)return;const d=await api("/conversations/"+conv+"/messages");$("log").innerHTML="";d.messages.forEach(m=>{const e=document.createElement("div");e.className="m "+m.role;const s=document.createElement("span");s.textContent=m.content;e.appendChild(s);$("log").appendChild(e)});
const r=d.run;$("st").textContent=r&&r.status==="running"?(r.live?"En cours : "+r.live.slice(-160):"En cours…"):r&&r.status==="awaiting_input"?"L'agent attend votre réponse.":r&&r.status==="failed"?"Le dernier tour a échoué.":"";$("log").scrollTop=1e9}
function tick(){setTimeout(async()=>{try{await load()}catch{}tick()},1500)}
$("tf").onsubmit=(e)=>{e.preventDefault();token=$("tk").value.trim();localStorage.setItem("fos_local_token",token);start().catch(()=>{})};
$("new").onclick=async()=>{const d=await api("/conversations",{method:"POST",body:JSON.stringify({title:"Conversation du "+new Date().toLocaleString()})});conv=d.id;await convs();load()};
$("f").onsubmit=async(e)=>{e.preventDefault();const t=$("t").value.trim();if(!t)return;if(!conv){const d=await api("/conversations",{method:"POST",body:JSON.stringify({title:t.slice(0,60)})});conv=d.id;await convs()}$("t").value="";await api("/conversations/"+conv+"/messages",{method:"POST",body:JSON.stringify({text:t})});load()};
$("t").addEventListener("keydown",(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("f").requestSubmit()}});
token?start().catch(()=>{}):gate();
</script></body></html>`;
}
