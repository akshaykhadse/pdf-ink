/**
 * The viewer's tool state, on top of EmbedPDF's interaction modes.
 *
 * One tool is active at a time:
 *   hand          EmbedPDF's pan mode (native): a drag pans, fingers scroll natively, two fingers pinch.
 *   pointer       EmbedPDF's pointer mode (native): text selection, tap and box (marquee) selection of annotations.
 *   pen           EmbedPDF's `ink` tool.
 *   marker        EmbedPDF's `inkHighlighter` tool.
 *   textHighlight EmbedPDF's `highlight` tool: selecting text makes a highlight.
 *   eraser        our own interaction mode; the pointer guard removes what it crosses.
 *   areaLink      EmbedPDF's capture plugin marquee (native); the rect becomes a link.
 *   image         EmbedPDF's `stamp` tool (native): a tap opens the file picker and places the picture there.
 *   text          EmbedPDF's `freeText` tool (native): a tap (or a dragged box) adds a text box and starts typing.
 *   shape         EmbedPDF's `lineArrow`, `line`, `square` or `circle` tool (native), by `settings.shapeKind`.
 */
import type { Settings, ShapeKind, ShapeLine, TextFormat, ToolStyle } from "./settings";
import { ALIGN_VALUE, LINE_END_VALUE, standardFont, strokePattern } from "./formats";

export type ToolId = "hand" | "pointer" | "pen" | "marker" | "textHighlight" | "text" | "shape" | "eraser" | "areaLink" | "image";

export const DRAWING_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["pen", "marker", "textHighlight", "text", "shape", "eraser", "areaLink", "image"]);
/** Tools whose style (colour, width, opacity) can be changed. */
export const STYLED_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["pen", "marker", "textHighlight", "text", "shape"]);

export const ERASER_MODE = "pdfInkEraser";

/** PDF annotation subtypes (PdfAnnotationSubtype). */
export const FREETEXT = 3, LINE = 4, SQUARE = 5, CIRCLE = 6, HIGHLIGHT = 9, INK = 15;

/** EmbedPDF tool id for each shape kind. */
export const SHAPE_TOOL: Record<ShapeKind, string> = { arrow: "lineArrow", line: "line", rectangle: "square", ellipse: "circle" };

const EMBED_TOOL: Record<string, string> = { pen: "ink", marker: "inkHighlighter", textHighlight: "highlight", image: "stamp", text: "freeText" };

/** Which styled tool an existing annotation belongs to (for restyling a selection), or null. */
export function toolOfAnnotation(o: any): ToolId | null {
	if (!o) return null;
	if (o.type === INK) return o.intent === "InkHighlight" ? "marker" : "pen";
	if (o.type === HIGHLIGHT) return "textHighlight";
	if (o.type === FREETEXT && o.intent !== "FreeTextCallout") return "text";
	if (o.type === LINE || o.type === SQUARE || o.type === CIRCLE) return "shape";
	return null;
}

export interface ToolState {
	tool: ToolId;
	stylusMode: boolean;
	canUndo: boolean;
	canRedo: boolean;
	zoom: number;
	page: number;
	pages: number;
	fullscreen: boolean;
}

export interface ToolHost {
	settings(): Settings;
	saveSettings(): void;
	setFullscreen(on: boolean): void;
	isFullscreen(): boolean;
}

/** Owns the active tool and pushes it into EmbedPDF; the toolbar and guard subscribe to it. */
export class ToolController {
	private _tool: ToolId = "hand";
	private readonly listeners = new Set<() => void>();
	private readonly off: (() => void)[] = [];
	private zoom = 1;
	private page = 1;
	private pages = 0;
	private canUndo = false;
	private canRedo = false;
	/** True while the controller itself changes EmbedPDF's mode. */
	private applying = false;
	/** The tool to return to when the eraser is toggled off again. */
	private previousTool: ToolId = "pen";

