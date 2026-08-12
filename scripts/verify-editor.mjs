/**
 * Opens the ArtifactEditor harness in a headless browser and reports what
 * survived: blocks mounted vs blocks in the document, console errors, and
 * whether the editor took over from the read-only fallback.
 *
 * Written after "the report goes blank" was diagnosed from source three times
 * and fixed three times without once being observed. The actual cause — a React
 * context boundary, not an Editor.js contract — was invisible to reading and
 * obvious the first time this ran. Run it after touching the editor:
 *
 *     npm run dev        # in another shell
 *     npm run verify:editor
 *
 * Expected: mode "live", editorBlocks equal to harness.expected, errors empty.
 */
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5174/editor-harness.html";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(6000);

const r = await page.evaluate(() => ({
  harness: window.__harness,
  editorBlocks: document.querySelectorAll(".ce-block").length,
  redactorExists: !!document.querySelector(".codex-editor__redactor"),
  fallbackVisible: !!Array.from(document.querySelectorAll("p"))
    .find((p) => p.textContent?.includes("ne s'ouvre pas dans l'éditeur")),
  holderHidden: (() => {
    const h = document.querySelector(".artifact-editor > div");
    return h ? h.className : "(no holder)";
  })(),
  mode: document.querySelector(".artifact-editor")?.dataset.mode,
  visibleText: (document.getElementById("root")?.innerText ?? "").slice(0, 400),
}));

console.log("=== CONSOLE ===");
for (const l of logs) console.log(l);
console.log("=== STATE ===");
console.log(JSON.stringify(r, null, 2));
await browser.close();
