import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertSafe } from "./scan.mjs";

const [base = "http://127.0.0.1:6017", outputArg, onlyArg] = process.argv.slice(2);
if (!outputArg) throw new Error("Usage: node scripts/portfolio-screens/capture.mjs <owned-storybook-url> <output-directory> [scene-name,...]");
const origin = new URL(base).origin;
if (new URL(base).hostname !== "127.0.0.1" || ["3100", "3101"].includes(new URL(base).port)) throw new Error("Use an owned loopback Storybook port");
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const sharpPackage = (await readdir(resolve(root, "node_modules/.pnpm"))).find(name => name.startsWith("sharp@"));
if (!sharpPackage) throw new Error("Installed image converter is missing");
const sharp = require(resolve(root, "node_modules/.pnpm", sharpPackage, "node_modules/sharp"));
const fixtureFiles = ["ui/storybook/stories/agent-chat/portfolio-screens.stories.tsx", ...await readdir(resolve(root, "ui/storybook/stories/portfolio")).then(files => files.map(name => `ui/storybook/stories/portfolio/${name}`))];
for (const file of fixtureFiles) assertSafe(await readFile(resolve(root, file), "utf8"), file);
const scenes = [
  ["01-agent-chat", "agent-chat", "chat", "main agent 對話、進行中與完成的 worker 任務，以及原生 subagent 卡。", "A main agent conversation with active and completed worker tasks and a native subagent card."],
  ["02-todo", "todo", "todo", "目標、完成進度、需要人決定的事項、待辦與近期完成項目。", "A goal, completion progress, human input, open work and recently finished items."],
  ["03-questions", "questions-and-approvals", "questions", "Worker 的問題由 main agent 代答；對外公開仍需人的確認。", "The main agent answers a worker question; sharing a preview still requires human confirmation."],
  ["04-worker-policy", "worker-policy", "workers", "預設 Codex worker 與 Claude Sonnet worker 的模型、權限與用途設定。", "Model, permission and purpose settings for a default Codex worker and a Claude Sonnet worker."],
  ["05-dashboard-costs", "dashboard-costs", "costs", "虛構的模型成本占比、專案用量與訂閱剩餘額度。", "Fictional model cost shares, project usage and remaining subscription quotas."],
  ["06-artifacts", "artifacts-wall", "artifacts", "可檢視的工作成果，包含 PDF 第一頁縮圖與三張示意圖片。", "Reviewable work products with a first-page PDF thumbnail and three sample images."],
];
const requiredText = {
  chat: ["In progress", "Completed", "Native subagent"], todo: ["Needs you", "To do", "Recently finished"],
  questions: ["Responsive grid", "Approve preview", "Human confirmation"], workers: ["Workers", "Default", "Save workers"],
  costs: ["Claude Opus", "Project usage", "mobile-client", "82% remaining"], artifacts: ["Release brief.pdf", "Mobile preview.svg"],
};
const only = onlyArg?.split(",");
if (only?.some(name => !scenes.some(scene => scene[0] === name))) throw new Error("Unknown scene selection");
const results = only ? JSON.parse(await readFile(resolve(output, "verification.json"), "utf8")).results.filter(row => !only.some(name => row.file.startsWith(`${name}-`))) : [];
const ocrAvailable = spawnSync("tesseract", ["--version"], { encoding: "utf8" }).status === 0;
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, story, screen] of scenes.filter(scene => !only || only.includes(scene[0]))) for (const [device, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [], blocked = [];
    context.on("page", opened => { if (opened !== page) errors.push("Unexpected popup"); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith("/api/")) { blocked.push(url.pathname); return route.abort("blockedbyclient"); }
      return route.continue();
    });
    await context.routeWebSocket(/.*/, ws => {
      const url = new URL(ws.url());
      if (url.host === new URL(origin).host && !url.pathname.startsWith("/api/")) ws.connectToServer();
      else { blocked.push(url.pathname); ws.close(); }
    });
    await page.clock.install({ time: new Date("2026-01-15T10:00:00Z") });
    await page.goto(`${origin}/iframe.html?id=portfolio-screens--${story}&viewMode=story&globals=theme:${theme}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(`[data-portfolio-ready="${screen}"]`).waitFor({ timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    for (const text of requiredText[screen]) await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor();
    if (screen === "workers") {
      for (const [index, model] of [[1, "Codex (GPT)"], [2, "Claude Sonnet"]]) {
        if (await page.getByLabel(`Worker ${index} model`, { exact: true }).inputValue() !== model) throw new Error("Missing worker model");
      }
    }
    if (screen === "artifacts") await page.locator('img[src^="data:image/jpeg"]').waitFor({ timeout: 45000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".portfolio-shell img")].every(img => img.complete && img.naturalWidth > 0));
    const text = await page.locator("body").innerText();
    const dom = await page.locator(".portfolio-shell").evaluate(el => el.outerHTML);
    assertSafe(text, `${name}/${device}/${theme} text`);
    assertSafe(dom, `${name}/${device}/${theme} DOM`);
    if (/loading|unexpected|something went wrong|could not load/i.test(text)) throw new Error(`${name}: unfinished or failed content`);
    if (errors.length || blocked.length) throw new Error(JSON.stringify({ name, errors, blocked }));
    const layout = await page.locator(".portfolio-shell").evaluate(el => {
      const main = el.querySelector("main");
      return { width: document.documentElement.scrollWidth, height: Math.ceil(main.getBoundingClientRect().bottom), viewport: innerHeight,
        spinners: [...el.querySelectorAll('.animate-spin,[aria-busy="true"]')].filter(node => node.getClientRects().length).length };
    });
    if (layout.width > width || layout.height > height || layout.spinners) throw new Error(`${name}/${device}: clipped layout ${JSON.stringify(layout)}`);
    const stem = `${name}-${device}-${theme}`;
    const png = resolve(output, `${stem}.png`);
    await page.screenshot({ path: png, animations: "disabled" });
    await sharp(png).webp({ quality: 85 }).toFile(resolve(output, `${stem}.webp`));
    if (ocrAvailable) {
      const ocr = spawnSync("tesseract", [png, "stdout"], { encoding: "utf8" });
      if (ocr.status !== 0) throw new Error(`OCR failed for ${stem}: ${ocr.stderr}`);
      assertSafe(ocr.stdout, `${stem} OCR`);
    }
    results.push({ file: `${stem}.png`, width, height, source: "component-story", domScan: "pass", networkRequestsOutsideStorybook: blocked.length, layout, ocr: ocrAvailable ? "pass" : "unavailable; visual review required" });
    results.sort((a, b) => a.file.localeCompare(b.file));
    await writeFile(resolve(output, "verification.json"), JSON.stringify({ source: "Storybook component compositions", fixtureFiles, results }, null, 2) + "\n");
    await writeFile(resolve(output, `${stem}.dom.txt`), text + "\n");
    console.log(`Captured ${stem}`);
    await context.close();
  }
} finally { await browser.close(); }
if (results.length !== 24) throw new Error(`Incomplete collection: ${results.length}/24 captures; finish missing scenes before delivery`);
await writeFile(resolve(output, "captions.md"), "所有畫面均為使用正式元件的 Storybook 假資料組合；非正式實例截圖。\nAll screens are fictional Storybook compositions of shipped components, not live-instance screenshots.\n\n" + scenes.map(([name, , , zh, en]) => `${name}\n${zh}\n${en}\n`).join("\n"));
const thumbs = [];
for (let i = 0; i < results.length; i++) {
  const png = resolve(output, results[i].file);
  const thumb = await sharp(png).resize({ width: 360, height: 240, fit: "contain", background: "#d9dfe7" }).png().toBuffer();
  thumbs.push({ input: thumb, left: (i % 4) * 360, top: Math.floor(i / 4) * 240 });
}
await sharp({ create: { width: 1440, height: 1440, channels: 3, background: "#d9dfe7" } }).composite(thumbs).png().toFile(resolve(output, "contact-sheet.png"));
console.log(`Verified ${results.length} PNG + ${results.length} WebP; OCR ${ocrAvailable ? "passed" : "unavailable"}.`);
