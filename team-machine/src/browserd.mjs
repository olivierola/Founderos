#!/usr/bin/env node
// Le navigateur d'UN agent : un Chromium sans écran, piloté par Playwright,
// lancé SOUS L'IDENTITÉ de l'agent (setpriv, comme tout ce qu'il exécute).
//
//   node browserd.mjs <socket> <profil>
//
// Son profil (cookies, sessions, stockage local) vit dans le dossier perso de
// l'agent (~/.browser/profile, 0700) : aucun autre agent ne le lit, et il
// survit d'un run à l'autre. Le superviseur lui parle par une socket Unix
// posée au même endroit ; root seul peut s'y connecter en dehors de l'agent.
// Sans commande pendant BROWSER_IDLE_SECONDS (600 par défaut), il s'arrête.
//
// Les éléments d'une page se désignent par un numéro (ref) que `snapshot`
// pose sur les liens, boutons et champs visibles : plus robuste qu'un sélecteur
// CSS deviné, et lisible pour un modèle.

import http from "node:http";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [socketPath, profileDir] = process.argv.slice(2);
if (!socketPath || !profileDir) {
  console.error("usage : browserd.mjs <socket> <profil>");
  process.exit(2);
}
const IDLE_MS = (Number(process.env.BROWSER_IDLE_SECONDS) || 600) * 1000;
const home = process.env.HOME || path.dirname(path.dirname(profileDir));
const capturesDir = path.join(home, "captures");
const downloadsDir = path.join(home, "Downloads");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
  downloadsPath: downloadsDir,
  locale: "fr-FR",
  // /dev/shm est petit dans un conteneur : Chromium écrit ailleurs.
  args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
});
let active = context.pages()[0] ?? await context.newPage();
const consoleLog = [];
const watch = (p) => {
  p.on("console", (m) => { consoleLog.push(`[${m.type()}] ${m.text()}`.slice(0, 500)); if (consoleLog.length > 200) consoleLog.shift(); });
  p.on("pageerror", (e) => { consoleLog.push(`[pageerror] ${e.message}`.slice(0, 500)); if (consoleLog.length > 200) consoleLog.shift(); });
};
context.pages().forEach(watch);
context.on("page", (p) => { watch(p); active = p; });
context.on("download", () => {});

let idle;
let lastUse = Date.now();
const touch = () => {
  lastUse = Date.now();
  clearTimeout(idle);
  idle = setTimeout(() => shutdown(), IDLE_MS);
};

const T = 15_000;
const target = (a) => {
  if (a.ref != null && a.ref !== "") return active.locator(`[data-tmref="${String(a.ref).replace(/[^0-9]/g, "")}"]`).first();
  if (a.selector) return active.locator(String(a.selector)).first();
  if (a.text) return active.getByText(String(a.text), { exact: false }).first();
  throw new Error("désigne l'élément : ref (vu dans snapshot), selector (CSS) ou text");
};

/** Les éléments utiles de la page, numérotés : liens, boutons, champs. */
async function snapshot(limit = 120) {
  const items = await active.evaluate((max) => {
    const sel = "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=true], summary";
    const out = [];
    let n = 0;
    document.querySelectorAll("[data-tmref]").forEach((e) => e.removeAttribute("data-tmref"));
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
      n += 1;
      el.setAttribute("data-tmref", String(n));
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type");
      const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const href = tag === "a" ? el.getAttribute("href") : null;
      out.push({ ref: n, kind: el.getAttribute("role") || (type ? `${tag}[${type}]` : tag), label, href: href ? href.slice(0, 120) : undefined, value: tag === "input" || tag === "textarea" ? String(el.value ?? "").slice(0, 60) : undefined });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
  return items;
}

async function pageText(max = 12_000) {
  const text = await active.evaluate(() => document.body?.innerText ?? "");
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max)}\n… [${clean.length - max} caractères de plus]` : clean;
}

const where = async () => ({ url: active.url(), title: await active.title().catch(() => "") });

/**
 * Ce que l'agent veut ouvrir, en adresse. Une URL avec schéma passe telle
 * quelle. Un CHEMIN (~/…, /…, ./…, ou un fichier qui existe dans le dossier
 * perso, comme « me.html ») s'ouvre en file:// : sans cela, « me.html »
 * devenait https://me.html, l'agent devinait une URL sur le dernier site
 * visité, et une appli à route attrape-tout (Vercel) lui rendait sa page
 * d'accueil, capture après capture. Le noyau décide toujours de l'accès :
 * le navigateur tourne sous l'identité de l'agent.
 */
function resolveUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("url requise");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  let file = null;
  if (s === "~" || s.startsWith("~/")) file = path.join(home, s.slice(1));
  else if (s.startsWith("/")) file = s;
  else if (s.startsWith("./") || s.startsWith("../")) file = path.resolve(home, s);
  else if (existsSync(path.resolve(home, s))) file = path.resolve(home, s);
  if (file) {
    if (!existsSync(file)) throw new Error(`fichier introuvable : ${file}. Vérifie le chemin (team_files list) ; ~ est ton dossier perso (${home}).`);
    return pathToFileURL(file).href;
  }
  return `https://${s}`;
}

/** Ouvre une adresse et dit ce qui est VRAIMENT affiché : le statut HTTP, et
 *  l'adresse finale quand elle diffère de celle demandée (redirection). */
