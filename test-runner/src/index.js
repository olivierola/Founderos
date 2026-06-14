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

let warnedNoStorage = false;
// Capture a screenshot, upload to storage, return a public URL (or null).
async function snapshot(page, runId, idx) {
  try {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    if (!storage) {
      if (!warnedNoStorage) {
        console.warn("  [screenshots] SUPABASE_SERVICE_ROLE_KEY not set — the live view will show 'No frame captured'.");
        warnedNoStorage = true;
      }
      return null;
    }
    const path = `${runId}/${String(idx).padStart(4, "0")}.png`;
    const { error } = await storage.storage.from("test-artifacts").upload(path, buf, {
      contentType: "image/png", upsert: true,
    });
    if (error) {
      console.warn(`  [screenshots] upload failed: ${error.message}`);
      return null;
    }
    return storage.storage.from("test-artifacts").getPublicUrl(path).data.publicUrl;
  } catch (e) {
    console.warn(`  [screenshots] ${e.message}`);
    return null;
  }
}

// Wait for an SPA to actually render: network to settle, then for some
// interactive content (or visible text) to exist. Avoids the agent acting on
// an empty DOM right after domcontentloaded (React/Vue hasn't hydrated yet).
async function waitForReady(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 12000 });
  } catch { /* keep going — some apps keep long-poll connections open */ }
  try {
    await page.waitForFunction(() => {
      const hasControls = document.querySelector("input,button,a,textarea,select,[role=button]");
      const hasText = (document.body?.innerText || "").trim().length > 20;
      return !!hasControls || hasText;
    }, { timeout: 12000 });
  } catch { /* proceed with whatever rendered */ }
  // Small settle for late layout.
  await page.waitForTimeout(400);
}

