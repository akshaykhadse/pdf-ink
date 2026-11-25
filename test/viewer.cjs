// End-to-end checks in headless Chromium: open a PDF, use every tool with mouse,
// pen and fingers, fold the toolbar, make links, save and reopen.
// These checks run in order on one page; newer scenarios live in test/scenarios.cjs.
const fs = require("fs");
const path = require("path");
const { start, tinyPng, out, root } = require("./lib.cjs");

(async () => {
	const h = await start();
	const { browser, context, page, cdp, check, api, ready, pageRect, click, tool, drag, stroke, count, touch, fingerSwipe, scrollTop, setScroll, pen } = h;
	await page.goto("http://test/");
	// Two notes link to the PDF: one with a rect, one by page only.
	await page.evaluate(() => {
		window.links = [
			{ source: "notes/a.md", link: "sample.pdf#page=1&rect=60,700,300,780", displayText: "intro", position: { start: { line: 4 } } },
			{ source: "notes/b.md", link: "docs/sample.pdf#page=2", displayText: "", position: { start: { line: 0 } } },
		];
	});
	const t0 = Date.now();
	const ran = await page.evaluate(() => window.run());
	const up = await ready();
	console.log("opened in", Date.now() - t0, "ms");
	check("the view opens a PDF and renders pages", ran === "ok" && up);
	check("stylus mode is off by default", (await page.evaluate(() => window.settings.stylusMode)) === false && (await page.$(".pdf-ink-stylus.is-active")) === null);
	// The rest of the checks assume stylus mode on; turn it on as the user would.
	await page.click(".pdf-ink-stylus");
	check("the stylus button turns stylus mode on", (await page.evaluate(() => window.settings.stylusMode)) === true);
	const r0 = await pageRect(0);
	check("the first page fits the leaf width", r0 && Math.abs(r0.width - (1200 - 24)) < 1 && r0.x >= 12, JSON.stringify(r0));
	const z = r0.width / 595;
	// "Page 1 of 3" sits at PDF (60, 760) in 24 pt Helvetica; y down from the top = 842 - 760.
	const textY = r0.y + (842 - 766) * z, textX0 = r0.x + 55 * z, textX1 = r0.x + 200 * z;
	const x = r0.x + r0.width / 2, y = r0.y + r0.height / 3;

	// --- hand tool (default): finger scrolls, pinch zooms, mouse drag pans
	check("the hand tool is active by default and EmbedPDF is in pan mode", (await api(`[tools.tool, im.getActiveMode()]`)).join() === "hand,panMode", await api(`[tools.tool, im.getActiveMode()]`));
	await fingerSwipe(600, 900, 0, -320);
	const s1 = await scrollTop();
	check("hand: one finger scrolls natively", s1 > 100, `scrollTop ${s1}`);
	await setScroll(0);
	const z0 = await api(`zoom.getState().currentZoomLevel`);
	await touch("touchStart", [[x - 50, y + 200], [x + 50, y + 200]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x - 50 - i * 10, y + 200], [x + 50 + i * 10, y + 200]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(800);
	const z1 = await api(`zoom.getState().currentZoomLevel`);
	check("hand: two fingers pinch to zoom", z1 > z0 * 1.2, `${z0} -> ${z1}`);
	await click('.pdf-ink-toolbar [aria-label="Fit width"]');
	await page.waitForTimeout(500);
	await setScroll(200);
	await drag(x, y + 300, x, y, 10, 300);
	const panned = await scrollTop();
	check("hand: a mouse or pen drag pans", panned > 400, `scrollTop 200 -> ${panned}`);
	await setScroll(0);

	// --- backlinks drawn on the page
	const bl = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-backlink")].map((b) => [b.closest(".pdf-ink-page").dataset.pageIndex, b.title]));
	check("a note's rect link to the PDF shows as a box on its page", bl.length === 1 && bl[0][0] === "0" && bl[0][1] === "notes/a.md", JSON.stringify(bl));
	await page.evaluate(() => document.querySelector(".pdf-ink-backlink").click());
	const opened = await page.evaluate(() => window.opened);
	check("clicking a backlink opens the note at its line", opened.length === 1 && opened[0][0] === "notes/a.md" && opened[0][1].eState.line === 4, JSON.stringify(opened));

	// --- pointer tool: text selection menu, link, highlight
	await tool("pointer");
	check("the pointer tool uses EmbedPDF's pointer mode", (await api(`im.getActiveMode()`)) === "pointerMode");
	await drag(textX0, textY, textX1, textY, 8, 500);
	const menuItems = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].map((b) => b.textContent.trim()));
	check("selecting text shows the link menu", menuItems.includes("Link") && menuItems.includes("Highlight") && menuItems.includes("Copy text"), JSON.stringify(menuItems));
	const linkBtn = await page.evaluate(() => {
		const b = [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].find((b) => b.textContent.trim() === "Link");
		const r = b.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2, onTop: b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
	});
	check("the text selection menu is on top and clickable", linkBtn.onTop, JSON.stringify(linkBtn));
	await page.mouse.click(linkBtn.x, linkBtn.y);
	await page.waitForTimeout(400);
	const clip = await page.evaluate(() => window.clipboard);
	check("the link menu copies a PDF++-style rect link with the selected text", clip.length === 1 && /^\[\[sample\.pdf#page=1&rect=[\d.,]+\|Page 1 of 3\]\]$/.test(clip[0]), JSON.stringify(clip));
	const rectNums = (clip[0]?.match(/rect=([\d.,]+)/) || [])[1]?.split(",").map(Number) || [];
	check("the rect is in PDF space around the text", rectNums.length === 4 && rectNums[0] > 50 && rectNums[0] < 65 && rectNums[1] > 740 && rectNums[3] < 790, JSON.stringify(rectNums));
	const sidecar = await page.evaluate(() => window.notes);
	check("the link also lands in the sidecar note (next to the PDF)", Object.keys(sidecar).length === 1 && Object.keys(sidecar)[0] === "docs/sample.md" && sidecar["docs/sample.md"].includes(clip[0]), JSON.stringify(Object.keys(sidecar)));
	await drag(textX0, textY, textX1, textY, 8, 500);
	await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].find((b) => b.textContent.trim() === "Highlight").click());
	await page.waitForTimeout(500);
	const hl = await api(`ann.getAnnotations().map((a) => [a.object.type, a.object.color, a.object.segmentRects?.length])`);
	check("the selection menu's Highlight makes a text highlight in the text-highlighter colour", hl.length === 1 && hl[0][0] === 9 && hl[0][1] === "#ffe066" && hl[0][2] >= 1, JSON.stringify(hl));
	// Text first: a drag over the highlight selects its text again; a tap on it selects the highlight.
	const menuNow = () => page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].map((b) => b.textContent.trim()));
	await page.mouse.click(textX1 + 300, textY + 400);
	await page.waitForTimeout(200);
	await drag(textX0 + 10, textY, textX1 - 10, textY, 8, 500);
	const overHl = [await menuNow(), await api(`ann.getSelectedAnnotations().length`)];
	check("pointer: a drag that starts on a highlight selects the text under it", overHl[0].includes("Copy text") && overHl[1] === 0, JSON.stringify(overHl));
	await page.mouse.click(textX1 + 300, textY + 400);
	await page.waitForTimeout(200);
	// The backlink box from the fixture covers this text and is drawn above annotations (its tap wins): hide it for this check.
	await page.evaluate(() => ((window.savedLinks = window.links), (window.links = []), window.view.handle.refreshBacklinks()));
	await page.waitForTimeout(100);
	await page.mouse.click((textX0 + textX1) / 2, textY);
	await page.waitForTimeout(300);
	await page.evaluate(() => ((window.links = window.savedLinks), window.view.handle.refreshBacklinks()));
	const tapHl = await api(`ann.getSelectedAnnotations().map((a) => a.object.type)`);
	check("pointer: a tap on a highlight selects the highlight", tapHl.length === 1 && tapHl[0] === 9, JSON.stringify(tapHl));
	await page.mouse.click(textX1 + 300, textY + 400);
	await page.waitForTimeout(200);
	check("pointer: a tap beside it deselects", (await api(`ann.getSelectedAnnotations().length`)) === 0);
	await page.mouse.click(r0.x + 250 * z, r0.y + 125 * z); // inside the backlink box, below the highlight
	await page.waitForTimeout(200);
	check("pointer: a tap on a backlink box still opens the note", (await page.evaluate(() => window.opened.length)) === 2, await page.evaluate(() => window.opened.length));
	await api(`ann.deleteAllAnnotations()`);
	await page.waitForTimeout(200);

	// --- pen: colour, width, opacity, smoothing, stroke over stroke
	await tool("pen");
	check("the pen activates EmbedPDF's ink tool", (await api(`ann.getActiveTool()?.id`)) === "ink");
	const openStyle = async () => {
		if (!(await page.$(".pdf-ink-popover .pdf-ink-swatches"))) await click('.pdf-ink-toolbar [aria-label="Tool options"]');
		await page.waitForTimeout(80);
	};
	await openStyle();
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-swatches .pdf-ink-swatch")[2].click());
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-widths .pdf-ink-swatch")[2].click());
	await page.waitForTimeout(100);
	check("the style popover shows the swatches, widths and opacity; the bar itself holds one style button", (await page.evaluate(() => [document.querySelectorAll(".pdf-ink-popover .pdf-ink-swatch").length, document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-swatch").length, document.querySelectorAll(".pdf-ink-toolbar .pdf-ink-style").length])).join() === "9,0,1");
	await page.mouse.click(x, y + 500); // closes the popover
	await stroke(x, y);
	const inkProps = await api(`(() => { const o = ann.getAnnotations()[0]?.object; return o && [o.type, o.strokeColor, o.strokeWidth, o.opacity, o.inkList[0].points.length, window.view.dirty]; })()`);
	check("a pen stroke becomes an ink annotation with the chosen colour and width", inkProps && inkProps[0] === 15 && inkProps[1] === "#e03131" && inkProps[2] === 4 && inkProps[3] === 1 && inkProps[5] === true, JSON.stringify(inkProps));
	check("the stroke is smoothed through its samples", inkProps && inkProps[4] > 11, inkProps && inkProps[4]);
	await stroke(x + 4, y + 2);
	const over = await api(`[ann.getAnnotations().length, ann.getSelectedAnnotations().length]`);
	check("a stroke starting on an earlier stroke draws rather than selecting it", over[0] === 2 && over[1] === 0, JSON.stringify(over));
	// The runtime hooks into EmbedPDF's internals must still engage (an EmbedPDF update could break them silently).
	const memo = await page.evaluate(() => ({ ...window.memoStats }));
	check("the annotation memo wraps EmbedPDF's containers and skips unchanged ones", memo.wrapped > 0 && memo.skipped > 0, JSON.stringify(memo));
	check("stroke smoothing hooks EmbedPDF's createAnnotation", await api(`!!reg.getPlugin("annotation").__pdfInkRawCreate`));
	check("quiet changes can detach EmbedPDF's annotation history", await api(`"history" in reg.getPlugin("annotation") && !!reg.getPlugin("annotation").history`));
	// opacity slider
	await openStyle();
	await page.evaluate(() => {
		const r = document.querySelector(".pdf-ink-popover .pdf-ink-opacity input");
		r.value = "40";
		r.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await stroke(x, y + 120);
	const op = await api(`ann.getAnnotations()[2]?.object.opacity`);
	check("the opacity slider applies to new strokes", op === 0.4, op);
	// The pen's companion touch events stop at the viewer (they would open Obsidian's side panels).
	const swipe = await page.evaluate(([px, py]) => {
		const target = document.elementFromPoint(px, py);
		const seen = [];
		const listener = (e) => seen.push(e.type + "@" + e.changedTouches[0].clientX);
		document.addEventListener("touchmove", listener);
		const send = (x, y, id) => {
			const t = new Touch({ identifier: id, target, clientX: x, clientY: y });
			target.dispatchEvent(new TouchEvent("touchmove", { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
		};
		const pen = (type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { pointerId: 77, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1, pressure: 0.5, ...extra }));
		pen("pointerdown", px, py);
		send(px + 5, py, 1);
		send(px + 300, py + 200, 2);
		pen("pointerup", px, py, { buttons: 0, pressure: 0 });
		send(px + 5, py, 1);
		document.removeEventListener("touchmove", listener);
		return seen;
	}, [r0.x - 6, y + 300]);
	check("the pen's touch events are kept from Obsidian's swipe gesture while it is down", swipe.length === 2, JSON.stringify(swipe));

	// --- pointer: tap selects, marquee multi-selects, delete
	await tool("pointer");
	// Text first: the strokes lie over text lines; a drag starting on one selects the text, not the stroke.
	await drag(x + 40, y + 5, x + 200, y + 5, 10, 500);
	const overInk = [await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].map((b) => b.textContent.trim())), await api(`ann.getSelectedAnnotations().length`)];
	check("pointer: a drag that starts on a stroke over text selects the text", overInk[0].includes("Copy text") && overInk[1] === 0, JSON.stringify(overInk));
	await page.mouse.click(x - 200, y + 400);
	await page.waitForTimeout(200);
	await page.mouse.click(x + 40, y + 5);
	await page.waitForTimeout(300);
	const sel1 = await api(`ann.getSelectedAnnotations().length`);
	check("pointer: a tap on a stroke selects it", sel1 === 1, sel1);
	const annMenu = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu button")].map((b) => b.getAttribute("aria-label")).filter(Boolean));
	check("a selected annotation shows colour swatches, link and delete", annMenu.includes("Delete") && annMenu.includes("Copy link to annotation") && annMenu.some((l) => l.startsWith("#")), JSON.stringify(annMenu));
	await page.evaluate(() => document.querySelector('.pdf-ink-menu [aria-label="#1971c2"]').click());
	await page.waitForTimeout(200);
	const recolored = await api(`ann.getSelectedAnnotations()[0]?.object.strokeColor`);
	check("a swatch in the annotation menu recolours it", recolored === "#1971c2", recolored);
	const yBefore = await api(`ann.getSelectedAnnotations()[0].object.rect.origin.y`);
	await drag(x + 40, y + 5, x + 40, y + 65, 8, 400);
	const moved = await api(`[ann.getSelectedAnnotations().length, ann.getSelectedAnnotations()[0]?.object.rect.origin.y]`);
	check("pointer: dragging the selected stroke still moves it", moved[0] === 1 && moved[1] > yBefore + 20, JSON.stringify([yBefore, moved]));
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo puts it back", Math.abs((await api(`ann.getAnnotations().find((a) => a.object.strokeColor === "#1971c2")?.object.rect.origin.y`)) - yBefore) < 0.5);
	await page.mouse.click(x - 200, y + 400);
	await page.waitForTimeout(200);
	const sel = [x - 20, y - 40, x + 320, y + 160];
	await drag(x + 320, y - 40, x - 20, y + 160, 10, 400); // starts in empty space right of the text
	const selN = await api(`ann.getSelectedAnnotations().length`);
	check("pointer: dragging a box selects every stroke inside it", selN === 3, selN);
	// The group menu offers the same swatches as the single menu and recolours the whole selection as one undo step.
	const groupSwatches = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-swatch")].map((b) => b.getAttribute("aria-label")));
	const colorsBefore = await api(`ann.getAnnotations().map((a) => a.object.strokeColor)`);
	await page.evaluate(() => document.querySelector('.pdf-ink-menu [aria-label="#e03131"]').click());
	await page.waitForTimeout(200);
	const groupColors = await api(`ann.getAnnotations().map((a) => a.object.strokeColor)`);
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	const undone = await api(`ann.getAnnotations().map((a) => a.object.strokeColor)`);
	check("the group menu recolours every selected stroke with one undo step", groupSwatches.length >= 3 && colorsBefore.some((c) => c !== "#e03131") && groupColors.every((c) => c === "#e03131") && JSON.stringify(undone) === JSON.stringify(colorsBefore), `swatches ${groupSwatches.length}, before ${JSON.stringify(colorsBefore)}, after ${JSON.stringify(groupColors)}, undone ${JSON.stringify(undone)}`);
	await click('.pdf-ink-toolbar [aria-label="Redo"]');
	await page.waitForTimeout(300);
	check("redo recolours them again", (await api(`ann.getAnnotations().every((a) => a.object.strokeColor === "#e03131")`)) === true);
	await drag(x + 320, y - 40, x - 20, y + 160, 10, 400);
	check("the strokes are selected again for the delete check", (await api(`ann.getSelectedAnnotations().length`)) === 3);
	// A real mouse click: the menu must sit outside the selection box's handle layer.
	const del = await page.evaluate((sel) => {
		const b = document.querySelector('.pdf-ink-menu [aria-label="Delete selected"]');
		const r = b.getBoundingClientRect();
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return { x: r.x + r.width / 2, y: r.y + r.height / 2, onTop: b.contains(hit), outside: r.bottom <= sel[1] || r.top >= sel[3] };
	}, sel);
	await page.mouse.click(del.x, del.y);
	await page.waitForTimeout(300);
	check("the group menu is clickable and deletes the selection", del.onTop && (await count()) === 0, JSON.stringify(del) + ` left ${await count()}`);
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo restores the deleted strokes", (await count()) === 3, await count());

	// --- pointer tool and stylus mode: fingers scroll when it is on, select when it is off
	await tool("pointer");
	await api(`ann.deselectAnnotation()`);
	await setScroll(300);
	await fingerSwipe(x + 320, y - 40, -340, 200); // a downward swipe scrolls back up
	check("pointer + stylus mode on: a finger scrolls and selects nothing", (await scrollTop()) < 200 && (await api(`ann.getSelectedAnnotations().length`)) === 0, `scrollTop ${await scrollTop()}, selected ${await api(`ann.getSelectedAnnotations().length`)}`);
	await setScroll(0);
	await click(".pdf-ink-stylus");
	await page.waitForTimeout(100);
	await fingerSwipe(x + 320, y - 40 + 300, -340, -200);
	check("pointer + stylus mode off: a finger box-selects and does not scroll", (await scrollTop()) === 0 && (await api(`ann.getSelectedAnnotations().length`)) >= 1, `scrollTop ${await scrollTop()}, selected ${await api(`ann.getSelectedAnnotations().length`)}`);
	const zp = await api(`zoom.getState().currentZoomLevel`);
	await touch("touchStart", [[x - 50, y + 300], [x + 50, y + 300]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x - 50 - i * 10, y + 300], [x + 50 + i * 10, y + 300]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(500);
	check("pointer + stylus mode off: two fingers do not pinch", Math.abs((await api(`zoom.getState().currentZoomLevel`)) - zp) < 0.01);
	await click(".pdf-ink-stylus");
	// A free-text annotation over text: a tap selects it, a double-click edits it, a drag from it selects text.
	await api(`ann.deselectAnnotation()`);
	await api(`ann.createAnnotation(0, { type: 3, id: "ft1", pageIndex: 0, rect: { origin: { x: 60, y: 480 }, size: { width: 160, height: 30 } }, contents: "Note", fontSize: 14, fontColor: "#000000", color: "transparent", opacity: 1 })`);
	await page.waitForTimeout(400);
	const ftX = r0.x + 120 * z, ftY = r0.y + 492 * z;
	await drag(ftX, ftY, ftX + 150 * z, ftY, 8, 500);
	const overFt = [await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-menu .pdf-ink-menu-item")].map((b) => b.textContent.trim())), await api(`ann.getSelectedAnnotations().length`)];
	check("pointer: a drag that starts on a text box selects the text under it", overFt[0].includes("Copy text") && overFt[1] === 0, JSON.stringify(overFt));
	await page.mouse.click(x - 200, y + 400);
	await page.waitForTimeout(200);
	await page.mouse.click(ftX, ftY);
	await page.waitForTimeout(300);
	check("pointer: a tap on a text box selects it", (await api(`ann.getSelectedAnnotations().map((a) => a.object.id).join()`)) === "ft1");
	await page.mouse.dblclick(ftX, ftY);
	await page.waitForTimeout(300);
	const editing = await page.evaluate(() => !!document.querySelector('.pdf-ink-page [contenteditable="true"]'));
	check("pointer: a double-click on a text box edits its text", editing);
	await page.mouse.click(x - 200, y + 400);
	await page.waitForTimeout(300);
	await api(`ann.deleteAnnotation(0, "ft1")`);
	await page.waitForTimeout(200);
	await page.waitForTimeout(100);
	await api(`ann.deselectAnnotation()`);

	// --- hand tool over strokes: a drag pans and selects nothing
	await tool("hand");
	await api(`ann.deselectAnnotation()`);
	await setScroll(100);
	await drag(x + 40, y + 5, x + 40, y - 200, 10, 300);
	const handSel = await api(`ann.getSelectedAnnotations().length`);
	check("hand: dragging on a stroke pans and does not select it", handSel === 0 && (await scrollTop()) > 200, `selected ${handSel}, scrollTop ${await scrollTop()}`);
	await setScroll(0);

	// --- marker and text highlighter
	await tool("marker");
	await stroke(x, y + 220);
	const mk = await api(`(() => { const o = ann.getAnnotations().at(-1).object; return [o.type, o.intent, o.strokeColor, o.strokeWidth, o.opacity]; })()`);
	check("the highlighter makes a translucent ink highlight", mk[0] === 15 && mk[1] === "InkHighlight" && mk[2] === "#ffe066" && mk[3] === 14 && mk[4] === 0.5, JSON.stringify(mk));
	await tool("textHighlight");
	await openStyle();
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-swatches .pdf-ink-swatch")[1].click());
	await page.mouse.click(x, y + 500);
	await page.waitForTimeout(100);
	await drag(textX0, textY, textX1, textY, 8, 600);
	const th = await api(`(() => { const o = ann.getAnnotations().at(-1).object; return [o.type, o.color, o.segmentRects?.length, ann.getAnnotations().length]; })()`);
	check("the text highlighter highlights the selected text in its colour", th[0] === 9 && th[1] === "#8ce99a" && th[2] >= 1 && th[3] === 5, JSON.stringify(th));
	// Still in the text highlighter: a click on the highlight just made must not select it.
	await page.mouse.click((textX0 + textX1) / 2, textY);
	await page.waitForTimeout(200);
	check("the text highlighter does not select an existing highlight on click", (await api(`ann.getSelectedAnnotations().length`)) === 0 && (await api(`tools.tool`)) === "textHighlight", `selected ${await api(`ann.getSelectedAnnotations().length`)}`);

	// --- image (EmbedPDF's native stamp tool): a tap opens the file picker and places the picture there
	await tool("image");
	check("the image tool activates EmbedPDF's stamp tool", (await api(`ann.getActiveTool()?.id`)) === "stamp");
	// Headless Chromium does not surface the picker, so the picked file is set on the input the tap armed.
	await page.mouse.click(x, y + 300);
	await page.waitForTimeout(100);
	const picked = await page.$$('input[type=file][accept="image/png,image/jpeg"]');
	check("a tap with the image tool asks for a PNG or JPEG file", picked.length === 1, `${picked.length} armed input(s)`);
	if (picked.length) await picked[0].setInputFiles({ name: "pic.png", mimeType: "image/png", buffer: tinyPng(8, 4) });
	await page.waitForTimeout(600);
	const st = await api(`(() => { const o = ann.getAnnotations().at(-1).object; return [o.type, o.rect.size.width / o.rect.size.height, ann.getAnnotations().length, ann.getSelectedAnnotations().length]; })()`);
	check("the picked picture becomes a stamp annotation at the tap, keeping its aspect ratio", st[0] === 13 && Math.abs(st[1] - 2) < 0.05 && st[2] === 6 && st[3] === 0, JSON.stringify(st));
	const stampPixel = async () =>
		page.evaluate(async () => {
			for (let i = 0; i < 30; i++) {
				const img = document.querySelector(".pdf-ink-page [style*='z-index: 2'] img");
				if (img && img.complete && img.naturalWidth) {
					const c = document.createElement("canvas");
					c.width = img.naturalWidth; c.height = img.naturalHeight;
					c.getContext("2d").drawImage(img, 0, 0);
					return [...c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data];
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			return "no stamp image";
		});
	const shown = await stampPixel();
	check("the picked picture is visible right away (not an empty box)", Array.isArray(shown) && shown[0] > 150 && shown[1] < 80, JSON.stringify(shown));
	const savedImg = await page.evaluate(async () => {
		const ok = await window.view.saveNow(true);
		const txt = new TextDecoder("latin1").decode(window.saved[window.saved.length - 1]);
		window.saved.length = 0; // the save check further down expects the first save
		return [ok, (txt.match(/\/Stamp/g) || []).length, (txt.match(/\/Image/g) || []).length];
	});
	check("the image is written into the PDF as a stamp with an image stream", savedImg[0] === true && savedImg[1] >= 1 && savedImg[2] >= 1, JSON.stringify(savedImg));
	// Reopen the saved file: this stamp's bytes are not known any more, so it is drawn by the engine.
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	await ready();
	const reopened = await stampPixel();
	check("after reopening, the engine draws the saved image", Array.isArray(reopened) && reopened[0] > 150 && reopened[1] < 80 && (await count()) === 6, `${JSON.stringify(reopened)}, ${await count()} annotations`);
	await api(`(() => { const o = ann.getAnnotations().find((a) => a.object.type === 13).object; ann.deleteAnnotation(o.pageIndex, o.id); })()`);
	await page.waitForTimeout(200);
	check("deleting the reopened image leaves the five earlier annotations", (await count()) === 5, await count());

	// --- eraser
	await tool("eraser");
	check("the eraser has its own exclusive mode", (await api(`[im.getActiveMode(), ann.getActiveTool()]`)).join() === "pdfInkEraser,", await api(`im.getActiveMode()`));
	await drag(textX0 + 40, textY - 40, textX0 + 40, textY + 40, 8, 300);
	check("the eraser removes the text highlight it crosses", (await count()) === 4, await count());
	await drag(x + 40, y - 30, x + 40, y + 60, 8, 300);
	const afterErase = await count();
	check("the eraser removes the strokes it crosses", afterErase === 2, afterErase);
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo brings erased strokes back", (await count()) === 4, await count());
	// One eraser stroke that crosses two strokes at different moments is still one undo step.
	await tool("pen");
	await stroke(x - 200, y + 500);
	await stroke(x - 200, y + 640);
	const n6 = await count();
	await tool("eraser");
	await drag(x - 160, y + 460, x - 160, y + 690, 24, 300);
	const n7 = await count();
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("one eraser stroke across two strokes is one undo step", n7 === n6 - 2 && (await count()) === n6, `${n6} -> ${n7} -> ${await count()}`);
	await click('.pdf-ink-toolbar [aria-label="Redo"]');
	await page.waitForTimeout(300);
	check("redo removes them again", (await count()) === n7, await count());
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	await api(`(() => { for (const a of ann.getAnnotations().filter((a) => a.object.rect.origin.y > 600)) ann.deleteAnnotation(a.object.pageIndex, a.object.id); })()`);
	await page.waitForTimeout(300);

	// --- stylus mode
	await tool("pen");
	await setScroll(0);
	const before = await count();
	await fingerSwipe(x, y + 300, 0, -240);
	check("stylus mode on: with the pen tool a finger scrolls instead of drawing", (await scrollTop()) > 100 && (await count()) === before, `scrollTop ${await scrollTop()}, annotations ${await count()}`);
	await setScroll(0);
	const z2 = await api(`zoom.getState().currentZoomLevel`);
	await touch("touchStart", [[x - 50, y + 200], [x + 50, y + 200]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x - 50 - i * 10, y + 200], [x + 50 + i * 10, y + 200]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(800);
	check("stylus mode on: two fingers still pinch", (await api(`zoom.getState().currentZoomLevel`)) > z2 * 1.2 && (await count()) === before);
	await click('.pdf-ink-toolbar [aria-label="Fit width"]');
	await page.waitForTimeout(500);
	await setScroll(0);
	await click(".pdf-ink-stylus");
	await page.waitForTimeout(100);
	await fingerSwipe(x, y + 300, 100, 10);
	check("stylus mode off: a finger draws", (await count()) === before + 1 && (await page.evaluate(() => window.settings.stylusMode)) === false, `annotations ${await count()}`);
	const z3 = await api(`zoom.getState().currentZoomLevel`);
	const n2b = await count();
	await touch("touchStart", [[x - 50, y + 300], [x + 50, y + 300]]);
	for (let i = 1; i <= 8; i++) {
		await touch("touchMove", [[x - 50 - i * 10, y + 300], [x + 50 + i * 10, y + 300]]);
		await page.waitForTimeout(16);
	}
	await touch("touchEnd", []);
	await page.waitForTimeout(500);
	check("stylus mode off: with the pen tool two fingers do not pinch", Math.abs((await api(`zoom.getState().currentZoomLevel`)) - z3) < 0.01, `zoom ${z3} -> ${await api(`zoom.getState().currentZoomLevel`)}, annotations ${n2b} -> ${await count()}`);
	// The first finger drew one stroke; the second finger was swallowed, so the stroke is a plain line, not a zigzag between the two.
	const twoFinger = await api(`(() => { const o = ann.getAnnotations().at(-1).object; const pts = o.inkList?.[0]?.points ?? []; return [${n2b}, ann.getAnnotations().length, pts.length, pts.every((p, i, a) => i === 0 || p.x <= a[i - 1].x + 1)]; })()`);
	check("stylus mode off: a second finger does not weave into the stroke", twoFinger[1] === n2b + 1 && twoFinger[3] === true, JSON.stringify(twoFinger));
	await click(".pdf-ink-stylus");
	await page.waitForTimeout(100);

	// --- the pen's side button toggles the eraser
	const n3 = await count();
	await pen("pointermove", x, y - 60, { buttons: 1, pressure: 0 });
	await pen("pointermove", x + 2, y - 60, { buttons: 1, pressure: 0 }); // still held: no second toggle
	const armed = await page.evaluate(() => document.querySelector('.pdf-ink-toolbar [data-tool="eraser"]').classList.contains("is-active"));
	check("a press of the pen's side button switches to the eraser", armed && (await api(`tools.tool`)) === "eraser", `armed ${armed}, tool ${await api(`tools.tool`)}`);
	await pen("pointermove", x, y - 60, { buttons: 0, pressure: 0 }); // released
	await pen("pointerdown", x + 40, y - 30, { buttons: 1, pressure: 0.5 });
	for (let i = 1; i <= 6; i++) await pen("pointermove", x + 40, y - 30 + i * 10, { buttons: 1, pressure: 0.5 });
	await pen("pointerup", x + 40, y + 30, { buttons: 0, pressure: 0 });
	await page.waitForTimeout(300);
	const n4 = await count();
	check("the eraser stays on after a stroke", n4 < n3 && (await api(`tools.tool`)) === "eraser", `${n3} -> ${n4}, tool ${await api(`tools.tool`)}`);
	await pen("pointermove", x, y - 60, { buttons: 1, pressure: 0 }); // second press
	await pen("pointermove", x, y - 60, { buttons: 0, pressure: 0 });
	const toolAfter = await api(`[tools.tool, ann.getActiveTool()?.id]`);
	check("the next press returns to the previous tool", toolAfter[0] === "pen" && toolAfter[1] === "ink", JSON.stringify(toolAfter));

	// --- area link
	await tool("areaLink");
	check("the area link tool uses EmbedPDF's capture marquee", (await api(`im.getActiveMode()`)) === "marqueeCapture");
	await page.evaluate(() => (window.clipboard.length = 0));
	await drag(r0.x + 100 * z, r0.y + 300 * z, r0.x + 300 * z, r0.y + 400 * z, 8, 600);
	const areaMenu = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-area-menu .pdf-ink-menu-item")].map((b) => b.textContent.trim()));
	check("dragging an area shows the area link menu", areaMenu.includes("Link") && areaMenu.includes("Embed"), JSON.stringify(areaMenu));
	await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-area-menu .pdf-ink-menu-item")].find((b) => b.textContent.trim() === "Embed").click());
	await page.waitForTimeout(300);
	const areaClip = await page.evaluate(() => window.clipboard);
	const an = (areaClip[0]?.match(/rect=([\d.,]+)/) || [])[1]?.split(",").map(Number) || [];
	check("the area becomes an embed link with the rect in PDF space", areaClip.length === 1 && areaClip[0].startsWith("![[sample.pdf#page=1&rect=") && Math.abs(an[0] - 100) < 3 && Math.abs(an[1] - 442) < 3 && Math.abs(an[2] - 300) < 3 && Math.abs(an[3] - 542) < 3, JSON.stringify(areaClip));
	check("the area menu closes after copying", (await page.evaluate(() => document.querySelectorAll(".pdf-ink-area").length)) === 0);

	// --- following a link into the PDF
	await page.evaluate(() => window.view.setEphemeralState({ subpath: "#page=2&rect=60,600,300,700" }));
	await page.waitForTimeout(900);
	const flashed = await page.evaluate(() => {
		const f = document.querySelector(".pdf-ink-flash");
		return f && [f.closest(".pdf-ink-page").dataset.pageIndex, f.getBoundingClientRect().top];
	});
	check("a link's page and rect scroll into view and flash", flashed && flashed[0] === "1" && flashed[1] > 0 && flashed[1] < 600 && (await api(`scroll.getCurrentPage()`)) === 2, JSON.stringify(flashed));

	// --- toolbar folding
	await tool("pen");
	const level = () => page.evaluate(() => Number(document.querySelector(".pdf-ink-toolbar-host").dataset.level));
	check("at 1200px the toolbar shows everything", (await level()) === 0 && (await page.evaluate(() => !!document.querySelector(".pdf-ink-zoom-level"))));
	await page.evaluate(() => (document.getElementById("leaf").style.width = "640px"));
	await page.waitForTimeout(400);
	const l640 = await level();
	const fits = await page.evaluate(() => {
		const t = document.querySelector(".pdf-ink-toolbar");
		return t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= 640;
	});
	check("at 640px the toolbar still fits", fits, `level ${l640}`);
	await click('.pdf-ink-toolbar [aria-label="Tool options"]');
	await page.waitForTimeout(100);
	const popSwatches = await page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-swatches .pdf-ink-swatch").length);
	check("the tool options popover holds the swatches", popSwatches === 6, popSwatches);
	await page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-swatches .pdf-ink-swatch")[4].click());
	check("picking a colour in the popover changes the pen", (await page.evaluate(() => window.settings.pen.color)) === "#f08c00");
	await page.evaluate(() => (document.getElementById("leaf").style.width = "300px"));
	await page.waitForTimeout(500);
	const l360 = await level();
	const fits360 = await page.evaluate(() => document.querySelector(".pdf-ink-toolbar").getBoundingClientRect().right <= 300);
	check("at 300px the toolbar folds to one drawing tool and a menu", l360 === 4 && fits360 && (await page.evaluate(() => !!document.querySelector(".pdf-ink-more") && document.querySelectorAll(".pdf-ink-toolbar [data-tool]").length === 3)), `level ${l360}`);
	await click(".pdf-ink-more");
	await page.waitForTimeout(100);
	const more = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-popover .pdf-ink-menu-item")].map((b) => b.textContent.trim()));
	check("the overflow menu holds undo, redo, zoom, fit, sidecar and full screen", ["Undo", "Redo", "Fit width", "Fit page", "Open sidecar note", "Full screen"].every((i) => more.includes(i)), JSON.stringify(more));
	await click(".pdf-ink-chevron");
	await page.waitForTimeout(100);
	await page.evaluate(() => document.querySelector('.pdf-ink-popover [data-tool="marker"]').click());
	check("the tool picker switches the drawing tool", (await api(`tools.tool`)) === "marker");
	await page.evaluate(() => (document.getElementById("leaf").style.width = "1200px"));
	await page.waitForTimeout(500);
	check("back at 1200px the toolbar unfolds", (await level()) === 0);

	// --- full screen
	await click('.pdf-ink-toolbar [aria-label="Full screen"]');
	const fs1 = await page.evaluate(() => [document.getElementById("leaf").classList.contains("pdf-ink-fullscreen"), document.body.classList.contains("pdf-ink-fullscreen-active"), document.body.classList.contains("pdf-ink-fullscreen-hide-chrome"), document.querySelector('.pdf-ink-toolbar [aria-label="Exit full screen"]') !== null]);
	check("full screen marks the pane and the body", fs1.every(Boolean), JSON.stringify(fs1));
	await page.evaluate(() => window.view.setFullscreen(false));
	check("leaving full screen clears the classes", await page.evaluate(() => !document.getElementById("leaf").classList.contains("pdf-ink-fullscreen") && !document.body.classList.contains("pdf-ink-fullscreen-active")));

	// --- save, reload, close
	await tool("textHighlight");
	await drag(textX0, textY, textX1, textY, 8, 600);
	const total = await count();
	const ok = await page.evaluate(() => window.view.saveNow(true));
	const saved = await page.evaluate(() => {
		const last = window.saved[window.saved.length - 1];
		const txt = last ? new TextDecoder("latin1").decode(last) : "";
		return { n: window.saved.length, ink: (txt.match(/\/Ink/g) || []).length, hl: (txt.match(/\/Highlight/g) || []).length, header: txt.slice(0, 5) };
	});
	check("save writes the PDF with the ink and highlight annotations", ok === true && saved.n === 1 && saved.ink >= 3 && saved.hl >= 1 && saved.header === "%PDF-", JSON.stringify(saved));
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	check("the saved annotations load back", (await ready()) && (await count()) === total, `${await count()} of ${total}`);
	await page.evaluate(() => (window.saved.length = 0));
	await tool("pen");
	await page.mouse.move(x, y + 200);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 8, y + 200 + (i % 2) * 10);
	await page.mouse.up();
	await page.evaluate(() => window.view.close());
	const closedSave = await page.evaluate(() => window.saved.length);
	check("closing right after a stroke saves it", closedSave === 1, closedSave);

	// A stroke drawn while a save is exporting the PDF must still be written (it is not in those bytes).
	await page.evaluate(() => window.view.onLoadFile(window.file));
	await ready();
	await tool("pen");
	{
		const r = await pageRect(0);
		await page.evaluate(() => {
			const h = window.view.handle, orig = h.save;
			h.save = async () => { const b = await orig(); await new Promise((res) => setTimeout(res, 600)); return b; };
		});
		await stroke(r.x + 100, r.y + 300);
		const before = await count();
		const saving = page.evaluate(() => window.view.saveNow(false));
		await page.waitForTimeout(50);
		await stroke(r.x + 100, r.y + 420);
		await saving;
		const dirtyAfter = await page.evaluate(() => window.view.dirty);
		await page.evaluate(() => window.view.flush());
		await page.evaluate(() => window.view.onLoadFile(window.file));
		await ready();
		await page.waitForTimeout(500);
		const after = await count();
		check("a stroke drawn while a save runs stays unsaved, then is written", dirtyAfter === true && after === before + 1, JSON.stringify({ dirtyAfter, before, after }));
	}

	// --- long document
	await page.evaluate(() => window.run("/long.pdf"));
	check("a 30-page PDF opens", await ready());
	await api(`scroll.scrollToPage({ pageNumber: 12, behavior: "instant" })`);
	await page.waitForTimeout(800);
	await tool("pen");
	const mid = await page.evaluate(() => {
		const r = document.querySelector(".pdf-ink-viewport").getBoundingClientRect();
		return [r.x + r.width / 2, r.y + r.height / 2];
	});
	await stroke(mid[0], mid[1]);
	const deep = await api(`ann.getAnnotations().map((a) => a.object.pageIndex)`);
	const pageInput = await page.evaluate(() => document.querySelector(".pdf-ink-page-input").value);
	await tool("eraser");
	await drag(mid[0] + 40, mid[1] - 30, mid[0] + 40, mid[1] + 60, 8, 300);
	check("the eraser finds the right page deep in a long document", deep.length === 1 && deep[0] >= 9 && (await count()) === 0 && Number(pageInput) >= 10 && Number(pageInput) <= 13, `stroke on ${JSON.stringify(deep)}, page ${pageInput}, left ${await count()}`);

	// --- the reading position is remembered per file (plugin addition) and restored on reopen
	await setScroll((await scrollTop()) + 137);
	await page.waitForTimeout(1200);
	const posBefore = await page.evaluate(() => window.view.handle.position());
	const remembered = await page.evaluate(() => window.positions[window.file.path]);
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	await ready();
	await page.waitForTimeout(600);
	const posAfter = await page.evaluate(() => window.view.handle.position());
	check("the reading position is remembered and restored on reopen", posBefore && remembered && remembered.page === posBefore.page && posAfter && posAfter.page === posBefore.page && Math.abs(posAfter.y - posBefore.y) < 3, `before ${JSON.stringify(posBefore)}, stored ${JSON.stringify(remembered)}, after ${JSON.stringify(posAfter)}`);

	await page.screenshot({ path: path.join(out, "viewer.png") });
	// Pen timing log (diagnostic): off by default, one JSON line per stroke when on.
	await tool("pen");
	await page.evaluate(() => (window.settings.penTimingLog = true));
	await stroke(x + 40, y + 60);
	await page.waitForTimeout(2400);
	const log = await page.evaluate(() => (window.penLog ?? "").trim().split("\n").map((l) => JSON.parse(l)));
	const strokeLine = log.find((l) => l.n === 1);
	check("the pen timing log writes a session line and one line per stroke", log[0]?.session && strokeLine && strokeLine.moves > 0 && typeof strokeLine.downFrame === "number" && typeof strokeLine.firstMoveDt === "number", JSON.stringify(log).slice(0, 300));
	await page.evaluate(() => (window.settings.penTimingLog = false));

	// --- text, arrow and shapes (EmbedPDF's native freeText, lineArrow, line, square and circle tools) on a fresh copy
	await page.evaluate(() => window.run("/sample.pdf"));
	await ready();
	await page.waitForTimeout(300);
	const p0 = await pageRect(0);
	const zz = p0.width / 595;
	const at = (px, py) => [p0.x + px * zz, p0.y + py * zz];
	const objs = () => api(`ann.getAnnotations().map((a) => a.object)`);
	await tool("text");
	check("the text tool activates EmbedPDF's free text tool", (await api(`ann.getActiveTool()?.id`)) === "freeText");
	await page.mouse.click(...at(120, 300));
	await page.waitForTimeout(300);
	const typing = await page.evaluate(() => !!document.activeElement?.isContentEditable);
	check("a tap with the text tool adds a text box and starts typing in it, placeholder selected", typing && (await page.evaluate(() => getSelection().toString())) === "Text" && (await count()) === 1, `editing ${typing}, ${await count()} annotations`);
	const typed = "Hello from PDF Ink, a longer line that needs a wider box";
	await page.keyboard.type(typed);
	// A tap inside the box being typed in moves the caret rather than starting a new box (plugin addition).
	await page.mouse.click(...at(70, 300));
	await page.waitForTimeout(200);
	check("a tap inside the box being typed in keeps typing there", (await count()) === 1 && (await page.evaluate(() => document.activeElement?.isContentEditable)), await count());
	// A real tap on another tool ends typing (EmbedPDF writes the text on blur).
	await page.click('.pdf-ink-toolbar [data-tool="pointer"]');
	await page.waitForTimeout(400);
	const ft = (await objs()).find((o) => o.type === 3);
	check("the typed text is kept in the tool's colour and size", ft && ft.contents === typed && ft.fontColor === "#e03131" && ft.fontSize === 14, JSON.stringify(ft && [ft.contents, ft.fontColor, ft.fontSize]));
	check("the text box grows to fit its text (plugin addition)", ft && ft.rect.size.width > 300, JSON.stringify(ft?.rect));
	const shownText = await page.evaluate(() => [...document.querySelectorAll(".pdf-ink-page span")].filter((e) => e.textContent.includes("Hello from")).map((e) => e.innerText));
	check("the typed text shows once", shownText.length === 1 && shownText[0].trim() === typed, JSON.stringify(shownText));
	await tool("text");
	await page.mouse.click(...at(120, 500));
	await page.waitForTimeout(300);
	await page.click('.pdf-ink-toolbar [data-tool="hand"]');
	await page.waitForTimeout(400);
	check("a text box left empty is removed when typing ends", (await count()) === 1, await count());
	// Text options: colour and size apply to the next box.
	await tool("text");
	await click('.pdf-ink-toolbar [aria-label="Tool options"]');
	await page.waitForTimeout(100);
	await click('.pdf-ink-popover [aria-label="Text size 24"]');
	await click('.pdf-ink-popover [aria-label="Colour #1971c2"]');
	await page.mouse.click(...at(300, 120));
	await page.waitForTimeout(300);
	await page.keyboard.type("Big");
	await page.click('.pdf-ink-toolbar [data-tool="pointer"]');
	await page.waitForTimeout(400);
	const big = (await objs()).find((o) => o.type === 3 && o.contents === "Big");
	check("text size and colour come from the tool options", big && big.fontSize === 24 && big.fontColor === "#1971c2" && big.rect.size.height >= 24, JSON.stringify(big && [big.fontSize, big.fontColor, big.rect]));

	await tool("shape");
	check("the shape tool starts as an arrow (EmbedPDF's lineArrow tool)", (await api(`ann.getActiveTool()?.id`)) === "lineArrow");
	await page.mouse.click(...at(400, 600));
	await page.waitForTimeout(300);
	check("a tap with the shape tool draws nothing", (await count()) === 2, await count());
	await drag(...at(100, 560), ...at(250, 600));
	const arrow = (await objs()).find((o) => o.type === 4);
	check("a drag draws an arrow in the shape colour and width", arrow && arrow.intent === "LineArrow" && arrow.strokeColor === "#e03131" && arrow.strokeWidth === 2 && Math.abs(arrow.linePoints.end.x - 250) < 3 && arrow.lineEndings?.end && arrow.lineEndings.end !== 0, JSON.stringify(arrow && [arrow.intent, arrow.strokeColor, arrow.strokeWidth, arrow.linePoints, arrow.lineEndings]));
	const kind = async (k) => {
		await tool("shape");
		if (!(await page.$(".pdf-ink-popover .pdf-ink-shapes"))) await click('.pdf-ink-toolbar [aria-label="Tool options"]');
		await page.waitForTimeout(80);
		await click(`.pdf-ink-popover [data-shape="${k}"]`);
		await page.waitForTimeout(80);
	};
	await kind("rectangle");
	check("choosing rectangle switches to EmbedPDF's square tool and remembers it", (await api(`ann.getActiveTool()?.id`)) === "square" && (await page.evaluate(() => window.settings.shapeKind)) === "rectangle");
	await click('.pdf-ink-popover [aria-label="Width 4"]');
	await click('.pdf-ink-popover [aria-label="Colour #2f9e44"]');
	await drag(...at(300, 400), ...at(450, 500));
	const rectA = (await objs()).find((o) => o.type === 5);
	check("a drag draws an unfilled rectangle in the chosen colour and width", rectA && rectA.strokeColor === "#2f9e44" && rectA.strokeWidth === 4 && (rectA.color === "transparent" || !rectA.color) && rectA.rect.size.width > 140, JSON.stringify(rectA && [rectA.strokeColor, rectA.strokeWidth, rectA.color, rectA.rect]));
	await kind("ellipse");
	await drag(...at(60, 330), ...at(160, 400));
	await kind("line");
	await drag(...at(300, 540), ...at(450, 590));
	const types = (await objs()).map((o) => o.type + (o.intent ? ":" + o.intent : "")).sort();
	check("ellipse and line draw circle and plain line annotations", types.join() === ["3", "3", "4", "4:LineArrow", "5", "6"].sort().join(), types.join());
	check("the toolbar shape button shows the chosen shape", (await page.evaluate(() => document.querySelector('.pdf-ink-toolbar [data-tool="shape"]').innerHTML)).length > 0);

	// The eraser takes shapes by their outline and text boxes anywhere.
	await tool("eraser");
	await drag(...at(375, 440), ...at(380, 460), 4);
	check("the eraser leaves a rectangle alone when it only crosses the inside", (await objs()).some((o) => o.type === 5), (await objs()).map((o) => o.type).join());
	await drag(...at(375, 380), ...at(375, 420), 6);
	check("the eraser removes a rectangle when it crosses the outline", !(await objs()).some((o) => o.type === 5), (await objs()).map((o) => o.type).join());
	await drag(...at(110, 320), ...at(110, 342), 6);
	check("the eraser removes an ellipse when it crosses the outline", !(await objs()).some((o) => o.type === 6), (await objs()).map((o) => o.type).join());
	await drag(...at(175, 565), ...at(175, 595), 6);
	check("the eraser removes an arrow it crosses", !(await objs()).some((o) => o.intent === "LineArrow"), (await objs()).map((o) => o.type).join());
	await drag(...at(310, 115), ...at(320, 135), 4);
	check("the eraser removes a text box it touches", !(await objs()).some((o) => o.contents === "Big"), (await objs()).map((o) => o.type).join());
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo brings the erased text box back", (await objs()).some((o) => o.contents === "Big"));

	// Recolour a selected text box from its menu (pen colours stay for strokes; text gets the text palette).
	await tool("pointer");
	const ftNow = (await objs()).find((o) => o.contents === typed);
	await page.mouse.click(...at(ftNow.rect.origin.x + 20, ftNow.rect.origin.y + 8));
	await page.waitForTimeout(300);
	const selTypes = await api(`ann.getSelectedAnnotations().map((a) => a.object.type)`);
	const sw = await page.$('.pdf-ink-float [aria-label="#2f9e44"]');
	if (sw) await sw.click();
	await page.waitForTimeout(300);
	const recol = (await objs()).find((o) => o.contents === typed);
	check("a selected text box is recoloured from its menu (font colour)", selTypes.join() === "3" && sw && recol.fontColor === "#2f9e44", JSON.stringify([selTypes, !!sw, recol?.fontColor]));

	// --- text formats and line styles (native: standard fonts, alignment, border dash pattern, line endings)
	await tool("text");
	await click('.pdf-ink-toolbar [aria-label="Tool options"]');
	await page.waitForTimeout(80);
	await click('.pdf-ink-popover [data-font="serif"]');
	await click('.pdf-ink-popover [aria-label="Bold"]');
	await click('.pdf-ink-popover [aria-label="Italic"]');
	await click('.pdf-ink-popover [aria-label="Align center"]');
	await page.mouse.click(...at(400, 220));
	await page.waitForTimeout(300);
	await page.keyboard.type("Fmt");
	await page.click('.pdf-ink-toolbar [data-tool="pointer"]');
	await page.waitForTimeout(400);
	const fmt = (await objs()).find((o) => o.contents === "Fmt");
	check("text takes the chosen font, bold, italic and alignment (Times Bold Italic, centred)", fmt && fmt.fontFamily === 10 && fmt.textAlign === 1, JSON.stringify(fmt && [fmt.fontFamily, fmt.textAlign]));
	const fmtStyle = await page.evaluate(() => { const e = [...document.querySelectorAll(".pdf-ink-page span")].find((x) => x.textContent === "Fmt"); return e && [getComputedStyle(e).fontWeight, getComputedStyle(e).fontStyle]; });
	check("the text box shows bold italic on the page", fmtStyle && Number(fmtStyle[0]) >= 600 && fmtStyle[1] === "italic", JSON.stringify(fmtStyle));
	await page.mouse.click(...at(fmt.rect.origin.x + fmt.rect.size.width / 2, fmt.rect.origin.y + fmt.rect.size.height / 2));
	await page.waitForTimeout(300);
	const boldBtn = await page.$('.pdf-ink-float [aria-label="Bold"]');
	if (boldBtn) await boldBtn.click();
	await page.waitForTimeout(300);
	const unbolded = (await objs()).find((o) => o.contents === "Fmt");
	check("a selected text box's menu toggles bold (Times Italic now)", boldBtn && unbolded.fontFamily === 11, JSON.stringify([!!boldBtn, unbolded?.fontFamily]));
	await kind("arrow");
	await click('.pdf-ink-popover [data-line-style="dashed"]');
	await click('.pdf-ink-popover [data-side="start"] [data-end="closedArrow"]');
	await click('.pdf-ink-popover [data-side="end"] [data-end="circle"]');
	await drag(...at(80, 470), ...at(250, 520));
	const darrow = (await objs()).find((o) => o.type === 4 && o.strokeStyle === 2);
	check("an arrow takes the chosen dashes and ends", darrow && darrow.strokeDashArray?.[0] === 3 * darrow.strokeWidth && darrow.lineEndings?.start === 5 && darrow.lineEndings?.end === 2, JSON.stringify(darrow && [darrow.strokeStyle, darrow.strokeDashArray, darrow.strokeWidth, darrow.lineEndings]));
	await kind("rectangle");
	await click('.pdf-ink-popover [data-line-style="dotted"]');
	check("arrow end choices show only for arrows", (await page.$('.pdf-ink-popover [data-side="start"]')) === null);
	await drag(...at(300, 420), ...at(420, 500));
	const drect = (await objs()).find((o) => o.type === 5);
	check("a rectangle takes the dotted style", drect && drect.strokeStyle === 2 && drect.strokeDashArray?.[0] === Math.max(1, drect.strokeWidth), JSON.stringify(drect && [drect.strokeStyle, drect.strokeDashArray, drect.strokeWidth]));
	await tool("pointer");
	await page.mouse.click(...at(300, 460));
	await page.waitForTimeout(300);
	const solidBtn = await page.$('.pdf-ink-float [aria-label="Solid line"]');
	if (solidBtn) await solidBtn.click();
	await page.waitForTimeout(300);
	const srect = (await objs()).find((o) => o.type === 5);
	check("a selected shape's menu switches it back to a solid line", solidBtn && srect.strokeStyle === 1, JSON.stringify([!!solidBtn, srect?.strokeStyle]));
	await click('.pdf-ink-toolbar [aria-label="Undo"]');
	await page.waitForTimeout(300);
	check("undo brings the dotted line back", (await objs()).find((o) => o.type === 5)?.strokeStyle === 2);
	const savedFmt = await page.evaluate(async () => {
		await window.view.saveNow(true);
		const txt = new TextDecoder("latin1").decode(window.saved[window.saved.length - 1]);
		return [/Times-Italic/.test(txt), /\/D\s*\[/.test(txt), /\/LE\s*\[\s*\/ClosedArrow\s*\/Circle/.test(txt)];
	});
	check("font, dash pattern and line ends are written into the PDF", savedFmt.every(Boolean), JSON.stringify(savedFmt));
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	await ready();
	const reFmt = await objs();
	const ra = reFmt.find((o) => o.type === 4 && o.strokeStyle === 2), rt = reFmt.find((o) => o.contents === "Fmt");
	await page.waitForTimeout(300);
	check("restoring the font on load does not mark the file changed", (await page.evaluate(() => window.view.dirty)) === false);
	check("they load back the same", ra && ra.lineEndings?.start === 5 && ra.lineEndings?.end === 2 && rt && rt.fontFamily === 11 && rt.textAlign === 1, JSON.stringify([ra && [ra.strokeDashArray, ra.lineEndings], rt && [rt.fontFamily, rt.textAlign]]));
	const savedShapes = await page.evaluate(async () => {
		const ok = await window.view.saveNow(true);
		const txt = new TextDecoder("latin1").decode(window.saved[window.saved.length - 1]);
		return [ok, (txt.match(/\/FreeText/g) || []).length, (txt.match(/\/Subtype\s*\/Line/g) || []).length];
	});
	check("text boxes and lines are written into the PDF", savedShapes[0] === true && savedShapes[1] >= 2 && savedShapes[2] >= 1, JSON.stringify(savedShapes));
	const shapesBefore = (await objs()).length;
	await page.evaluate(async () => {
		await window.view.onUnloadFile(window.file);
		await window.view.onLoadFile(window.file);
	});
	await ready();
	const back = await objs();
	check("the text and line load back from the saved PDF", back.length === shapesBefore && back.some((o) => o.type === 3 && o.contents === typed), `${back.length} of ${shapesBefore}: ${back.map((o) => o.type + ":" + (o.contents ?? "")).join("; ")}`);
	await page.screenshot({ path: path.join(out, "shapes.png") });
	await browser.close();
	if (h.failed()) process.exit(1);
})().catch((e) => {
	console.error("FAILED", e);
	process.exit(1);
});
