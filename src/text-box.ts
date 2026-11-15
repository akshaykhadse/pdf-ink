/**
 * Text boxes (EmbedPDF free text) have a fixed size and clip what does not fit.
 * When typing ends, the box grows to fit its text: wider up to the page's right
 * edge, then taller for the wrapped lines. Not native to EmbedPDF.
 */

/** What a new box holds, selected, until the first key replaces it. */
export const TEXT_PLACEHOLDER = "Text";
/** Width of a box added by a tap, in PDF points. */
export const TEXT_BOX_WIDTH = 160;
/** EmbedPDF's free text line height is 1.18 em. */
const LINE_HEIGHT = 1.18;
/** Room for the caret and PDFium's inset when it draws the text. */
const PAD = 4;

export function textLineHeight(fontSize: number): number {
	return Math.ceil(fontSize * LINE_HEIGHT + PAD);
}

let ctx: CanvasRenderingContext2D | null | undefined;
function measurer(): ((text: string, fontSize: number) => number) | null {
	if (ctx === undefined) ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
	if (!ctx) return null;
	const c = ctx;
	return (text, fontSize) => {
		c.font = `${fontSize}px Helvetica, Arial, sans-serif`;
		return c.measureText(text).width;
	};
}

/** Lines after wrapping at `width` (words longer than a line stay whole). */
export function wrapLines(text: string, width: number, measure: (t: string) => number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/(\s+)/)) {
			const next = line + word;
			if (line && measure(next.trimEnd()) > width) {
				out.push(line.trimEnd());
				line = word.trimStart();
			} else line = next;
		}
		out.push(line);
	}
	return out;
}

/** The rect the box needs for its text, or null when it already fits. Only grows the box. */
export function fitTextBox(a: any, pageSize: { width: number; height: number }, measureText = measurer()): any | null {
	const o = a?.rect?.origin, sz = a?.rect?.size;
	if (!o || !sz || !measureText || typeof a.contents !== "string") return null;
	const fontSize = a.fontSize || 12;
	const measure = (t: string) => measureText(t, fontSize);
	const maxWidth = Math.max(sz.width, pageSize.width - o.x);
	// Slack for the difference between the browser's Helvetica stand-in and PDFium's metrics.
	const longest = Math.max(0, ...a.contents.split("\n").map(measure)) * 1.06 + PAD + fontSize * 0.5;
	const width = Math.min(maxWidth, Math.max(sz.width, Math.ceil(longest)));
	const lines = wrapLines(a.contents, width - PAD, measure).length;
	const maxHeight = Math.max(sz.height, pageSize.height - o.y);
	const height = Math.min(maxHeight, Math.max(sz.height, Math.ceil(lines * fontSize * LINE_HEIGHT + PAD)));
	if (width <= sz.width + 0.5 && height <= sz.height + 0.5) return null;
	return { origin: { x: o.x, y: o.y }, size: { width, height } };
}

/**
 * With the text tool active, EmbedPDF covers the page with its tool layer, so a tap
 * inside the box being typed in would start a new box. Such a tap moves the caret
 * instead. Not native to EmbedPDF. Returns the remover.
 */
export function keepTapsInTextBox(root: HTMLElement, isTextTool: () => boolean): () => void {
	const doc = root.ownerDocument;
	const onDown = (e: PointerEvent) => {
		if (!isTextTool()) return;
		const editor = root.querySelector<HTMLElement>('[contenteditable="true"]');
		if (!editor) return;
		const r = editor.getBoundingClientRect();
		if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
		e.stopPropagation();
		e.preventDefault(); // no mousedown, so the box keeps focus
		const d: any = doc;
		let range: Range | null = null;
		// The tool layer lies on top of the box: let hit testing see through it while finding the caret.
		const covering: [HTMLElement, string][] = [];
		for (const el of doc.elementsFromPoint(e.clientX, e.clientY)) {
			if (el === editor || editor.contains(el)) break;
			if (el instanceof HTMLElement && !el.contains(editor)) covering.push([el, el.style.pointerEvents]), (el.style.pointerEvents = "none");
		}
		if (typeof d.caretRangeFromPoint === "function") range = d.caretRangeFromPoint(e.clientX, e.clientY);
		else if (typeof d.caretPositionFromPoint === "function") {
			const pos = d.caretPositionFromPoint(e.clientX, e.clientY);
			if (pos) (range = doc.createRange()), range.setStart(pos.offsetNode, pos.offset);
		}
		for (const [el, pe] of covering) el.style.pointerEvents = pe;
		editor.focus();
		const sel = doc.getSelection();
		if (range && sel && editor.contains(range.startContainer)) {
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	};
	root.addEventListener("pointerdown", onDown, true);
	return () => root.removeEventListener("pointerdown", onDown, true);
}
