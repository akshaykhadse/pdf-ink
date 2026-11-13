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
 *  - Early samples: the same real samples are taken from pointerrawupdate,
 *    which fires as they arrive instead of once per frame (no prediction).
 *  - Android reports the pen as touch events too, and Obsidian's edge swipe
 *    (which opens the side panels) listens to those: the pen's own touch
 *    events are stopped while it is on the page.
 *  - A stale DOM text selection would start a native drag on the next pen-down
 *    and swallow the stroke: dragstart is blocked.
 */
import type { Settings } from "./settings";
import type { ToolController } from "./tools";

interface PagePoint {
	pageIndex: number;
	/** PDF points from the page's top-left corner (EmbedPDF's page space). */
	x: number;
	y: number;
	/** Rendered pixels per PDF point. */
	scale: number;
}

const INK = 15;
const HIGHLIGHT = 9;
/** A touch this close to the pen's contact point (CSS px) is the pen itself. */
const PEN_TOUCH_RADIUS = 48;
/** Pen buttons that mean "erase": primary while hovering (S Pen), barrel (2) or eraser end (32). */
const ERASER_BUTTONS = 1 | 2 | 32;

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether an ink stroke or text highlight is within `radius` page units of the point. */
export function annotationHit(a: any, x: number, y: number, radius: number): boolean {
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
	/** Pointers whose samples this stroke already reached EmbedPDF through pointerrawupdate. */
	private readonly rawFed = new Set<number>();
	/** How each active touch was classified when it landed (stylus mode may change mid-touch). */
	/** What each touch is: a finger (scrolls), a pen stand-in (draws), or an extra touch while something already draws (ignored). */
	private readonly kinds = new Map<number, "finger" | "pen" | "extra">();
	/** What the current eraser stroke has removed, recorded as one undo step when it ends. */
	private erased: any[] = [];
	private readonly win: Window;

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
		on("pointerrawupdate", (e) => this.onRawUpdate(e));
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

	/** Maps a client point to page coordinates via the page element under it. */
	locate(clientX: number, clientY: number): PagePoint | null {
		const el = this.root.ownerDocument.elementsFromPoint(clientX, clientY).find((e) => this.root.contains(e) && (e as HTMLElement).closest(".pdf-ink-page"));
		const page = (el as HTMLElement | undefined)?.closest(".pdf-ink-page") as HTMLElement | null;
		if (!page) return null;
		const scale: number | undefined = this.tools.registry?.getPlugin("zoom")?.provides()?.forDocument(this.tools.documentId)?.getState()?.currentZoomLevel;
		if (!scale) return null;
		const rect = page.getBoundingClientRect();
		return { pageIndex: Number(page.dataset.pageIndex), x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale };
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
			this.rawFed.delete(e.pointerId);
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
		this.eraseAt(e.clientX, e.clientY);
	}

	private inkTool(): boolean {
		const tool = this.tools.tool;
		return tool === "pen" || tool === "marker";
	}

	/**
	 * Early samples (not native): Chromium delivers pointermove once per frame,
	 * just before drawing it, so each sample waits up to a frame before EmbedPDF
	 * sees it. pointerrawupdate carries the same real samples as soon as they
	 * arrive; they are passed on as pointermoves at once, and the frame-aligned
	 * pointermove that repeats them is then kept from EmbedPDF.
	 */
	private onRawUpdate(e: PointerEvent) {
		if (!e.isTrusted || !this.settings().earlyPenSamples || !this.inkTool()) return;
		if (e.pointerType === "touch" && this.isFinger(e)) return;
		if (!this.pens.has(e.pointerId) || this.pens.get(e.pointerId) || e.buttons === 0) return;
		const events = this.settings().fullPenRate && typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		this.rawFed.add(e.pointerId);
		this.dispatchSamples(e, events.length ? events : [e]);
	}

	/** Re-dispatches samples as pointermoves on the event's target (EmbedPDF reads only the event itself). */
	private dispatchSamples(e: PointerEvent, samples: PointerEvent[]) {
		if (!(e.target instanceof Element)) return;
		this.replaying = true;
		try {
			for (const c of samples) {
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

	private replayCoalesced(e: PointerEvent) {
		if (this.replaying || !e.isTrusted || typeof e.getCoalescedEvents !== "function") return;
		if (!this.settings().fullPenRate) return;
		if (!this.inkTool() || !(e.target instanceof Element)) return;
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
		if (this.pens.has(e.pointerId) && e.buttons === 0) this.forget(e); // a release nobody saw
		const down = this.pens.has(e.pointerId);
		if (down && this.penAt?.id === e.pointerId) {
			this.penAt.x = e.clientX;
			this.penAt.y = e.clientY;
		}
		if (e.pointerType === "pen" && !down) {
			// Side button while hovering: buttons pressed, no pointerdown, no pressure. Each press toggles the eraser.
			const pressed = (e.buttons & ERASER_BUTTONS) !== 0 && e.pressure === 0;
			if (pressed && !this.buttonHeld) this.tools.toggleEraser();
			this.buttonHeld = pressed;
		}
		if (down) {
			if (!this.pens.get(e.pointerId)) {
				if (this.rawFed.has(e.pointerId) && e.isTrusted && this.inkTool()) {
					// Its samples already went in through pointerrawupdate.
					e.stopPropagation();
					return;
				}
				this.replayCoalesced(e);
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			this.showCursor(e);
			const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			for (const c of events.length ? events : [e]) this.eraseAt(c.clientX, c.clientY);
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
		const wasPen = e.pointerType === "pen" && this.pens.has(e.pointerId);
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

	// ------------------------------------------------------------------ eraser

	private showCursor(e: PointerEvent) {
		const size = this.settings().eraserSize;
		const r = this.root.getBoundingClientRect();
		this.cursor.style.width = this.cursor.style.height = `${size}px`;
		this.cursor.style.left = `${e.clientX - r.left - size / 2}px`;
		this.cursor.style.top = `${e.clientY - r.top - size / 2}px`;
		this.cursor.hidden = false;
	}

	private eraseAt(clientX: number, clientY: number) {
		const p = this.locate(clientX, clientY);
		const annotations = this.tools.annotations();
		if (!p || !annotations) {
			if (this.erasing) this.erasing.last = null;
			return;
		}
		const radius = this.settings().eraserSize / 2 / p.scale;
		const last = this.erasing?.last;
		const samples: PagePoint[] = [p];
		if (last && last.pageIndex === p.pageIndex) {
			const steps = Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / radius);
			for (let i = 1; i < steps; i++) samples.push({ ...p, x: last.x + ((p.x - last.x) * i) / steps, y: last.y + ((p.y - last.y) * i) / steps });
		}
		if (this.erasing) this.erasing.last = p;
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
