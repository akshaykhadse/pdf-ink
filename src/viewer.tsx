/**
 * The viewer: EmbedPDF's headless plugins (PDFium engine, virtual scroller,
 * tiled rendering, pan, selection, annotation, capture) under the plugin's own
 * toolbar, rendered with Preact into the Obsidian view.
 */
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PdfEngine } from "@embedpdf/models";
import { uuidV4 } from "@embedpdf/models";
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
import { AnnotationLayer, AnnotationPluginPackage } from "@embedpdf/plugin-annotation/preact";
import { CapturePluginPackage, MarqueeCapture } from "@embedpdf/plugin-capture/preact";
import { ExportPluginPackage } from "@embedpdf/plugin-export/preact";
import { Toolbar } from "./toolbar";
import { PointerGuard } from "./guard";
import type { Settings } from "./settings";
import { installInkSmoothing } from "./ink";
import { ToolController } from "./tools";
import { Backlink, LinkVars, PageRect, fillTemplate, linkText, parseSubpath, rectFromParam, rectParam, union } from "./links";
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
		const guard = new PointerGuard(root, tools, host.settings, host.onChange);
		const annotations: any = (registry.getPlugin("annotation") as any)?.provides();
		const scoped = annotations?.forDocument(documentId);
		const offAnn = scoped?.onAnnotationEvent?.((event: { type: string; committed?: boolean }) => {
			// Commits re-emit every event with committed: true; only new edits mark the file dirty.
			if (event.type !== "loaded" && !event.committed) host.onChange();
		});
		const capture: any = (registry.getPlugin("capture") as any)?.provides()?.forDocument(documentId);
		const offCapture = capture?.onCaptureArea?.((e: any) => setArea({ pageIndex: e.pageIndex, rect: toRect(e.rect) }));
		const offTools = tools.subscribe(() => bump((n) => n + 1));
		const scroll: any = (registry.getPlugin("scroll") as any)?.provides()?.forDocument(documentId);
		onReady({
			registry,
			documentId,
			tools,
			applySettings: () => {
				tools.pushAllStyles();
				tools.notify();
			},
			refreshBacklinks: () => setBacklinks(host.backlinks()),
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
			offAnn?.();
			offCapture?.();
			offTools();
			guard.destroy();
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
					type: 9,
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

	const annotationMenu = ({ menuWrapperProps, context, selected, placement }: any) => {
		if (!selected) return null;
		const a = context.annotation?.object;
		const pageIndex: number = context.pageIndex;
		const ann = tools.annotations();
		const isInk = a?.type === 15, isHighlight = a?.type === 9;
		const colors = isInk && a.intent !== "InkHighlight" ? settings.penColors : settings.highlightColors;
		const recolor = (color: string) => ann?.updateAnnotation(pageIndex, a.id, { strokeColor: color, color });
		return (
			<Menu wrapperProps={menuWrapperProps} placement={placement}>
					{(isInk || isHighlight) &&
						colors.map((c) => (
							<button key={c} class={"pdf-ink-swatch" + (a.strokeColor?.toLowerCase() === c ? " is-active" : "")} aria-label={c} onClick={() => recolor(c)}>
								<span class="pdf-ink-dot" style={{ background: c }} />
							</button>
						))}
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
					<button class="pdf-ink-menu-item" aria-label="Delete selected" onClick={() => tools.deleteMany(items.map((t) => ({ pageIndex: t.object.pageIndex, id: t.object.id })))}>
						<Icon name="trash-2" /> Delete {items.length}
					</button>
			</Menu>
		);
	};

	return (
		<div class="pdf-ink" ref={rootRef}>
			<Toolbar tools={tools} settings={settings} onOpenSidecar={host.openSidecar} />
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
											<div class={"pdf-ink-backlinks" + (tools.tool === "pointer" ? " is-clickable" : "")}>
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
										<SelectionLayer documentId={documentId} pageIndex={pageIndex} selectionMenu={selectionMenu} />
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
	);
}
