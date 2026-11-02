/**
 * Pointer prediction (not native to EmbedPDF).
 *
 * Chrome predicts where a pen will be by the time the frame is shown (`getPredictedEvents`). The guard
 * records the prediction of the newest real sample here, and the stroke preview draws it as a short tail
 * beyond the last point, so the ink seems to keep up with the pen. The tail is redrawn from scratch on
 * every sample and is never part of the saved stroke.
 */
export interface Point {
	x: number;
	y: number;
}

export interface Tip {
	/** Predicted offsets from the sample, in screen pixels. */
	dx: number[];
	dy: number[];
	/** The sample's event time; a stale tip is not drawn. */
	t: number;
}

export const tip: Tip = { dx: [], dy: [], t: 0 };

export function recordTip(e: PointerEvent) {
	const predicted = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
	tip.dx.length = 0;
	tip.dy.length = 0;
	for (const p of predicted) {
		tip.dx.push(p.clientX - e.clientX);
		tip.dy.push(p.clientY - e.clientY);
	}
	tip.t = e.timeStamp;
}

export function clearTip() {
	tip.dx.length = 0;
	tip.dy.length = 0;
	tip.t = 0;
}

/** How long a recorded tip stays valid, in ms. */
export const TIP_MAX_AGE = 120;

/** The predicted tail in page units, continuing from the stroke's last point. */
export function tipPoints(last: Point, scale: number, now: number, t: Tip = tip): Point[] {
	if (!t.dx.length || now - t.t > TIP_MAX_AGE) return [];
	return t.dx.map((dx, i) => ({ x: last.x + dx / scale, y: last.y + t.dy[i] / scale }));
}
