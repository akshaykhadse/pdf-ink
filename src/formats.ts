/**
 * Text formats and line styles, mapped onto what a PDF (and EmbedPDF) can store:
 * the 12 standard fonts (Helvetica, Times, Courier with bold and italic), text
 * alignment, the border style with its dash pattern, and line ending styles.
 */
import type { LineEnd, LineStyle, TextAlign, TextFont, TextFormat } from "./settings";

/** PdfStandardFont: each family has regular, bold, bold italic, italic in this order. */
const FONT_BASE: Record<TextFont, number> = { mono: 0, sans: 4, serif: 8 };

export function standardFont(f: Pick<TextFormat, "font" | "bold" | "italic">): number {
	const offset = f.bold && f.italic ? 2 : f.bold ? 1 : f.italic ? 3 : 0;
	return FONT_BASE[f.font] + offset;
}

/** The family, bold and italic of a PdfStandardFont value (Helvetica for anything else). */
export function fontFormat(font: number): Pick<TextFormat, "font" | "bold" | "italic"> {
	if (!(font >= 0 && font <= 11)) return { font: "sans", bold: false, italic: false };
	const family: TextFont = font < 4 ? "mono" : font < 8 ? "sans" : "serif";
	const offset = font % 4;
	return { font: family, bold: offset === 1 || offset === 2, italic: offset === 2 || offset === 3 };
}

/** CSS font for measuring text in a given format. */
export function cssFont(f: Pick<TextFormat, "font" | "bold" | "italic">, sizePx: number): string {
	const family = f.font === "mono" ? "Courier, 'Courier New', monospace" : f.font === "serif" ? "Times, 'Times New Roman', serif" : "Helvetica, Arial, sans-serif";
	return `${f.italic ? "italic " : ""}${f.bold ? "bold " : ""}${sizePx}px ${family}`;
}

/** PdfTextAlignment */
export const ALIGN_VALUE: Record<TextAlign, number> = { left: 0, center: 1, right: 2 };

/** PdfAnnotationLineEnding */
export const LINE_END_VALUE: Record<LineEnd, number> = { none: 0, square: 1, circle: 2, diamond: 3, openArrow: 4, closedArrow: 5, bar: 6 };

export function lineEndOf(value: number | undefined): LineEnd {
	const hit = (Object.keys(LINE_END_VALUE) as LineEnd[]).find((k) => LINE_END_VALUE[k] === value);
	return hit ?? "none";
}

/** PdfAnnotationBorderStyle SOLID = 1, DASHED = 2 */
const SOLID = 1, DASHED = 2;

/** Border style and dash pattern for a line style; dashes scale with the line width. */
export function strokePattern(style: LineStyle, width: number): { strokeStyle: number; strokeDashArray?: number[] } {
	const m = Math.max(1, width);
	if (style === "dashed") return { strokeStyle: DASHED, strokeDashArray: [3 * m, 2 * m] };
	if (style === "dotted") return { strokeStyle: DASHED, strokeDashArray: [m, 2 * m] };
	return { strokeStyle: SOLID };
}

/** The line style an annotation's border reads as (dots: dash no longer than the width). */
export function lineStyleOf(a: any): LineStyle {
	if (a?.strokeStyle !== DASHED) return "solid";
	const d = a.strokeDashArray;
	if (Array.isArray(d) && d.length && d[0] <= Math.max(1, a.strokeWidth ?? 1) * 1.01) return "dotted";
	return "dashed";
}
