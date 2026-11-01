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
import type { Settings } from "./settings";
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
	{ id: "eraser", icon: "eraser", label: "Eraser" },
	{ id: "areaLink", icon: "scan", label: "Area link" },
	{ id: "image", icon: "image", label: "Image: tap the page to insert a picture" },
];

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
	const activeDraw = DRAW_TOOLS.find((t) => t.id === state.tool) ?? DRAW_TOOLS[0];
	const styled = STYLED_TOOLS.has(state.tool);

	const toolButton = (t: ToolDef) => (
		<button key={t.id} class={"pdf-ink-btn pdf-ink-tool" + (state.tool === t.id ? " is-active" : "")} aria-label={t.label} data-tool={t.id} onClick={() => pick(t.id)}>
			<Icon name={t.icon} />
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
				<div class="pdf-ink-group">
					{level < 4 ? (
						DRAW_TOOLS.map(toolButton)
					) : (
						<>
							{toolButton(activeDraw)}
							<button class="pdf-ink-btn pdf-ink-chevron" aria-label="Drawing tools" onClick={() => setPopover(popover === "tools" ? null : "tools")}>
								<Icon name="chevron-down" />
							</button>
						</>
					)}
				</div>
				{styled && (
					<div class="pdf-ink-group">
						<button class={"pdf-ink-btn pdf-ink-style" + (popover === "options" ? " is-open" : "")} aria-label="Tool options" onClick={() => setPopover(popover === "options" ? null : "options")}>
							<span class="pdf-ink-bar" style={{ background: tools.style()?.color, height: dotSize(tools.style()?.width || 3), opacity: tools.style()?.opacity }} />
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
					<div class="pdf-ink-group">{DRAW_TOOLS.map(toolButton)}</div>
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
	const colors = tool === "pen" ? settings.penColors : settings.highlightColors;
	const widths = tool === "pen" ? settings.penWidths : tool === "marker" ? settings.markerWidths : [];
	return (
		<div class="pdf-ink-tool-options">
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
			<div class="pdf-ink-group pdf-ink-opacity">
				<Icon name="blend|droplet" />
				<input type="range" min={5} max={100} step={5} value={Math.round(style.opacity * 100)} aria-label="Opacity" onInput={(e) => tools.setStyle(tool, { opacity: Number((e.target as HTMLInputElement).value) / 100 })} />
			</div>
		</div>
	);
}
