/**
 * Interaction pass over the harness: click a paragraph, select text in it, and
 * report what the editor actually did — which element took focus, whether a
 * textarea appeared, and whether the inline toolbar showed up.
 */
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5174/editor-harness.html";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector('.artifact-editor[data-mode="live"]', { timeout: 15000 });

const para = page.locator(".ce-paragraph").first();
await para.click();
await page.waitForTimeout(400);

const afterClick = await page.evaluate(() => {
  const a = document.activeElement;
  return {
    activeTag: a?.tagName,
    activeClass: a?.className?.toString().slice(0, 90),
    activeEditable: a?.getAttribute?.("contenteditable"),
    textareasInEditor: document.querySelectorAll(".codex-editor textarea").length,
  };
});

// Select the paragraph's text the way a person would, and look for the toolbar.
await para.evaluate((el) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.waitForTimeout(700);

const afterSelect = await page.evaluate(() => {
  const bar = document.querySelector(".ce-inline-toolbar");
  return {
    inlineToolbarExists: !!bar,
    inlineToolbarShown: !!bar?.classList.contains("ce-inline-toolbar--showed"),
    inlineTools: Array.from(document.querySelectorAll(".ce-inline-toolbar .ce-inline-tool"))
      .map((b) => b.getAttribute("data-tool") ?? b.getAttribute("title") ?? "?"),
  };
});

// What tool owns each block, as Editor.js sees it.
const blockTools = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".ce-block")).map((b) => b.dataset.tool ?? "?"));

console.log(JSON.stringify({ afterClick, afterSelect, blockTools, errors: logs }, null, 2));
await browser.close();
