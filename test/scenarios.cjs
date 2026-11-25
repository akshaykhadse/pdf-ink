// Independent browser scenarios: each one opens a fresh Chromium page, so a
// failure stays in its scenario. Run by `npm test` after test/viewer.cjs.
const { start } = require("./lib.cjs");

/** Each scenario gets the helpers of a fresh page and the settings to open with. */
const scenarios = [];
const scenario = (name, settings, fn) => scenarios.push({ name, settings, fn });

const open = async (h, settings) => {
	await h.page.goto("http://test/");
	const { pdf, ...rest } = settings;
	await h.page.evaluate((s) => (window.settings = window.normalizeSettings({ ...window.DEFAULT_SETTINGS, autosave: false, ...s })), rest);
	await h.page.evaluate((u) => window.run(u), pdf ?? "/sample.pdf");
	return h.ready();
};
const press = (h, combo) => h.page.evaluate((c) => window.view.scope.press(c), combo);
const objs = (h) => h.api(`ann.getAnnotations().map((t) => t.object)`);
const selectFirst = (h) => h.api(`(() => { const o = ann.getAnnotations()[0].object; tools.setTool("pointer"); ann.selectAnnotation(o.pageIndex, o.id); return o.id; })()`);

scenario("keyboard: undo, redo and delete", {}, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	h.check("a stroke is drawn", (await h.count()) === 1);
	await press(h, "Mod+z");
	await h.page.waitForTimeout(200);
	h.check("Mod+Z undoes it", (await h.count()) === 0);
	await press(h, "Mod+Shift+z");
	await h.page.waitForTimeout(200);
	h.check("Mod+Shift+Z redoes it", (await h.count()) === 1);
	await selectFirst(h);
	await h.page.waitForTimeout(200);
	await press(h, "Delete");
	await h.page.waitForTimeout(200);
	h.check("Delete removes the selected annotation", (await h.count()) === 0);
	await press(h, "Mod+y");
	await h.page.waitForTimeout(200);
	h.check("Mod+Y redoes too (the delete is undone first with Mod+Z)", (await h.count()) === 0);
	await press(h, "Mod+z");
	await h.page.waitForTimeout(200);
	h.check("undoing the delete brings it back", (await h.count()) === 1);
	const typing = await h.page.evaluate(() => {
		const el = document.createElement("div");
		el.contentEditable = "true";
		document.body.appendChild(el);
		el.focus();
		const passed = window.view.scope.press("Mod+z");
		el.remove();
		return passed;
	});
	h.check("keys pass through while typing in a text box", typing === true && (await h.count()) === 1);
});

scenario("a selected annotation's width, opacity and text size", {}, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	await selectFirst(h);
	await h.page.waitForTimeout(300);
	await h.page.locator('.pdf-ink-menu-item[aria-label="Width and opacity"]').click();
	await h.page.locator('.pdf-ink-menu-style [aria-label="Width 4"]').click();
	await h.page.waitForTimeout(300);
	h.check("a width from the menu restyles the stroke", (await objs(h))[0].strokeWidth === 4, (await objs(h))[0].strokeWidth);
	await h.page.evaluate(() => {
		const el = document.querySelector('.pdf-ink-menu-style input[type="range"]');
		el.value = "60";
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.value = "40";
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await h.page.waitForTimeout(300);
	h.check("the opacity slider restyles it once, when let go", Math.abs((await objs(h))[0].opacity - 0.4) < 0.01, (await objs(h))[0].opacity);
	await h.api(`tools.undo()`);
	await h.page.waitForTimeout(200);
	await h.api(`tools.undo()`);
	await h.page.waitForTimeout(200);
	h.check("each change is one undo step", (await objs(h))[0].strokeWidth === 2 && (await objs(h))[0].opacity === 1, JSON.stringify((await objs(h)).map((o) => [o.strokeWidth, o.opacity])));
	h.check("the toolbar pen style is unchanged", (await h.page.evaluate(() => window.settings.pen.width)) === 2);
});

scenario("autosave writes a moment after a change", { autosave: true }, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	h.check("nothing is written at once", (await h.page.evaluate(() => window.saved.length)) === 0);
	await h.page.waitForTimeout(3200);
	const saved = await h.page.evaluate(() => window.saved.length);
	h.check("the PDF is written after the quiet time", saved === 1 && (await h.page.evaluate(() => window.view.dirty)) === false, saved);
});

