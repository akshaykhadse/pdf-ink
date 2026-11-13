/**
 * Pen timing log (a diagnostic, not native): one JSON line per pen stroke with
 * the timings that decide how fast ink appears. Only listens (passive capture
 * listeners); writes nothing while the pen is down.
 */
import type { ToolController } from "./tools";

interface Stroke {
	id: number;
	type: string;
	tool: string;
	downStamp: number;
	downX: number;
	downY: number;
	/** Handler start minus the event's timestamp: how long the event waited in the queue. */
	downQueue: number;
	downTask?: number;
	downFrame?: number;
	sincePrevUp: number | null;
	sinceHover: number | null;
	firstMoveDt?: number;
	firstMovePx?: number;
	firstMoveCoalesced?: number;
	moves: number;
	samples: number;
	lastSample: number;
	maxSampleGap: number;
	queue: number[];
	frames: number[];
	longBefore: number;
	longDuring: number;
	pressure0: number;
	/** The page under the pen, or -1. */
	page: number;
}

const MAX_STROKES = 400;

const r1 = (n: number | undefined | null) => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);

function stats(a: number[]) {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return { p50: r1(s[Math.floor(s.length / 2)]), p90: r1(s[Math.floor(0.9 * (s.length - 1))]), max: r1(s[s.length - 1]) };
}

export class PenLog {
	private readonly off: (() => void)[] = [];
	private stroke: Stroke | null = null;
	private lines: string[] = [];
	private count = 0;
	private lastUp: number | null = null;
	private lastHover: number | null = null;
	private flushTimer: number | null = null;
	private longTasks: { t: number; d: number }[] = [];
	private readonly win: Window;
	private headed = false;

	constructor(private readonly root: HTMLElement, private readonly tools: ToolController, private readonly write: (text: string) => void, private readonly enabled: () => boolean) {
		this.win = root.ownerDocument.defaultView ?? window;
		const on = (type: string, fn: (e: PointerEvent) => void, target: EventTarget = root) => {
			const l = fn as EventListener;
			target.addEventListener(type, l, { capture: true, passive: true });
			this.off.push(() => target.removeEventListener(type, l, { capture: true }));
		};
		on("pointerdown", (e) => this.onDown(e));
		on("pointermove", (e) => this.onMove(e));
		on("pointerup", (e) => this.onUp(e, false), this.win);
		on("pointercancel", (e) => this.onUp(e, true), this.win);
		const PO = (this.win as any).PerformanceObserver;
		if (PO?.supportedEntryTypes?.includes("longtask")) {
			const obs = new PO((list: any) => {
				for (const e of list.getEntries()) this.longTasks.push({ t: e.startTime, d: e.duration });
				if (this.longTasks.length > 200) this.longTasks.splice(0, this.longTasks.length - 200);
			});
			obs.observe({ type: "longtask" });
			this.off.push(() => obs.disconnect());
		}
	}

	private header() {
		if (this.headed) return;
		this.headed = true;
		const PO = (this.win as any).PerformanceObserver;
		const nav = this.win.navigator;
		this.lines.push(
			JSON.stringify({
				session: new Date().toISOString(),
				ua: nav.userAgent,
				dpr: this.win.devicePixelRatio,
				screen: [this.win.screen?.width, this.win.screen?.height],
				rawupdate: "onpointerrawupdate" in this.win,
				coalesced: typeof (PointerEvent.prototype as any).getCoalescedEvents === "function",
				longtask: !!PO?.supportedEntryTypes?.includes("longtask"),
			})
		);
	}

	destroy() {
		for (const off of this.off) off();
		this.off.length = 0;
		this.flush();
	}

	private drawing(): boolean {
		const t = this.tools.tool;
		return t === "pen" || t === "marker";
	}