// Build an indexed, agent-friendly snapshot. Each VISIBLE interactive element
// gets a stable ref number written onto the element as data-e2e-ref, so the
// agent can act by ref (e.g. {"ref": 12}) instead of guessing CSS selectors.
// Returns a numbered listing the agent reads.
async function domExcerpt(page) {
  return await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-e2e-ref]")) el.removeAttribute("data-e2e-ref");

    const explicit = "a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[onclick],[tabindex],[data-testid],[data-test],[data-cy],[contenteditable='true']";
    // Laid-out & not display:none/visibility:hidden. We intentionally KEEP
    // opacity:0 elements (commonly revealed on hover) and flag them instead.
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < 0 || r.top > (innerHeight + 1200)) return false; // skip far off-screen
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    // True when an element is in the DOM/layout but currently invisible because
    // it's gated behind a hover (opacity 0). The agent should hover its parent.
    const isHoverHidden = (el) => {
      const st = getComputedStyle(el);
      if (Number(st.opacity) === 0) return true;
      // group-hover / hover: utility classes that hide until hovered.
      const cls = (el.getAttribute("class") || "") + " " + (el.parentElement?.getAttribute("class") || "");
      return /\bopacity-0\b/.test(cls) && /group-hover:opacity-100|hover:opacity-100/.test(cls);
    };
    // Find a sensible ref-bearing ancestor to hover to reveal this element.
    const hoverHandleOf = (el) => {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
        if (p.hasAttribute?.("data-e2e-ref")) return p.getAttribute("data-e2e-ref");
        const cls = p.getAttribute?.("class") || "";
        if (/\bgroup\b/.test(cls)) return p.getAttribute("data-e2e-ref"); // may be null; still a hint
      }
      return null;
    };
    // A test id, if present on the element or a close ancestor — the most stable
    // hook the agent can reference.
    const testIdOf = (el) => {
      let p = el;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const t = p.getAttribute?.("data-testid") || p.getAttribute?.("data-test") || p.getAttribute?.("data-cy");
        if (t) return t;
      }
      return "";
    };
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    // Resolve text from another element referenced by id (aria-labelledby/-describedby).
    const refText = (ids) => {
      if (!ids) return "";
      for (const id of ids.split(/\s+/)) {
        const t = document.getElementById(id);
        if (t) { const v = clean(t.innerText || t.getAttribute("aria-label")); if (v) return v; }
      }
      return "";
    };
    // Lucide icons render <svg class="lucide lucide-settings ...">; derive a name.
    const iconName = (el) => {
      const svg = el.matches?.("svg") ? el : el.querySelector?.("svg");
      if (!svg) return "";
      const cls = svg.getAttribute("class") || "";
      const m = cls.match(/lucide-([a-z0-9-]+)/i);
      if (m) return m[1].replace(/-/g, " ");
      const title = svg.querySelector?.("title");
      return clean(title?.textContent);
    };
    // A human-meaningful hint from an href path, e.g. /app/x/y/devops -> "devops".
    const hrefHint = (el) => {
      const href = el.getAttribute?.("href");
      if (!href || href === "#") return "";
      try {
        const path = href.startsWith("http") ? new URL(href).pathname : href;
        const seg = path.split("?")[0].split("/").filter(Boolean).pop();
        return seg && !/^[0-9a-f-]{12,}$/i.test(seg) ? seg.replace(/-/g, " ") : "";
      } catch { return ""; }
    };
    const labelOf = (el) => {
      // 1) Direct accessible name / text.
      let base = clean(
        el.getAttribute("aria-label") ||
        refText(el.getAttribute("aria-labelledby")) ||
        el.getAttribute("placeholder") ||
        (el.tagName === "INPUT" ? "" : el.innerText) ||
        el.value ||
        el.getAttribute("title") ||
        refText(el.getAttribute("aria-describedby")) ||
        el.getAttribute("alt") ||
        el.getAttribute("name"),
      );
      // 2) Borrow an accessible name / title from a close ancestor (icon wrapped
      //    in a labelled link/button).
      if (!base) {
        let p = el.parentElement;
        for (let i = 0; i < 3 && p && !base; i++, p = p.parentElement) {
          base = clean(p.getAttribute?.("aria-label") || p.getAttribute?.("title") || refText(p.getAttribute?.("aria-labelledby")));
        }
      }
      // 3) Look inside for a title / aria-label / image alt.
      if (!base) {
        const inner = el.querySelector?.("[aria-label],[title],img[alt]");
        if (inner) base = clean(inner.getAttribute("aria-label") || inner.getAttribute("title") || inner.getAttribute("alt"));
      }
      // 4) Derive from the link target path.
      if (!base) base = hrefHint(el);
      // 5) Last resort for icon-only controls: name the icon so the agent has a
      //    semantic hook (e.g. "settings", "trash", "plus").
      if (!base) { const ic = iconName(el); if (ic) base = ic + " (icon)"; }
      return base.slice(0, 90);
    };

    // Candidate set: explicit controls + elements that LOOK clickable (React
    // attaches onClick without an [onclick] attribute, so use cursor:pointer).
    const candidates = new Set(document.querySelectorAll(explicit));
    for (const el of document.querySelectorAll("div,li,article,section,span,label,tr")) {
      if (getComputedStyle(el).cursor === "pointer") candidates.add(el);
    }

    // Keep only the OUTERMOST clickable in a nesting chain, and only visible
    // ones with a usable label. Sort by document order.
    const all = Array.from(candidates).filter(isVisible);
    const chosen = [];
    for (const el of all) {
      // Drop if an ancestor is also a candidate (avoid duplicate inner refs)…
      let p = el.parentElement, nestedInside = false;
      while (p) { if (candidates.has(p)) { nestedInside = true; break; } p = p.parentElement; }
      if (nestedInside) continue;
      const label = labelOf(el);
      if (!label && !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) continue;
      chosen.push(el);
    }
    chosen.sort((a, b) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1,
    );

    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const type = el.getAttribute("type");
      const kind = type ? `${tag}:${type}` : role ? `${tag}[${role}]` : tag;
      const tid = testIdOf(el);
      // Extra hooks the agent can use to disambiguate icon-only controls:
      // a test id, a tooltip/title distinct from the label, and the link target.
      const title = clean(el.getAttribute("title"));
      const lbl = labelOf(el);
      const href = hrefHint(el);
      let meta = tid ? ` {testid:${tid}}` : "";
      if (title && title !== lbl) meta += ` {title:${title.slice(0, 40)}}`;
      if (href && !lbl.includes(href)) meta += ` {to:${href}}`;
      // Current value of form fields, so the agent KNOWS a field is already
      // filled and doesn't re-fill it in a loop. Mask password values.
      let val = "";
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const v = (el.value ?? "").trim();
        if (v) val = type === "password" ? ` value="••••(${v.length})"` : ` value="${v.slice(0, 40)}"`;
        else val = " value=(empty)";
        if (el.checked !== undefined && (type === "checkbox" || type === "radio")) {
          val = el.checked ? " (checked)" : " (unchecked)";
        }
      }
      const state =
        el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true"
          ? " (selected)"
          : el.disabled || el.getAttribute("aria-disabled") === "true"
            ? " (disabled)"
            : "";
      return `${kind} "${lbl}"${val}${meta}${state}`;
    };

    const picked = chosen.slice(0, 200);
    // Pass 1: assign refs to all picked elements first so hover hints can point
    // at a parent's ref.
    picked.forEach((el, i) => el.setAttribute("data-e2e-ref", String(i)));
    // Pass 2: describe, flagging hover-revealed items with how to reveal them.
    const lines = picked.map((el, i) => {
      let extra = "";
      if (isHoverHidden(el)) {
        const handle = hoverHandleOf(el);
        extra = handle != null ? ` (hidden — hover ref ${handle} to reveal)` : " (hidden until hover)";
      }
      return `[${i}] ${describe(el)}${extra}`;
    });

    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .filter(isVisible).slice(0, 8)
      .map((h) => `# ${h.innerText.trim().slice(0, 80)}`);

    const out = [];
    if (headings.length) out.push("HEADINGS:", ...headings, "");
    out.push("INTERACTIVE ELEMENTS (act with \"ref\"):", ...lines);
    return out.join("\n").slice(0, 9000);
  });
}