scenario("Mod+S saves, Escape leaves full screen", {}, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	await press(h, "Mod+s");
	await h.page.waitForTimeout(800);
	h.check("Mod+S writes the PDF", (await h.page.evaluate(() => window.saved.length)) === 1);
	await h.page.evaluate(() => window.view.setFullscreen(true));
	h.check("full screen is on", await h.page.evaluate(() => window.view.isFullscreen()));
	const handled = await press(h, "Escape");
	h.check("Escape leaves full screen", handled === false && !(await h.page.evaluate(() => window.view.isFullscreen())));
	h.check("Escape is left to Obsidian when not full screen", (await press(h, "Escape")) === true);
});

scenario("a change made elsewhere", {}, async (h) => {
	const before = await h.count();
	// Another device adds nothing but rewrites the file: while clean, the view reloads it.
	await h.page.evaluate(() => {
		window.view.handle.tools.notify();
		window.reloads = 0;
		const orig = window.view.onLoadFile.bind(window.view);
		window.handlers["vault:modify"](window.file);
	});
	await h.ready();
	h.check("a clean view reloads the changed file", (await h.count()) === before);
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	await h.page.evaluate(() => {
		window.notices = [];
		window.handlers["vault:modify"](window.file);
	});
	await h.page.waitForTimeout(300);
	const notices = await h.page.evaluate(() => window.notices);
	h.check("a dirty view keeps its annotations and says the file changed", (await h.count()) === 1 && notices.some((n) => n.includes("changed elsewhere")), JSON.stringify(notices));
});

scenario("zoom buttons, page box and fit page", {}, async (h) => {
	const zoom = () => h.api(`zoom.getState().currentZoomLevel`);
	const z0 = await zoom();
	await h.click('.pdf-ink-toolbar [aria-label="Zoom in"]');
	await h.page.waitForTimeout(400);
	const z1 = await zoom();
	h.check("zoom in zooms in", z1 > z0, `${z0} -> ${z1}`);
	await h.click('.pdf-ink-toolbar [aria-label="Fit width"]');
	await h.page.waitForTimeout(400);
	h.check("the zoom percentage fits the width again", Math.abs((await zoom()) - z0) < 0.01);
	await h.page.evaluate(() => {
		const input = document.querySelector(".pdf-ink-page-input");
		input.value = "3";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await h.page.waitForTimeout(1200);
	h.check("the page box goes to page 3", (await h.api(`scroll.getCurrentPage()`)) === 3, await h.api(`scroll.getCurrentPage()`));
	await h.api(`tools.fitPage()`);
	await h.page.waitForTimeout(400);
	h.check("fit page shows a whole page", (await zoom()) < z0);
});

scenario("undo and redo of a drawn shape", {}, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("shape");
	await h.drag(r.x + 100, r.y + 200, r.x + 300, r.y + 300);
	h.check("an arrow is drawn", (await h.count()) === 1);
	await h.api(`tools.undo()`);
	await h.page.waitForTimeout(200);
	h.check("undo removes it", (await h.count()) === 0);
	await h.api(`tools.redo()`);
	await h.page.waitForTimeout(200);
	h.check("redo brings it back", (await h.count()) === 1);
});

scenario("an eraser stroke across two pages", {}, async (h) => {
	// Scroll so the end of page 1 and the top of page 2 are both on screen.
	await h.setScroll((await h.pageRect(0)).height - 600);
	const r0 = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r0.x + 100, r0.y + r0.height - 40);
	const r1 = await h.pageRect(1);
	await h.stroke(r1.x + 100, r1.y + 30);
	h.check("two strokes, one per page", (await h.count()) === 2);
	await h.tool("eraser");
	await h.drag(r0.x + 140, r0.y + r0.height - 60, r1.x + 140, r1.y + 50, 30);
	h.check("one eraser stroke removes both", (await h.count()) === 0, await h.count());
	await h.api(`tools.undo()`);
	await h.page.waitForTimeout(300);
	h.check("one undo brings both back", (await h.count()) === 2, await h.count());
});

