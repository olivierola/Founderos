// Browser automation server for AI agents.
// Manages a pool of Playwright browser pages (one per agent session).
// Receives commands via HTTP POST /api/browser and returns DOM snapshots.

import { chromium } from "playwright";
import http from "node:http";
import { RUNNER_TOKEN, ts } from "./env.js";

let browser = null;
const sessions = new Map(); // session_id → { page, lastUsed }
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min idle → cleanup

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    console.log(`[${ts()}] Browser launched`);
  }
  return browser;
}

async function getPage(sessionId) {
  let session = sessions.get(sessionId);
  if (session) {
    session.lastUsed = Date.now();
    return session.page;
  }
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  sessions.set(sessionId, { page, ctx, lastUsed: Date.now() });
  return page;
}

async function closeSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TIMEOUT_MS) {
      await s.ctx.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

// Build a text snapshot of the DOM with numbered refs (same format as test-agent).
async function snapshot(page) {
  return page.evaluate(() => {
    const lines = [];
    let idx = 0;
    const walk = (el) => {
      if (el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "svg", "path"].includes(tag)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const role = el.getAttribute("role") || "";
      const text = (el.textContent || "").trim().slice(0, 80).replace(/\s+/g, " ");
      const value = el.value ?? "";
      const placeholder = el.getAttribute("placeholder") || "";
      const disabled = el.disabled ? " (disabled)" : "";
      const href = el.getAttribute("href") || "";

      const isInteractive = ["a", "button", "input", "select", "textarea"].includes(tag) ||
        role === "button" || role === "link" || el.getAttribute("tabindex") != null;

      if (isInteractive || text) {
        const ref = idx++;
        let desc = `[${ref}] ${tag}`;
        if (role) desc += `:${role}`;
        if (tag === "a" && href) desc += ` href="${href.slice(0, 60)}"`;
        if (tag === "input") desc += `:${el.type || "text"}`;
        if (placeholder) desc += ` "${placeholder}"`;
        if (value) desc += ` value="${String(value).slice(0, 40)}"`;
        if (text && !["input", "select", "textarea"].includes(tag)) desc += ` "${text.slice(0, 60)}"`;
        if (disabled) desc += disabled;
        lines.push(desc);
      }
      for (const child of el.children) walk(child);
    };
    walk(document.body);
    return lines.join("\n");
  });
}

async function handleAction(body) {
  const { session_id = "default", action, url, ref, value, selector } = body;
  const page = await getPage(session_id);

  const locator = (r, sel) => {
    if (typeof r === "number") {
      // Use nth interactive element matching the ref index
      return page.locator(`[data-ref="${r}"], :is(a, button, input, select, textarea):visible`).nth(r);
    }
    if (sel) return page.locator(sel).first();
    throw new Error("No ref or selector provided");
  };

  switch (action) {
    case "navigate":
      if (!url) return { error: "url required" };
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      break;
    case "click":
      await locator(ref, selector).click({ timeout: 5000 });
      await page.waitForTimeout(500);
      break;
    case "fill":
      await locator(ref, selector).fill(value || "", { timeout: 5000 });
      break;
    case "select":
      await locator(ref, selector).selectOption(value || "", { timeout: 5000 });
      break;
    case "scroll":
      await page.mouse.wheel(0, value === "up" ? -400 : 400);
      await page.waitForTimeout(300);
      break;
    case "press":
      await page.keyboard.press(value || "Enter");
      break;
    case "hover":
      await locator(ref, selector).hover({ timeout: 5000 });
      await page.waitForTimeout(300);
      break;
    case "wait":
      await page.waitForTimeout(Math.min(Number(value) || 1000, 5000));
      break;
    case "screenshot": {
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      return { current_url: page.url(), screenshot_base64: buf.toString("base64"), snapshot: await snapshot(page) };
    }
    case "extract_text": {
      const el = locator(ref, selector);
      const text = await el.textContent({ timeout: 5000 });
      return { current_url: page.url(), text: (text || "").trim(), snapshot: await snapshot(page) };
    }
    case "extract_links": {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")].map(a => ({ text: a.textContent?.trim().slice(0, 80), href: a.href })).filter(l => l.href.startsWith("http")).slice(0, 50)
      );
      return { current_url: page.url(), links, snapshot: await snapshot(page) };
    }
    default:
      return { error: `Unknown action: ${action}` };
  }

  return { current_url: page.url(), snapshot: await snapshot(page) };
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

export function startBrowserServer(port = 3847) {
  const server = http.createServer(async (req, res) => {
    // Auth check
    const token = req.headers["x-runner-token"];
    if (token !== RUNNER_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/browser") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const result = await handleAction(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`  browser:   http://localhost:${port}/api/browser`);
  });

  // Cleanup idle sessions every minute
  setInterval(closeSessions, 60000);

  return server;
}
