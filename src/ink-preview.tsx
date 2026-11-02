/**
 * A canvas preview for strokes in progress (not native).
 *
 * EmbedPDF previews an ink stroke as an SVG path whose container is resized
 * to the stroke's bounds on every sample: the path string is rebuilt from all
 * points, and the page lays out, restyles and repaints for each one. This
 * renderer registers for ink previews only (committed strokes stay EmbedPDF's
 * SVG) and draws the new segment onto a canvas instead. The canvas covers the
 * stroke's bounds plus a margin and grows in steps, so a sample costs one
 * lineTo and a repaint of a small bitmap, with no layout.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { PdfAnnotationSubtype, PdfBlendMode, Rect } from "@embedpdf/models";
import { createRenderer, useRegisterRenderers } from "@embedpdf/plugin-annotation/preact";
import { stampRenderer } from "./stamp";
import { tipPoints } from "./tip";

interface Point {
	x: number;
	y: number;
}

interface InkPreviewData {
	strokeColor?: string;
	color?: string;
	strokeWidth?: number;
	opacity?: number;
	blendMode?: PdfBlendMode;
	inkList: { points: Point[] }[];
}

/** Margin around the stroke, in screen pixels, so the canvas rarely has to grow. */
const MARGIN_PX = 160;

const BLEND: Record<number, string> = { [PdfBlendMode.Multiply]: "multiply" };

interface Cover {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function CanvasInkPreview({ data, bounds, scale }: { data: InkPreviewData; bounds: Rect; scale: number }) {
	const ref = useRef<HTMLCanvasElement>(null);
	/** A second canvas for the predicted tail, cleared and redrawn on every sample (see tip.ts). */
	const tipRef = useRef<HTMLCanvasElement>(null);
	const tipDrawn = useRef(false);
	/** The page area the canvas covers, in PDF points. */
	const cover = useRef<Cover | null>(null);
	/** How many points of each stroke are on the canvas already. */
	const drawn = useRef<number[]>([]);
	const pageSize = useRef<{ w: number; h: number } | null>(null);

	useLayoutEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
		if (!pageSize.current) {
			const page = canvas.closest(".pdf-ink-page-layers") ?? canvas.parentElement?.parentElement;
			pageSize.current = { w: (page?.clientWidth || 1) / scale, h: (page?.clientHeight || 1) / scale };
		}
		const width = data.strokeWidth ?? 1;
		const need: Cover = { x0: bounds.origin.x - width, y0: bounds.origin.y - width, x1: bounds.origin.x + bounds.size.width + width, y1: bounds.origin.y + bounds.size.height + width };
		const c = cover.current;
		if (!c || need.x0 < c.x0 || need.y0 < c.y0 || need.x1 > c.x1 || need.y1 > c.y1) {
			// (Re)size: the bounds plus a margin, clamped to the page. Resizing clears the bitmap, so redraw everything.
			const m = MARGIN_PX / scale;
			const page = pageSize.current;
			const next: Cover = { x0: Math.max(0, need.x0 - m), y0: Math.max(0, need.y0 - m), x1: Math.min(page.w, need.x1 + m), y1: Math.min(page.h, need.y1 + m) };
			const w = Math.max(1, (next.x1 - next.x0) * scale), h = Math.max(1, (next.y1 - next.y0) * scale);
			for (const cv of [canvas, tipRef.current]) {
				if (!cv) continue;
				cv.width = Math.ceil(w * dpr);
				cv.height = Math.ceil(h * dpr);
				cv.style.left = `${next.x0 * scale}px`;
				cv.style.top = `${next.y0 * scale}px`;
				cv.style.width = `${w}px`;
				cv.style.height = `${h}px`;
			}
			cover.current = next;
			drawn.current = [];
			tipDrawn.current = false;
		}
		const cv = cover.current!;
		ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -cv.x0 * dpr * scale, -cv.y0 * dpr * scale);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.strokeStyle = data.strokeColor ?? data.color ?? "#000";
		ctx.lineWidth = width;
		ctx.globalAlpha = data.opacity ?? 1;
		data.inkList.forEach((stroke, i) => {
			const pts = stroke.points;
			const from = drawn.current[i] ?? 0;
			if (pts.length <= from) return;
			ctx.beginPath();
			if (from === 0) {
				ctx.moveTo(pts[0].x, pts[0].y);
				if (pts.length === 1) ctx.lineTo(pts[0].x, pts[0].y); // a dot
			} else ctx.moveTo(pts[from - 1].x, pts[from - 1].y);
			for (let k = Math.max(from, 1); k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
			ctx.stroke();
			drawn.current[i] = pts.length;
		});
		// The predicted tail: from the last real point along the browser's prediction, on its own canvas.
		const tc = tipRef.current?.getContext("2d");
		if (tc) {
			if (tipDrawn.current) {
				tc.setTransform(1, 0, 0, 1, 0, 0);
				tc.clearRect(0, 0, tc.canvas.width, tc.canvas.height);
				tipDrawn.current = false;
			}
			const last = data.inkList.at(-1)?.points.at(-1);
			const tail = last ? tipPoints(last, scale, performance.now()) : [];
			if (last && tail.length) {
				tipDrawn.current = true;
				tc.setTransform(dpr * scale, 0, 0, dpr * scale, -cv.x0 * dpr * scale, -cv.y0 * dpr * scale);
				tc.lineCap = "round";
				tc.lineJoin = "round";
				tc.strokeStyle = ctx.strokeStyle;
				tc.lineWidth = width;
				tc.globalAlpha = data.opacity ?? 1;
				tc.beginPath();
				tc.moveTo(last.x, last.y);
				for (const p of tail) tc.lineTo(p.x, p.y);
				tc.stroke();
			}
		}
	});

	return (
		<>
			<canvas ref={ref} class="pdf-ink-stroke-preview" style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} />
			<canvas ref={tipRef} class="pdf-ink-stroke-tip" style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} />
		</>
	);
}

const renderers = [
	stampRenderer,
	createRenderer<any, InkPreviewData>({
		id: "pdf-ink-canvas-preview",
		matchesPreview: (p) => p.type === PdfAnnotationSubtype.INK,
		renderPreview: ({ data, bounds, scale }) => <CanvasInkPreview data={data} bounds={bounds} scale={scale} />,
		// A fixed container: EmbedPDF sizes it to the stroke's bounds on every sample, which forces layout.
		previewContainerStyle: ({ data }) => ({ left: 0, top: 0, width: 0, height: 0, overflow: "visible", mixBlendMode: BLEND[data.blendMode ?? 0] ?? "normal" }),
	}),
];

/** Mount once under an AnnotationRendererProvider to take over ink previews and stamp rendering. */
export function PdfInkRenderers() {
	useRegisterRenderers(renderers);
	return null;
}
