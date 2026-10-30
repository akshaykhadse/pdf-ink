// Plugin settings: tool styles, stylus behaviour, link templates and the sidecar.
import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfInkPlugin from "./main";

/** A drawing tool's current style. */
export interface ToolStyle {
	color: string;
	/** Stroke width in PDF points (unused by the text highlighter). */
	width: number;
	/** 0–1 */
	opacity: number;
}

/** A named link template; variables: {{file}} {{page}} {{rect}} {{text}} {{color}} {{path}}. */
export interface LinkFormat {
	name: string;
	template: string;
}

export interface Settings {
	/** Colours offered on the toolbar for the pen. */
	penColors: string[];
	/** Colours offered on the toolbar for both highlighters. */
	highlightColors: string[];
	/** Stroke widths offered on the toolbar for the pen. */
	penWidths: number[];
	/** Stroke widths offered on the toolbar for the freehand highlighter. */
	markerWidths: number[];
	pen: ToolStyle;
	marker: ToolStyle;
	textHighlight: ToolStyle;
	/** Eraser diameter in CSS pixels. */
	eraserSize: number;
	/** Stylus mode: fingers pan and scroll, only the pen draws. Toggled from the toolbar too. */
	stylusMode: boolean;
	/** Resample strokes along a spline so quick strokes stop looking like polygons. */
	smoothStrokes: boolean;
	/** Feed the pen's coalesced samples to the stroke (browsers deliver one move per frame). */
	fullPenRate: boolean;
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
}

export const DEFAULT_SETTINGS: Settings = {
	penColors: ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5"],
	highlightColors: ["#ffe066", "#8ce99a", "#74c0fc", "#ffa8a8", "#e599f7", "#ffc078"],
	penWidths: [1, 2, 4],
	markerWidths: [8, 14, 24],
	pen: { color: "#1e1e1e", width: 2, opacity: 1 },
	marker: { color: "#ffe066", width: 14, opacity: 0.5 },
	textHighlight: { color: "#ffe066", width: 0, opacity: 1 },
	eraserSize: 20,
	stylusMode: true,
	smoothStrokes: true,
	fullPenRate: true,
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
};

const MIN_WIDTH = 0.25;
const MAX_WIDTH = 40;

