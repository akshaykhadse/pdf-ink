// End-to-end checks in headless Chromium: open a PDF, draw with the pen, keep
// fingers from drawing, pinch, erase, undo, save, reopen.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "out");
fs.mkdirSync(out, { recursive: true });

/** A simple PDF with `pages` pages of Helvetica text, written by hand. */
function makePdf(pages) {
	const objs = [];
	const add = (body) => objs.push(body) && objs.length;
	add("<< /Type /Catalog /Pages 2 0 R >>");
	add(""); // pages, filled in below
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids = [];
	for (let i = 0; i < pages; i++) {
		let text = `BT /F1 24 Tf 60 760 Td (Page ${i + 1} of ${pages}) Tj ET\n`;
		// Two tightly leaded lines (24 pt type on a 22 pt pitch) whose font boxes overlap.
		text += `BT /F1 24 Tf 300 800 Td (Tight one) Tj ET\nBT /F1 24 Tf 300 778 Td (Tight two) Tj ET\n`;
		for (let l = 0; l < 20; l++) text += `BT /F1 12 Tf 60 ${700 - l * 28} Td (Line ${l + 1}: the quick brown fox jumps over the lazy dog.) Tj ET\n`;
		const content = add(`<< /Length ${text.length} >>\nstream\n${text}endstream`);
		kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	}
	objs[1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`;
	let pdf = "%PDF-1.4\n";
	const offsets = [];
	objs.forEach((o, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}
fs.writeFileSync(path.join(out, "sample.pdf"), makePdf(3));
fs.writeFileSync(path.join(out, "long.pdf"), makePdf(30));

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>html,body{margin:0;height:100%;--background-secondary:#eee;--background-primary-alt:#ddd;--text-muted:#555;--text-normal:#111;--background-modifier-border:#ccc;--background-modifier-hover:#ddd;--interactive-accent:#36f;--radius-s:4px;--font-ui-small:12px}#leaf{width:1200px;height:1300px}.view-content{height:100%}</style></head><body><div id="leaf"><div id="content" class="view-content"></div></div><script src="/harness.js"></script></body></html>`;
const files = {
	"/harness.js": [path.join(out, "harness.js"), "text/javascript"],
	"/styles.css": [path.join(root, "styles.css"), "text/css"],
	"/sample.pdf": [path.join(out, "sample.pdf"), "application/pdf"],
	"/long.pdf": [path.join(out, "long.pdf"), "application/pdf"],
	"/pdfium.wasm": [path.join(root, "pdfium.wasm"), "application/wasm"],
};

(async () => {
	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1200, height: 1300 }, hasTouch: true });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	page.on("console", (m) => {
		if (m.type() === "error" || m.text().startsWith("NOTICE:")) console.log("[console]", m.text().slice(0, 200));
	});
	page.on("pageerror", (e) => console.log("[pageerror]", e.message));
	page.on("requestfailed", (r) => console.log("[requestfailed]", r.url().slice(0, 120)));
	await page.route("http://test/**", async (route) => {
		const u = new URL(route.request().url()).pathname;
		if (u === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
		const f = files[u];
		if (!f) return route.fulfill({ status: 404, body: "nf " + u });
		route.fulfill({ status: 200, contentType: f[1], body: fs.readFileSync(f[0]) });
	});
	let failed = false;
	const check = (name, ok, detail) => {
		console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ": " + detail : ""}`);
		if (!ok) failed = true;
	};
	const api = (expr) =>
		page.evaluate((e) => {
			const h = window.view.handle;
			const reg = h.registry;
			const id = h.documentId;
			const ann = reg.getPlugin("annotation").provides().forDocument(id);
			const zoom = reg.getPlugin("zoom").provides().forDocument(id);
			const scroll = reg.getPlugin("scroll").provides().forDocument(id);
			return eval(e);
		}, expr);
	const ready = async () => {
		for (let i = 0; i < 200; i++) {
			if (await page.evaluate(() => !!window.view?.handle && document.querySelectorAll(".pdf-ink-page img").length > 0)) return true;
			await page.waitForTimeout(100);
		}
		return false;
	};
	const pageRect = (index = 0) => page.evaluate((i) => document.querySelector(`.pdf-ink-page[data-page-index="${i}"]`)?.getBoundingClientRect().toJSON(), index);
	const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
	const stroke = async (x, y) => {
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 8, y + (i % 2) * 10);
		await page.mouse.up();
		await page.waitForTimeout(1200);
	};
	const count = () => api(`ann.getAnnotations().length`);
	const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y]) => ({ x, y, radiusX: 10, radiusY: 10 })) });
	const scrollTop = () => page.evaluate(() => document.querySelector(".pdf-ink-viewport").scrollTop);

	await page.goto("http://test/");
	const t0 = Date.now();
	const ran = await page.evaluate(() => window.run());
	const up = await ready();
	console.log("opened in", Date.now() - t0, "ms");
	check("the view opens a PDF and renders pages", ran === "ok" && up);
	const r0 = await pageRect(0);
	check("the first page fits the leaf width", r0 && Math.abs(r0.width - (1200 - 24)) < 1 && r0.x >= 12, JSON.stringify(r0));
	// Select mode: a finger scrolls natively (EmbedPDF's touch-action none is overridden).
	await page.evaluate(() => (document.querySelector(".pdf-ink-viewport").scrollTop = 0));
	await touch("touchStart", [[600, 900]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[600, 900 - i * 40]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(600);
	const selScroll = await scrollTop();
	check("in select mode a finger scrolls the pages", selScroll > 100, `scrollTop ${selScroll}`);
	await page.evaluate(() => (document.querySelector(".pdf-ink-viewport").scrollTop = 0));
	await page.waitForTimeout(300);

	// Text highlight: select text with the pointer while the text-highlight tool is on.
	await click(".pdf-ink-text-highlight");
	await page.waitForTimeout(100);
	{
		// "Page 1 of 3" sits at PDF (60, 760) in 24 pt Helvetica; y down from the top = 842 - 760.
		const z = r0.width / 595;
		const ty = r0.y + (842 - 766) * z, tx0 = r0.x + 55 * z, tx1 = r0.x + 200 * z;
		await page.mouse.move(tx0, ty);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(tx0 + ((tx1 - tx0) * i) / 8, ty);
		await page.mouse.up();
		await page.waitForTimeout(600);
	}
	const hl = await api(`ann.getAnnotations().map((a) => [a.object.type, a.object.color, a.object.segmentRects?.length])`);
	check("selecting text with the text-highlight tool creates a highlight", hl.length === 1 && hl[0][0] === 9 && hl[0][2] >= 1, JSON.stringify(hl));
	{
		// The eraser removes it too.
		await click(".pdf-ink-toolbar [aria-label^='Eraser']");
		await page.waitForTimeout(50);
		const z = r0.width / 595;
		const ty = r0.y + (842 - 766) * z, tx = r0.x + 100 * z;
		await page.mouse.move(tx, ty - 40);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(tx, ty - 40 + i * 10);
		await page.mouse.up();
		await page.waitForTimeout(300);
	}
	const hlLeft = await count();
	check("the eraser removes a text highlight", hlLeft === 0, String(hlLeft));
	await click(".pdf-ink-toolbar [aria-label^='Eraser']");
	// Two separate highlights on tightly leaded lines meet instead of stacking.
	await click(".pdf-ink-text-highlight");
	await page.waitForTimeout(100);
	for (const base of [800, 778]) {
		const z = r0.width / 595;
		const ty = r0.y + (842 - base - 7) * z, tx0 = r0.x + 295 * z, tx1 = r0.x + 400 * z;
		await page.mouse.move(tx0, ty);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(tx0 + ((tx1 - tx0) * i) / 8, ty);
		await page.mouse.up();
		await page.waitForTimeout(600);
	}
	const tight = await api(`ann.getAnnotations().map((a) => a.object.segmentRects.map((r) => [r.origin.y, r.origin.y + r.size.height])).flat().sort((a, b) => a[0] - b[0])`);
	check("highlights on adjacent tight lines do not overlap", tight.length === 2 && tight[0][1] <= tight[1][0] + 0.01 && tight[0][1] > tight[0][0] && tight[1][1] > tight[1][0], JSON.stringify(tight));
	await api(`ann.getAnnotations().forEach((a) => ann.deleteAnnotation(a.object.pageIndex, a.object.id))`);
	await page.waitForTimeout(300);
	await click(".pdf-ink-text-highlight");

	// Pen: a toolbar swatch picks the ink tool in that colour, a stroke becomes an annotation.
	const color = await page.evaluate(() => {
		const b = document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch")[1];
		b.click();
		return b.querySelector(".pdf-ink-dot").style.background;
	});
	await page.waitForTimeout(100);
	const tool = await api(`[ann.getActiveTool()?.id, reg.getPlugin("annotation").provides().getTool("ink").defaults.strokeColor]`);
	check("a pen swatch activates the ink tool in that colour", tool[0] === "ink" && cssColor(tool[1]) === color, JSON.stringify([tool, color]));
	const x = r0.x + r0.width / 2, y = r0.y + r0.height / 3;
	await stroke(x, y);
	const n1 = await count();
	const dirty1 = await page.evaluate(() => window.view.dirty);
	check("a pen stroke becomes an ink annotation and marks the file dirty", n1 === 1 && dirty1 === true, `${n1}, dirty ${dirty1}`);
	// The 11 pointer samples of that zigzag are resampled along a spline through them.
	const smooth = await api(`(() => {
		const o = ann.getAnnotations()[0].object;
		const pts = o.inkList[0].points;
		const inside = pts.every((p) => p.x >= o.rect.origin.x && p.y >= o.rect.origin.y && p.x <= o.rect.origin.x + o.rect.size.width && p.y <= o.rect.origin.y + o.rect.size.height);
		return { n: pts.length, inside };
	})()`);
	check("the stroke is smoothed through its samples", smooth.n > 11 && smooth.inside, JSON.stringify(smooth));

	// Fingers: with the pen active a finger scrolls, two fingers pinch.
	const s0 = await scrollTop();
	await touch("touchStart", [[x, y + 300]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x, y + 300 - i * 30]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(1200);
	const s1 = await scrollTop();
	check("a finger scrolls instead of drawing while the pen is active", s1 > s0 + 100 && (await count()) === 1, `scrollTop ${s0} -> ${s1}, annotations ${await count()}`);
	const z0 = await api(`zoom.getState().currentZoomLevel`);
	await touch("touchStart", [[x - 50, y + 200], [x + 50, y + 200]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x - 50 - i * 10, y + 200], [x + 50 + i * 10, y + 200]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(800);
	const z1 = await api(`zoom.getState().currentZoomLevel`);
	check("two fingers pinch to zoom", z1 > z0 * 1.2 && (await count()) === 1, `${z0} -> ${z1}`);
	await click('.pdf-ink-toolbar [aria-label="Fit width"]');
	await page.evaluate((s) => (document.querySelector(".pdf-ink-viewport").scrollTop = s), s0);
	await page.waitForTimeout(800);

	// Save: the written PDF carries the ink annotation and loads back with it.
	const ok = await page.evaluate(() => window.view.saveNow(true));
	const saved = await page.evaluate(() => {
		const last = window.saved[window.saved.length - 1];
		const txt = last ? new TextDecoder("latin1").decode(last) : "";
		return { n: window.saved.length, bytes: last?.length, ink: (txt.match(/\/Ink/g) || []).length, header: txt.slice(0, 5) };
	});
	check("save writes the PDF with the Ink annotation", ok === true && saved.n === 1 && saved.ink >= 1 && saved.header === "%PDF-", JSON.stringify(saved));
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	check("the saved annotation loads back", (await ready()) && (await count()) === 1, `${await count()}`);

	// Eraser from the toolbar: dragging across the stroke deletes it; undo brings it back.
	await page.evaluate(() => (window.view.dirty = false));
	await click('.pdf-ink-toolbar [aria-label^="Eraser"]');
	await page.waitForTimeout(100);
	const r1 = await pageRect(0);
	const ex = r1.x + r1.width / 2 + 40, ey = r1.y + r1.height / 3 - 30;
	const toolErasing = await api(`ann.getActiveTool()`);
	await page.mouse.move(ex, ey);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(ex, ey + i * 10);
	await page.mouse.up();
	await page.waitForTimeout(300);
	const n2 = await count();
	const dirty2 = await page.evaluate(() => window.view.dirty);
	check("the eraser deletes the stroke it crosses", toolErasing === null && n2 === 0 && dirty2 === true, `tool ${toolErasing}, annotations ${n2}, dirty ${dirty2}`);
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo restores the erased stroke", (await count()) === 1, `${await count()}`);
	await click('.pdf-ink-toolbar [aria-label="Redo"]');
	await page.waitForTimeout(300);

	// The pen's side button while hovering arms the eraser for one stroke, then the pen is back.
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch")[0].click());
	await page.waitForTimeout(100);
	await stroke(x, y);
	const n3 = await count();
	const pen = (type, cx, cy, extra) =>
		page.evaluate(
			([type, cx, cy, extra]) => {
				const target = document.elementFromPoint(cx, cy);
				target.dispatchEvent(new PointerEvent(type, { pointerType: "pen", pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: cx, clientY: cy, ...extra }));
			},
			[type, cx, cy, extra]
		);
	await pen("pointermove", x, y - 60, { buttons: 1, pressure: 0 });
	const armed = await page.evaluate(() => document.querySelector('.pdf-ink-toolbar [aria-label^="Eraser"]').classList.contains("is-active"));
	await pen("pointerdown", x + 40, y - 30, { buttons: 1, pressure: 0.5 });
	for (let i = 1; i <= 6; i++) await pen("pointermove", x + 40, y - 30 + i * 10, { buttons: 1, pressure: 0.5 });
	await pen("pointerup", x + 40, y + 30, { buttons: 0, pressure: 0 });
	await page.waitForTimeout(300);
	const n4 = await count();
	const after = await page.evaluate(() => [document.querySelector('.pdf-ink-toolbar [aria-label^="Eraser"]').classList.contains("is-active")]);
	const toolAfter = await api(`ann.getActiveTool()?.id`);
	check("the pen's side button arms the eraser for one stroke, then the pen returns", n3 === 1 && armed && n4 === 0 && after[0] === false && toolAfter === "ink", `before ${n3}, armed ${armed}, after ${n4}, eraser ${after[0]}, tool ${toolAfter}`);

	// Letting go of the side button before touching down disarms the eraser: the next stroke draws.
	await pen("pointermove", x, y - 60, { buttons: 1, pressure: 0 });
	const armed2 = await page.evaluate(() => document.querySelector('.pdf-ink-toolbar [aria-label^="Eraser"]').classList.contains("is-active"));
	await pen("pointermove", x + 5, y - 60, { buttons: 0, pressure: 0 });
	const disarmed = await page.evaluate(() => !document.querySelector('.pdf-ink-toolbar [aria-label^="Eraser"]').classList.contains("is-active"));
	await stroke(x, y + 120);
	check("releasing the side button without touching disarms the eraser", armed2 && disarmed && (await count()) === 1, `armed ${armed2}, disarmed ${disarmed}, annotations ${await count()}`);
	await click('.pdf-ink-toolbar [aria-label^="Eraser"]');
	await page.mouse.move(x + 40, y + 90);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(x + 40, y + 90 + i * 10);
	await page.mouse.up();
	await page.waitForTimeout(300);
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch")[0].click());
	await page.waitForTimeout(100);
	// A release outside the viewer ends an eraser stroke: hovering back must not erase.
	await stroke(x, y);
	await click('.pdf-ink-toolbar [aria-label^="Eraser"]');
	await page.mouse.move(x - 200, y + 300);
	await page.mouse.down();
	await page.mouse.move(x - 200, 10);
	await page.mouse.up();
	await page.mouse.move(x + 20, y - 5);
	await page.mouse.move(x + 60, y + 5);
	await page.waitForTimeout(200);
	check("a release outside the viewer ends the eraser stroke", (await count()) === 1, `${await count()}`);
	await click('.pdf-ink-toolbar [aria-label="Select and scroll"]');

	// Closing right after a stroke still saves it (the stroke commits on pen-up).
	await page.evaluate(() => (window.saved.length = 0));
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch")[0].click());
	await page.waitForTimeout(100);
	await page.mouse.move(x, y + 200);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 8, y + 200 + (i % 2) * 10);
	await page.mouse.up();
	await page.evaluate(() => window.view.close());
	const closedSave = await page.evaluate(() => {
		const last = window.saved[window.saved.length - 1];
		const txt = last ? new TextDecoder("latin1").decode(last) : "";
		return { n: window.saved.length, ink: (txt.match(/\/Ink/g) || []).length };
	});
	check("closing right after a stroke saves it", closedSave.n === 1 && closedSave.ink >= 2, JSON.stringify(closedSave));
	// Long document: the eraser finds the page under the pointer after scrolling.
	await page.evaluate(() => window.run("/long.pdf"));
	check("a 30-page PDF opens", await ready());
	await api(`scroll.scrollToPage({ pageNumber: 12, behavior: "instant" })`);
	await page.waitForTimeout(800);
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch")[0].click());
	await page.waitForTimeout(100);
	const mid = await page.evaluate(() => {
		const r = document.querySelector(".pdf-ink-viewport").getBoundingClientRect();
		return [r.x + r.width / 2, r.y + r.height / 2];
	});
	await stroke(mid[0], mid[1]);
	const deep = await api(`ann.getAnnotations().map((a) => a.object.pageIndex)`);
	const pages = await page.evaluate(() => document.querySelector(".pdf-ink-pages").textContent);
	await click('.pdf-ink-toolbar [aria-label^="Eraser"]');
	await page.mouse.move(mid[0] + 40, mid[1] - 30);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(mid[0] + 40, mid[1] - 30 + i * 10);
	await page.mouse.up();
	await page.waitForTimeout(300);
	check("the eraser finds the right page deep in a long document", deep.length === 1 && deep[0] >= 9 && (await count()) === 0 && /^1[0-3] \/ 30$/.test(pages), `stroke on ${JSON.stringify(deep)}, pages "${pages}", left ${await count()}`);

	await page.screenshot({ path: path.join(out, "viewer.png") });
	await browser.close();
	if (failed) process.exit(1);
})().catch((e) => {
	console.error("FAILED", e);
	process.exit(1);
});

/** "#1971c2" → "rgb(25, 113, 194)", as the DOM reports inline styles. */
function cssColor(hex) {
	const n = parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
