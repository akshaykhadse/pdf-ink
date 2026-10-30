/**
 * Stylus handling on top of EmbedPDF's tools: palm rejection, finger
 * scrolling while a pen tool is active, and the eraser.
 *
 * EmbedPDF's tools draw with any pointer type on page layers that have
 * `touch-action: none`, so a finger or a resting palm would draw and could not
 * scroll. This guard listens on the viewer root in the capture phase, before
 * any tool: while a tool is active it stops finger pointer events and scrolls
 * the viewport itself. EmbedPDF's two-finger pinch keeps working because it
 * listens to touch events, which are left alone.
 *
 * The eraser is also handled here: pen and mouse events are stopped before the
 * tools see them and matched against the annotations of the page under the
 * pointer.
 */
import type { Settings } from "./settings";

export interface GuardOptions {
	documentId: string;
	settings(): Settings;
	onErased(): void;
	onEraserChange(active: boolean): void;
}

interface PagePoint {
	pageIndex: number;
	/** In PDF points from the page's top-left corner. */
	x: number;
	y: number;
	/** Rendered pixels per PDF point. */
	scale: number;
}

interface Stroke {
	points: { x: number; y: number }[];
}

/** PdfAnnotationSubtype.INK: the eraser only ever removes ink (never links, forms, notes). */
const INK = 15;