export function parseNumbers(text: string, min: number, max: number): number[] {
	const out: number[] = [];
	for (const part of text.split(/[\s,]+/)) {
		const n = Number(part);
		if (part && Number.isFinite(n) && n >= min && n <= max && !out.includes(n)) out.push(n);
	}
	return out.sort((a, b) => a - b);
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

function style(s: Partial<ToolStyle> | undefined, d: ToolStyle, minWidth = MIN_WIDTH): ToolStyle {
	return {
		color: typeof s?.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : d.color,
		width: clamp(s?.width, minWidth, MAX_WIDTH, d.width),
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
	const list = (v: unknown, fallback: string[]) => (Array.isArray(v) ? parseColors(v.join(",")) : []).length ? parseColors((v as string[]).join(",")) : fallback;
	const nums = (v: unknown, fallback: number[]) => (Array.isArray(v) && parseNumbers(v.join(","), MIN_WIDTH, MAX_WIDTH).length ? parseNumbers(v.join(","), MIN_WIDTH, MAX_WIDTH) : fallback);
	return {
		penColors: list(r.penColors, d.penColors),
		highlightColors: list(r.highlightColors, d.highlightColors),
		penWidths: nums(r.penWidths, d.penWidths),
		markerWidths: nums(r.markerWidths, d.markerWidths),
		pen: style(r.pen, d.pen),
		marker: style(r.marker, d.marker),
		textHighlight: style(r.textHighlight, d.textHighlight, 0),
		eraserSize: clamp(r.eraserSize, 6, 120, d.eraserSize),
		stylusMode: typeof r.stylusMode === "boolean" ? r.stylusMode : d.stylusMode,
		smoothStrokes: typeof r.smoothStrokes === "boolean" ? r.smoothStrokes : d.smoothStrokes,
		fullPenRate: typeof r.fullPenRate === "boolean" ? r.fullPenRate : d.fullPenRate,
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

		new Setting(containerEl).setName("Stylus").setHeading();
		new Setting(containerEl).setName("Stylus mode on by default").setDesc("Fingers pan and scroll while only the pen draws. Can also be toggled on the toolbar.").addToggle((t) => t.setValue(s.stylusMode).onChange(async (v) => ((s.stylusMode = v), save())));
		new Setting(containerEl).setName("Smooth strokes").setDesc("Resample each stroke along a curve through the pen's samples (not native to EmbedPDF, which draws straight segments).").addToggle((t) => t.setValue(s.smoothStrokes).onChange(async (v) => ((s.smoothStrokes = v), save())));
		new Setting(containerEl).setName("Use the pen's full sample rate").setDesc("Feed the browser's coalesced pointer samples to the stroke (not native to EmbedPDF).").addToggle((t) => t.setValue(s.fullPenRate).onChange(async (v) => ((s.fullPenRate = v), save())));
		new Setting(containerEl).setName("Eraser size").setDesc("Diameter in pixels.").addSlider((sl) => sl.setLimits(6, 120, 2).setValue(s.eraserSize).setDynamicTooltip().onChange(async (v) => ((s.eraserSize = v), save())));

		new Setting(containerEl).setName("Tools").setHeading();
		const colors = (name: string, desc: string, get: () => string[], set: (v: string[]) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).addTextArea((t) =>
				t.setValue(get().join(", ")).onChange(async (v) => {
					const parsed = parseColors(v);
					if (parsed.length) {
						set(parsed);
						await save();
					}
				})
			);
		colors("Pen colours", "Hex colours offered for the pen, separated by commas.", () => s.penColors, (v) => (s.penColors = v));
		colors("Highlighter colours", "Hex colours offered for the freehand and text highlighters.", () => s.highlightColors, (v) => (s.highlightColors = v));
		const widths = (name: string, desc: string, get: () => number[], set: (v: number[]) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
				t.setValue(get().join(", ")).onChange(async (v) => {
					const parsed = parseNumbers(v, MIN_WIDTH, MAX_WIDTH);
					if (parsed.length) {
						set(parsed);
						await save();
					}
				})
			);
		widths("Pen widths", `Stroke widths in PDF points offered for the pen (${MIN_WIDTH}–${MAX_WIDTH}).`, () => s.penWidths, (v) => (s.penWidths = v));
		widths("Highlighter widths", "Stroke widths offered for the freehand highlighter.", () => s.markerWidths, (v) => (s.markerWidths = v));

		new Setting(containerEl).setName("Links").setHeading();
		new Setting(containerEl).setName("Copied links go to").setDesc("The sidecar note is the note opened beside the PDF with 'Open sidecar note'.").addDropdown((d) =>
			d.addOptions({ clipboard: "Clipboard", sidecar: "Sidecar note", both: "Clipboard and sidecar note" }).setValue(s.linkTarget).onChange(async (v) => ((s.linkTarget = v as Settings["linkTarget"]), save()))
		);
		const formatsSetting = (name: string, desc: string, get: () => LinkFormat[], set: (v: LinkFormat[]) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).addTextArea((t) => {
				t.inputEl.rows = 6;
				t.inputEl.cols = 50;
				t.setValue(get().map((f) => `${f.name}: ${f.template.replace(/\n/g, "\\n")}`).join("\n")).onChange(async (v) => {
					const parsed = v
						.split("\n")
						.map((line) => line.match(/^\s*([^:]+?)\s*:\s*(.+)$/))
						.filter((m): m is RegExpMatchArray => !!m)
						.map((m) => ({ name: m[1], template: m[2].replace(/\\n/g, "\n") }));
					if (parsed.length) {
						set(parsed);
						await save();
					}
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
		new Setting(containerEl).setName("Backlink colour").addText((t) =>
			t.setValue(s.backlinkColor).onChange(async (v) => {
				const c = parseColors(v)[0];
				if (c) {
					s.backlinkColor = c;
					await save();
				}
			})
		);
		new Setting(containerEl).setName("Sidecar note folder").setDesc("Folder for sidecar notes. Empty: next to the PDF.").addText((t) => t.setValue(s.sidecarFolder).onChange(async (v) => ((s.sidecarFolder = v.replace(/^\/+|\/+$/g, "")), save())));
		new Setting(containerEl).setName("Sidecar note suffix").setDesc("Added to the PDF's name, e.g. ' notes' makes 'paper notes.md' for 'paper.pdf'.").addText((t) => t.setValue(s.sidecarSuffix).onChange(async (v) => ((s.sidecarSuffix = v), save())));

		new Setting(containerEl).setName("Full screen").setHeading();
		new Setting(containerEl).setName("Hide Obsidian's bars in full screen").setDesc("Also hide the status bar, ribbon and mobile navigation while a PDF is full screen.").addToggle((t) => t.setValue(s.fullscreenHidesChrome).onChange(async (v) => ((s.fullscreenHidesChrome = v), save())));
	}
}
