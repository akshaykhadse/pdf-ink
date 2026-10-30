import { useEffect, useRef } from "preact/hooks";
import { setIcon, setTooltip } from "obsidian";
import { useAnnotation, useAnnotationCapability } from "@embedpdf/plugin-annotation/preact";
import { ZoomMode, useZoom } from "@embedpdf/plugin-zoom/preact";
import { useHistoryCapability } from "@embedpdf/plugin-history/preact";
import { useScroll } from "@embedpdf/plugin-scroll/preact";
import { PEN_WIDTHS, type Settings } from "./settings";

interface ToolbarProps {
	documentId: string;
	settings: Settings;
	eraser: boolean;
	setEraser(on: boolean): void;
	onSettingsChange(): void;
	/** The active EmbedPDF tool changed (the pointer guard re-checks what to block). */
	onToolChange(): void;
}

/** An Obsidian (Lucide) icon. */
function Icon({ name }: { name: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, name);
	}, [name]);
	return <span class="pdf-ink-icon" ref={ref} />;
}

function Button({ tip, active, onClick, children, cls }: { tip: string; active?: boolean; onClick(): void; children: any; cls?: string }) {
	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (ref.current) setTooltip(ref.current, tip);
	}, [tip]);
	return (
		<button
			ref={ref}
			type="button"
			class={`pdf-ink-btn ${cls ?? ""} ${active ? "is-active" : ""}`}
			aria-label={tip}
			aria-pressed={active ? "true" : undefined}
			onPointerDown={(e) => e.preventDefault()}
			onClick={(e) => {
				e.preventDefault();
				onClick();
			}}
		>
			{children}
		</button>
	);
}

export function Toolbar({ documentId, settings, eraser, setEraser, onSettingsChange, onToolChange }: ToolbarProps) {
	const { provides: annotations, state } = useAnnotation(documentId);
	const { provides: annotationTools } = useAnnotationCapability();
	const { provides: zoom, state: zoomState } = useZoom(documentId);
	const { provides: history } = useHistoryCapability();
	const { state: pages, provides: scroll } = useScroll(documentId);
	const tool = eraser ? "eraser" : (state?.activeToolId ?? null);

	useEffect(() => onToolChange(), [state?.activeToolId]);

	const apply = () => {
		annotationTools?.setToolDefaults("ink", { strokeColor: settings.penColor, color: settings.penColor, strokeWidth: settings.penWidth, opacity: 1 } as any);
		annotationTools?.setToolDefaults("inkHighlighter", { strokeColor: settings.highlightColor, color: settings.highlightColor, strokeWidth: settings.highlightWidth } as any);
	};
	const pick = (toolId: string | null) => {
		setEraser(false);
		apply();
		annotations?.setActiveTool(toolId);
	};
	const pen = (color: string) => {
		settings.penColor = color;
		onSettingsChange();
		pick("ink");
	};
	const width = (w: number) => {
		settings.penWidth = w;
		onSettingsChange();
		pick("ink");
	};
	const highlighter = (color: string) => {
		settings.highlightColor = color;
		onSettingsChange();
		pick("inkHighlighter");
	};
	const docHistory = history?.forDocument(documentId);
	const percent = Math.round((zoomState?.currentZoomLevel ?? 1) * 100);

	return (
		<div class="pdf-ink-toolbar" role="toolbar">
			<Button tip="Select and scroll" active={tool === null} onClick={() => pick(null)}>
				<Icon name="mouse-pointer-2" />
			</Button>
			<span class="pdf-ink-sep" />
			{settings.penColors.map((color) => (
				<Button key={color} tip={`Pen ${color}`} cls="pdf-ink-swatch" active={tool === "ink" && settings.penColor === color} onClick={() => pen(color)}>
					<span class="pdf-ink-dot" style={{ background: color }} />
				</Button>
			))}
			<span class="pdf-ink-sep" />
			{PEN_WIDTHS.map((w) => (
				<Button key={w.width} tip={`${w.name} pen`} cls="pdf-ink-width" active={tool === "ink" && settings.penWidth === w.width} onClick={() => width(w.width)}>
					<span class="pdf-ink-dot" style={{ width: 6 + w.width * 3, height: 6 + w.width * 3 }} />
				</Button>
			))}
			<span class="pdf-ink-sep" />
			{settings.highlightColors.map((color) => (
				<Button key={color} tip={`Highlighter ${color}`} cls="pdf-ink-swatch pdf-ink-highlighter" active={tool === "inkHighlighter" && settings.highlightColor === color} onClick={() => highlighter(color)}>
					<span class="pdf-ink-dot" style={{ background: color }} />
				</Button>
			))}
			<span class="pdf-ink-sep" />
			<Button tip="Eraser (or press the pen's side button)" active={eraser} onClick={() => setEraser(!eraser)}>
				<Icon name="eraser" />
			</Button>
			<span class="pdf-ink-sep" />
			<Button tip="Undo" onClick={() => docHistory?.undo()}>
				<Icon name="undo-2" />
			</Button>
			<Button tip="Redo" onClick={() => docHistory?.redo()}>
				<Icon name="redo-2" />
			</Button>
			<span class="pdf-ink-grow" />
			<span class="pdf-ink-pages">
				{pages.currentPage} / {pages.totalPages}
			</span>
			<Button tip="Previous page" onClick={() => scroll?.scrollToPreviousPage()}>
				<Icon name="chevron-up" />
			</Button>
			<Button tip="Next page" onClick={() => scroll?.scrollToNextPage()}>
				<Icon name="chevron-down" />
			</Button>
			<span class="pdf-ink-sep" />
			<Button tip="Zoom out" onClick={() => zoom?.zoomOut()}>
				<Icon name="zoom-out" />
			</Button>
			<Button tip="Fit width" onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}>
				<span class="pdf-ink-zoom-level">{percent}%</span>
			</Button>
			<Button tip="Zoom in" onClick={() => zoom?.zoomIn()}>
				<Icon name="zoom-in" />
			</Button>
		</div>
	);
}