scenario("hidden tools, start tool and dark pages", { hiddenTools: ["image", "areaLink"], startTool: "pen", darkPages: "always" }, async (h) => {
	const shown = await h.page.evaluate(() => [...document.querySelectorAll(".pdf-ink-toolbar [data-tool]")].map((b) => b.dataset.tool));
	h.check("hidden tools are not on the toolbar", !shown.includes("image") && !shown.includes("areaLink") && shown.includes("pen"), shown.join());
	h.check("the PDF opens with the start tool", (await h.api(`tools.tool`)) === "pen");
	const filter = await h.page.evaluate(() => getComputedStyle(document.querySelector(".pdf-ink-page")).filter);
	h.check("dark pages invert the pages", filter.includes("invert"), filter);
	await h.page.evaluate(() => {
		window.settings.darkPages = "off";
		window.settings.hiddenTools = [];
		window.view.settingsChanged();
	});
	await h.page.waitForTimeout(200);
	h.check("turning them off in the settings applies at once", !(await h.page.evaluate(() => getComputedStyle(document.querySelector(".pdf-ink-page")).filter.includes("invert"))) && (await h.page.$('.pdf-ink-toolbar [data-tool="image"]')) !== null);
});

scenario("start with the last tool", { startTool: "last" }, async (h) => {
	await h.tool("marker");
	await h.page.evaluate(() => window.view.onLoadFile(window.file));
	await h.ready();
	h.check("reopening starts with the tool used last", (await h.api(`tools.tool`)) === "marker");
});

scenario("pen side button set to nothing", { penButton: "off" }, async (h) => {
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.pen("pointermove", r.x + 200, r.y + 200, { buttons: 2, pressure: 0 });
	await h.pen("pointermove", r.x + 202, r.y + 200, { buttons: 0, pressure: 0 });
	h.check("a side-button press leaves the tool alone", (await h.api(`tools.tool`)) === "pen");
});

