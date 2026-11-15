// Plugin settings: tool styles, stylus behaviour, link templates and the sidecar.
import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type PdfInkPlugin from "./main";
import type { ToolId } from "./tools";

/** A drawing tool's current style. */
export interface ToolStyle {
	color: string;
	/** Stroke width in PDF points (unused by the text highlighter). */
	width: number;
	/** 0–1 */
	opacity: number;
}

/** What the shape tool draws. */
export type ShapeKind = "arrow" | "line" | "rectangle" | "ellipse";
export const SHAPE_KINDS: readonly ShapeKind[] = ["arrow", "line", "rectangle", "ellipse"];

/** The PDF standard font families a text box can use (PDF viewers all have them). */
export type TextFont = "sans" | "serif" | "mono";
export const TEXT_FONTS: readonly TextFont[] = ["sans", "serif", "mono"];
export type TextAlign = "left" | "center" | "right";
export const TEXT_ALIGNS: readonly TextAlign[] = ["left", "center", "right"];

/** How the text tool sets its text. */
export interface TextFormat {
	font: TextFont;
	bold: boolean;
	italic: boolean;
	align: TextAlign;
}

export type LineStyle = "solid" | "dashed" | "dotted";
export const LINE_STYLES: readonly LineStyle[] = ["solid", "dashed", "dotted"];
/** Line ends (PDF line ending styles). */
export type LineEnd = "none" | "openArrow" | "closedArrow" | "circle" | "square" | "diamond" | "bar";
export const LINE_ENDS: readonly LineEnd[] = ["none", "openArrow", "closedArrow", "circle", "square", "diamond", "bar"];

/** The stroke of arrows, lines and shapes, and the arrow's ends. */
export interface ShapeLine {
	style: LineStyle;
	/** Arrow tool only: the end where the drag started. */
	start: LineEnd;
	/** Arrow tool only: the end where the drag finished. */
	end: LineEnd;
}

/** A named link template; variables: {{file}} {{page}} {{rect}} {{text}} {{color}} {{path}}. */
export interface LinkFormat {
	name: string;
	template: string;
}

/** Drawing tools that can be hidden from the toolbar (hand and pointer always show). */
export const HIDEABLE_TOOLS: readonly ToolId[] = ["pen", "marker", "textHighlight", "text", "shape", "eraser", "areaLink", "image"];
export const START_TOOLS: readonly (ToolId | "last")[] = ["hand", "pointer", "pen", "marker", "textHighlight", "text", "shape", "eraser", "last"];
export type DarkPages = "off" | "theme" | "always";
export type PenButton = "eraser" | "off";

export interface Settings {
	/** Colours offered on the toolbar for the pen. */
	penColors: string[];
	/** Colours offered on the toolbar for both highlighters. */
	highlightColors: string[];
	/** Stroke widths offered on the toolbar for the pen. */
	penWidths: number[];
	/** Stroke widths offered on the toolbar for the freehand highlighter. */
	markerWidths: number[];
	/** Colours offered on the toolbar for the text tool. */
	textColors: string[];
	/** Font sizes in points offered on the toolbar for the text tool. */
	textSizes: number[];
	/** Colours offered on the toolbar for arrows, lines and shapes. */
	shapeColors: string[];
	/** Line widths in PDF points offered on the toolbar for arrows, lines and shapes. */
	shapeWidths: number[];
	pen: ToolStyle;
	marker: ToolStyle;
	textHighlight: ToolStyle;
	/** The text tool; `width` is the font size in points. */
	text: ToolStyle;
	/** Arrows, lines and shapes; `width` is the line width. */
	shape: ToolStyle;
	/** What the shape tool draws. */
	shapeKind: ShapeKind;
	textFormat: TextFormat;
	shapeLine: ShapeLine;
	/** Eraser diameter in CSS pixels. */
	eraserSize: number;
	/** Stylus mode: fingers pan and scroll, only the pen draws. Toggled from the toolbar too. */
	stylusMode: boolean;
	/** Resample strokes along a spline so quick strokes stop looking like polygons. */
	smoothStrokes: boolean;
	/** Feed the pen's coalesced samples to the stroke (browsers deliver one move per frame). */
	fullPenRate: boolean;
	/** Diagnostic: write per-stroke pen timings to pen-timing.log in the plugin folder. */
	penTimingLog: boolean;
	autosave: boolean;
	openByDefault: boolean;
	/** Where copied links go. */
	linkTarget: "clipboard" | "sidecar" | "both";
	textLinkFormats: LinkFormat[];
	areaLinkFormats: LinkFormat[];
	/** Show links from notes to this PDF as boxes on the pages. */
	showBacklinks: boolean;
	backlinkColor: string;
	/** Folder for sidecar notes; empty = next to the PDF. */
	sidecarFolder: string;
	/** Appended to the PDF's basename to name its sidecar note. */
	sidecarSuffix: string;
	/** Full-screen mode also hides Obsidian's status bar and mobile navigation. */
	fullscreenHidesChrome: boolean;
	/** Drawing tools left off the toolbar. */
	hiddenTools: ToolId[];
	/** The tool a PDF opens with; "last" = the tool used last. */
	startTool: ToolId | "last";
	/** The tool used last (for startTool "last"). */
	lastTool: ToolId;
	/** Show pages inverted (dark): never, when Obsidian's theme is dark, or always. Not native to EmbedPDF. */
	darkPages: DarkPages;
	/** What a press of the pen's side button does while hovering. */
	penButton: PenButton;
}

