// Shared setup for the browser tests: sample PDFs, the harness page, and input helpers.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

/** A solid 2-colour PNG of the given size, for the image tool. */
function tinyPng(w, h, alpha = false) {
	const zlib = require("zlib");
	const crc = (buf) => {
		let c = ~0;
		for (const b of buf) {
			c ^= b;
			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
		return (~c) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	const bpp = alpha ? 4 : 3;
	ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; // 8-bit RGB or RGBA
	const raw = Buffer.alloc((w * bpp + 1) * h);
	for (let r = 0; r < h; r++) {
		raw[r * (w * bpp + 1)] = 0;
		for (let cx = 0; cx < w; cx++) raw.set(alpha ? [200, 40, 40, 255] : [200, 40, 40], r * (w * bpp + 1) + 1 + cx * bpp);
	}
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "out");
fs.mkdirSync(out, { recursive: true });

/** A simple PDF with `pages` pages of Helvetica text, written by hand; `inks` ink annotations on page 1. */
function makePdf(pages, inks = 0) {
	const objs = [];
	const add = (body) => objs.push(body) && objs.length;
	add("<< /Type /Catalog /Pages 2 0 R >>");
	add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids = [];
	for (let i = 0; i < pages; i++) {
		let text = `BT /F1 24 Tf 60 760 Td (Page ${i + 1} of ${pages}) Tj ET\n`;
		for (let l = 0; l < 20; l++) text += `BT /F1 12 Tf 60 ${700 - l * 28} Td (Line ${l + 1}: the quick brown fox jumps over the lazy dog.) Tj ET\n`;
		const content = add(`<< /Length ${text.length} >>\nstream\n${text}endstream`);
		const annots = [];
		for (let n = 0; i === 0 && n < inks; n++) {
			const x0 = 20 + (n % 30) * 18, y0 = 820 - Math.floor(n / 30) * 15;
			const pts = Array.from({ length: 40 }, (_, k) => `${(x0 + k * 0.4).toFixed(1)} ${(y0 + Math.sin(k / 4) * 3).toFixed(1)}`).join(" ");
			annots.push(add(`<< /Type /Annot /Subtype /Ink /Rect [${x0 - 1} ${y0 - 4} ${x0 + 17} ${y0 + 4}] /InkList [[${pts}]] /C [0.1 0.1 0.1] /BS << /W 1 >> /F 4 /NM (ink${n}) >>`));
		}
		const annotRef = annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : "";
		kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annotRef} >>`));
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
fs.writeFileSync(path.join(out, "dense.pdf"), makePdf(3, Number(process.env.PDF_INK_PERF_STROKES || 1500)));

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>html,body{margin:0;height:100%;--background-secondary:#eee;--background-primary:#fff;--background-primary-alt:#ddd;--text-muted:#555;--text-normal:#111;--background-modifier-border:#ccc;--background-modifier-hover:#ddd;--interactive-accent:#36f;--radius-s:4px;--font-ui-small:12px}#leaf{width:1200px;height:1300px;position:relative}.view-content{height:100%}</style></head><body><div id="leaf" class="workspace-leaf-content"><div id="content" class="view-content"></div></div><script src="/harness.js"></script></body></html>`;
const files = {
	"/harness.js": [path.join(out, "harness.js"), "text/javascript"],
	"/styles.css": [path.join(root, "styles.css"), "text/css"],
	"/sample.pdf": [path.join(out, "sample.pdf"), "application/pdf"],
	"/long.pdf": [path.join(out, "long.pdf"), "application/pdf"],
	"/dense.pdf": [path.join(out, "dense.pdf"), "application/pdf"],
	"/pdfium.wasm": [path.join(root, "pdfium.wasm"), "application/wasm"],
};

/**
 * Starts Chromium on the harness page and returns the page with the helpers the
 * checks use. Each call is a fresh browser, so scenarios do not share state.
 */
async function start() {
	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1200, height: 1300 }, hasTouch: true });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	page.on("console", (m) => {
		if (m.type() === "error" || m.text().startsWith("NOTICE:")) console.log("[console]", m.text().slice(0, 300));
	});
	page.on("pageerror", (e) => console.log("[pageerror]", e.message));
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
			const tools = h.tools;
			const ann = reg.getPlugin("annotation").provides().forDocument(id);
			const zoom = reg.getPlugin("zoom").provides().forDocument(id);
			const scroll = reg.getPlugin("scroll").provides().forDocument(id);
			const im = reg.getPlugin("interaction-manager").provides().forDocument(id);
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
	const tool = (id) => click(`.pdf-ink-toolbar [data-tool="${id}"]`).then(() => page.waitForTimeout(80));
	const drag = async (x0, y0, x1, y1, steps = 10, settle = 300) => {
		await page.mouse.move(x0, y0);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
		await page.mouse.up();
		await page.waitForTimeout(settle);
	};
	const stroke = async (x, y) => {
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 8, y + (i % 2) * 10);
		await page.mouse.up();
		await page.waitForTimeout(400);
	};
	const count = () => api(`ann.getAnnotations().length`);
	const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y]) => ({ x, y, radiusX: 10, radiusY: 10 })) });
	const fingerSwipe = async (x, y, dx, dy) => {
		await touch("touchStart", [[x, y]]);
		for (let i = 1; i <= 8; i++) {
			await touch("touchMove", [[x + (dx * i) / 8, y + (dy * i) / 8]]);
			await page.waitForTimeout(16);
		}
		await touch("touchEnd", []);
		await page.waitForTimeout(500);
	};
	const scrollTop = () => page.evaluate(() => document.querySelector(".pdf-ink-viewport").scrollTop);
	const setScroll = (v) => page.evaluate((s) => (document.querySelector(".pdf-ink-viewport").scrollTop = s), v).then(() => page.waitForTimeout(300));
	const pen = (type, cx, cy, extra) =>
		page.evaluate(
			([type, cx, cy, extra]) => {
				const target = document.elementFromPoint(cx, cy);
				target.dispatchEvent(new PointerEvent(type, { pointerType: "pen", pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: cx, clientY: cy, ...extra }));
			},
			[type, cx, cy, extra]
		);

	return { browser, context, page, cdp, check, api, ready, pageRect, click, tool, drag, stroke, count, touch, fingerSwipe, scrollTop, setScroll, pen, failed: () => failed };
}

module.exports = { start, tinyPng, makePdf, out, root };
