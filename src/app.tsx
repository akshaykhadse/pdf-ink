/**
 * The viewer UI: EmbedPDF's headless plugins (PDFium engine, virtual scroller,
 * tiled rendering, annotation tools) under the plugin's own toolbar, rendered
 * with Preact into the view's content element.
 */
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PdfEngine } from "@embedpdf/models";
import { createPluginRegistration, type PluginRegistry } from "@embedpdf/core";
import { EmbedPDF, useRegistry } from "@embedpdf/core/preact";
import { DocumentContent, DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/preact";
import { Viewport, ViewportPluginPackage } from "@embedpdf/plugin-viewport/preact";
import { Scroller, ScrollPluginPackage } from "@embedpdf/plugin-scroll/preact";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/preact";
import { TilingLayer, TilingPluginPackage } from "@embedpdf/plugin-tiling/preact";
import { ZoomGestureWrapper, ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/preact";
import { InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/preact";
import { SelectionLayer, SelectionPluginPackage } from "@embedpdf/plugin-selection/preact";
import { HistoryPluginPackage } from "@embedpdf/plugin-history/preact";
import { AnnotationLayer, AnnotationPluginPackage } from "@embedpdf/plugin-annotation/preact";
import { ExportPluginPackage } from "@embedpdf/plugin-export/preact";
import { Toolbar } from "./toolbar";
import { PointerGuard } from "./guard";
import type { Settings } from "./settings";
import { installAnnotationFixes } from "./ink";

/** What the Obsidian view gets once a document is open. */
export interface ViewerHandle {
	registry: PluginRegistry;
	documentId: string;
	/** The PDF with every annotation written into it. */
	save(): Promise<ArrayBuffer>;
	/** Pushes the current pen settings into the tools (after a settings change). */
	applySettings(): void;
}

export interface ViewerProps {
	engine: PdfEngine;
	bytes: ArrayBuffer;
	name: string;
	settings: Settings;
	onReady(handle: ViewerHandle): void;
	/** An annotation was added, changed or removed. */
	onChange(): void;
	onError(error: Error): void;
	/** The user picked a pen colour or width on the toolbar. */
	onSettingsChange(): void;
}

/** Resolves an EmbedPDF Task. */
export function settle<T>(task: { toPromise?: () => Promise<T>; wait: (ok: (v: T) => void, no: (e: unknown) => void) => void }): Promise<T> {
	if (typeof task.toPromise === "function") return task.toPromise();
	return new Promise<T>((ok, no) => task.wait(ok, no));
}

/** Renders the viewer into `el`. `refresh` re-renders after a settings change. */
export function mountViewer(el: HTMLElement, props: ViewerProps): { unmount: () => void; refresh: () => void } {
	let version = 0;
	render(<App {...props} version={version} />, el);
	return {
		unmount: () => render(null, el),
		refresh: () => render(<App {...props} version={++version} />, el),
	};
}

function App(props: ViewerProps & { version: number }) {
	const { engine, settings } = props;
	const plugins = useMemo(
		() => [
			createPluginRegistration(DocumentManagerPluginPackage),
			createPluginRegistration(ViewportPluginPackage, { viewportGap: 12 }),
			createPluginRegistration(ScrollPluginPackage, { defaultPageGap: 12, defaultBufferSize: 2 }),
			createPluginRegistration(RenderPluginPackage),
			createPluginRegistration(TilingPluginPackage, { tileSize: 768, overlapPx: 3, extraRings: 0 }),
			createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth, minZoom: 0.25, maxZoom: 8 }),
			createPluginRegistration(InteractionManagerPluginPackage),
			createPluginRegistration(SelectionPluginPackage),
			createPluginRegistration(HistoryPluginPackage),
			createPluginRegistration(AnnotationPluginPackage, {
				autoCommit: true,
				annotationAuthor: "",
				selectAfterCreate: false,
				tools: toolDefaults(settings),
			}),
			createPluginRegistration(ExportPluginPackage),
		],
		[]
	);

	const onInitialized = async (registry: PluginRegistry) => {
		try {
			const documents: any = (registry.getPlugin("document-manager") as any)?.provides();
			const opened: { documentId: string; task: any } = await settle(documents.openDocumentBuffer({ buffer: props.bytes, name: props.name }));
			await settle(opened.task);
			const documentId = opened.documentId;
			installAnnotationFixes(registry.getPlugin("annotation"), registry.getPlugin("selection"), () => props.settings.smoothStrokes);
			const annotations: any = (registry.getPlugin("annotation") as any)?.provides();
			const scoped = annotations?.forDocument(documentId);
			scoped?.onAnnotationEvent?.((event: { type: string }) => {
				if (event.type !== "loaded") props.onChange();
			});
			const applySettings = () => {
				const s = props.settings;
				annotations?.setToolDefaults("ink", { strokeColor: s.penColor, color: s.penColor, strokeWidth: s.penWidth, opacity: 1 });
				annotations?.setToolDefaults("inkHighlighter", { strokeColor: s.highlightColor, color: s.highlightColor, strokeWidth: s.highlightWidth });
			};
			props.onReady({
				registry,
				documentId,
				applySettings,
				save: async () => {
					// commit() returns at once while another commit runs: wait until nothing is pending.
					for (let i = 0; i < 50 && scoped?.commit; i++) {
						await settle(scoped.commit()).catch(() => {});
						if (!scoped.getState?.()?.hasPendingChanges) break;
						await new Promise((r) => setTimeout(r, 20));
					}
					const exporter: any = (registry.getPlugin("export") as any)?.provides()?.forDocument(documentId);
					return settle<ArrayBuffer>(exporter.saveAsCopy());
				},
			});
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

function toolDefaults(s: Settings) {
	return [
		// commitDelay 0: a stroke is an annotation as soon as the pen lifts, so a
		// save or close right after it never loses the stroke.
		{ id: "ink", defaults: { strokeColor: s.penColor, color: s.penColor, strokeWidth: s.penWidth, opacity: 1 }, behavior: { commitDelay: 0 } },
		{ id: "inkHighlighter", defaults: { strokeColor: s.highlightColor, color: s.highlightColor, strokeWidth: s.highlightWidth }, behavior: { commitDelay: 0 } },
		// EmbedPDF's text-markup highlight: select text with the pen and it is highlighted.
		{ id: "highlight", defaults: { strokeColor: s.highlightColor, color: s.highlightColor } },
	] as any;
}

function Viewer({ documentId, settings, onChange, onSettingsChange, version }: ViewerProps & { documentId: string; version: number }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const guardRef = useRef<PointerGuard | null>(null);
	const [eraser, setEraserState] = useState(false);
	const { registry } = useRegistry();

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const guard = new PointerGuard(root, {
			documentId,
			settings: () => settings,
			onErased: onChange,
			onEraserChange: setEraserState,
		});
		guard.registry = registry;
		guardRef.current = guard;
		guard.sync();
		return () => {
			guard.destroy();
			guardRef.current = null;
		};
	}, [documentId]);

	// Settings (palm rejection, colours) may have changed: re-check what to block.
	useEffect(() => guardRef.current?.sync(), [version]);

	return (
		<div class="pdf-ink" ref={rootRef}>
			<Toolbar
				documentId={documentId}
				settings={settings}
				eraser={eraser}
				setEraser={(on) => guardRef.current?.setEraser(on)}
				onSettingsChange={onSettingsChange}
				onToolChange={() => guardRef.current?.sync()}
			/>
			<Viewport documentId={documentId} class="pdf-ink-viewport">
				<ZoomGestureWrapper documentId={documentId} class="pdf-ink-zoom">
					<Scroller
						documentId={documentId}
						renderPage={({ pageIndex, width, height }) => (
							<div class="pdf-ink-page" data-page-index={pageIndex} style={{ width, height }}>
								<PagePointerProvider documentId={documentId} pageIndex={pageIndex} class="pdf-ink-page-layers">
									<RenderLayer documentId={documentId} pageIndex={pageIndex} scale={1} class="pdf-ink-base" />
									<TilingLayer documentId={documentId} pageIndex={pageIndex} class="pdf-ink-tiles" />
									<SelectionLayer documentId={documentId} pageIndex={pageIndex} />
									<AnnotationLayer documentId={documentId} pageIndex={pageIndex} />
								</PagePointerProvider>
							</div>
						)}
					/>
				</ZoomGestureWrapper>
			</Viewport>
		</div>
	);
}
