/**
 * The viewer: EmbedPDF's headless plugins (PDFium engine, virtual scroller,
 * tiled rendering, pan, selection, annotation, capture) under the plugin's own
 * toolbar, rendered with Preact into the Obsidian view.
 */
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PdfEngine } from "@embedpdf/models";
import { PdfAnnotationSubtype, uuidV4 } from "@embedpdf/models";
import { createPluginRegistration, type PluginRegistry } from "@embedpdf/core";
import { EmbedPDF, useDocumentState, useRegistry } from "@embedpdf/core/preact";
import { DocumentContent, DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/preact";
import { Viewport, ViewportPluginPackage } from "@embedpdf/plugin-viewport/preact";
import { Scroller, ScrollPluginPackage } from "@embedpdf/plugin-scroll/preact";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/preact";
import { TilingLayer, TilingPluginPackage } from "@embedpdf/plugin-tiling/preact";
import { ZoomGestureWrapper, ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/preact";
import { GlobalPointerProvider, InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/preact";
import { PanPluginPackage } from "@embedpdf/plugin-pan/preact";
import { SelectionLayer, SelectionPluginPackage } from "@embedpdf/plugin-selection/preact";
import { HistoryPluginPackage } from "@embedpdf/plugin-history/preact";
import { AnnotationLayer, AnnotationPluginPackage, AnnotationRendererProvider } from "@embedpdf/plugin-annotation/preact";
import { CapturePluginPackage, MarqueeCapture } from "@embedpdf/plugin-capture/preact";
import { ExportPluginPackage } from "@embedpdf/plugin-export/preact";
import { Toolbar } from "./toolbar";
import { PointerGuard } from "./guard";
import { PenLog } from "./pen-log";
import type { Settings } from "./settings";
import { installInkSmoothing } from "./ink";
import { PdfInkRenderers } from "./ink-preview";
import { installAnnotationMemo } from "./memo-annotations";
import { forgetStampSource, rememberStampSource } from "./stamp";
import { FREETEXT, HIGHLIGHT, INK, LINE, SQUARE, CIRCLE, SHAPE_TOOL, ToolController, isMarker, toolOfAnnotation } from "./tools";
import { fontFormat, lineStyleOf } from "./formats";
import { LineStyleGlyph, dotSize } from "./toolbar";
import { LINE_STYLES } from "./settings";
import { TEXT_BOX_WIDTH, TEXT_PLACEHOLDER, fitTextBox, keepTapsInTextBox, textLineHeight } from "./text-box";
import { Backlink, LinkVars, PageRect, fillTemplate, linkText, parseSubpath, rectFromParam, rectParam } from "./links";
import { Icon } from "./icon";

/** What the Obsidian view provides to the viewer. */
export interface ViewerHost {
	settings(): Settings;
	saveSettings(): void;
	/** An annotation was added, changed or removed. */
	onChange(): void;
	setFullscreen(on: boolean): void;
	isFullscreen(): boolean;
	/** Variables for a link template (the host knows the file's link text). */
	linkVars(page: number, rect: string, text: string, color: string): LinkVars;
	deliverLink(text: string): Promise<void>;
	backlinks(): Backlink[];
	openBacklink(link: Backlink): void;
	openSidecar(): void;
	/** The reading position moved (throttled); the host remembers it per file. */
	positionChanged(pos: ReadingPosition): void;
	/** Appends text to the pen timing log (a diagnostic). */
	penLog(text: string): void;
	/** Adds a blank page after or before the current page, or deletes the current page. */
	editPages(action: PageAction): void;
}

export type PageAction = "insertAfter" | "insertBefore" | "delete";

/** Where the reader is: the topmost visible page and the offset into it in PDF points. */
export interface ReadingPosition {
	page: number;
	y: number;
}

/** What the Obsidian view gets once a document is open. */
export interface ViewerHandle {
	registry: PluginRegistry;
	documentId: string;
	tools: ToolController;
	/** The PDF with every annotation written into it. */
	save(): Promise<ArrayBuffer>;
	/** Pushes the settings into the tools (after a settings change). */
	applySettings(): void;
	/** Scrolls to "#page=N&rect=..." and flashes the rect. */
	goTo(subpath: string): void;
	/** Backlinks changed (a note was edited). */
	refreshBacklinks(): void;
	/** The current reading position, or null before the layout exists. */
	position(): ReadingPosition | null;
	/** Scrolls back to a remembered position without animation. */
	restore(pos: ReadingPosition): void;
	/** Size of a page (0-based) in PDF points before its /Rotate, and that rotation in quarter turns. */
	pageSize(pageIndex: number): { width: number; height: number; rotation: number } | null;
	/** The zoom as set by the reader: a mode such as "fit-width", or a number. */
	zoomLevel(): unknown;
	setZoomLevel(level: unknown): void;
}

export interface ViewerProps {
	engine: PdfEngine;
	bytes: ArrayBuffer;
	name: string;
	host: ViewerHost;
	onReady(handle: ViewerHandle): void;
	onError(error: Error): void;
}

/** Resolves an EmbedPDF Task. */
export function settle<T>(task: { toPromise?: () => Promise<T>; wait: (ok: (v: T) => void, no: (e: unknown) => void) => void }): Promise<T> {
	if (typeof task.toPromise === "function") return task.toPromise();
	return new Promise<T>((ok, no) => task.wait(ok, no));
}

export function mountViewer(el: HTMLElement, props: ViewerProps): { unmount: () => void } {
	installAnnotationMemo(!(globalThis as any).__pdfInkNoMemo);
	render(<App {...props} />, el);
	return { unmount: () => render(null, el) };
}

const toRect = (r: any): PageRect => ({ x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });

function App(props: ViewerProps) {
	const { engine, host } = props;
	const plugins = useMemo(() => {
		const s = host.settings();
		const ink = (id: string, style: { color: string; width: number; opacity: number }) => ({
			id,
			defaults: { strokeColor: style.color, color: style.color, strokeWidth: style.width, opacity: style.opacity },
			// commitDelay 0: a stroke is an annotation as soon as the pen lifts, so a save right after it never loses it.
			behavior: { commitDelay: 0 },
			// exclusive: while drawing, existing annotations are not clickable, so a stroke over an earlier one draws.
			interaction: { exclusive: true },
		});
		return [
			createPluginRegistration(DocumentManagerPluginPackage),
			createPluginRegistration(ViewportPluginPackage, { viewportGap: 12 }),
			createPluginRegistration(ScrollPluginPackage, { defaultPageGap: 12, defaultBufferSize: 2 }),
			createPluginRegistration(RenderPluginPackage),
			createPluginRegistration(TilingPluginPackage, { tileSize: 768, overlapPx: 3, extraRings: 0 }),
			createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth, minZoom: 0.25, maxZoom: 8 }),
			createPluginRegistration(InteractionManagerPluginPackage),
			createPluginRegistration(PanPluginPackage, { defaultMode: "never" }),
			createPluginRegistration(SelectionPluginPackage),
			createPluginRegistration(HistoryPluginPackage),
			createPluginRegistration(AnnotationPluginPackage, {
				autoCommit: true,
				annotationAuthor: "",
				selectAfterCreate: false,
				tools: [
					ink("ink", s.pen),
					ink("inkHighlighter", s.marker),
					// exclusive as well: a tap on an existing highlight or stroke must not select it while highlighting.
					{ id: "highlight", defaults: { strokeColor: s.textHighlight.color, color: s.textHighlight.color, opacity: s.textHighlight.opacity }, interaction: { exclusive: true } },
					// stamp (image): a tap opens the file picker and drops the picture there; exclusive so a tap on an existing annotation inserts rather than selects.
					{ id: "stamp", interaction: { exclusive: true } },
					// freeText: a tap adds a box with its placeholder selected, so typing replaces it (a drag sets the box); a box left empty or untouched is removed when typing ends.
					{
						id: "freeText",
						defaults: { fontColor: s.text.color, fontSize: s.text.width, opacity: s.text.opacity, color: "transparent", backgroundColor: "transparent", contents: TEXT_PLACEHOLDER },
						clickBehavior: { enabled: true, defaultSize: { width: TEXT_BOX_WIDTH, height: textLineHeight(s.text.width) }, defaultContent: TEXT_PLACEHOLDER },
						interaction: { exclusive: true },
					},
					// Arrow, line, rectangle, ellipse: drag to draw. No tap-to-insert, so a stray pen tap leaves nothing behind.
					...Object.values(SHAPE_TOOL).map((id) => ({
						id,
						defaults: { strokeColor: s.shape.color, strokeWidth: s.shape.width, opacity: s.shape.opacity, color: "transparent" },
						clickBehavior: { enabled: false },
						interaction: { exclusive: true },
					})),
				] as any,
			}),
			createPluginRegistration(CapturePluginPackage, { scale: 2, imageType: "image/png", withAnnotations: true }),
			createPluginRegistration(ExportPluginPackage),
		];
	}, []);

	const onInitialized = async (registry: PluginRegistry) => {
		try {
			const documents: any = (registry.getPlugin("document-manager") as any)?.provides();
			const opened: { documentId: string; task: any } = await settle(documents.openDocumentBuffer({ buffer: props.bytes, name: props.name }));
			await settle(opened.task);
			installInkSmoothing(registry.getPlugin("annotation"), () => host.settings().smoothStrokes);
		} catch (e) {
			props.onError(e instanceof Error ? e : new Error(String(e)));
		}
	};

	return (
		<EmbedPDF engine={engine} plugins={plugins} onInitialized={onInitialized}>
			{({ activeDocumentId }) =>
				activeDocumentId && (
					<DocumentContent documentId={activeDocumentId}>
						{({ isLoaded }) => isLoaded && <Viewer documentId={activeDocumentId} {...props} />}
					</DocumentContent>
				)
			}
		</EmbedPDF>
	);
}

/** A menu beside a selection: the wrapper EmbedPDF gives us covers the selection with pointer-events none, so the menu floats above or below it. */
function Menu({ wrapperProps, placement, extraClass, children }: { wrapperProps: any; placement: any; extraClass?: string; children: any }) {
	return (
		<div {...wrapperProps} class="pdf-ink-menu-anchor">
			<div class={"pdf-ink-menu pdf-ink-float " + (placement?.suggestTop === false ? "is-below" : "is-above") + (extraClass ? " " + extraClass : "")} onPointerDown={(e) => e.stopPropagation()}>
				{children}
			</div>
		</div>
	);
}

interface Flash {
	pageIndex: number;
	rect: PageRect | null;
	token: number;
}

interface AreaPick {
	pageIndex: number;
	rect: PageRect;
}

function Viewer({ documentId, host, onReady }: ViewerProps & { documentId: string }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { registry } = useRegistry();
	const docState = useDocumentState(documentId);
	const pages: { size: { width: number; height: number } }[] = docState?.document?.pages ?? [];
	const tools = useMemo(() => new ToolController(registry, documentId, { settings: host.settings, saveSettings: host.saveSettings, setFullscreen: host.setFullscreen, isFullscreen: host.isFullscreen }), [registry, documentId]);
	const pagesRef = useRef(pages);
	pagesRef.current = pages;
	const [flash, setFlash] = useState<Flash | null>(null);
	const [area, setArea] = useState<AreaPick | null>(null);
	const [backlinks, setBacklinks] = useState<Backlink[]>(() => host.backlinks());
	const [, bump] = useState(0);

	useEffect(() => {
		const root = rootRef.current;
		if (!root || !registry) return;
		// Before the guard, so its listeners see events first and the guard's work counts in the timings.
		const penLog = new PenLog(root, tools, host.penLog, () => host.settings().penTimingLog);
		const guard = new PointerGuard(root, tools, host.settings, host.onChange);
		const offTextTaps = keepTapsInTextBox(root, () => tools.tool === "text");
		const annotations: any = (registry.getPlugin("annotation") as any)?.provides();
		const scoped = annotations?.forDocument(documentId);
		/** Text boxes with a change waiting to be committed: true when it is typed text. */
		const textEdits = new Map<string, boolean>();
		/**
		 * PDFium reads a text box's font back only for Helvetica (other standard fonts come back as
		 * Unknown, -1); the font we set is also in the annotation's custom data, so put it back.
		 * Not an edit: the file is not marked changed. Not native to EmbedPDF.
		 */
		let restoringFonts = false;
		const restoreTextFonts = () => {
			const wrong = (scoped?.getAnnotations?.() ?? []).map((t: any) => t?.object).filter((o: any) => o?.type === FREETEXT && typeof o.custom?.pdfInkFont === "number" && o.fontFamily !== o.custom.pdfInkFont);
			if (!wrong.length) return;
			restoringFonts = true;
			try {
				tools.quietly(() => wrong.forEach((o: any) => scoped.updateAnnotation(o.pageIndex, o.id, { fontFamily: o.custom.pdfInkFont })));
			} finally {
				restoringFonts = false;
			}
		};
		const offAnn = scoped?.onAnnotationEvent?.((event: any) => {
			if (event.type === "loaded") restoreTextFonts();
			// Commits re-emit every event with committed: true; only new edits mark the file dirty.
			if (event.type !== "loaded" && !event.committed && !restoringFonts) host.onChange();
			// A new stamp carries its image bytes; keep them so it shows at once (see stamp.tsx).
			if (event.type === "create" && !event.committed && event.annotation?.type === PdfAnnotationSubtype.STAMP && event.ctx?.data) rememberStampSource(event.annotation.id, event.ctx.data);
			if (event.type === "delete" && event.committed) forgetStampSource(event.annotation?.id);
			// Typing in a text box ended (EmbedPDF writes the text on blur): once that is committed, drop a box left
			// empty or untouched, or grow it to fit its text. Not native to EmbedPDF.
			// A new font or size can need a bigger box too.
			if (event.type === "update" && event.annotation?.type === FREETEXT && event.patch) {
				const id = event.annotation.id, pageIndex = event.pageIndex ?? event.annotation.pageIndex;
				if (!event.committed) {
					if (typeof event.patch.contents === "string") textEdits.set(id, true);
					else if ("fontFamily" in event.patch || "fontSize" in event.patch) textEdits.set(id, textEdits.get(id) ?? false);
				} else if (textEdits.has(id)) {
					const typed = textEdits.get(id);
					textEdits.delete(id);
					setTimeout(() => {
						const current = scoped?.getAnnotationById?.(id)?.object;
						if (!current) return;
						const text = (current.contents ?? "").trim();
						if (typed && (!text || text === TEXT_PLACEHOLDER)) return void scoped.deleteAnnotation(pageIndex, id);
						const size = pagesRef.current[pageIndex]?.size;
						const rect = size && fitTextBox(current, size);
						// Not an undo step of its own: undoing the text leaves the box size, which is harmless.
						if (rect) tools.quietly(() => scoped.updateAnnotation(pageIndex, id, { rect }));
					}, 0);
				}
			}
		});
		restoreTextFonts();
		const capture: any = (registry.getPlugin("capture") as any)?.provides()?.forDocument(documentId);
		const offCapture = capture?.onCaptureArea?.((e: any) => setArea({ pageIndex: e.pageIndex, rect: toRect(e.rect) }));
		// The toolbar follows zoom, page, history and styles itself; the pages only change with the tool or the settings.
		let seenTool = tools.tool, seenSettings = tools.settingsVersion;
		const offTools = tools.subscribe(() => {
			if (tools.tool === seenTool && tools.settingsVersion === seenSettings) return;
			seenTool = tools.tool;
			seenSettings = tools.settingsVersion;
			bump((n) => n + 1);
		});
		const scroll: any = (registry.getPlugin("scroll") as any)?.provides()?.forDocument(documentId);
		const zoomScope: any = (registry.getPlugin("zoom") as any)?.provides()?.forDocument(documentId);
		const position = (metrics?: any): ReadingPosition | null => {
			const m = metrics ?? scroll?.getMetrics?.();
			const first = m?.pageVisibilityMetrics?.[0];
			if (!first) return null;
			return { page: first.pageNumber, y: Math.max(0, Math.round(first.original?.pageY ?? 0)) };
		};
		// Not native: EmbedPDF forgets where the reader was; the host is told, throttled, so it can remember per file.
		let lastReport = 0, reportTimer: ReturnType<typeof setTimeout> | null = null;
		const offScroll = scroll?.onScroll?.((m: any) => {
			const report = () => {
				lastReport = Date.now();
				const pos = position(m);
				if (pos) host.positionChanged(pos);
			};
			if (reportTimer) clearTimeout(reportTimer);
			if (Date.now() - lastReport > 1000) report();
			else reportTimer = setTimeout(report, 1000);
		});
		onReady({
			registry,
			documentId,
			tools,
			applySettings: () => {
				tools.pushAllStyles();
				tools.notify();
			},
			refreshBacklinks: () => {
				// Obsidian re-resolves links after edits anywhere in the vault: re-render only when this PDF's backlinks changed.
				const next = host.backlinks();
				setBacklinks((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
			},
			position: () => position(),
			pageSize: (i) => {
				const page: any = pagesRef.current[i];
				return page?.size ? { width: page.size.width, height: page.size.height, rotation: page.rotation ?? 0 } : null;
			},
			zoomLevel: () => zoomScope?.getState?.()?.zoomLevel,
			setZoomLevel: (level) => level !== undefined && zoomScope?.requestZoom?.(level),
			restore: (pos) => scroll?.scrollToPage?.({ pageNumber: pos.page, pageCoordinates: { x: 0, y: pos.y }, behavior: "instant" }),
			goTo: (subpath) => {
				const sub = parseSubpath(subpath);
				if (!sub.page) return;
				const pageIndex = sub.page - 1;
				const height = pagesRef.current[pageIndex]?.size.height ?? 0;
				const rect = sub.rect && height ? rectFromParam(sub.rect, height) : null;
				scroll?.scrollToPage?.({ pageNumber: sub.page, behavior: "smooth", ...(rect ? { pageCoordinates: { x: rect.x, y: Math.max(0, rect.y - 40) } } : {}) });
				setFlash({ pageIndex, rect, token: Date.now() });
			},
			save: async () => {
				// commit() returns at once while another commit runs: wait until nothing is pending.
				const deadline = Date.now() + 15000;
				while (scoped?.commit) {
					await settle(scoped.commit()).catch(() => {});
					if (!scoped.getState?.()?.hasPendingChanges) break;
					if (Date.now() > deadline) throw new Error("annotations are still being written; try again");
					await new Promise((r) => setTimeout(r, 20));
				}
				const exporter: any = (registry.getPlugin("export") as any)?.provides()?.forDocument(documentId);
				return settle<ArrayBuffer>(exporter.saveAsCopy());
			},
		});
		return () => {
			if (reportTimer) clearTimeout(reportTimer);
			offScroll?.();
			offAnn?.();
			offCapture?.();
			offTools();
			offTextTaps();
			guard.destroy();
			penLog.destroy();
			tools.destroy();
		};
	}, [documentId, registry]);

	// The area pick belongs to the area link tool; leaving it drops the pick.
	useEffect(() => {
		if (tools.tool !== "areaLink" && area) setArea(null);
	}, [tools.tool, area]);

	useEffect(() => {
		if (!flash) return;
		const t = setTimeout(() => setFlash((f) => (f?.token === flash.token ? null : f)), 2200);
		return () => clearTimeout(t);
	}, [flash?.token]);

	const settings = host.settings();

	const copyLink = async (pageIndex: number, rect: PageRect, text: string, template: string, color = "") => {
		const height = pages[pageIndex]?.size.height ?? 0;
		const vars = host.linkVars(pageIndex + 1, rectParam(rect, height), linkText(text), color.replace(/^#/, ""));
		await host.deliverLink(fillTemplate(template, vars));
	};

	const selectionScope = (): any => (registry?.getPlugin("selection") as any)?.provides()?.forDocument(documentId);

	const selectionMenu = ({ menuWrapperProps, context, selected, placement }: any) => {
		if (!selected) return null;
		const pageIndex: number = context.pageIndex;
		const withSelection = async (fn: (rect: PageRect, segments: PageRect[], text: string) => Promise<void> | void) => {
			const sel = selectionScope();
			const formatted = sel?.getFormattedSelectionForPage?.(pageIndex);
			if (!formatted) return;
			const text = await settle<string[]>(sel.getSelectedText()).catch(() => [] as string[]);
			await fn(toRect(formatted.rect), formatted.segmentRects.map(toRect), text.join("\n"));
			sel.clear();
		};
		const highlight = () =>
			withSelection((rect, segmentRects, text) => {
				const s = host.settings().textHighlight;
				const ann = tools.annotations();
				ann?.createAnnotation(pageIndex, {
					type: HIGHLIGHT,
					id: uuidV4(),
					pageIndex,
					rect: { origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } },
					segmentRects: segmentRects.map((r) => ({ origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } })),
					strokeColor: s.color,
					color: s.color,
					opacity: s.opacity,
					blendMode: 1,
					created: new Date(),
					custom: { text },
				});
			});
		return (
			<Menu wrapperProps={menuWrapperProps} placement={placement}>
					{settings.textLinkFormats.map((f) => (
						<button key={f.name} class="pdf-ink-menu-item" onClick={() => withSelection((rect, _s, text) => copyLink(pageIndex, rect, text, f.template, settings.textHighlight.color))}>
							<Icon name="link" /> {f.name}
						</button>
					))}
					<button class="pdf-ink-menu-item" onClick={highlight}>
						<Icon name="highlighter" /> Highlight
					</button>
					<button class="pdf-ink-menu-item" onClick={() => withSelection((_r, _s, text) => navigator.clipboard.writeText(text))}>
						<Icon name="copy" /> Copy text
					</button>
			</Menu>
		);
	};

	/** Each kind of annotation takes its tool's palette (pen, highlighters, text, shapes); a mixed selection gets them all. */
	const paletteFor = (objects: any[]): string[] => {
		const pen = objects.some((o) => o?.type === INK && !isMarker(o));
		const hl = objects.some((o) => o?.type === HIGHLIGHT || isMarker(o));
		const text = objects.some((o) => o?.type === FREETEXT && o.intent !== "FreeTextCallout");
		const shape = objects.some((o) => o?.type === LINE || o?.type === SQUARE || o?.type === CIRCLE);
		return [...new Set([...(pen ? settings.penColors : []), ...(hl ? settings.highlightColors : []), ...(text ? settings.textColors : []), ...(shape ? settings.shapeColors : [])])];
	};
	const colorOf = (o: any): string | undefined => (o?.type === FREETEXT ? o.fontColor : o?.strokeColor)?.toLowerCase();
	const Swatches = ({ objects }: { objects: any[] }) => {
		const colors = paletteFor(objects);
		if (!colors.length) return null;
		const shared = objects.every((o) => colorOf(o) === colorOf(objects[0])) ? colorOf(objects[0]) : null;
		const items = objects.map((o) => ({ pageIndex: o.pageIndex, id: o.id }));
		return (
			<>
				{colors.map((c) => (
					<button key={c} class={"pdf-ink-swatch" + (shared === c ? " is-active" : "")} aria-label={c} onClick={() => tools.recolorMany(items, c)}>
						<span class="pdf-ink-dot" style={{ background: c }} />
					</button>
				))}
			</>
		);
	};

	const annotationMenu = ({ menuWrapperProps, context, selected, placement }: any) => {
		if (!selected) return null;
		const a = context.annotation?.object;
		const pageIndex: number = context.pageIndex;
		const ann = tools.annotations();
		return (
			<Menu wrapperProps={menuWrapperProps} placement={placement}>
					{a && <Swatches objects={[a]} />}
					{a?.type === FREETEXT && (() => {
						// Bold and italic of this box; the family and alignment stay as they are.
						const f = { ...settings.textFormat, ...fontFormat(a.fontFamily), align: (["left", "center", "right"] as const)[a.textAlign] ?? "left" };
						return (
							<>
								<button class={"pdf-ink-menu-item" + (f.bold ? " is-active" : "")} aria-label="Bold" onClick={() => tools.formatTextBox(a, { bold: !f.bold }, f)}>
									<b>B</b>
								</button>
								<button class={"pdf-ink-menu-item" + (f.italic ? " is-active" : "")} aria-label="Italic" onClick={() => tools.formatTextBox(a, { italic: !f.italic }, f)}>
									<i style={{ fontFamily: "Times, serif" }}>I</i>
								</button>
							</>
						);
					})()}
					{(a?.type === LINE || a?.type === SQUARE || a?.type === CIRCLE) &&
						LINE_STYLES.map((ls) => (
							<button key={ls} class={"pdf-ink-menu-item" + (lineStyleOf(a) === ls ? " is-active" : "")} aria-label={`${ls[0].toUpperCase()}${ls.slice(1)} line`} onClick={() => tools.setAnnotationLineStyle(a, ls)}>
								<LineStyleGlyph style={ls} />
							</button>
						))}
					{a && toolOfAnnotation(a) && <StyleControls o={a} tools={tools} settings={settings} />}
					{a && (
						<button class="pdf-ink-menu-item" aria-label="Copy link to annotation" onClick={() => copyLink(pageIndex, toRect(a.rect), a.custom?.text ?? a.contents ?? `p.${pageIndex + 1}`, settings.areaLinkFormats[0]?.template ?? "[[{{file}}#page={{page}}&rect={{rect}}]]", a.strokeColor ?? "")}>
							<Icon name="link" />
						</button>
					)}
					<button class="pdf-ink-menu-item" aria-label="Delete" onClick={() => ann?.deleteAnnotation(pageIndex, a.id)}>
						<Icon name="trash-2" />
					</button>
			</Menu>
		);
	};

	const groupMenu = ({ menuWrapperProps, context, selected, placement }: any) => {
		if (!selected) return null;
		const items: any[] = context.annotations ?? [];
		return (
			<Menu wrapperProps={menuWrapperProps} placement={placement}>
					<Swatches objects={items.map((t) => t.object)} />
					<button class="pdf-ink-menu-item" aria-label="Delete selected" onClick={() => tools.deleteMany(items.map((t) => ({ pageIndex: t.object.pageIndex, id: t.object.id })))}>
						<Icon name="trash-2" /> Delete {items.length}
					</button>
			</Menu>
		);
	};

	return (
		<AnnotationRendererProvider>
		<PdfInkRenderers />
		<div class={"pdf-ink" + (settings.darkPages === "always" ? " is-dark-pages" : settings.darkPages === "theme" ? " is-dark-theme-pages" : "")} ref={rootRef}>
			<Toolbar tools={tools} settings={settings} onOpenSidecar={host.openSidecar} onEditPages={host.editPages} />
			<GlobalPointerProvider documentId={documentId} class="pdf-ink-global">
			<Viewport documentId={documentId} class="pdf-ink-viewport">
				<ZoomGestureWrapper documentId={documentId} class="pdf-ink-zoom">
					<Scroller
						documentId={documentId}
						renderPage={({ pageIndex, width, height }) => {
							const size = pages[pageIndex]?.size;
							const scale = size ? width / size.width : 1;
							const pageHeight = size?.height ?? height / scale;
							const links = backlinks.filter((b) => b.page === pageIndex + 1 && b.rect);
							return (
								<div class="pdf-ink-page" data-page-index={pageIndex} style={{ width, height }}>
									<PagePointerProvider documentId={documentId} pageIndex={pageIndex} class="pdf-ink-page-layers">
										<RenderLayer documentId={documentId} pageIndex={pageIndex} scale={1} class="pdf-ink-base" />
										<TilingLayer documentId={documentId} pageIndex={pageIndex} class="pdf-ink-tiles" />
										{settings.showBacklinks && links.length > 0 && (
											<div class="pdf-ink-backlinks">
												{links.map((b, i) => {
													const r = rectFromParam(b.rect!, pageHeight);
													if (!r) return null;
													return (
														<button
															key={i}
															class="pdf-ink-backlink"
															style={{ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale, borderColor: settings.backlinkColor }}
															aria-label={`Open ${b.sourcePath}`}
															title={b.sourcePath}
															onPointerDown={(e) => e.stopPropagation()}
															onClick={() => host.openBacklink(b)}
														/>
													);
												})}
											</div>
										)}
										<SelectionLayer documentId={documentId} pageIndex={pageIndex} background="rgba(0, 120, 255, 0.22)" selectionMenu={selectionMenu} />
										<AnnotationLayer documentId={documentId} pageIndex={pageIndex} selectionMenu={annotationMenu} groupSelectionMenu={groupMenu} />
										{tools.tool === "areaLink" && <MarqueeCapture documentId={documentId} pageIndex={pageIndex} className="pdf-ink-marquee" />}
										{flash && flash.pageIndex === pageIndex && (
											<div
												class="pdf-ink-flash"
												key={flash.token}
												style={flash.rect ? { left: flash.rect.x * scale, top: flash.rect.y * scale, width: flash.rect.width * scale, height: flash.rect.height * scale } : { inset: 0 }}
											/>
										)}
										{area && area.pageIndex === pageIndex && (
											<div class="pdf-ink-area" style={{ left: area.rect.x * scale, top: area.rect.y * scale, width: area.rect.width * scale, height: area.rect.height * scale }} onPointerDown={(e) => e.stopPropagation()}>
												<div class="pdf-ink-menu pdf-ink-area-menu">
													{settings.areaLinkFormats.map((f) => (
														<button key={f.name} class="pdf-ink-menu-item" onClick={() => copyLink(pageIndex, area.rect, `p.${pageIndex + 1}`, f.template).then(() => setArea(null))}>
															<Icon name="link" /> {f.name}
														</button>
													))}
													<button class="pdf-ink-menu-item" aria-label="Cancel" onClick={() => setArea(null)}>
														<Icon name="x" />
													</button>
												</div>
											</div>
										)}
									</PagePointerProvider>
								</div>
							);
						}}
					/>
				</ZoomGestureWrapper>
			</Viewport>
			</GlobalPointerProvider>
		</div>
		</AnnotationRendererProvider>
	);
}

/**
 * Width (or text size) and opacity of one selected annotation, behind a single
 * menu button so the menu stays small. Each pick is one undo step.
 */
function StyleControls({ o, tools, settings }: { o: any; tools: ToolController; settings: Settings }) {
	const [open, setOpen] = useState(false);
	const tool = toolOfAnnotation(o);
	const sizes = tool === "pen" ? settings.penWidths : tool === "marker" ? settings.markerWidths : tool === "shape" ? settings.shapeWidths : tool === "text" ? settings.textSizes : [];
	const current = tool === "text" ? o.fontSize : o.strokeWidth;
	const color = (tool === "text" ? o.fontColor : o.strokeColor) ?? "currentColor";
	return (
		<>
			<button class={"pdf-ink-menu-item" + (open ? " is-active" : "")} aria-label="Width and opacity" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="sliders-horizontal|settings-2" />
			</button>
			{open && (
				<div class="pdf-ink-menu-row pdf-ink-menu-style">
					{sizes.map((w) => (
						<button key={w} class={"pdf-ink-swatch" + (current === w ? " is-active" : "")} aria-label={tool === "text" ? `Text size ${w}` : `Width ${w}`} onClick={() => tools.restyle(o, { width: w })}>
							{tool === "text" ? <span class="pdf-ink-size">{w}</span> : <span class="pdf-ink-bar" style={{ height: dotSize(w), background: color }} />}
						</button>
					))}
					<span class="pdf-ink-opacity">
						<Icon name="blend|droplet" />
						<OpacitySlider value={o.opacity ?? 1} onCommit={(v) => tools.restyle(o, { opacity: v })} />
					</span>
				</div>
			)}
		</>
	);
}

/**
 * An opacity slider that changes the annotation once, when it is let go (one
 * undo step), not on every tick. A native change listener: EmbedPDF loads
 * preact/compat, which turns onChange into onInput.
 */
function OpacitySlider({ value, onCommit }: { value: number; onCommit(v: number): void }) {
	const ref = useRef<HTMLInputElement>(null);
	const commit = useRef(onCommit);
	commit.current = onCommit;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const changed = () => commit.current(Number(el.value) / 100);
		el.addEventListener("change", changed);
		return () => el.removeEventListener("change", changed);
	}, []);
	return <input ref={ref} type="range" min={5} max={100} step={5} defaultValue={String(Math.round(value * 100))} aria-label="Opacity" />;
}
