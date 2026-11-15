/**
 * Pointer handling that EmbedPDF does not do itself (none of this is native):
 *
 *  - Stylus mode: while a drawing tool is active, fingers are kept from
 *    EmbedPDF and scroll the viewport instead (one finger scrolls with a
 *    fling, two fingers reach EmbedPDF's pinch zoom, which listens to touch
 *    events and is left alone).
 *  - The eraser: pen and mouse events are intercepted and matched against the
 *    annotations of the page under the pointer. A press of the pen's side
 *    button while hovering switches to the eraser, and the next press back.
 *  - Full pen sample rate: browsers deliver one pointermove per frame and fold
 *    the rest into getCoalescedEvents(); EmbedPDF reads only the event itself,
 *    so the folded samples are re-dispatched ahead of it.
 *  - Android reports the pen as touch events too, and Obsidian's edge swipe
 *    (which opens the side panels) listens to those: the pen's own touch
 *    events are stopped while it is on the page.
 *  - A stale DOM text selection would start a native drag on the next pen-down
 *    and swallow the stroke: dragstart is blocked.
 *  - Text first with the pointer tool: EmbedPDF selects an annotation on
 *    pointer-down, so text under a stroke or highlight could not be selected.
 *    Unselected annotations are made transparent to the pointer (CSS, class
 *    is-pointer), so a drag selects text (or draws a box) as if they were not
 *    there; a tap that did not move is hit-tested against the annotations'
 *    shapes afterwards and selects the one under it. Backlink boxes work the
 *    same way: a drag selects the text inside, a tap opens the note.
 */
import type { Settings } from "./settings";
import { CIRCLE, FREETEXT, HIGHLIGHT, INK, LINE, POLYGON, POLYLINE, SQUARE, type ToolController } from "./tools";

interface PagePoint {
	pageIndex: number;
	/** PDF points from the page's top-left corner (EmbedPDF's page space). */
	x: number;
	y: number;
	/** Rendered pixels per PDF point. */
	scale: number;
	/** The page's client rect when it was located. */
	rect?: DOMRect;
}

/** A touch this close to the pen's contact point (CSS px) is the pen itself. */
const PEN_TOUCH_RADIUS = 48;
/** Pen buttons that mean "erase": primary while hovering (S Pen), barrel (2) or eraser end (32). */
const ERASER_BUTTONS = 1 | 2 | 32;
/** How far (CSS px) a press may move and still count as a tap, by pointer type. */
const TAP_SLOP: Record<string, number> = { mouse: 5, pen: 8, touch: 10 };

