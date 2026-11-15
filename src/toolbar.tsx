/**
 * The toolbar: one row of icon buttons. The active tool's colour, width and
 * opacity live behind a single style button. The bar measures itself and
 * folds as the pane gets narrower: zoom and page controls into the overflow
 * menu, then undo/redo, sidecar and full screen, and finally the drawing
 * tools into one picker.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Icon } from "./icon";
import { LINE_ENDS, LINE_STYLES, SHAPE_KINDS, TEXT_ALIGNS, TEXT_FONTS, type LineEnd, type LineStyle, type Settings, type ShapeKind, type TextFont } from "./settings";
import { STYLED_TOOLS, ToolController, ToolId } from "./tools";

const MAX_LEVEL = 4;

interface ToolDef {
	id: ToolId;
	icon: string;
	label: string;
}

const NAV_TOOLS: ToolDef[] = [
	{ id: "hand", icon: "hand", label: "Hand: pan and scroll" },
	{ id: "pointer", icon: "mouse-pointer-2|mouse-pointer", label: "Pointer: select" },
];
const DRAW_TOOLS: ToolDef[] = [
	{ id: "pen", icon: "pen-line|pencil", label: "Pen" },
	{ id: "marker", icon: "highlighter", label: "Highlighter" },
	{ id: "textHighlight", icon: "text-select|text-cursor-input|type", label: "Text highlighter" },
	{ id: "text", icon: "type|text", label: "Text: tap the page to type, or drag a box" },
	{ id: "shape", icon: "", label: "Shapes: drag to draw an arrow, line, rectangle or ellipse" },
	{ id: "eraser", icon: "eraser", label: "Eraser" },
	{ id: "areaLink", icon: "scan", label: "Area link" },
	{ id: "image", icon: "image", label: "Image: tap the page to insert a picture" },
];

export const SHAPE_ICON: Record<ShapeKind, string> = { arrow: "move-up-right|arrow-up-right", line: "minus|slash", rectangle: "square", ellipse: "circle" };
const SHAPE_LABEL: Record<ShapeKind, string> = { arrow: "Arrow", line: "Line", rectangle: "Rectangle", ellipse: "Ellipse" };

/** Thickness of the colour bar that stands for a stroke width in PDF points. */
export function dotSize(width: number): number {
	return Math.round(Math.min(10, Math.max(2, 1 + 2 * Math.sqrt(width))));
}

interface Props {
	tools: ToolController;
	settings: Settings;
	onOpenSidecar(): void;
}

type Popover = "options" | "tools" | "more" | null;