export const DEFAULT_SETTINGS: Settings = {
	penColors: ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5"],
	highlightColors: ["#ffe066", "#8ce99a", "#74c0fc", "#ffa8a8", "#e599f7", "#ffc078"],
	penWidths: [1, 2, 4],
	markerWidths: [8, 14, 24],
	textColors: ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5"],
	textSizes: [10, 14, 18, 24],
	shapeColors: ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5"],
	shapeWidths: [1, 2, 4],
	pen: { color: "#1e1e1e", width: 2, opacity: 1 },
	marker: { color: "#ffe066", width: 14, opacity: 0.5 },
	textHighlight: { color: "#ffe066", width: 0, opacity: 1 },
	text: { color: "#e03131", width: 14, opacity: 1 },
	shape: { color: "#e03131", width: 2, opacity: 1 },
	shapeKind: "arrow",
	textFormat: { font: "sans", bold: false, italic: false, align: "left" },
	shapeLine: { style: "solid", start: "none", end: "openArrow" },
	eraserSize: 20,
	stylusMode: false,
	smoothStrokes: true,
	fullPenRate: true,
	penTimingLog: false,
	autosave: true,
	openByDefault: false,
	linkTarget: "both",
	textLinkFormats: [
		{ name: "Link", template: "[[{{file}}#page={{page}}&rect={{rect}}|{{text}}]]" },
		{ name: "Quote", template: "> {{text}}\n> [[{{file}}#page={{page}}&rect={{rect}}|p.{{page}}]]" },
		{ name: "Callout", template: "> [!quote|{{color}}] [[{{file}}#page={{page}}&rect={{rect}}|p.{{page}}]]\n> {{text}}" },
	],
	areaLinkFormats: [
		{ name: "Link", template: "[[{{file}}#page={{page}}&rect={{rect}}|p.{{page}}]]" },
		{ name: "Embed", template: "![[{{file}}#page={{page}}&rect={{rect}}]]" },
	],
	showBacklinks: true,
	backlinkColor: "#1971c2",
	sidecarFolder: "",
	sidecarSuffix: "",
	fullscreenHidesChrome: true,
	hiddenTools: [],
	startTool: "hand",
	lastTool: "hand",
	darkPages: "off",
	penButton: "eraser",
};

/** A fresh copy of the defaults that shares no arrays or objects with DEFAULT_SETTINGS. */
export function defaultSettings(): Settings {
	return normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
}

const MIN_WIDTH = 0.25;
const MAX_WIDTH = 40;
const MIN_FONT = 4;
const MAX_FONT = 96;

export function parseNumbers(text: string, min: number, max: number): number[] {
	const out: number[] = [];
	for (const part of text.split(/[\s,]+/)) {
		const n = Number(part);
		if (part && Number.isFinite(n) && n >= min && n <= max && !out.includes(n)) out.push(n);
	}
	return out.sort((a, b) => a - b);
}

/** The parts of a list that `parse` would drop, for feedback in the settings tab. */
export function ignoredParts(text: string, keep: (part: string) => boolean): string[] {
	return text
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter((p) => p && !keep(p));
}

/** "Name: template" lines (\n in a template is a line break); lines without a colon are skipped. */
export function parseLinkFormats(text: string): LinkFormat[] {
	return text
		.split("\n")
		.map((line) => line.match(/^\s*([^:]+?)\s*:\s*(.+)$/))
		.filter((m): m is RegExpMatchArray => !!m)
		.map((m) => ({ name: m[1], template: m[2].replace(/\\n/g, "\n") }));
}

