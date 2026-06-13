// FounderOS Test Runner — agentic E2E execution with Playwright.
//
// Loop:
//   1. claim the next queued test_run (test-runner-poll, mode=claim)
//   2. launch a Chromium page, navigate to the app URL
//   3. observe → send {current_url, dom_excerpt, screenshot_url} to the
//      orchestrator, which returns the next browser action decided by the agent
//   4. execute the action (click/fill/scroll/...); repeat from (3)
//   5. on ask_user → idle-poll until the user answers, then continue
//   6. on pass/fail/terminal → stop
//
// Screenshots are uploaded to the Supabase Storage bucket `test-artifacts`
// (create it as public, or swap for a signed-URL flow) so the live view can
// render the frame the agent acted on.
//
// Env (.env or process env):
//   SUPABASE_URL                 e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    used only for storage uploads
//   RUNNER_TOKEN                 the plaintext runner token (matches ops_settings)
//   RUNNER_ID                    optional, defaults to hostname-pid
//   POLL_INTERVAL_MS             optional, default 3000
//   MAX_STEPS                    optional safety cap per run, default 40

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
const RUNNER_ID = process.env.RUNNER_ID || `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000;
const MAX_STEPS = Number(process.env.MAX_STEPS) || 40;
const POLL_URL = `${SUPABASE_URL}/functions/v1/test-runner-poll`;

if (!SUPABASE_URL || !RUNNER_TOKEN) {
  console.error("SUPABASE_URL and RUNNER_TOKEN are required.");
  process.exit(1);
}
const storage = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null;

const ts = () => new Date().toISOString();

async function rpc(body) {
  const res = await fetch(POLL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Runner-Token": RUNNER_TOKEN },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

// Capture a screenshot, upload to storage, return a public URL (or null).
async function snapshot(page, runId, idx) {
  try {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    if (!storage) return null;
    const path = `${runId}/${String(idx).padStart(4, "0")}.png`;
    const { error } = await storage.storage.from("test-artifacts").upload(path, buf, {
      contentType: "image/png", upsert: true,
    });
    if (error) return null;
    return storage.storage.from("test-artifacts").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

// A compact, agent-friendly DOM/accessibility excerpt: interactive elements
// with their text + key attributes, plus visible headings.
async function domExcerpt(page) {
  return await page.evaluate(() => {
    const out = [];
    const sel = "a,button,input,textarea,select,[role=button],[role=link],h1,h2,h3,label,[aria-label]";
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 250)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue; // skip hidden
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80);
      const id = el.id ? `#${el.id}` : "";
      const name = el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : "";
      const type = el.getAttribute("type") ? `type=${el.getAttribute("type")}` : "";
      const line = `<${tag}${id}${name} ${type}> ${text}`.replace(/\s+/g, " ").trim();
      if (!seen.has(line)) { seen.add(line); out.push(line); }
    }
    return out.join("\n").slice(0, 8000);
  });
}

// Resolve a selector that may be CSS or human text; fall back to text=.
function locator(page, selector) {
  if (!selector) return null;
  // If it looks like CSS (starts with #/./[/tag), use it directly.
  if (/^[#.\[a-zA-Z]/.test(selector) && /[#.\[\]=>:]/.test(selector)) {
    try { return page.locator(selector).first(); } catch { /* fall through */ }
  }
  return page.getByText(selector, { exact: false }).first();
}

async function execAction(page, action) {
  switch (action.type) {
    case "navigate":
      await page.goto(action.value, { waitUntil: "domcontentloaded", timeout: 30000 });
      break;
    case "click": {
      const loc = locator(page, action.selector);
      if (loc) await loc.click({ timeout: 10000 });
      break;
    }
    case "fill": {
      const loc = locator(page, action.selector);
      if (loc) await loc.fill(String(action.value ?? ""), { timeout: 10000 });
      break;
    }
    case "select": {
      const loc = locator(page, action.selector);
      if (loc) await loc.selectOption(String(action.value ?? ""));
      break;
    }
    case "press": {
      const loc = action.selector ? locator(page, action.selector) : page;
      await loc.press(action.key || "Enter");
      break;
    }
    case "scroll":
      await page.mouse.wheel(0, (action.direction === "up" ? -1 : 1) * (action.amount || 600));
      break;
    case "wait":
      await page.waitForTimeout(Math.min(action.amount || 800, 5000));
      break;
    case "assert":
      // Soft assert: the agent reads the next DOM excerpt to confirm.
      break;
    default:
      break;
  }
  // Let the SPA settle after an action.
  await page.waitForTimeout(700);
}

async function runOne(claimed) {
  const { id: runId, app_url } = claimed;
  console.log(`[${ts()}] Run ${runId.slice(0, 8)} — ${app_url}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let idx = 0;

  try {
    await page.goto(app_url, { waitUntil: "domcontentloaded", timeout: 30000 });

    for (let step = 0; step < MAX_STEPS; step++) {
      const screenshot_url = await snapshot(page, runId, idx++);
      const dom = await domExcerpt(page);
      const { action, terminal, paused } = await rpc({
        mode: "observe",
        run_id: runId,
        current_url: page.url(),
        dom_excerpt: dom,
        screenshot_url,
      });
      console.log(`  → ${action?.type}${action?.selector ? ` ${action.selector}` : ""}`);

      if (terminal) break;

      if (paused || action?.type === "ask_user") {
        // Idle-poll until the user answers (orchestrator re-queues → resumed).
        let resumed = false;
        for (let i = 0; i < 600 && !resumed; i++) { // up to ~30 min
          await new Promise((r) => setTimeout(r, 3000));
          const p = await rpc({ mode: "poll", run_id: runId });
          resumed = p.resumed;
          if (p.status && ["passed", "failed", "error", "cancelled"].includes(p.status)) { resumed = false; break; }
        }
        if (!resumed) break;
        continue;
      }

      try {
        await execAction(page, action);
      } catch (e) {
        await rpc({ mode: "observe", run_id: runId, current_url: page.url(),
          dom_excerpt: `ACTION ERROR: ${e.message}\n` + (await domExcerpt(page).catch(() => "")) });
      }
    }
  } catch (e) {
    console.error(`  run error: ${e.message}`);
    await rpc({ mode: "complete", run_id: runId, status: "error", error_message: e.message }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pollOnce() {
  try {
    const { run } = await rpc({ mode: "claim", runner_id: RUNNER_ID });
    if (!run) return false;
    await runOne(run);
    return true;
  } catch (e) {
    console.error(`[${ts()}] Poll error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log("FounderOS Test Runner starting");
  console.log(`  runner_id: ${RUNNER_ID}`);
  console.log(`  url:       ${SUPABASE_URL}`);
  while (true) {
    const didWork = await pollOnce();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
main();