async function open(page, raw) {
  const url = resolveUrl(raw);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  const status = resp?.status() ?? null;
  const final = page.url();
  return { requested: url, ...(status != null ? { status } : {}), redirected: final.replace(/\/$/, "") !== url.replace(/\/$/, "") };
}

async function run(a) {
  const action = String(a.action ?? "");
  switch (action) {
    case "navigate": {
      const nav = await open(active, a.url ?? a.path);
      return { ...(await where()), ...nav, text: await pageText(4_000), elements: await snapshot(60) };
    }
    case "snapshot":
      return { ...(await where()), elements: await snapshot(Number(a.limit) || 120) };
    case "text":
      return { ...(await where()), text: await pageText(Number(a.max) || 12_000) };
    case "html": {
      const html = await active.content();
      return { ...(await where()), html: html.slice(0, 40_000), truncated: html.length > 40_000 };
    }
    case "click":
      await target(a).click({ timeout: T });
      await active.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
      return { ...(await where()), elements: await snapshot(60) };
    case "fill":
      await target(a).fill(String(a.value ?? ""), { timeout: T });
      return { ...(await where()), filled: true };
    case "type":
      await target(a).pressSequentially(String(a.value ?? ""), { timeout: T, delay: 20 });
      return { ...(await where()), typed: true };
    case "press":
      if (a.ref != null || a.selector || a.text) await target(a).press(String(a.value || "Enter"), { timeout: T });
      else await active.keyboard.press(String(a.value || "Enter"));
      await active.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
      return await where();
    case "select":
      await target(a).selectOption(String(a.value ?? ""), { timeout: T });
      return { ...(await where()), selected: a.value };
    case "check":
    case "uncheck":
      await (action === "check" ? target(a).check({ timeout: T }) : target(a).uncheck({ timeout: T }));
      return await where();
    case "hover":
      await target(a).hover({ timeout: T });
      return await where();
    case "scroll":
      await active.mouse.wheel(0, a.value === "up" ? -700 : 700);
      return await where();
    case "wait":
      if (a.ref != null || a.selector || a.text) await target(a).waitFor({ timeout: Math.min(Number(a.timeout) || 10_000, 30_000) });
      else await active.waitForTimeout(Math.min(Number(a.timeout) || 1_000, 10_000));
      return await where();
    case "back": await active.goBack({ timeout: T }).catch(() => {}); return await where();
    case "forward": await active.goForward({ timeout: T }).catch(() => {}); return await where();
    case "reload": await active.reload({ timeout: T }); return await where();
    case "screenshot": {
      mkdirSync(capturesDir, { recursive: true, mode: 0o770 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = a.path ? String(a.path) : path.join(capturesDir, `${stamp}.png`);
      if (a.ref != null || a.selector) await target(a).screenshot({ path: file, timeout: T });
      else await active.screenshot({ path: file, fullPage: a.full_page === true });
      return { ...(await where()), saved: file };
    }
    case "evaluate": {
      const value = await active.evaluate(String(a.value ?? "null"));
      const json = JSON.stringify(value ?? null);
      return { ...(await where()), result: json && json.length > 10_000 ? `${json.slice(0, 10_000)}…` : json };
    }
    case "console":
      return { ...(await where()), console: consoleLog.slice(-60) };
    case "tabs":
      return { tabs: await Promise.all(context.pages().map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => ""), active: p === active }))) };
    case "new_tab":
      active = await context.newPage();
      const nav = a.url || a.path ? await open(active, a.url ?? a.path) : {};
      return { ...(await where()), ...nav };
    case "switch_tab": {
      const p = context.pages()[Number(a.index)];
      if (!p) throw new Error("onglet inconnu : tabs les liste");
      active = p;
      await p.bringToFront();
      return await where();
    }
    case "close_tab": {
      await active.close();
      active = context.pages().at(-1) ?? await context.newPage();
      return await where();
    }
    case "peek": {
      // Ce qu'un humain voit depuis l'onglet Activité : les onglets, et l'écran
      // de l'onglet actif. Ne compte pas comme une activité de l'agent.
      const tabs = await Promise.all(context.pages().map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => ""), active: p === active })));
      const shot = await active.screenshot({ type: "jpeg", quality: 55, timeout: 10_000 }).catch(() => null);
      return { tabs, image: shot ? shot.toString("base64") : null, idle_s: Math.round((Date.now() - lastUse) / 1000) };
    }
    case "close":
      setTimeout(() => shutdown(), 50);
      return { closed: true };
    default:
      throw new Error(`action inconnue « ${action} »`);
  }
}

if (existsSync(socketPath)) rmSync(socketPath, { force: true });
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") { res.end(JSON.stringify({ ok: true, pid: process.pid })); return; }
  let body = "";
  for await (const c of req) body += c;
  let out;
  try {
    const cmd = JSON.parse(body || "{}");
    if (cmd.action !== "peek") touch();
    out = { ok: true, result: await run(cmd) };
  } catch (e) {
    out = { ok: false, error: String(e?.message ?? e).split("\n")[0].slice(0, 600) };
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
});
server.listen(socketPath, () => touch());

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await context.close().catch(() => {});
  rmSync(socketPath, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