export function parseColors(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/[\s,]+/)) {
		const c = part.trim().toLowerCase();
		if (/^#[0-9a-f]{6}$/.test(c) && !out.includes(c)) out.push(c);
	}
	return out;
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

function style(s: Partial<ToolStyle> | undefined, d: ToolStyle, minWidth = MIN_WIDTH, maxWidth = MAX_WIDTH): ToolStyle {
	return {
		color: typeof s?.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : d.color,
		width: clamp(s?.width, minWidth, maxWidth, d.width),
		opacity: clamp(s?.opacity, 0.05, 1, d.opacity),
	};
}

function formats(list: unknown, d: LinkFormat[]): LinkFormat[] {
	if (!Array.isArray(list)) return d;
	const out = list.filter((f): f is LinkFormat => f && typeof f.name === "string" && typeof f.template === "string" && f.template.length > 0);
	return out.length ? out : d;
}

/** Fills in missing fields and drops invalid ones; safe on any stored shape. */
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
	const r: any = raw ?? {};
	const d = DEFAULT_SETTINGS;
	const list = (v: unknown, fallback: string[]) => {
		const parsed = Array.isArray(v) ? parseColors(v.join(",")) : [];
		return parsed.length ? parsed : fallback;
	};
	const nums = (v: unknown, fallback: number[], lo = MIN_WIDTH, hi = MAX_WIDTH) => {
		const parsed = Array.isArray(v) ? parseNumbers(v.join(","), lo, hi) : [];
		return parsed.length ? parsed : fallback;
	};
	const ALL_TOOLS: readonly string[] = ["hand", "pointer", ...HIDEABLE_TOOLS];
	return {
		penColors: list(r.penColors, d.penColors),
		highlightColors: list(r.highlightColors, d.highlightColors),
		penWidths: nums(r.penWidths, d.penWidths),
		markerWidths: nums(r.markerWidths, d.markerWidths),
		textColors: list(r.textColors, d.textColors),
		textSizes: nums(r.textSizes, d.textSizes, MIN_FONT, MAX_FONT),
		shapeColors: list(r.shapeColors, d.shapeColors),
		shapeWidths: nums(r.shapeWidths, d.shapeWidths),
		pen: style(r.pen, d.pen),
		marker: style(r.marker, d.marker),
		textHighlight: style(r.textHighlight, d.textHighlight, 0),
		text: style(r.text, d.text, MIN_FONT, MAX_FONT),
		shape: style(r.shape, d.shape),
		shapeKind: SHAPE_KINDS.includes(r.shapeKind) ? r.shapeKind : d.shapeKind,
		textFormat: {
			font: TEXT_FONTS.includes(r.textFormat?.font) ? r.textFormat.font : d.textFormat.font,
			bold: typeof r.textFormat?.bold === "boolean" ? r.textFormat.bold : d.textFormat.bold,
			italic: typeof r.textFormat?.italic === "boolean" ? r.textFormat.italic : d.textFormat.italic,
			align: TEXT_ALIGNS.includes(r.textFormat?.align) ? r.textFormat.align : d.textFormat.align,
		},
		shapeLine: {
			style: LINE_STYLES.includes(r.shapeLine?.style) ? r.shapeLine.style : d.shapeLine.style,
			start: LINE_ENDS.includes(r.shapeLine?.start) ? r.shapeLine.start : d.shapeLine.start,
			end: LINE_ENDS.includes(r.shapeLine?.end) ? r.shapeLine.end : d.shapeLine.end,
		},
		eraserSize: clamp(r.eraserSize, 6, 120, d.eraserSize),
		stylusMode: typeof r.stylusMode === "boolean" ? r.stylusMode : d.stylusMode,
		smoothStrokes: typeof r.smoothStrokes === "boolean" ? r.smoothStrokes : d.smoothStrokes,
		fullPenRate: typeof r.fullPenRate === "boolean" ? r.fullPenRate : d.fullPenRate,
		penTimingLog: typeof r.penTimingLog === "boolean" ? r.penTimingLog : d.penTimingLog,
		autosave: typeof r.autosave === "boolean" ? r.autosave : d.autosave,
		openByDefault: typeof r.openByDefault === "boolean" ? r.openByDefault : d.openByDefault,
		linkTarget: r.linkTarget === "clipboard" || r.linkTarget === "sidecar" || r.linkTarget === "both" ? r.linkTarget : d.linkTarget,
		textLinkFormats: formats(r.textLinkFormats, d.textLinkFormats),
		areaLinkFormats: formats(r.areaLinkFormats, d.areaLinkFormats),
		showBacklinks: typeof r.showBacklinks === "boolean" ? r.showBacklinks : d.showBacklinks,
		backlinkColor: typeof r.backlinkColor === "string" && /^#[0-9a-f]{6}$/i.test(r.backlinkColor) ? r.backlinkColor.toLowerCase() : d.backlinkColor,
		sidecarFolder: typeof r.sidecarFolder === "string" ? r.sidecarFolder.replace(/^\/+|\/+$/g, "") : d.sidecarFolder,
		sidecarSuffix: typeof r.sidecarSuffix === "string" ? r.sidecarSuffix : d.sidecarSuffix,
		fullscreenHidesChrome: typeof r.fullscreenHidesChrome === "boolean" ? r.fullscreenHidesChrome : d.fullscreenHidesChrome,
		hiddenTools: Array.isArray(r.hiddenTools) ? HIDEABLE_TOOLS.filter((t) => r.hiddenTools.includes(t)) : [...d.hiddenTools],
		startTool: START_TOOLS.includes(r.startTool) ? r.startTool : d.startTool,
		lastTool: ALL_TOOLS.includes(r.lastTool) ? r.lastTool : d.lastTool,
		darkPages: r.darkPages === "off" || r.darkPages === "theme" || r.darkPages === "always" ? r.darkPages : d.darkPages,
		penButton: r.penButton === "eraser" || r.penButton === "off" ? r.penButton : d.penButton,
	};
}

