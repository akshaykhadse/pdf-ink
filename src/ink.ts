// Stroke smoothing. EmbedPDF stores every pointer sample as a vertex and every
// viewer draws ink as straight segments between vertices, so a quick stroke
// from a 60 Hz pointer looks like a polygon. Before an ink annotation is
// created, each stroke is resampled along a centripetal Catmull-Rom spline
// through its samples: the curve passes through every original point, so
// nothing the pen did is lost, and sharp corners stay sharp.

export interface Point {
	x: number;
	y: number;
}

const INK = 15;
/** Samples closer than this (PDF points) are the same point. */
const MIN_GAP = 0.15;
/** Segments shorter than this get no extra vertices. */
const FLAT_LEN = 1.5;
/** Turns smaller than this (radians) at both ends of a segment need no curve. */
const FLAT_TURN = 0.035;
const MAX_SUBDIVISIONS = 8;

function dedupe(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= MIN_GAP) out.push({ x: p.x, y: p.y });
	}
	return out;
}

function turn(a: Point, b: Point, c: Point): number {
	const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
	const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
	if (lu === 0 || lv === 0) return 0;
	const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)));
	return Math.acos(cos);
}

/** Centripetal Catmull-Rom point between p1 and p2 at parameter t in [0, 1]. */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
	const knot = (a: Point, b: Point, prev: number) => prev + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
	const t0 = 0;
	const t1 = knot(p0, p1, t0);
	const t2 = knot(p1, p2, t1);
	const t3 = knot(p2, p3, t2);
	if (t1 === t0 || t2 === t1 || t3 === t2) return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
	const tt = t1 + (t2 - t1) * t;
	const lerp = (a: Point, b: Point, ta: number, tb: number): Point => {
		const w = (tt - ta) / (tb - ta);
		return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
	};
	const a1 = lerp(p0, p1, t0, t1);
	const a2 = lerp(p1, p2, t1, t2);
	const a3 = lerp(p2, p3, t2, t3);
	const b1 = lerp(a1, a2, t0, t2);
	const b2 = lerp(a2, a3, t1, t3);
	return lerp(b1, b2, t1, t2);
}

/** Resamples a stroke along a spline through its points; keeps every original point. */
export function smoothStroke(raw: Point[]): Point[] {
	const pts = dedupe(raw);
	if (pts.length < 3) return pts;
	const out: Point[] = [pts[0]];
	for (let i = 0; i < pts.length - 1; i++) {
		const p1 = pts[i];
		const p2 = pts[i + 1];
		// Phantom neighbours past the ends keep the first and last segments curved.
		const p0 = pts[i - 1] ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
		const p3 = pts[i + 2] ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
		const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
		const bend = Math.max(turn(p0, p1, p2), turn(p1, p2, p3));
		if (len >= FLAT_LEN && bend >= FLAT_TURN) {
			const n = Math.min(MAX_SUBDIVISIONS, Math.max(1, Math.ceil(len / 3)));
			for (let k = 1; k < n; k++) out.push(catmullRom(p0, p1, p2, p3, k / n));
		}
		out.push(p2);
	}
	return out;
}

/** Returns the annotation with smoothed strokes and a rect that still covers them. */
export function smoothInkAnnotation<T extends { type?: number; inkList?: { points: Point[] }[]; strokeWidth?: number; rect?: unknown }>(annotation: T): T {
	if (annotation.type !== INK || !Array.isArray(annotation.inkList)) return annotation;
	const inkList = annotation.inkList.map((s) => ({ ...s, points: smoothStroke(s.points) }));
	const all = inkList.flatMap((s) => s.points);
	if (all.length === 0) return annotation;
	const pad = (annotation.strokeWidth ?? 1) / 2;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of all) {
		minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
	}
	const rect = { origin: { x: minX - pad, y: minY - pad }, size: { width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad } };
	return { ...annotation, inkList, rect };
}

interface Rect {
	origin: { x: number; y: number };
	size: { width: number; height: number };
}

const HIGHLIGHT = 9;

/**
 * EmbedPDF builds a text highlight from the glyphs' full font boxes, which
 * are often taller than the line spacing, so the boxes of neighbouring lines
 * overlap and the overlap shows darker. Where two boxes share columns and
 * overlap vertically, the boundary moves to the middle of the overlap.
 */
export function tidyHighlightRects(rects: Rect[]): Rect[] {
	const out = rects
		.filter((r) => r?.origin && r?.size && r.size.width > 0 && r.size.height > 0)
		.map((r) => ({ top: r.origin.y, bottom: r.origin.y + r.size.height, left: r.origin.x, right: r.origin.x + r.size.width }))
		.sort((a, b) => a.top - b.top || a.left - b.left);
	for (let i = 0; i < out.length; i++) {
		for (let j = i + 1; j < out.length; j++) {
			const a = out[i], b = out[j];
			if (b.top >= a.bottom) break;
			if (b.right <= a.left || b.left >= a.right) continue;
			if (b.bottom <= a.bottom && b.top >= a.top) continue; // nested: leave it
			const mid = (b.top + a.bottom) / 2;
			a.bottom = Math.max(a.top, mid);
			b.top = Math.min(b.bottom, mid);
		}
	}
	return out.map((r) => ({ origin: { x: r.left, y: r.top }, size: { width: r.right - r.left, height: r.bottom - r.top } }));
}

function tidyHighlightAnnotation<T extends { type?: number; segmentRects?: Rect[]; rect?: Rect }>(annotation: T): T {
	if (annotation.type !== HIGHLIGHT || !Array.isArray(annotation.segmentRects) || annotation.segmentRects.length < 2) return annotation;
	return { ...annotation, segmentRects: tidyHighlightRects(annotation.segmentRects) };
}

/**
 * Patches EmbedPDF's annotation plugin so every ink annotation it creates is
 * smoothed first and text highlights get non-overlapping line boxes. Done on the plugin instance (not the per-document scope)
 * so it runs before the history entry is recorded.
 */
export function installInkSmoothing(annotationPlugin: any, enabled: () => boolean): void {
	if (!annotationPlugin) return;
	if (annotationPlugin.__pdfInkSmoothing) {
		annotationPlugin.__pdfInkSmoothing = enabled;
		return;
	}
	const original = annotationPlugin.createAnnotation;
	if (typeof original !== "function") return;
	annotationPlugin.__pdfInkSmoothing = enabled;
	annotationPlugin.createAnnotation = function (pageIndex: number, annotation: any, ...rest: unknown[]) {
		const on = annotationPlugin.__pdfInkSmoothing;
		const fixed = tidyHighlightAnnotation(on() ? smoothInkAnnotation(annotation) : annotation);
		return original.call(this, pageIndex, fixed, ...rest);
	};
}