// Resolve a target. Prefer the ref number (rock-solid); fall back to a CSS
// selector or visible text only if no ref was given.
function resolveTarget(page, action) {
  if (action.ref !== undefined && action.ref !== null && action.ref !== "") {
    return page.locator(`[data-e2e-ref="${String(action.ref).replace(/"/g, "")}"]`).first();
  }
  const sel = action.selector;
  if (!sel) return null;
  if (/^[#.\[a-zA-Z]/.test(sel) && /[#.\[\]=>:]/.test(sel)) {
    try { return page.locator(sel).first(); } catch { /* fall through */ }
  }
  return page.getByText(sel, { exact: false }).first();
}

async function execAction(page, action) {
  switch (action.type) {
    case "navigate":
      await page.goto(action.value, { waitUntil: "domcontentloaded", timeout: 30000 });
      break;
    case "click": {
      const loc = resolveTarget(page, action);
      if (!loc) throw new Error("click: no ref or selector");
      await loc.click({ timeout: 10000 });
      break;
    }
    case "fill": {
      const loc = resolveTarget(page, action);
      await loc.fill(String(action.value ?? ""), { timeout: 10000 });
      break;
    }
    case "select": {
      const loc = resolveTarget(page, action);
      if (!loc) throw new Error("select: no ref or selector");
      await loc.selectOption(String(action.value ?? ""));
      break;
    }
    case "press": {
      const loc = (action.ref !== undefined || action.selector) ? resolveTarget(page, action) : page;
      await loc.press(action.key || "Enter");
      break;
    }
    case "hover": {
      // Reveal elements that only appear on hover (dropdowns, row actions,
      // submenus). The next snapshot will include what hovering exposed.
      const loc = resolveTarget(page, action);
      if (!loc) throw new Error("hover: no ref or selector");
      await loc.hover({ timeout: 10000 });
      await page.waitForTimeout(400); // let the reveal animation play
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
  // Let the SPA settle (and re-render) after an action.
  await waitForReady(page);
}

async function runOne(claimed) {
  if (!claimed || !claimed.id) {
    console.warn(`[${ts()}] Claimed run missing id; skipping:`, JSON.stringify(claimed));
    return;
  }
  const { id: runId, app_url } = claimed;
  console.log(`[${ts()}] Run ${String(runId).slice(0, 8)} — ${app_url}`);
  const browser = await chromium.launch({ headless: true });
  // Wide viewport (16:10) so the captured frame matches the preview area and
  // fills its width without letterboxing.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let idx = 0;

  // Carry a note about the previous action's failure into the next observation
  // so the agent stops repeating an action that can't be performed.
  let actionError = null;

  // Wait (idle-poll) for the run to be re-queued after it finished or paused,
  // WITHOUT closing the browser — so a follow-up instruction continues from the
  // current page (logged in, same screen) instead of reloading the app.
  // Returns true if resumed, false if abandoned/timed out.
  async function waitForResume() {
    for (let i = 0; i < 600; i++) { // up to ~30 min
      await new Promise((r) => setTimeout(r, 3000));
      const p = await rpc({ mode: "poll", run_id: runId }).catch(() => ({}));
      if (p.resumed) return true;
      if (p.status === "cancelled" || p.status === "error") return false;
    }
    return false;
  }

  try {
    await page.goto(app_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForReady(page);

    // Per-segment step budget that resets whenever the user resumes the run, so
    // a continued session isn't cut off by the initial cap.
    let step = 0;
    while (true) {
      if (step >= MAX_STEPS) {
        // Hit the budget — pause and wait for a human nudge rather than stopping.
        await rpc({ mode: "observe", run_id: runId, current_url: page.url(),
          dom_excerpt: "STEP BUDGET REACHED — pausing for the user." }).catch(() => {});
      }
      const screenshot_url = await snapshot(page, runId, idx++);
      let dom = await domExcerpt(page);
      if (actionError) {
        dom = `PREVIOUS ACTION FAILED: ${actionError}\n(adjust your approach — pick a different selector or step)\n\n${dom}`;
        actionError = null;
      }
      const { action, terminal, paused } = await rpc({
        mode: "observe",
        run_id: runId,
        current_url: page.url(),
        dom_excerpt: dom,
        screenshot_url,
      });
      console.log(`  → ${action?.type}${action?.ref !== undefined ? ` ref=${action.ref}` : action?.selector ? ` ${action.selector}` : ""}${action?.reason ? `  (${action.reason})` : ""}`);

      // Terminal or paused → keep the browser open and wait for a resume. If the
      // user sends a new instruction, continue IN THE SAME PAGE (no reload).
      if (terminal || paused || action?.type === "ask_user") {
        const resumed = await waitForResume();
        if (!resumed) break;
        step = 0;              // fresh budget for the new instruction
        actionError = null;
        await waitForReady(page).catch(() => {});
        continue;
      }

      try {
        await execAction(page, action);
      } catch (e) {
        console.log(`    action failed: ${e.message}`);
        actionError = `${action?.type} ${action?.selector ?? ""} — ${e.message}`.trim();
        await waitForReady(page).catch(() => {});
      }
      step++;
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
    const resp = await rpc({ mode: "claim", runner_id: RUNNER_ID });
    const run = resp?.run ?? null;
    if (!run) return false;
    await runOne(run);
    return true;
  } catch (e) {
    console.error(`[${ts()}] Poll error: ${e.message}`);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
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
