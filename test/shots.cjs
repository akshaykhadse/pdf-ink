// Screenshots of the toolbar at several pane widths (test/out/shot-*.png).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "out");
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>html,body{margin:0;height:100%;background:#1e1e1e;--background-secondary:#262626;--background-primary:#1e1e1e;--text-muted:#999;--text-normal:#ddd;--background-modifier-border:#444;--background-modifier-hover:#333;--interactive-accent:#7c6cff;--text-on-accent:#fff;--radius-s:4px;--radius-m:8px;--font-ui-small:13px;--font-ui-smaller:11px;font-family:system-ui}#leaf{width:1200px;height:700px;position:relative}.view-content{height:100%}</style></head><body><div id="leaf" class="workspace-leaf-content"><div id="content" class="view-content"></div></div><script src="/harness.js"></script></body></html>`;
const files = { "/harness.js": [path.join(out, "harness.js"), "text/javascript"], "/styles.css": [path.join(root, "styles.css"), "text/css"], "/sample.pdf": [path.join(out, "sample.pdf"), "application/pdf"], "/pdfium.wasm": [path.join(root, "pdfium.wasm"), "application/wasm"] };
(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
	await page.route("http://test/**", async (route) => {
		const u = new URL(route.request().url()).pathname;
		if (u === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
		const f = files[u];
		if (!f) return route.fulfill({ status: 404, body: "nf" });
		route.fulfill({ status: 200, contentType: f[1], body: fs.readFileSync(f[0]) });
	});
	await page.goto("http://test/");
	await page.evaluate(() => window.run());
	for (let i = 0; i < 100 && !(await page.evaluate(() => document.querySelectorAll(".pdf-ink-page img").length > 0)); i++) await page.waitForTimeout(100);
	await page.evaluate(() => document.querySelector('.pdf-ink-toolbar [data-tool="pen"]').click());
	await page.waitForTimeout(300);
	await page.screenshot({ path: path.join(out, "shot-1200.png"), clip: { x: 0, y: 0, width: 1200, height: 120 } });
	for (const w of [700, 420, 300]) {
		await page.evaluate((w) => (document.getElementById("leaf").style.width = w + "px"), w);
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.join(out, `shot-${w}.png`), clip: { x: 0, y: 0, width: w, height: 120 } });
		const opt = await page.$('.pdf-ink-toolbar [aria-label="Tool options"]');
		if (opt) {
			await opt.click();
			await page.waitForTimeout(200);
			await page.screenshot({ path: path.join(out, `shot-${w}-options.png`), clip: { x: 0, y: 0, width: w, height: 260 } });
			await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		}
		const more = await page.$(".pdf-ink-more");
		if (more) {
			await more.click();
			await page.waitForTimeout(200);
			await page.screenshot({ path: path.join(out, `shot-${w}-more.png`), clip: { x: 0, y: 0, width: w, height: 400 } });
			await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		}
	}
	await browser.close();
})();
