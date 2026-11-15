// Opt-in performance check (`npm run test:perf`): a page with many strokes, as in
// a real annotated book. Budgets are loose (headless, any CPU); they catch a lost
// optimisation (the memo, the build patches, the eraser's rect check), not small drifts.
const { start } = require("./lib.cjs");

const STROKES = Number(process.env.PDF_INK_PERF_STROKES || 1500);

(async () => {
	const h = await start();
	const { browser, page, check, api, ready, pageRect, tool, count } = h;
	await page.goto("http://test/");
	await page.evaluate(() => window.run("/dense.pdf"));
	await ready();
	await page.waitForTimeout(1500);
	check(`${STROKES} strokes are on page 1`, (await count()) >= STROKES, await count());

	const r = await pageRect(0);
	// Pen-down to next frame while writing quickly, as in the tablet's pen timing log.
	await tool("pen");
	const downs = [];
	for (let s = 0; s < 12; s++) {
		const x = r.x + 80 + (s % 4) * 120, y = r.y + 500 + Math.floor(s / 4) * 60;
		await page.mouse.move(x, y);
		await page.evaluate(() => {
			window.downTime = new Promise((res) => {
				addEventListener("pointerdown", (e) => { const t0 = performance.now(); requestAnimationFrame(() => res(performance.now() - t0 + (t0 - e.timeStamp))); }, { once: true, capture: true });
			});
		});
		await page.mouse.down();
		downs.push(await page.evaluate(() => window.downTime));
		for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 8, y + (i % 2) * 6);
		await page.mouse.up();
		await page.waitForTimeout(40);
	}
	downs.sort((a, b) => a - b);
	const p50 = downs[Math.floor(downs.length / 2)];
	check("pen-down to frame stays fast with many strokes on the page (p50 under 60 ms)", p50 < 60, `p50 ${p50.toFixed(1)} ms, max ${downs[downs.length - 1].toFixed(1)} ms`);
	const memo = await page.evaluate(() => ({ ...window.memoStats }));
	check("the memo skips unchanged annotation containers", memo.skipped > STROKES, JSON.stringify(memo));

	// The eraser over the dense area: time per move event.
	await tool("eraser");
	const eraseMs = await page.evaluate(async ([x, y]) => {
		const target = document.elementFromPoint(x, y);
		const ev = (type, cx) => new PointerEvent(type, { pointerType: "pen", pointerId: 9, isPrimary: true, bubbles: true, cancelable: true, clientX: cx, clientY: y, buttons: type === "pointerup" ? 0 : 1, pressure: 0.5 });
		target.dispatchEvent(ev("pointerdown", x));
		const t0 = performance.now();
		for (let i = 1; i <= 40; i++) target.dispatchEvent(ev("pointermove", x + i * 0.2));
		const ms = (performance.now() - t0) / 40;
		target.dispatchEvent(ev("pointerup", x + 8));
		return ms;
	}, [r.x + 600, r.y + 900]);
	check("an eraser move through a dense page costs under 2 ms", eraseMs < 2, `${eraseMs.toFixed(2)} ms`);

	// Tool switches restyle the page's annotations (CSS): time a round trip.
	const switchMs = await page.evaluate(async () => {
		const click = (id) => document.querySelector(`.pdf-ink-toolbar [data-tool="${id}"]`).click();
		const settle = () => new Promise((r) => setTimeout(r, 50));
		let total = 0;
		for (const id of ["hand", "pointer", "pen", "hand", "pointer", "pen"]) {
			const t0 = performance.now();
			click(id);
			// The work the switch causes: handlers, then the style and layout pass it forces.
			void document.body.offsetHeight;
			total += performance.now() - t0;
			await settle();
		}
		return total / 6;
	});
	check("a tool switch with many strokes on the page takes under 60 ms", switchMs < 60, `${switchMs.toFixed(1)} ms`);
	await browser.close();
	if (h.failed()) process.exit(1);
})().catch((e) => {
	console.error("FAILED", e);
	process.exit(1);
});