export class PdfInkSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PdfInkPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Open PDFs with PDF Ink").setDesc("Use PDF Ink instead of Obsidian's PDF viewer when a PDF is opened. Otherwise use the file menu or the command.").addToggle((t) =>
			t.setValue(s.openByDefault).onChange(async (v) => {
				s.openByDefault = v;
				await save();
				this.plugin.applyOpenByDefault();
			})
		);
		new Setting(containerEl).setName("Autosave").setDesc("Write annotations into the PDF a moment after each change. Off: save with Ctrl/Cmd+S or when the PDF is closed.").addToggle((t) => t.setValue(s.autosave).onChange(async (v) => ((s.autosave = v), save())));

		new Setting(containerEl).setName("Pages").setHeading();
		new Setting(containerEl)
			.setName("Dark pages")
			.setDesc("Show pages inverted, light on dark, with annotations inverted to match (not native to EmbedPDF; the PDF itself is not changed).")
			.addDropdown((d) => d.addOptions({ off: "Off", theme: "With a dark Obsidian theme", always: "Always" }).setValue(s.darkPages).onChange(async (v) => ((s.darkPages = v as DarkPages), save())));

		new Setting(containerEl).setName("Toolbar").setHeading();
		new Setting(containerEl)
			.setName("Tool when a PDF opens")
			.addDropdown((d) =>
				d
					.addOptions({ hand: "Hand", pointer: "Pointer", pen: "Pen", marker: "Highlighter", textHighlight: "Text highlighter", text: "Text", shape: "Shapes", eraser: "Eraser", last: "The tool used last" })
					.setValue(s.startTool)
					.onChange(async (v) => ((s.startTool = v as Settings["startTool"]), save()))
			);
		const TOOL_NAMES: Record<string, string> = { pen: "Pen", marker: "Highlighter", textHighlight: "Text highlighter", text: "Text", shape: "Shapes", eraser: "Eraser", areaLink: "Area link", image: "Image" };
		for (const tool of HIDEABLE_TOOLS) {
			new Setting(containerEl)
				.setName(`Show ${TOOL_NAMES[tool]}`)
				.setDesc(tool === "textHighlight" ? "Selecting text with the pointer also offers Highlight." : "")
				.addToggle((t) =>
					t.setValue(!s.hiddenTools.includes(tool)).onChange(async (v) => {
						s.hiddenTools = v ? s.hiddenTools.filter((x) => x !== tool) : [...s.hiddenTools, tool];
						await save();
					})
				);
		}

		new Setting(containerEl).setName("Stylus").setHeading();
		new Setting(containerEl).setName("Stylus mode").setDesc("On: fingers pan and scroll while only the pen draws. Off: fingers draw too. The toolbar's stylus button switches it, and the choice is kept.").addToggle((t) => t.setValue(s.stylusMode).onChange(async (v) => ((s.stylusMode = v), save())));
		new Setting(containerEl)
			.setName("Pen side button")
			.setDesc("What a press of the pen's button does while the pen hovers over the page.")
			.addDropdown((d) => d.addOptions({ eraser: "Switch to the eraser and back", off: "Nothing" }).setValue(s.penButton).onChange(async (v) => ((s.penButton = v as PenButton), save())));
		new Setting(containerEl).setName("Eraser size").setDesc("Diameter in pixels.").addSlider((sl) => sl.setLimits(6, 120, 2).setValue(s.eraserSize).setDynamicTooltip().onChange(async (v) => ((s.eraserSize = v), save())));

		new Setting(containerEl).setName("Tools").setHeading();
		/** A list typed as text: read when the field loses focus; ignored entries are reported. */
		const listField = <T,>(setting: Setting, multiline: boolean, get: () => T[], parse: (text: string) => T[], keep: (part: string) => boolean, set: (v: T[]) => void, what: string) => {
			const add = (c: { inputEl: HTMLInputElement | HTMLTextAreaElement; setValue(v: string): unknown }) => {
				c.setValue(get().join(", "));
				c.inputEl.addEventListener("blur", async () => {
					const text = c.inputEl.value;
					const parsed = parse(text);
					const ignored = ignoredParts(text, keep);
					if (ignored.length) new Notice(`PDF Ink ignored ${ignored.map((x) => `"${x}"`).join(", ")}: not ${what}.`, 6000);
					if (parsed.length) {
						set(parsed);
						await save();
					}
					c.setValue(get().join(", "));
				});
			};
			if (multiline) setting.addTextArea(add as any);
			else setting.addText(add as any);
		};
		const colors = (name: string, desc: string, get: () => string[], set: (v: string[]) => void) =>
			listField(new Setting(containerEl).setName(name).setDesc(desc), true, get, parseColors, (p) => parseColors(p).length > 0, set, "a #rrggbb colour");
		colors("Pen colours", "Hex colours offered for the pen, separated by commas.", () => s.penColors, (v) => (s.penColors = v));
		colors("Highlighter colours", "Hex colours offered for the freehand and text highlighters.", () => s.highlightColors, (v) => (s.highlightColors = v));
		colors("Text colours", "Hex colours offered for the text tool.", () => s.textColors, (v) => (s.textColors = v));
		colors("Shape colours", "Hex colours offered for arrows, lines, rectangles and ellipses.", () => s.shapeColors, (v) => (s.shapeColors = v));
		const widths = (name: string, desc: string, get: () => number[], set: (v: number[]) => void, lo = MIN_WIDTH, hi = MAX_WIDTH) =>
			listField(new Setting(containerEl).setName(name).setDesc(desc), false, get, (t) => parseNumbers(t, lo, hi), (p) => parseNumbers(p, lo, hi).length > 0, set, `a number from ${lo} to ${hi}`);
		widths("Pen widths", `Stroke widths in PDF points offered for the pen (${MIN_WIDTH}–${MAX_WIDTH}).`, () => s.penWidths, (v) => (s.penWidths = v));
		widths("Highlighter widths", "Stroke widths offered for the freehand highlighter.", () => s.markerWidths, (v) => (s.markerWidths = v));
		widths("Shape line widths", `Line widths in PDF points offered for arrows, lines and shapes (${MIN_WIDTH}–${MAX_WIDTH}).`, () => s.shapeWidths, (v) => (s.shapeWidths = v));
		widths("Text sizes", `Font sizes in points offered for the text tool (${MIN_FONT}–${MAX_FONT}).`, () => s.textSizes, (v) => (s.textSizes = v), MIN_FONT, MAX_FONT);

		new Setting(containerEl).setName("Links").setHeading();
		new Setting(containerEl).setName("Copied links go to").setDesc("The sidecar note is the note opened beside the PDF with 'Open sidecar note'.").addDropdown((d) =>
			d.addOptions({ clipboard: "Clipboard", sidecar: "Sidecar note", both: "Clipboard and sidecar note" }).setValue(s.linkTarget).onChange(async (v) => ((s.linkTarget = v as Settings["linkTarget"]), save()))
		);
		const formatsSetting = (name: string, desc: string, get: () => LinkFormat[], set: (v: LinkFormat[]) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).setClass("pdf-ink-setting-stacked").addTextArea((t) => {
				t.inputEl.rows = 4;
				const show = () => t.setValue(get().map((f) => `${f.name}: ${f.template.replace(/\n/g, "\\n")}`).join("\n"));
				show();
				t.inputEl.addEventListener("blur", async () => {
					const parsed = parseLinkFormats(t.inputEl.value);
					if (parsed.length) {
						set(parsed);
						await save();
					} else new Notice("PDF Ink kept the link formats: write each as 'Name: template'.", 6000);
					show();
				});
			});
		formatsSetting(
			"Text link formats",
			"One per line as 'Name: template'. Variables: {{file}} {{path}} {{page}} {{rect}} {{text}} {{color}}; \\n for a line break. Links use PDF++'s page and rect parameters, so they open in PDF++ and in Obsidian's viewer too.",
			() => s.textLinkFormats,
			(v) => (s.textLinkFormats = v)
		);
		formatsSetting("Area link formats", "Formats offered after selecting an area with the area link tool.", () => s.areaLinkFormats, (v) => (s.areaLinkFormats = v));
		new Setting(containerEl).setName("Show backlinks on pages").setDesc("Draw a box where a note links to a page area or text of this PDF; click it to open the note.").addToggle((t) => t.setValue(s.showBacklinks).onChange(async (v) => ((s.showBacklinks = v), save())));
		new Setting(containerEl)
			.setName("Backlink colour")
			.setDesc("Outline colour of the backlink boxes.")
			.addColorPicker((c) => c.setValue(s.backlinkColor).onChange(async (v) => ((s.backlinkColor = parseColors(v)[0] ?? s.backlinkColor), save())));
		new Setting(containerEl).setName("Sidecar note folder").setDesc("Folder for sidecar notes. Empty: next to the PDF.").addText((t) => t.setValue(s.sidecarFolder).onChange(async (v) => ((s.sidecarFolder = v.replace(/^\/+|\/+$/g, "")), save())));
		new Setting(containerEl).setName("Sidecar note suffix").setDesc("Added to the PDF's name, e.g. ' notes' makes 'paper notes.md' for 'paper.pdf'.").addText((t) => t.setValue(s.sidecarSuffix).onChange(async (v) => ((s.sidecarSuffix = v), save())));

		new Setting(containerEl).setName("Full screen").setHeading();
		new Setting(containerEl).setName("Hide Obsidian's bars in full screen").setDesc("Also hide the status bar, ribbon and mobile navigation while a PDF is full screen.").addToggle((t) => t.setValue(s.fullscreenHidesChrome).onChange(async (v) => ((s.fullscreenHidesChrome = v), save())));

		new Setting(containerEl).setName("Advanced").setHeading();
		new Setting(containerEl).setName("Smooth strokes").setDesc("Resample each stroke along a curve through the pen's samples (not native to EmbedPDF, which draws straight segments).").addToggle((t) => t.setValue(s.smoothStrokes).onChange(async (v) => ((s.smoothStrokes = v), save())));
		new Setting(containerEl).setName("Use the pen's full sample rate").setDesc("Feed the browser's coalesced pointer samples to the stroke (not native to EmbedPDF).").addToggle((t) => t.setValue(s.fullPenRate).onChange(async (v) => ((s.fullPenRate = v), save())));
		new Setting(containerEl).setName("Log pen timing").setDesc("Diagnostic: write the timings of each pen stroke to pen-timing.log in the plugin folder (up to 400 strokes per opened PDF).").addToggle((t) => t.setValue(s.penTimingLog).onChange(async (v) => ((s.penTimingLog = v), save())));

		new Setting(containerEl).setName("Reset").setHeading();
		new Setting(containerEl)
			.setName("Reset all settings to defaults")
			.setDesc("Restores every setting on this page. Annotations and reading positions are kept.")
			.addButton((b) =>
				b
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(() =>
						new ConfirmModal(this.app, "Reset all PDF Ink settings to their defaults?", "Reset", async () => {
							Object.assign(this.plugin.settings, defaultSettings());
							await save();
							this.display();
						}).open()
					)
			);
	}
}

/** A yes/no dialog; `onConfirm` runs only on the confirm button. */
class ConfirmModal extends Modal {
	constructor(app: App, private readonly message: string, private readonly confirmText: string, private readonly onConfirm: () => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Reset settings");
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						void this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