function nearRect(o: { x: number; y: number }, sz: { width: number; height: number }, x: number, y: number, pad: number): boolean {
	return x >= o.x - pad && x <= o.x + sz.width + pad && y >= o.y - pad && y <= o.y + sz.height + pad;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether an ink stroke, highlight, text box, line or shape is within `radius` page units of the point. */
export function annotationHit(a: any, x: number, y: number, radius: number): boolean {
	const box = a?.rect, o = box?.origin, sz = box?.size;
	// Cheap reject first: nothing of an annotation lies outside its rect (padded for the stroke).
	if (o && sz && !nearRect(o, sz, x, y, radius + (a.strokeWidth ?? 1))) return false;
	if (a?.type === FREETEXT) {
		// A text box goes when the eraser touches it anywhere.
		return !!o && !!sz && x >= o.x - radius && x <= o.x + sz.width + radius && y >= o.y - radius && y <= o.y + sz.height + radius;
	}
	if (a?.type === LINE) {
		const p = a.linePoints;
		if (!p?.start || !p?.end) return false;
		return segmentDistance(x, y, p.start.x, p.start.y, p.end.x, p.end.y) <= radius + (a.strokeWidth ?? 1) / 2;
	}
	if (a?.type === SQUARE || a?.type === CIRCLE) {
		// Outlines only: the eraser has to cross the border, as with a stroke (the inside is empty).
		if (!o || !sz) return false;
		const w = a.strokeWidth ?? 1, r = radius + w / 2;
		const left = o.x + w / 2, top = o.y + w / 2, right = o.x + sz.width - w / 2, bottom = o.y + sz.height - w / 2;
		if (a.type === SQUARE) {
			const corners: [number, number][] = [[left, top], [right, top], [right, bottom], [left, bottom]];
			return corners.some(([ax, ay], i) => segmentDistance(x, y, ax, ay, corners[(i + 1) % 4][0], corners[(i + 1) % 4][1]) <= r);
		}
		const cx = (left + right) / 2, cy = (top + bottom) / 2, rx = Math.max(0, (right - left) / 2), ry = Math.max(0, (bottom - top) / 2);
		const n = 48;
		let px = cx + rx, py = cy;
		for (let i = 1; i <= n; i++) {
			const t = (i / n) * 2 * Math.PI, qx = cx + rx * Math.cos(t), qy = cy + ry * Math.sin(t);
			if (segmentDistance(x, y, px, py, qx, qy) <= r) return true;
			(px = qx), (py = qy);
		}
		return false;
	}
	if (a?.type === HIGHLIGHT) {
		const boxes: any[] = Array.isArray(a.segmentRects) && a.segmentRects.length ? a.segmentRects : a.rect ? [a.rect] : [];
		return boxes.some((b) => {
			const o = b?.origin, sz = b?.size;
			if (!o || !sz) return false;
			return x >= o.x - radius && x <= o.x + sz.width + radius && y >= o.y - radius && y <= o.y + sz.height + radius;
		});
	}
	if (a?.type !== INK || !Array.isArray(a.inkList)) return false;
	const r = radius + (a.strokeWidth ?? 1) / 2;
	for (const stroke of a.inkList) {
		const pts = stroke?.points ?? [];
		if (pts.length === 1 && Math.hypot(pts[0].x - x, pts[0].y - y) <= r) return true;
		for (let i = 1; i < pts.length; i++) if (segmentDistance(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r) return true;
	}
	return false;
}


const filled = (a: any) => !!a.color && a.color !== "transparent";

/**
 * Whether a tap at (x, y) page units lands on an annotation's shape, within
 * `radius`: strokes and highlights as for the eraser, lines and polylines by
 * their segments, hollow boxes and ellipses by their outline, anything else
 * (text, images, filled shapes) by its rectangle.
 */
export function tapHit(a: any, x: number, y: number, radius: number): boolean {
	if (a?.type === INK || a?.type === HIGHLIGHT) return annotationHit(a, x, y, radius);
	const o = a?.rect?.origin, sz = a?.rect?.size;
	if (!o || !sz) return false;
	if (x < o.x - radius || x > o.x + sz.width + radius || y < o.y - radius || y > o.y + sz.height + radius) return false;
	const r = radius + (a.strokeWidth ?? 1) / 2;
	const near = (pts: { x: number; y: number }[], closed: boolean) => {
		for (let i = 1; i < pts.length; i++) if (segmentDistance(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r) return true;
		return closed && pts.length > 2 && segmentDistance(x, y, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= r;
	};
	if (a.type === LINE && a.linePoints?.start && a.linePoints?.end) return near([a.linePoints.start, a.linePoints.end], false);
	if ((a.type === POLYLINE || a.type === POLYGON) && Array.isArray(a.vertices) && a.vertices.length) {
		if (a.type === POLYGON && filled(a)) return true; // inside the rect is close enough for a filled polygon
		return near(a.vertices, a.type === POLYGON);
	}
	if (a.type === SQUARE && !filled(a)) {
		const inner = x > o.x + r && x < o.x + sz.width - r && y > o.y + r && y < o.y + sz.height - r;
		return !inner;
	}
	if (a.type === CIRCLE) {
		const rx = sz.width / 2, ry = sz.height / 2;
		if (rx <= 0 || ry <= 0) return false;
		const d = Math.hypot((x - o.x - rx) / rx, (y - o.y - ry) / ry);
		if (filled(a)) return d <= 1 + r / Math.min(rx, ry);
		return Math.abs(d - 1) * Math.min(rx, ry) <= r;
	}
	return true;
}

export class PointerGuard {
	/** Whether the pen's side button was down on the last hover sample. */
	private buttonHeld = false;
	private readonly cursor: HTMLElement;
	private readonly off: (() => void)[] = [];
	/** Fingers whose events are kept from EmbedPDF (decided when they land). */
	private readonly blocked = new Set<number>();
	private readonly fingers = new Set<number>();
	private scroller: { id: number; x: number; y: number; vx: number; vy: number; t: number; el: HTMLElement } | null = null;
	private fling = 0;
	/** Pens and mice that are down, with whether the eraser owns them. */
	private readonly pens = new Map<number, boolean>();
	private erasing: { id: number; last: PagePoint | null } | null = null;
	/** Where the pen last touched the page, while it is down. */
	private penAt: { id: number; x: number; y: number } | null = null;
	/** True while the coalesced samples of a move are being re-dispatched. */
	private replaying = false;
	/** How each active touch was classified when it landed (stylus mode may change mid-touch). */
	/** What each touch is: a finger (scrolls), a pen stand-in (draws), or an extra touch while something already draws (ignored). */
	private readonly kinds = new Map<number, "finger" | "pen" | "extra">();
	/** What the current eraser stroke has removed, recorded as one undo step when it ends. */
	private erased: any[] = [];
	private readonly win: Window;
	/** A pointer-tool press that may still turn out to be a tap on an annotation. */
	private tap: { id: number; x: number; y: number; slop: number } | null = null;

	constructor(private readonly root: HTMLElement, private readonly tools: ToolController, private readonly settings: () => Settings, private readonly onErased: () => void) {
		this.win = root.ownerDocument.defaultView ?? window;
		this.cursor = root.ownerDocument.createElement("div");
		this.cursor.className = "pdf-ink-eraser-cursor";
		this.cursor.hidden = true;
		root.appendChild(this.cursor);
		const on = (type: string, fn: (e: PointerEvent) => void) => {
			const listener = fn as EventListener;
			root.addEventListener(type, listener, { capture: true });
			this.off.push(() => root.removeEventListener(type, listener, { capture: true }));
		};
		on("pointerdown", (e) => this.onDown(e));
		on("pointermove", (e) => this.onMove(e));
		on("pointerup", (e) => this.onUp(e));
		on("pointercancel", (e) => this.onUp(e));
		on("pointerleave", (e) => {
			if (e.pointerType !== "touch" && !this.erasing) this.cursor.hidden = true;
		});
		const noDrag = (e: Event) => e.preventDefault();
		root.addEventListener("dragstart", noDrag, true);
		this.off.push(() => root.removeEventListener("dragstart", noDrag, true));
		// A release outside the viewer still ends the pointer (bubble phase: the root's capture handlers ran first).
		const forget = (e: Event) => this.forget(e as PointerEvent);
		const win = this.win;
		win.addEventListener("pointerup", forget);
		win.addEventListener("pointercancel", forget);
		const penTouch = (e: Event) => this.blockPenTouch(e as TouchEvent);
		const touchTypes = ["touchstart", "touchmove", "touchend", "touchcancel"];
		for (const t of touchTypes) win.addEventListener(t, penTouch, { capture: true, passive: false });
		this.off.push(() => {
			win.removeEventListener("pointerup", forget);
			win.removeEventListener("pointercancel", forget);
			for (const t of touchTypes) win.removeEventListener(t, penTouch, true);
		});
		this.off.push(tools.subscribe(() => this.sync()));
		this.sync();
	}

	destroy() {
		for (const off of this.off) off();
		this.off.length = 0;
		this.fling++;
		this.cursor.remove();
	}

	/** Re-applies the touch policy classes; runs whenever the tool state changes. */
	sync() {
		this.root.classList.toggle("is-guarding", this.blockingFingers());
		// Stylus mode off with a drawing tool: fingers draw, so pages must not scroll natively.
		this.root.classList.toggle("is-touch-draw", !this.tools.stylusMode && this.tools.penOnly);
		// Hand tool: nothing on the page is clickable, so a drag over a stroke pans instead of selecting it.
		this.root.classList.toggle("is-hand", this.tools.tool === "hand");
		// Pointer tool: unselected annotations let presses through to the text; taps are hit-tested by the guard.
		this.root.classList.toggle("is-pointer", this.tools.tool === "pointer");
		if (this.tools.tool !== "pointer") this.tap = null;
		if (!this.eraserActive()) this.cursor.hidden = true;
	}

	// ----------------------------------------------------------------- helpers

	private eraserActive() {
		return this.tools.tool === "eraser";
	}

	private blockingFingers(): boolean {
		return this.tools.stylusMode && (this.tools.penOnly || this.pens.size > 0);
	}

	/** The scrolling viewport under a point, or null over the toolbar. */
	private viewportAt(x: number, y: number): HTMLElement | null {
		for (const el of this.root.ownerDocument.elementsFromPoint(x, y)) {
			if (!this.root.contains(el)) continue;
			if (el.classList.contains("pdf-ink-viewport")) return el as HTMLElement;
		}
		return null;
	}

	/**
	 * Maps a client point to page coordinates. Compares the point with the
	 * rendered pages' rects (only a few are in the DOM) rather than hit testing,
	 * which walks every annotation element on a dense page.
	 */
	locate(clientX: number, clientY: number): PagePoint | null {
		const viewport = this.root.querySelector(".pdf-ink-viewport")?.getBoundingClientRect();
		if (!viewport || clientX < viewport.left || clientX > viewport.right || clientY < viewport.top || clientY > viewport.bottom) return null;
		let page: HTMLElement | null = null, rect: DOMRect | null = null;
		for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".pdf-ink-page"))) {
			const r = el.getBoundingClientRect();
			if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
				page = el;
				rect = r;
				break;
			}
		}
		if (!page || !rect) return null;
		const scale: number | undefined = this.tools.registry?.getPlugin("zoom")?.provides()?.forDocument(this.tools.documentId)?.getState()?.currentZoomLevel;
		if (!scale) return null;
		return { pageIndex: Number(page.dataset.pageIndex), x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale, rect };
	}

	private blockPenTouch(e: TouchEvent) {
		// Stylus mode off with the pointer or a drawing tool: fingers act on the page, so two fingers must not pinch either.
		if (!this.tools.stylusMode && this.tools.penOnly && e.touches.length > 1 && this.root.contains(e.target as Node)) {
			e.stopImmediatePropagation();
			return;
		}
		const pen = this.penAt;
		if (!pen || e.touches.length > 1) return;
		for (let i = 0; i < e.changedTouches.length; i++) {
			const t = e.changedTouches[i];
			if (Math.hypot(t.clientX - pen.x, t.clientY - pen.y) <= PEN_TOUCH_RADIUS) {
				e.stopImmediatePropagation();
				return;
			}
		}
	}

	/**
	 * In stylus mode a touch is a finger; otherwise it is treated like a pen.
	 * Decided once when the touch lands, so a stylus-mode toggle mid-touch cannot strand it.
	 */
	private isFinger(e: PointerEvent): boolean {
		if (e.pointerType !== "touch") return false;
		const known = this.kinds.get(e.pointerId);
		if (known) return known === "finger";
		return this.tools.stylusMode;
	}

	private swallowExtra(e: PointerEvent): boolean {
		if (this.kinds.get(e.pointerId) !== "extra") return false;
		e.stopPropagation();
		e.preventDefault();
		return true;
	}

	private forget(e: PointerEvent) {
		if (this.kinds.get(e.pointerId) === "extra") {
			this.kinds.delete(e.pointerId);
			return;
		}
		const finger = this.isFinger(e);
		this.kinds.delete(e.pointerId);
		if (finger) {
			this.fingers.delete(e.pointerId);
			this.blocked.delete(e.pointerId);
			if (this.scroller?.id === e.pointerId) this.scroller = null;
		} else {
			this.pens.delete(e.pointerId);
			if (this.erasing?.id === e.pointerId) this.endEraserStroke();
			if (this.penAt?.id === e.pointerId) this.penAt = null;
		}
		if (this.pens.size === 0 && this.fingers.size === 0) this.sync();
	}

	private endEraserStroke() {
		this.erasing = null;
		const erased = this.erased;
		this.erased = [];
		if (erased.length) this.tools.recordDeletion(erased);
	}

	// ------------------------------------------------------------------ events

	private onDown(e: PointerEvent) {
		if (e.pointerType === "touch") {
			// Stylus mode off: the first touch draws; a second finger landing while a pointer draws is swallowed,
			// else EmbedPDF's ink tool would weave both into one zigzag stroke.
			const extra = !this.tools.stylusMode && this.pens.size > 0;
			this.kinds.set(e.pointerId, extra ? "extra" : this.tools.stylusMode ? "finger" : "pen");
		}
		if (this.swallowExtra(e)) return;
		if (this.isFinger(e)) {
			this.fingers.add(e.pointerId);
			if (!this.blockingFingers()) return;
			this.blocked.add(e.pointerId);
			e.stopPropagation();
			this.fling = 0;
			if (this.pens.size > 0) {
				this.scroller = null; // a palm landing while the pen writes must not drag the page
			} else if (this.fingers.size === 1) {
				const el = this.viewportAt(e.clientX, e.clientY);
				this.scroller = el ? { id: e.pointerId, x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: e.timeStamp, el } : null;
			} else {
				this.scroller = null; // a second finger: EmbedPDF's pinch takes over
			}
			return;
		}
		this.noteTap(e);
		const intercept = this.eraserActive() && this.viewportAt(e.clientX, e.clientY) !== null;
		this.pens.set(e.pointerId, intercept);
		if (e.pointerType === "pen") {
			if (this.viewportAt(e.clientX, e.clientY)) this.penAt = { id: e.pointerId, x: e.clientX, y: e.clientY };
			this.sync();
		}
		if (!intercept) return;
		e.stopPropagation();
		e.preventDefault();
		try {
			this.root.setPointerCapture(e.pointerId);
		} catch {
			/* synthetic events have no active pointer */
		}
		this.erasing = { id: e.pointerId, last: null };
		this.erased = [];
		this.showCursor(e);
		this.eraseAt([e]);
	}

	private replayCoalesced(e: PointerEvent) {
		if (this.replaying || !e.isTrusted || typeof e.getCoalescedEvents !== "function") return;
		if (!this.settings().fullPenRate) return;
		const tool = this.tools.tool;
		if ((tool !== "pen" && tool !== "marker") || !(e.target instanceof Element)) return;
		const events = e.getCoalescedEvents();
		if (events.length < 2) return;
		this.replaying = true;
		try {
			for (let i = 0; i < events.length - 1; i++) {
				const c = events[i];
				e.target.dispatchEvent(
					new PointerEvent("pointermove", {
						bubbles: true,
						cancelable: true,
						composed: true,
						clientX: c.clientX,
						clientY: c.clientY,
						screenX: c.screenX,
						screenY: c.screenY,
						pointerId: e.pointerId,
						pointerType: e.pointerType,
						isPrimary: e.isPrimary,
						buttons: e.buttons,
						button: -1,
						pressure: c.pressure,
						tiltX: c.tiltX,
						tiltY: c.tiltY,
					})
				);
			}
		} finally {
			this.replaying = false;
		}
	}

	private onMove(e: PointerEvent) {
		if (this.replaying) return;
		if (this.swallowExtra(e)) return;
		if (this.isFinger(e)) {
			if (!this.blocked.has(e.pointerId)) return;
			e.stopPropagation();
			const s = this.scroller;
			if (s && s.id === e.pointerId && this.blocked.size === 1) {
				const dx = e.clientX - s.x, dy = e.clientY - s.y;
				const dt = Math.max(1, e.timeStamp - s.t);
				s.el.scrollTop -= dy;
				s.el.scrollLeft -= dx;
				s.vx = 0.8 * s.vx + 0.2 * (dx / dt);
				s.vy = 0.8 * s.vy + 0.2 * (dy / dt);
				s.x = e.clientX;
				s.y = e.clientY;
				s.t = e.timeStamp;
			}
			return;
		}
		if (this.tap?.id === e.pointerId && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > this.tap.slop) this.tap = null;
		if (this.pens.has(e.pointerId) && e.buttons === 0) this.forget(e); // a release nobody saw
		const down = this.pens.has(e.pointerId);
		if (down && this.penAt?.id === e.pointerId) {
			this.penAt.x = e.clientX;
			this.penAt.y = e.clientY;
		}
		if (e.pointerType === "pen" && !down) {
			// Side button while hovering: buttons pressed, no pointerdown, no pressure. Each press toggles the eraser.
			const pressed = (e.buttons & ERASER_BUTTONS) !== 0 && e.pressure === 0;
			if (pressed && !this.buttonHeld && this.settings().penButton === "eraser") this.tools.toggleEraser();
			this.buttonHeld = pressed;
		}
		if (down) {
			if (!this.pens.get(e.pointerId)) {
				this.replayCoalesced(e);
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			this.showCursor(e);
			const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			this.eraseAt(events.length ? events : [e]);
			return;
		}
		if (!this.eraserActive()) return;
		if (this.viewportAt(e.clientX, e.clientY)) {
			e.stopPropagation();
			this.showCursor(e);
		} else {
			this.cursor.hidden = true;
		}
	}

	private onUp(e: PointerEvent) {
		if (this.swallowExtra(e)) {
			this.kinds.delete(e.pointerId);
			return;
		}
		if (this.isFinger(e)) {
			const blocked = this.blocked.has(e.pointerId);
			const s = this.scroller;
			this.forget(e);
			if (!blocked) return;
			e.stopPropagation();
			if (s && s.id === e.pointerId && e.type === "pointerup") this.startFling(s);
			return;
		}
		const intercepted = this.pens.get(e.pointerId) ?? false;
		const tap = this.tap?.id === e.pointerId ? this.tap : null;
		if (tap) {
			this.tap = null;
			if (e.type === "pointerup" && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= tap.slop) {
				const { clientX, clientY, pointerType, ctrlKey, metaKey } = e;
				// After EmbedPDF has handled the release (a tap on the page clears the selection first).
				this.win.setTimeout(() => this.selectAt({ clientX, clientY, pointerType, ctrlKey, metaKey }), 0);
			}
		}
		this.forget(e);
		if (!intercepted) return;
		e.stopPropagation();
		e.preventDefault();
	}

	private startFling(s: { vx: number; vy: number; el: HTMLElement }) {
		let vx = s.vx * 16, vy = s.vy * 16;
		if (Math.hypot(vx, vy) < 2) return;
		const token = ++this.fling;
		const step = () => {
			if (token !== this.fling) return;
			s.el.scrollTop -= vy;
			s.el.scrollLeft -= vx;
			vx *= 0.95;
			vy *= 0.95;
			if (Math.hypot(vx, vy) >= 0.5) this.win.requestAnimationFrame(step);
		};
		this.win.requestAnimationFrame(step);
	}

	// ----------------------------------------------------------- text first

	/** Remembers a pointer-tool press on the page that may become a tap on an annotation. */
	private noteTap(e: PointerEvent) {
		this.tap = null;
		if (this.tools.tool !== "pointer" || e.button !== 0 || !e.isPrimary) return;
		const target = e.target as Element | null;
		if (!target?.closest?.(".pdf-ink-page-layers")) return;
		// Menus and a selected annotation's own move and resize handles keep their clicks.
		if (target.closest("[data-no-interaction], .pdf-ink-menu, .pdf-ink-area")) return;
		this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, slop: TAP_SLOP[e.pointerType] ?? 8 };
	}

	/**
	 * Selects what is under a tap: a backlink box (drawn above annotations)
	 * opens its note, otherwise the topmost annotation whose shape is within
	 * the slop gets selected (Ctrl/Cmd adds to the selection, as in EmbedPDF).
	 * Geometric, from the annotation data: switching EmbedPDF's hit areas
	 * back on for a DOM hit test restyles every annotation on the page, which
	 * took ~40 ms for 1,500 strokes. Returns whether something was hit.
	 */
	selectAt(p: { clientX: number; clientY: number; pointerType: string; ctrlKey: boolean; metaKey: boolean }): boolean {
		if (this.tools.tool !== "pointer") return false;
		const at = this.locate(p.clientX, p.clientY);
		if (!at) return false;
		const page = this.root.querySelector(`.pdf-ink-page[data-page-index="${at.pageIndex}"]`);
		for (const box of Array.from(page?.querySelectorAll<HTMLElement>(".pdf-ink-backlink") ?? []).reverse()) {
			const r = box.getBoundingClientRect();
			if (p.clientX >= r.left && p.clientX <= r.right && p.clientY >= r.top && p.clientY <= r.bottom) {
				box.click();
				return true;
			}
		}
		const scope = this.tools.annotations();
		if (!scope) return false;
		const radius = (TAP_SLOP[p.pointerType] ?? 8) / at.scale;
		const all: any[] = scope.getAnnotations?.({ pageIndex: at.pageIndex }) ?? [];
		let hit: any = null;
		for (let i = all.length - 1; i >= 0 && !hit; i--) {
			const o = all[i]?.object;
			if (!o || (o.flags && (o.flags.includes?.("hidden") || o.flags.includes?.("noView")))) continue;
			if (scope.isAnnotationInteractive && !scope.isAnnotationInteractive(o)) continue;
			if (tapHit(o, at.x, at.y, radius)) hit = o;
		}
		if (!hit) return false;
		// A reply (for example a link's popup) selects its parent, as EmbedPDF does.
		const parent = hit.inReplyToId ? all.find((t) => t?.object?.id === hit.inReplyToId)?.object : null;
		const target = parent ?? hit;
		this.tools.registry?.getPlugin?.("selection")?.provides?.()?.forDocument?.(this.tools.documentId)?.clear?.();
		if (p.ctrlKey || p.metaKey) scope.toggleSelection(target.pageIndex ?? at.pageIndex, target.id);
		else scope.selectAnnotation(target.pageIndex ?? at.pageIndex, target.id);
		return true;
	}

	// ------------------------------------------------------------------ eraser

	private showCursor(e: PointerEvent) {
		const size = this.settings().eraserSize;
		const r = this.root.getBoundingClientRect();
		this.cursor.style.width = this.cursor.style.height = `${size}px`;
		this.cursor.style.left = `${e.clientX - r.left - size / 2}px`;
		this.cursor.style.top = `${e.clientY - r.top - size / 2}px`;
		this.cursor.hidden = false;
	}

	/**
	 * Erases along the samples of one pointer event. The page is found once per
	 * event (its samples are a few pixels apart), and each annotation on the
	 * page is tested against all the samples in one pass.
	 */
	private eraseAt(points: { clientX: number; clientY: number }[]) {
		const last = points[points.length - 1];
		const p = this.locate(last.clientX, last.clientY);
		const annotations = this.tools.annotations();
		if (!p || !p.rect || !annotations) {
			if (this.erasing) this.erasing.last = null;
			return;
		}
		const radius = this.settings().eraserSize / 2 / p.scale;
		const samples: { x: number; y: number }[] = [];
		const before = this.erasing?.last;
		let prev = before && before.pageIndex === p.pageIndex ? before : null;
		for (const c of points) {
			const q: PagePoint = { ...p, x: (c.clientX - p.rect.left) / p.scale, y: (c.clientY - p.rect.top) / p.scale };
			// Fill the gap since the previous sample, so a fast stroke misses nothing.
			if (prev) {
				const steps = Math.ceil(Math.hypot(q.x - prev.x, q.y - prev.y) / radius);
				for (let i = 1; i < steps; i++) samples.push({ x: prev.x + ((q.x - prev.x) * i) / steps, y: prev.y + ((q.y - prev.y) * i) / steps });
			}
			samples.push(q);
			prev = q;
		}
		if (this.erasing) this.erasing.last = prev;
		const hits: { pageIndex: number; id: string }[] = [];
		for (const tracked of annotations.getAnnotations?.({ pageIndex: p.pageIndex }) ?? []) {
			const a = tracked?.object;
			if (a && samples.some((s) => annotationHit(a, s.x, s.y, radius))) hits.push({ pageIndex: p.pageIndex, id: a.id });
		}
		if (!hits.length) return;
		// Deleted now for feedback; the whole stroke becomes one undo step when it ends.
		this.erased.push(...this.tools.deleteQuietly(hits));
		this.onErased();
	}
}