scenario("add and delete pages", { pdf: "/mixed.pdf" }, async (h) => {
	const sizes = () => h.api(`reg.getPlugin("scroll").provides(), window.view.handle && Array.from({ length: tools.state().pages }, (_, i) => { const s = window.view.handle.pageSize(i); return s.width + "x" + s.height; }).join(",")`);
	const waitOpen = async () => {
		for (let i = 0; i < 100 && (await h.page.evaluate(() => window.view.editingPages)); i++) await h.page.waitForTimeout(50);
		await h.ready();
		for (let i = 0; i < 100 && (await h.page.evaluate(() => window.view.restoring)); i++) await h.page.waitForTimeout(50);
		await h.page.waitForTimeout(300);
	};
	h.check("the sample has three pages of different sizes", (await sizes()) === "595x842,842x595,420x595", await sizes());
	const r = await h.pageRect(0);
	await h.tool("pen");
	await h.stroke(r.x + 100, r.y + 200);
	await h.api(`tools.goToPage(2)`);
	await h.page.waitForTimeout(800);
	h.check("page 2 is in view", (await h.api(`tools.state().page`)) === 2);
	await h.click(".pdf-ink-pages-btn");
	const items = await h.page.evaluate(() => [...document.querySelectorAll(".pdf-ink-popover .pdf-ink-menu-item")].map((b) => b.textContent.trim()));
	h.check("the pages button offers add after, add before and delete", items.join("|") === "Add blank page after page 2|Add blank page before page 2|Delete page 2…", items.join("|"));
	await h.page.evaluate(() => document.querySelectorAll(".pdf-ink-popover .pdf-ink-menu-item")[0].click());
	await h.page.waitForTimeout(30);
	h.check("keys leave the document alone while the page is added", (await h.page.evaluate(() => window.view.editingPages && window.view.scope.press("Mod+z") === false)) && (await h.count()) === 1);
	await waitOpen();
	h.check("the reader is told undo starts afresh", (await h.page.evaluate(() => window.notices.at(-1))).startsWith("Added a blank page 3."));
	h.check("a blank page as big as page 2 follows it", (await sizes()) === "595x842,842x595,842x595,420x595", await sizes());
	h.check("the new page is in view", (await h.api(`tools.state().page`)) === 3, await h.api(`tools.state().page`));
	h.check("the file was written once, with the unsaved stroke in it", (await h.page.evaluate(() => window.saved.length)) === 1 && (await h.page.evaluate(() => new TextDecoder("latin1").decode(window.saved[0]).includes("/Ink"))));
	h.check("the stroke is still on page 1", (await h.api(`ann.getAnnotations().map((t) => t.object.pageIndex).join()`)) === "0");
	const textOf = (i) => h.page.evaluate((i) => { const h0 = window.view.handle; const doc = h0.registry.getStore().getState().core.documents[h0.documentId].document; return new Promise((r) => h0.registry.getEngine().extractText(doc, [i]).wait(r, () => r("ERR"))); }, i);
	h.check("the new page is blank and the others keep their text", (await textOf(2)).trim() === "" && (await textOf(1)).includes("Page 2 of 3") && (await textOf(3)).includes("Page 3 of 3"));

	await h.api(`tools.goToPage(1)`);
	await h.page.waitForTimeout(800);
	await h.page.evaluate(() => window.view.requestPageEdit("insertBefore"));
	await waitOpen();
	h.check("adding before page 1 makes a page as big as page 1", (await sizes()) === "595x842,595x842,842x595,842x595,420x595", await sizes());
	h.check("the stroke moved to page 2 with its page", (await h.api(`ann.getAnnotations().map((t) => t.object.pageIndex).join()`)) === "1");
	h.check("the new first page is in view", (await h.api(`tools.state().page`)) === 1);

	await h.api(`tools.goToPage(2)`);
	await h.page.waitForTimeout(800);
	await h.page.evaluate(() => window.view.requestPageEdit("delete"));
	h.check("deleting asks first and changes nothing yet", (await h.page.evaluate(() => window.modals?.length)) === 1 && (await h.page.evaluate(() => window.saved.length)) === 2);
	await h.page.evaluate(() => window.modals[0].onConfirm());
	await waitOpen();
	h.check("the page with the stroke is gone", (await sizes()) === "595x842,842x595,842x595,420x595" && (await h.count()) === 0, (await sizes()) + " / " + (await h.count()));
	h.check("the page after it is in view", (await h.api(`tools.state().page`)) === 2);

	await h.tool("pen");
	const r2 = await h.pageRect(1);
	await h.stroke(r2.x + 100, r2.y + 200);
	h.check("drawing works on the reopened file", (await h.count()) === 1);
	await h.page.evaluate(() => window.view.saveNow(false));
	const last = await h.page.evaluate(() => { const b = window.saved[window.saved.length - 1]; return new TextDecoder("latin1").decode(b); });
	h.check("and saves", last.includes("/Ink"));
	await h.page.evaluate(() => window.view.requestPageEdit("delete"));
	await h.page.evaluate(() => window.modals[1].onConfirm());
	await waitOpen();
	await h.page.evaluate(() => window.view.requestPageEdit("delete"));
	await h.page.evaluate(() => window.modals[2].onConfirm());
	await waitOpen();
	await h.page.evaluate(() => window.view.requestPageEdit("delete"));
	await h.page.evaluate(() => window.modals[3].onConfirm());
	await waitOpen();
	const n = await h.api(`tools.state().pages`);
	await h.page.evaluate(() => window.view.requestPageEdit("delete"));
	h.check("the last page cannot be deleted", n === 1 && (await h.page.evaluate(() => window.modals.length)) === 4 && (await h.api(`tools.state().pages`)) === 1, n);
});

scenario("a blank page beside a rotated page", { pdf: "/rotated.pdf" }, async (h) => {
	await h.page.evaluate(() => window.view.requestPageEdit("insertAfter"));
	await h.page.waitForTimeout(50);
	for (let i = 0; i < 100 && (await h.page.evaluate(() => window.view.editingPages)); i++) await h.page.waitForTimeout(50);
	await h.ready();
	const pages = await h.api(`[0, 1, 2].map((i) => JSON.stringify(window.view.handle.pageSize(i))).join()`);
	h.check("it takes the rotated page's size and /Rotate", pages === '{"width":595,"height":842,"rotation":1},{"width":595,"height":842,"rotation":1},{"width":595,"height":842,"rotation":0}', pages);
});

(async () => {
	let failed = false;
	const only = process.argv[2];
	for (const s of scenarios) {
		if (only && !s.name.includes(only)) continue;
		console.log(`-- ${s.name}`);
		const h = await start();
		try {
			if (!(await open(h, s.settings))) throw new Error("the PDF did not open");
			await s.fn(h);
		} catch (e) {
			h.check(`${s.name} ran`, false, e.message);
		}
		if (h.failed()) failed = true;
		await h.browser.close();
	}
	if (failed) process.exit(1);
})();