	private onDown(e: PointerEvent) {
		if (!this.enabled() || !this.drawing() || this.count >= MAX_STROKES) return;
		if (e.pointerType === "touch" && this.tools.stylusMode) return; // a finger scrolls
		if (this.stroke) return;
		const now = performance.now();
		const s: Stroke = {
			id: ++this.count,
			type: e.pointerType,
			tool: this.tools.tool,
			downStamp: e.timeStamp,
			downX: e.clientX,
			downY: e.clientY,
			downQueue: now - e.timeStamp,
			sincePrevUp: this.lastUp == null ? null : e.timeStamp - this.lastUp,
			sinceHover: this.lastHover == null ? null : e.timeStamp - this.lastHover,
			moves: 0,
			samples: 0,
			lastSample: e.timeStamp,
			maxSampleGap: 0,
			queue: [],
			frames: [],
			longBefore: this.longSum(e.timeStamp - 500, e.timeStamp),
			longDuring: 0,
			pressure0: e.pressure,
			page: Number((e.target as Element | null)?.closest?.(".pdf-ink-page")?.getAttribute("data-page-index") ?? -1),
		};
		this.header();
		this.stroke = s;
		// End of this task (handlers, Preact render, layout effects), then the first frame after it.
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			s.downTask = performance.now() - s.downStamp;
			ch.port1.close();
		};
		ch.port2.postMessage(0);
		this.win.requestAnimationFrame(() => (s.downFrame = performance.now() - s.downStamp));
	}

	private onMove(e: PointerEvent) {
		const s = this.stroke;
		if (!s) {
			if (e.pointerType === "pen" && e.buttons === 0) this.lastHover = e.timeStamp;
			return;
		}
		if (!e.isTrusted) return; // the guard's coalesced replays
		const now = performance.now();
		const co = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const samples = co.length ? co : [e];
		if (s.moves === 0) {
			s.firstMoveDt = e.timeStamp - s.downStamp;
			s.firstMovePx = Math.hypot(samples[0].clientX - s.downX, samples[0].clientY - s.downY);
			s.firstMoveCoalesced = co.length;
		}
		s.moves++;
		for (const c of samples) {
			s.maxSampleGap = Math.max(s.maxSampleGap, c.timeStamp - s.lastSample);
			s.lastSample = c.timeStamp;
		}
		s.samples += samples.length;
		s.queue.push(now - e.timeStamp);
		if (s.moves <= 60) {
			const stamp = e.timeStamp;
			this.win.requestAnimationFrame(() => s.frames.push(performance.now() - stamp));
		}
	}

	private onUp(e: PointerEvent, cancelled: boolean) {
		const s = this.stroke;
		if (!s) return;
		this.stroke = null;
		this.lastUp = e.timeStamp;
		const duration = e.timeStamp - s.downStamp;
		// Long tasks are reported late; read them a moment after the stroke.
		this.win.setTimeout(() => {
			s.longDuring = this.longSum(s.downStamp, s.downStamp + duration);
			let onPage: number | null = null;
			try {
				// Only this page's: listing every annotation in a big PDF is itself slow.
				if (s.page >= 0) onPage = this.tools.annotations()?.getAnnotations?.({ pageIndex: s.page })?.length ?? null;
			} catch {
				/* ignore */
			}
			this.lines.push(
				JSON.stringify({
					n: s.id,
					type: s.type,
					tool: s.tool,
					cancelled,
					page: s.page,
					pageAnnotations: onPage,
					sincePrevUp: r1(s.sincePrevUp),
					sinceHover: r1(s.sinceHover),
					downQueue: r1(s.downQueue),
					downTask: r1(s.downTask),
					downFrame: r1(s.downFrame),
					firstMoveDt: r1(s.firstMoveDt),
					firstMovePx: r1(s.firstMovePx),
					firstMoveCoalesced: s.firstMoveCoalesced ?? null,
					moves: s.moves,
					samples: s.samples,
					maxSampleGap: r1(s.maxSampleGap),
					moveQueue: stats(s.queue),
					moveFrame: stats(s.frames),
					longBefore: r1(s.longBefore),
					longDuring: r1(s.longDuring),
					duration: r1(duration),
					pressure0: r1(s.pressure0),
				})
			);
			this.scheduleFlush();
		}, 300);
	}

	private longSum(from: number, to: number): number {
		let sum = 0;
		for (const t of this.longTasks) if (t.t + t.d > from && t.t < to) sum += t.d;
		return sum;
	}

	private scheduleFlush() {
		if (this.flushTimer != null) this.win.clearTimeout(this.flushTimer);
		this.flushTimer = this.win.setTimeout(() => {
			this.flushTimer = null;
			if (this.stroke) this.scheduleFlush();
			else this.flush();
		}, 2000);
	}

	private flush() {
		if (!this.lines.length) return;
		const text = this.lines.join("\n") + "\n";
		this.lines = [];
		try {
			this.write(text);
		} catch (e) {
			console.warn("[pdf-ink] pen log", e);
		}
	}
}