/** Whether an ink annotation is within `radius` page units of the point. */
export function annotationHit(a: any, x: number, y: number, radius: number): boolean {
	if (a?.type !== INK) return false;
	const inkList: Stroke[] | undefined = a?.inkList;
	if (!Array.isArray(inkList)) return false;
	const r = radius + (a.strokeWidth ?? 1) / 2;
	for (const stroke of inkList) {
		const pts = stroke?.points ?? [];
		if (pts.length === 1 && Math.hypot(pts[0].x - x, pts[0].y - y) <= r) return true;
		for (let i = 1; i < pts.length; i++) {
			if (segmentDistance(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r) return true;
		}
	}
	return false;
}

/** Pen buttons that mean "erase": primary while hovering (S Pen), barrel (2) or eraser end (32). */
const ERASER_BUTTONS = 1 | 2 | 32;

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class PointerGuard {
	/** The eraser picked on the toolbar; stays on until switched off. */
	private eraser = false;
	/** The eraser armed by the pen's side button; lasts one stroke. */
	private penEraser = false;
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
	/** Set by the viewer once EmbedPDF's registry is known. */
	registry: any = null;

	constructor(private readonly root: HTMLElement, private readonly o: GuardOptions) {
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
		// A release outside the viewer (over the toolbar, another pane) still ends
		// the pointer. Bubble phase, so the root's capture handlers run first.
		const forget = (e: Event) => this.forget(e as PointerEvent);
		window.addEventListener("pointerup", forget);
		window.addEventListener("pointercancel", forget);
		this.off.push(() => {
			window.removeEventListener("pointerup", forget);
			window.removeEventListener("pointercancel", forget);
		});
	}

	destroy() {
		for (const off of this.off) off();
		this.off.length = 0;
		this.fling++;
		this.cursor.remove();
	}

	get eraserActive() {
		return this.eraser || this.penEraser;
	}

	setEraser(on: boolean) {
		const was = this.eraserActive;
		this.eraser = on;
		this.penEraser = false;
		if (was === this.eraserActive) return;
		this.announce();
	}

	/** Re-checks what fingers must be kept from; call after the active tool changes. */
	sync() {
		this.root.classList.toggle("is-guarding", this.blockingFingers());
	}

	private announce() {
		if (!this.eraserActive) this.cursor.hidden = true;
		// The toolbar's eraser replaces the tool; the pen's side button only
		// borrows one stroke, so the tool stays picked (its events are stopped anyway).
		if (this.eraser) this.annotations()?.setActiveTool?.(null);
		this.o.onEraserChange(this.eraserActive);
		this.sync();
	}

	// ----------------------------------------------------------------- helpers

	private registryOf(): any {
		if (!this.registry) {
			// The viewer sets `registry` once EmbedPDF is up; until then nothing to do.
			return null;
		}
		return this.registry;
	}

	private annotations(): any {
		return this.registryOf()?.getPlugin("annotation")?.provides()?.forDocument(this.o.documentId) ?? null;
	}

	private activeTool(): string | null {
		return this.annotations()?.getActiveTool?.()?.id ?? null;
	}

	private blockingFingers(): boolean {
		if (!this.o.settings().palmRejection) return false;
		return this.eraserActive || this.pens.size > 0 || this.activeTool() !== null;
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
		const scale: number | undefined = this.registryOf()?.getPlugin("zoom")?.provides()?.forDocument(this.o.documentId)?.getState()?.currentZoomLevel;
		if (!scale) return null;
		const rect = page.getBoundingClientRect();
		return { pageIndex: Number(page.dataset.pageIndex), x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale };
	}

	private forget(e: PointerEvent) {
		if (e.pointerType === "touch") {
			this.fingers.delete(e.pointerId);
			this.blocked.delete(e.pointerId);
			if (this.scroller?.id === e.pointerId) this.scroller = null;
		} else {
			this.pens.delete(e.pointerId);
			if (this.erasing?.id === e.pointerId) this.erasing = null;
		}
		if (this.pens.size === 0 && this.fingers.size === 0) this.sync();
	}

	// ------------------------------------------------------------------ events

	private onDown(e: PointerEvent) {
		if (e.pointerType === "touch") {
			this.fingers.add(e.pointerId);
			if (!this.blockingFingers()) return;
			this.blocked.add(e.pointerId);
			e.stopPropagation();
			this.fling = 0;
			if (this.fingers.size === 1) {
				const el = this.viewportAt(e.clientX, e.clientY);
				this.scroller = el ? { id: e.pointerId, x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: e.timeStamp, el } : null;
			} else {
				// A second finger: EmbedPDF's pinch (touch events) takes over.
				this.scroller = null;
			}
			return;
		}
		const intercept = this.eraserActive && this.viewportAt(e.clientX, e.clientY) !== null;
		this.pens.set(e.pointerId, intercept);
		if (e.pointerType === "pen") this.sync();
		if (!intercept) return;
		e.stopPropagation();
		e.preventDefault();
		try {
			this.root.setPointerCapture(e.pointerId);
		} catch {
			/* synthetic events have no active pointer */
		}
		this.erasing = { id: e.pointerId, last: null };
		this.showCursor(e);
		this.eraseAt(e.clientX, e.clientY);
	}

	/** True while the coalesced samples of a move are being re-dispatched. */
	private replaying = false;

	/**
	 * Browsers deliver one pointermove per frame and fold the pen's faster
	 * samples into getCoalescedEvents(); EmbedPDF reads only the event itself.
	 * While a tool is drawing, the folded samples are dispatched to the same
	 * target ahead of the real event so the stroke gets every sample.
	 */
	private replayCoalesced(e: PointerEvent) {
		if (this.replaying || !e.isTrusted || typeof e.getCoalescedEvents !== "function") return;
		if (this.activeTool() === null || !(e.target instanceof Element)) return;
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
						ctrlKey: e.ctrlKey,
						shiftKey: e.shiftKey,
						altKey: e.altKey,
						metaKey: e.metaKey,
					})
				);
			}
		} finally {
			this.replaying = false;
		}
	}

	private onMove(e: PointerEvent) {
		if (this.replaying) return;
		if (e.pointerType === "touch") {
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
		if (e.pointerType === "pen" && !down) {
			// A pen's side button while hovering: buttons pressed with no pointerdown
			// and no pressure. It arms the eraser for the next stroke; letting go
			// of the button before touching down disarms it again.
			const pressed = (e.buttons & ERASER_BUTTONS) !== 0 && e.pressure === 0;
			if (pressed && !this.eraserActive) {
				this.penEraser = true;
				this.announce();
			} else if (!pressed && this.penEraser && e.buttons === 0) {
				this.penEraser = false;
				this.announce();
			}
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
			for (const c of events.length ? events : [e]) this.eraseAt(c.clientX, c.clientY);
			return;
		}
		if (!this.eraserActive) return;
		if (this.viewportAt(e.clientX, e.clientY)) {
			e.stopPropagation();
			this.showCursor(e);
		} else {
			this.cursor.hidden = true;
		}
	}

	private onUp(e: PointerEvent) {
		if (e.pointerType === "touch") {
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
		if (this.penEraser && wasPen) {
			// The side-button eraser lasts one stroke.
			this.penEraser = false;
			this.announce();
		}
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
			if (Math.hypot(vx, vy) >= 0.5) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	// ------------------------------------------------------------------ eraser

	private showCursor(e: PointerEvent) {
		const size = this.o.settings().eraserSize;
		const r = this.root.getBoundingClientRect();
		this.cursor.style.width = this.cursor.style.height = `${size}px`;
		this.cursor.style.left = `${e.clientX - r.left - size / 2}px`;
		this.cursor.style.top = `${e.clientY - r.top - size / 2}px`;
		this.cursor.hidden = false;
	}

	private eraseAt(clientX: number, clientY: number) {
		const p = this.locate(clientX, clientY);
		const annotations = this.annotations();
		if (!p || !annotations) {
			if (this.erasing) this.erasing.last = null;
			return;
		}
		const radius = this.o.settings().eraserSize / 2 / p.scale;
		const last = this.erasing?.last;
		const samples: PagePoint[] = [p];
		// Fast moves: also test points between the last sample and this one.
		if (last && last.pageIndex === p.pageIndex) {
			const steps = Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / radius);
			for (let i = 1; i < steps; i++) samples.push({ ...p, x: last.x + ((p.x - last.x) * i) / steps, y: last.y + ((p.y - last.y) * i) / steps });
		}
		if (this.erasing) this.erasing.last = p;
		let count = 0;
		for (const tracked of annotations.getAnnotations?.({ pageIndex: p.pageIndex }) ?? []) {
			const a = tracked?.object;
			if (!a || !samples.some((s) => annotationHit(a, s.x, s.y, radius))) continue;
			annotations.deleteAnnotation(p.pageIndex, a.id);
			count++;
		}
		if (count) this.o.onErased();
	}
}