export function Toolbar({ tools, settings, onOpenSidecar }: Props) {
	const [, bump] = useState(0);
	useEffect(() => tools.subscribe(() => bump((n) => n + 1)), [tools]);
	const state = tools.state();
	const hostRef = useRef<HTMLDivElement>(null);
	const pillRef = useRef<HTMLDivElement>(null);
	const [level, setLevel] = useState(0);
	const need = useRef<number[]>([]);
	const [popover, setPopover] = useState<Popover>(null);

	// Fold or unfold until the pill fits the pane.
	useLayoutEffect(() => {
		const host = hostRef.current, pill = pillRef.current;
		if (!host || !pill) return;
		const measure = () => {
			const avail = host.clientWidth - 16;
			const width = pill.scrollWidth;
			need.current[level] = width;
			if (width > avail && level < MAX_LEVEL) setLevel(level + 1);
			// Unfold when the wider layout is known to fit, or try it when unknown (it folds back if not).
			else if (level > 0 && (need.current[level - 1] === undefined || need.current[level - 1] <= avail)) setLevel(level - 1);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(host);
		ro.observe(pill);
		return () => ro.disconnect();
	}, [level, state.tool, state.pages, state.zoom]);
	// A different tool needs a different width at each level: measure afresh.
	useEffect(() => {
		need.current = [];
	}, [state.tool]);

	// Any tap outside closes a popover.
	useEffect(() => {
		if (!popover) return;
		const doc = hostRef.current?.ownerDocument ?? document;
		const close = (e: Event) => {
			if (!hostRef.current?.contains(e.target as Node)) setPopover(null);
		};
		const key = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
		doc.addEventListener("pointerdown", close, true);
		doc.addEventListener("keydown", key);
		return () => {
			doc.removeEventListener("pointerdown", close, true);
			doc.removeEventListener("keydown", key);
		};
	}, [popover]);

	const pick = (id: ToolId) => {
		if (id === state.tool && STYLED_TOOLS.has(id)) setPopover(popover === "options" ? null : "options");
		else {
			tools.setTool(id);
			setPopover(null);
		}
	};
	// Tools hidden in the settings stay off the bar (the active one still shows).
	const drawTools = DRAW_TOOLS.filter((t) => t.id === state.tool || !settings.hiddenTools.includes(t.id));
	const activeDraw = drawTools.find((t) => t.id === state.tool) ?? drawTools[0];
	const styled = STYLED_TOOLS.has(state.tool);

	const toolButton = (t: ToolDef) => (
		<button key={t.id} class={"pdf-ink-btn pdf-ink-tool" + (state.tool === t.id ? " is-active" : "")} aria-label={t.label} data-tool={t.id} onClick={() => pick(t.id)}>
			<Icon name={t.id === "shape" ? SHAPE_ICON[settings.shapeKind] : t.icon} />
		</button>
	);

	const zoomControls = (
		<>
			<button class="pdf-ink-btn" aria-label="Zoom out" onClick={() => tools.zoomOut()}>
				<Icon name="zoom-out" />
			</button>
			<button class="pdf-ink-btn pdf-ink-zoom-level" aria-label="Fit width" onClick={() => tools.fitWidth()}>
				{Math.round(state.zoom * 100)}%
			</button>
			<button class="pdf-ink-btn" aria-label="Zoom in" onClick={() => tools.zoomIn()}>
				<Icon name="zoom-in" />
			</button>
		</>
	);
	const pageControl = (
		<span class="pdf-ink-pages">
			<input
				class="pdf-ink-page-input"
				type="text"
				inputMode="numeric"
				pattern="[0-9]*"
				value={state.page}
				aria-label="Page"
				onChange={(e) => tools.goToPage(Number((e.target as HTMLInputElement).value))}
				onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
			/>
			<span class="pdf-ink-page-total">/ {state.pages}</span>
		</span>
	);
	const historyControls = (
		<>
			<button class="pdf-ink-btn" aria-label="Undo" disabled={!state.canUndo} onClick={() => tools.undo()}>
				<Icon name="undo-2" />
			</button>
			<button class="pdf-ink-btn" aria-label="Redo" disabled={!state.canRedo} onClick={() => tools.redo()}>
				<Icon name="redo-2" />
			</button>
		</>
	);
	const viewControls = (
		<>
			<button class="pdf-ink-btn" aria-label="Open sidecar note" onClick={onOpenSidecar}>
				<Icon name="notebook-pen|notebook|file-text" />
			</button>
			<button class={"pdf-ink-btn" + (state.fullscreen ? " is-active" : "")} aria-label={state.fullscreen ? "Exit full screen" : "Full screen"} onClick={() => tools.toggleFullscreen()}>
				<Icon name={state.fullscreen ? "minimize-2" : "maximize-2"} />
			</button>
		</>
	);

	const menuItem = (icon: string, label: string, onClick: () => void, disabled = false) => (
		<button class="pdf-ink-menu-item" disabled={disabled} onClick={() => (onClick(), setPopover(null))}>
			<Icon name={icon} /> {label}
		</button>
	);

	return (
		<div class="pdf-ink-toolbar-host" ref={hostRef} data-level={level}>
			<div class="pdf-ink-toolbar" ref={pillRef} role="toolbar" aria-label="PDF Ink">
				<div class="pdf-ink-group">{NAV_TOOLS.map(toolButton)}</div>
				{drawTools.length > 0 && (<div class="pdf-ink-group">
					{level < 4 ? (
						drawTools.map(toolButton)
					) : (
						<>
							{toolButton(activeDraw)}
							<button class="pdf-ink-btn pdf-ink-chevron" aria-label="Drawing tools" onClick={() => setPopover(popover === "tools" ? null : "tools")}>
								<Icon name="chevron-down" />
							</button>
						</>
					)}
				</div>)}
				{styled && (
					<div class="pdf-ink-group">
						<button class={"pdf-ink-btn pdf-ink-style" + (popover === "options" ? " is-open" : "")} aria-label="Tool options" onClick={() => setPopover(popover === "options" ? null : "options")}>
							{state.tool === "text" ? (
								<span class="pdf-ink-letter" style={{ color: tools.style()?.color, opacity: tools.style()?.opacity }}>A</span>
							) : (
								<span class="pdf-ink-bar" style={{ background: tools.style()?.color, height: dotSize(tools.style()?.width || 3), opacity: tools.style()?.opacity }} />
							)}
						</button>
					</div>
				)}
				<div class="pdf-ink-group">
					<button class={"pdf-ink-btn pdf-ink-stylus" + (state.stylusMode ? " is-active" : "")} aria-label={state.stylusMode ? "Stylus mode on: fingers scroll, the pen draws" : "Stylus mode off: fingers draw too"} onClick={() => tools.setStylusMode(!state.stylusMode)}>
						<Icon name="pen-tool" />
					</button>
				</div>
				{level < 3 && <div class="pdf-ink-group">{historyControls}</div>}
				{level < 2 && <div class="pdf-ink-group">{pageControl}</div>}
				{level < 2 && <div class="pdf-ink-group">{zoomControls}</div>}
				{level < 3 && <div class="pdf-ink-group">{viewControls}</div>}
				{level >= 2 && (
					<div class="pdf-ink-group">
						<button class={"pdf-ink-btn pdf-ink-more" + (popover === "more" ? " is-active" : "")} aria-label="More" onClick={() => setPopover(popover === "more" ? null : "more")}>
							<Icon name="ellipsis|more-horizontal" />
						</button>
					</div>
				)}
			</div>
			{popover === "options" && styled && (
				<Pop>
					<ToolOptions tools={tools} settings={settings} />
				</Pop>
			)}
			{popover === "tools" && (
				<Pop>
					<div class="pdf-ink-group">{drawTools.map(toolButton)}</div>
				</Pop>
			)}
			{popover === "more" && (
				<Pop menu>
					{level >= 3 && menuItem("undo-2", "Undo", () => tools.undo(), !state.canUndo)}
					{level >= 3 && menuItem("redo-2", "Redo", () => tools.redo(), !state.canRedo)}
					<div class="pdf-ink-menu-row">
						{pageControl}
						{zoomControls}
					</div>
					{menuItem("move-horizontal|arrow-left-right", "Fit width", () => tools.fitWidth())}
					{menuItem("maximize", "Fit page", () => tools.fitPage())}
					{level >= 3 && menuItem("notebook-pen|notebook|file-text", "Open sidecar note", onOpenSidecar)}
					{level >= 3 && menuItem(state.fullscreen ? "minimize-2" : "maximize-2", state.fullscreen ? "Exit full screen" : "Full screen", () => tools.toggleFullscreen())}
				</Pop>
			)}
		</div>
	);
}

function Pop({ children, menu }: { children: ComponentChildren; menu?: boolean }) {
	return (
		<div class={"pdf-ink-popover" + (menu ? " pdf-ink-menu" : "")} onPointerDown={(e) => e.stopPropagation()}>
			{children}
		</div>
	);
}

/** Colour, width and opacity of the active styled tool. */
function ToolOptions({ tools, settings }: { tools: ToolController; settings: Settings }) {
	const tool = tools.tool;
	const style = tools.style(tool);
	if (!style) return null;
	const colors = tool === "pen" ? settings.penColors : tool === "text" ? settings.textColors : tool === "shape" ? settings.shapeColors : settings.highlightColors;
	const widths = tool === "pen" ? settings.penWidths : tool === "marker" ? settings.markerWidths : tool === "shape" ? settings.shapeWidths : [];
	return (
		<div class="pdf-ink-tool-options">
			{tool === "shape" && (
				<div class="pdf-ink-group pdf-ink-shapes">
					{SHAPE_KINDS.map((k) => (
						<button key={k} class={"pdf-ink-swatch pdf-ink-shape-kind" + (settings.shapeKind === k ? " is-active" : "")} aria-label={SHAPE_LABEL[k]} data-shape={k} onClick={() => tools.setShapeKind(k)}>
							<Icon name={SHAPE_ICON[k]} />
						</button>
					))}
				</div>
			)}
			<div class="pdf-ink-group pdf-ink-swatches">
				{colors.map((c) => (
					<button key={c} class={"pdf-ink-swatch" + (style.color === c ? " is-active" : "")} aria-label={`Colour ${c}`} onClick={() => tools.setStyle(tool, { color: c })}>
						<span class="pdf-ink-dot" style={{ background: c }} />
					</button>
				))}
			</div>
			{widths.length > 0 && (
				<div class="pdf-ink-group pdf-ink-widths">
					{widths.map((w) => (
						<button key={w} class={"pdf-ink-swatch" + (style.width === w ? " is-active" : "")} aria-label={`Width ${w}`} onClick={() => tools.setStyle(tool, { width: w })}>
							<span class="pdf-ink-bar" style={{ height: dotSize(w), background: style.color }} />
						</button>
					))}
				</div>
			)}
			{tool === "text" && (
				<div class="pdf-ink-group pdf-ink-sizes">
					{settings.textSizes.map((size) => (
						<button key={size} class={"pdf-ink-swatch pdf-ink-size" + (style.width === size ? " is-active" : "")} aria-label={`Text size ${size}`} onClick={() => tools.setStyle(tool, { width: size })}>
							{size}
						</button>
					))}
				</div>
			)}
			{tool === "text" && <TextFormatRow tools={tools} settings={settings} />}
			{tool === "shape" && (
				<div class="pdf-ink-group pdf-ink-line-styles">
					{LINE_STYLES.map((ls) => (
						<button key={ls} class={"pdf-ink-swatch pdf-ink-line-style" + (settings.shapeLine.style === ls ? " is-active" : "")} aria-label={LINE_STYLE_LABEL[ls]} data-line-style={ls} onClick={() => tools.setShapeLine({ style: ls })}>
							<LineStyleGlyph style={ls} />
						</button>
					))}
				</div>
			)}
			{tool === "shape" && settings.shapeKind === "arrow" && (["start", "end"] as const).map((side) => (
				<div key={side} class="pdf-ink-group pdf-ink-line-ends" data-side={side}>
					<span class="pdf-ink-row-label">{side === "start" ? "Start" : "End"}</span>
					{LINE_ENDS.map((le) => (
						<button key={le} class={"pdf-ink-swatch pdf-ink-line-end" + (settings.shapeLine[side] === le ? " is-active" : "")} aria-label={`${side === "start" ? "Start" : "End"}: ${LINE_END_LABEL[le]}`} data-end={le} onClick={() => tools.setShapeLine({ [side]: le })}>
							<LineEndGlyph end={le} />
						</button>
					))}
				</div>
			))}
			<div class="pdf-ink-group pdf-ink-opacity">
				<Icon name="blend|droplet" />
				<input type="range" min={5} max={100} step={5} value={Math.round(style.opacity * 100)} aria-label="Opacity" onInput={(e) => tools.setStyle(tool, { opacity: Number((e.target as HTMLInputElement).value) / 100 })} />
			</div>
		</div>
	);
}

const FONT_LABEL: Record<TextFont, string> = { sans: "Sans serif (Helvetica)", serif: "Serif (Times)", mono: "Monospace (Courier)" };
const FONT_CSS: Record<TextFont, string> = { sans: "Helvetica, Arial, sans-serif", serif: "Times, 'Times New Roman', serif", mono: "Courier, 'Courier New', monospace" };
const ALIGN_ICON = { left: "align-left", center: "align-center", right: "align-right" } as const;

/** Font family, bold, italic and alignment of the text tool. */
function TextFormatRow({ tools, settings }: { tools: ToolController; settings: Settings }) {
	const f = settings.textFormat;
	return (
		<>
			<div class="pdf-ink-group pdf-ink-text-format">
				{TEXT_FONTS.map((font) => (
					<button key={font} class={"pdf-ink-swatch pdf-ink-font" + (f.font === font ? " is-active" : "")} aria-label={FONT_LABEL[font]} data-font={font} onClick={() => tools.setTextFormat({ font })}>
						<span style={{ fontFamily: FONT_CSS[font] }}>Aa</span>
					</button>
				))}
				<span class="pdf-ink-sep" />
				<button class={"pdf-ink-swatch pdf-ink-font" + (f.bold ? " is-active" : "")} aria-label="Bold" aria-pressed={f.bold} onClick={() => tools.setTextFormat({ bold: !f.bold })}>
					<b>B</b>
				</button>
				<button class={"pdf-ink-swatch pdf-ink-font" + (f.italic ? " is-active" : "")} aria-label="Italic" aria-pressed={f.italic} onClick={() => tools.setTextFormat({ italic: !f.italic })}>
					<i style={{ fontFamily: "Times, serif" }}>I</i>
				</button>
			</div>
			<div class="pdf-ink-group pdf-ink-text-align">
				{TEXT_ALIGNS.map((align) => (
					<button key={align} class={"pdf-ink-swatch" + (f.align === align ? " is-active" : "")} aria-label={`Align ${align}`} onClick={() => tools.setTextFormat({ align })}>
						<Icon name={ALIGN_ICON[align]} />
					</button>
				))}
			</div>
		</>
	);
}

const LINE_STYLE_LABEL: Record<LineStyle, string> = { solid: "Solid line", dashed: "Dashed line", dotted: "Dotted line" };
const LINE_END_LABEL: Record<LineEnd, string> = { none: "none", openArrow: "open arrow", closedArrow: "closed arrow", circle: "circle", square: "square", diamond: "diamond", bar: "bar" };

export function LineStyleGlyph({ style }: { style: LineStyle }) {
	const dash = style === "dashed" ? "5 3" : style === "dotted" ? "2 3" : undefined;
	return (
		<svg class="pdf-ink-glyph" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="2" stroke-dasharray={dash} />
		</svg>
	);
}

/** A short line ending at the right in the given line end. */
function LineEndGlyph({ end }: { end: LineEnd }) {
	const head = (() => {
		switch (end) {
			case "openArrow":
				return <polyline points="11,5 17,10 11,15" fill="none" stroke="currentColor" stroke-width="1.6" />;
			case "closedArrow":
				return <polygon points="11,5 17,10 11,15" fill="currentColor" stroke="currentColor" stroke-width="1" />;
			case "circle":
				return <circle cx="14" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6" />;
			case "square":
				return <rect x="11" y="7" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.6" />;
			case "diamond":
				return <polygon points="14,6 18,10 14,14 10,10" fill="none" stroke="currentColor" stroke-width="1.6" />;
			case "bar":
				return <line x1="17" y1="5" x2="17" y2="15" stroke="currentColor" stroke-width="1.6" />;
			default:
				return null;
		}
	})();
	return (
		<svg class="pdf-ink-glyph" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<line x1="2" y1="10" x2={end === "none" ? 18 : end === "circle" || end === "square" ? 11 : end === "diamond" ? 10 : 16} y2="10" stroke="currentColor" stroke-width="1.6" />
			{head}
		</svg>
	);
}