	constructor(readonly registry: any, readonly documentId: string, readonly host: ToolHost) {
		const im = this.interaction();
		im?.registerMode?.({ id: ERASER_MODE, scope: "page", exclusive: true, cursor: "none" });
		const scope = im?.forDocument(documentId);
		// Something else changed the mode (a tool deactivated itself, a plugin): mirror it.
		this.off.push(scope?.onModeChange?.((mode: string) => this.modeChanged(mode)) ?? (() => {}));
		const zoom = this.plugin("zoom")?.forDocument(documentId);
		this.zoom = zoom?.getState?.()?.currentZoomLevel ?? 1;
		this.off.push(zoom?.onStateChange?.((s: any) => this.set(() => (this.zoom = s.currentZoomLevel))) ?? (() => {}));
		const scroll = this.plugin("scroll")?.forDocument(documentId);
		this.page = scroll?.getCurrentPage?.() ?? 1;
		this.pages = scroll?.getTotalPages?.() ?? 0;
		this.off.push(scroll?.onPageChange?.((e: any) => this.set(() => ((this.page = e.pageNumber), (this.pages = e.totalPages ?? this.pages)))) ?? (() => {}));
		const history = this.plugin("history")?.forDocument(documentId);
		const syncHistory = () => this.set(() => ((this.canUndo = !!history?.canUndo?.()), (this.canRedo = !!history?.canRedo?.())));
		this.off.push(history?.onHistoryChange?.(syncHistory) ?? (() => {}));
		syncHistory();
		this.setTool("hand");
	}

	destroy() {
		for (const off of this.off) off();
		this.off.length = 0;
		this.listeners.clear();
	}

	// ------------------------------------------------------------ EmbedPDF

	private plugin(id: string): any {
		return this.registry?.getPlugin?.(id)?.provides?.() ?? null;
	}
	private interaction(): any {
		return this.plugin("interaction-manager");
	}
	annotations(): any {
		return this.plugin("annotation")?.forDocument(this.documentId) ?? null;
	}

	// ---------------------------------------------------------------- state

	get tool(): ToolId {
		return this._tool;
	}

	get stylusMode(): boolean {
		return this.host.settings().stylusMode;
	}

	/** Whether the active tool draws (so fingers scroll in stylus mode). */
	get drawing(): boolean {
		return DRAWING_TOOLS.has(this._tool);
	}

	/** Tools where, in stylus mode, fingers scroll instead of acting on the page: drawing tools and the pointer. */
	get penOnly(): boolean {
		return this.drawing || this._tool === "pointer";
	}

	/** The pen's side button: switch to the eraser, or back to the tool used before it. */
	toggleEraser() {
		this.setTool(this._tool === "eraser" ? this.previousTool : "eraser");
	}

	state(): ToolState {
		return { tool: this._tool, stylusMode: this.stylusMode, canUndo: this.canUndo, canRedo: this.canRedo, zoom: this.zoom, page: this.page, pages: this.pages, fullscreen: this.host.isFullscreen() };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify() {
		for (const l of [...this.listeners]) l();
	}

	private set(mutate: () => void) {
		mutate();
		this.notify();
	}

	// ---------------------------------------------------------------- tools

	setTool(tool: ToolId) {
		const im = this.interaction()?.forDocument(this.documentId);
		const ann = this.annotations();
		const capture = this.plugin("capture")?.forDocument(this.documentId);
		if (tool === "eraser" && this._tool !== "eraser") this.previousTool = this._tool;
		// A text box being typed in commits its text on blur; end the edit before the tool changes.
		const focused = (globalThis as any).activeDocument?.activeElement ?? globalThis.document?.activeElement;
		if (focused?.isContentEditable) focused.blur();
		this._tool = tool;
		this.applying = true;
		try {
			ann?.deselectAnnotation?.();
			this.plugin("selection")?.forDocument(this.documentId)?.clear?.();
			if (tool !== "areaLink" && capture?.isMarqueeCaptureActive?.()) capture.disableMarqueeCapture();
			const embedTool = this.embedTool(tool);
			if (embedTool) {
				this.pushStyle(tool);
				if (ann?.getActiveTool?.()?.id !== embedTool) ann?.setActiveTool?.(embedTool);
				else im?.activate?.(embedTool);
			} else {
				if (ann?.getActiveTool?.()) ann.setActiveTool(null);
				if (tool === "hand") im?.activate?.("panMode");
				else if (tool === "pointer") im?.activate?.("pointerMode");
				else if (tool === "eraser") im?.activate?.(ERASER_MODE);
				else if (tool === "areaLink") capture?.enableMarqueeCapture?.();
			}
		} finally {
			this.applying = false;
		}
		this.notify();
	}

	private modeChanged(mode: string) {
		if (this.applying) return;
		const byMode: Record<string, ToolId> = { panMode: "hand", pointerMode: "pointer", ink: "pen", inkHighlighter: "marker", highlight: "textHighlight", stamp: "image", freeText: "text", lineArrow: "shape", line: "shape", square: "shape", circle: "shape", [ERASER_MODE]: "eraser", marqueeCapture: "areaLink" };
		const tool = byMode[mode];
		if (this._tool === "areaLink" && mode === "pointerMode") {
			// The capture plugin leaves its mode after each capture; the tool stays until the user picks another.
			queueMicrotask(() => {
				if (this._tool === "areaLink") this.plugin("capture")?.forDocument(this.documentId)?.enableMarqueeCapture?.();
			});
			return;
		}
		if (tool && tool !== this._tool) {
			this._tool = tool;
			this.notify();
		}
	}

	setStylusMode(on: boolean) {
		const s = this.host.settings();
		if (s.stylusMode === on) return;
		s.stylusMode = on;
		this.host.saveSettings();
		this.notify();
	}

	// ---------------------------------------------------------------- style

	/** The EmbedPDF tool behind one of ours (the shape tool depends on the chosen kind). */
	private embedTool(tool: ToolId): string | undefined {
		return tool === "shape" ? SHAPE_TOOL[this.shapeKind] : EMBED_TOOL[tool];
	}

	get shapeKind(): ShapeKind {
		return this.host.settings().shapeKind;
	}

	/** Picks what the shape tool draws and switches to it. */
	setShapeKind(kind: ShapeKind) {
		const s = this.host.settings();
		if (s.shapeKind !== kind) {
			s.shapeKind = kind;
			this.host.saveSettings();
		}
		this.setTool("shape");
	}

	style(tool: ToolId = this._tool): ToolStyle | null {
		const s = this.host.settings();
		if (tool === "pen") return s.pen;
		if (tool === "marker") return s.marker;
		if (tool === "textHighlight") return s.textHighlight;
		if (tool === "text") return s.text;
		if (tool === "shape") return s.shape;
		return null;
	}

	setStyle(tool: ToolId, patch: Partial<ToolStyle>) {
		const style = this.style(tool);
		if (!style) return;
		Object.assign(style, patch);
		this.pushStyle(tool);
		this.host.saveSettings();
		// Restyle what is selected too, so a swatch tap recolours a selected stroke.
		const ann = this.annotations();
		for (const a of ann?.getSelectedAnnotations?.() ?? []) {
			const o = a.object;
			if (toolOfAnnotation(o) === tool) ann.updateAnnotation(o.pageIndex, o.id, this.annotationPatch(tool, patch));
		}
		this.notify();
	}

	private annotationPatch(tool: ToolId, style: Partial<ToolStyle>): Record<string, unknown> {
		const p: Record<string, unknown> = {};
		if (tool === "text") {
			// Free text: the colour is the font's; `color` would fill the box.
			if (style.color !== undefined) p.fontColor = style.color;
			if (style.width !== undefined) p.fontSize = style.width;
		} else if (tool === "shape") {
			// Shapes: `color` is the interior fill, which stays transparent.
			if (style.color !== undefined) p.strokeColor = style.color;
			if (style.width !== undefined) {
				p.strokeWidth = style.width;
				// Dashes and dots scale with the width.
				Object.assign(p, strokePattern(this.host.settings().shapeLine.style, style.width));
			}
		} else {
			if (style.color !== undefined) (p.strokeColor = style.color), (p.color = style.color);
			if (style.width !== undefined && tool !== "textHighlight") p.strokeWidth = style.width;
		}
		if (style.opacity !== undefined) p.opacity = style.opacity;
		return p;
	}

	/** Pushes a tool's current style into EmbedPDF's tool defaults. */
	pushStyle(tool: ToolId = this._tool) {
		const style = this.style(tool);
		if (!style) return;
		const s = this.host.settings();
		const embedTools = tool === "shape" ? Object.values(SHAPE_TOOL) : [EMBED_TOOL[tool]].filter(Boolean);
		for (const id of embedTools) {
			const patch = this.annotationPatch(tool, style);
			if (tool === "text") Object.assign(patch, this.textFormatPatch(s.textFormat));
			if (id === SHAPE_TOOL.arrow) patch.lineEndings = this.lineEndsPatch(s.shapeLine);
			this.plugin("annotation")?.setToolDefaults?.(id, patch);
		}
	}

	private textFormatPatch(f: TextFormat): Record<string, unknown> {
		const fontFamily = standardFont(f);
		// PDFium writes a non-Helvetica font into the DA under a name it cannot read back (fontFamily -1 on reopen);
		// the font is kept in EmbedPDF's custom data too, and restored on load (restoreTextFonts).
		return { fontFamily, textAlign: ALIGN_VALUE[f.align], custom: { pdfInkFont: fontFamily } };
	}

	private lineEndsPatch(l: ShapeLine): { start: number; end: number } {
		return { start: LINE_END_VALUE[l.start], end: LINE_END_VALUE[l.end] };
	}

	/** Changes the text tool's font, bold, italic or alignment (and that of selected text boxes). */
	setTextFormat(patch: Partial<TextFormat>) {
		const s = this.host.settings();
		Object.assign(s.textFormat, patch);
		this.pushStyle("text");
		this.host.saveSettings();
		const ann = this.annotations();
		for (const a of ann?.getSelectedAnnotations?.() ?? []) if (toolOfAnnotation(a.object) === "text") ann.updateAnnotation(a.object.pageIndex, a.object.id, this.textFormatPatch(s.textFormat));
		this.notify();
	}

	/** Changes the line style of arrows, lines and shapes, or the arrow's ends. */
	setShapeLine(patch: Partial<ShapeLine>) {
		const s = this.host.settings();
		Object.assign(s.shapeLine, patch);
		this.pushStyle("shape");
		this.host.saveSettings();
		this.notify();
	}

	/** Formats one existing text box (from its selection menu): one undo step. */
	formatTextBox(o: any, patch: Partial<TextFormat>, current: TextFormat) {
		this.annotations()?.updateAnnotation(o.pageIndex, o.id, this.textFormatPatch({ ...current, ...patch }));
	}

	/** Sets the line style of one existing arrow, line or shape (from its selection menu). */
	setAnnotationLineStyle(o: any, style: ShapeLine["style"]) {
		this.annotations()?.updateAnnotation(o.pageIndex, o.id, strokePattern(style, o.strokeWidth ?? 1));
	}

	pushAllStyles() {
		for (const t of ["pen", "marker", "textHighlight", "text", "shape"] as ToolId[]) this.pushStyle(t);
	}

	// -------------------------------------------------------------- actions

	undo() {
		this.plugin("history")?.forDocument(this.documentId)?.undo?.();
	}
	redo() {
		this.plugin("history")?.forDocument(this.documentId)?.redo?.();
	}
	zoomIn() {
		this.plugin("zoom")?.forDocument(this.documentId)?.zoomIn?.();
	}
	zoomOut() {
		this.plugin("zoom")?.forDocument(this.documentId)?.zoomOut?.();
	}
	fitWidth() {
		this.plugin("zoom")?.forDocument(this.documentId)?.requestZoom?.("fit-width");
	}
	fitPage() {
		this.plugin("zoom")?.forDocument(this.documentId)?.requestZoom?.("fit-page");
	}
	goToPage(pageNumber: number) {
		const n = Math.max(1, Math.min(this.pages || 1, Math.round(pageNumber)));
		this.plugin("scroll")?.forDocument(this.documentId)?.scrollToPage?.({ pageNumber: n, behavior: "smooth" });
	}
	deleteSelected() {
		const ann = this.annotations();
		const selected = ann?.getSelectedAnnotations?.() ?? [];
		this.deleteMany(selected.map((a: any) => ({ pageIndex: a.object.pageIndex, id: a.object.id })));
	}

	/**
	 * Deletes several annotations as one undo step. EmbedPDF records one history
	 * entry per deleted annotation (an eraser stroke across five strokes would
	 * take five undos), so the deletes run with its history detached and one
	 * command for the lot is recorded instead. Not native to EmbedPDF.
	 */
	deleteMany(items: { pageIndex: number; id: string }[]) {
		this.recordDeletion(this.deleteQuietly(items));
	}

	/**
	 * Recolours strokes and highlights as one undo step (EmbedPDF would record
	 * one history entry per annotation). Returns how many were changed.
	 */
	recolorMany(items: { pageIndex: number; id: string }[], color: string): number {
		const ann = this.annotations();
		if (!ann || !items.length) return 0;
		const originals = items.map((it) => ann.getAnnotationById?.(it.id)?.object).filter((o: any) => toolOfAnnotation(o) !== null);
		if (!originals.length) return 0;
		/** The colour fields of each kind: text has a font colour, shapes keep their (transparent) fill. */
		const colorPatch = (o: any, c: string): Record<string, unknown> => (o.type === FREETEXT ? { fontColor: c } : o.type === LINE || o.type === SQUARE || o.type === CIRCLE ? { strokeColor: c } : { strokeColor: c, color: c });
		const before = originals.map((o: any) => ({ pageIndex: o.pageIndex, id: o.id, patch: o.type === FREETEXT ? { fontColor: o.fontColor } : o.type === LINE || o.type === SQUARE || o.type === CIRCLE ? { strokeColor: o.strokeColor } : { strokeColor: o.strokeColor, color: o.color } }));
		const apply = (c: string) => this.quietly(() => originals.forEach((o: any) => ann.updateAnnotation(o.pageIndex, o.id, colorPatch(o, c))));
		apply(color);
		const history = this.plugin("history")?.forDocument(this.documentId);
		if (history) {
			let first = true;
			history.register(
				{
					execute: () => (first ? void (first = false) : apply(color)),
					undo: () => this.quietly(() => before.forEach((b) => ann.updateAnnotation(b.pageIndex, b.id, b.patch))),
					metadata: { source: "pdf-ink", annotationIds: originals.map((o: any) => o.id) },
				},
				"annotations"
			);
		}
		this.notify();
		return originals.length;
	}

	/** Runs annotation changes without EmbedPDF history entries. */
	quietly(fn: () => void) {
		const instance: any = this.registry?.getPlugin?.("annotation");
		if (!instance || !("history" in instance)) return fn();
		const h = instance.history;
		instance.history = null;
		try {
			fn();
		} finally {
			instance.history = h;
		}
	}

	/** Deletes without a history entry and returns the deleted objects (for `recordDeletion`). */
	deleteQuietly(items: { pageIndex: number; id: string }[]): any[] {
		const ann = this.annotations();
		if (!ann || !items.length) return [];
		const originals = items.map((it) => ann.getAnnotationById?.(it.id)?.object).filter(Boolean);
		if (!originals.length) return [];
		this.quietly(() => ann.deleteAnnotations(originals.map((o: any) => ({ pageIndex: o.pageIndex, id: o.id }))));
		return originals;
	}

	/** Records one undo step that restores `originals` (already deleted) and re-deletes them on redo. */
	recordDeletion(originals: any[]) {
		const history = this.plugin("history")?.forDocument(this.documentId);
		const instance: any = this.registry?.getPlugin?.("annotation");
		if (!originals.length || !history || !instance) return;
		const ann = this.annotations();
		let first = true;
		const execute = () => {
			// history.register runs the command once; the deletes have already happened.
			if (first) return void (first = false);
			this.quietly(() => ann?.deleteAnnotations(originals.map((o: any) => ({ pageIndex: o.pageIndex, id: o.id }))));
		};
		const undo = () =>
			this.quietly(() => {
				const create = instance.__pdfInkRawCreate ?? instance.createAnnotation;
				for (const o of originals) create.call(instance, o.pageIndex, o, undefined, this.documentId);
			});
		history.register({ execute, undo, metadata: { source: "pdf-ink", annotationIds: originals.map((o: any) => o.id) } }, "annotations");
	}
	toggleFullscreen() {
		this.host.setFullscreen(!this.host.isFullscreen());
		this.notify();
	}
}
