import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfInkPlugin from "./main";

export interface Settings {
	/** Pen colours offered on the toolbar. */
	penColors: string[];
	penColor: string;
	/** Pen widths offered on the toolbar, in PDF points. */
	penWidths: number[];
	/** Pen stroke width in PDF points. */
	penWidth: number;
	highlightColors: string[];
	highlightColor: string;
	highlightWidth: number;
	/** Eraser diameter in screen pixels. */
	eraserSize: number;
	/** Fingers scroll and pinch; only the stylus draws. */
	palmRejection: boolean;
	/** Write changes back into the PDF a moment after the last stroke. */
	autosave: boolean;
	/** Open every PDF in the vault with this plugin. */
	openByDefault: boolean;
	/** Resample each stroke along a spline through its samples (not an EmbedPDF feature). */
	smoothStrokes: boolean;
	/** Feed the pen samples the browser folds between frames into the stroke. */
	fullPenRate: boolean;
}

export const MIN_PEN_WIDTH = 0.25;
export const MAX_PEN_WIDTH = 20;

export const DEFAULT_SETTINGS: Settings = {
	penColors: ["#1b1b1b", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5"],
	penColor: "#1b1b1b",
	penWidths: [1, 2, 4],
	penWidth: 2,
	highlightColors: ["#ffe066", "#8ce99a", "#74c0fc", "#faa2c1"],
	highlightColor: "#ffe066",
	highlightWidth: 14,
	eraserSize: 20,
	palmRejection: true,
	autosave: true,
	openByDefault: false,
	smoothStrokes: true,
	fullPenRate: true,
};

const HEX = /^#[0-9a-f]{6}$/i;

function colors(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const out = value.filter((c): c is string => typeof c === "string" && HEX.test(c)).map((c) => c.toLowerCase());
	return out.length ? [...new Set(out)] : [...fallback];
}

/** A list of widths in PDF points: finite, within range, ascending, no repeats. */
export function widths(value: unknown, fallback: number[]): number[] {
	if (!Array.isArray(value)) return [...fallback];
	const out = value
		.map((w) => (typeof w === "string" ? Number(w) : w))
		.filter((w): w is number => typeof w === "number" && Number.isFinite(w) && w >= MIN_PEN_WIDTH && w <= MAX_PEN_WIDTH)
		.map((w) => Math.round(w * 100) / 100);
	return out.length ? [...new Set(out)].sort((a, b) => a - b) : [...fallback];
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Fills in and sanitises whatever was stored. */
export function normalizeSettings(raw: unknown): Settings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
	const d = DEFAULT_SETTINGS;
	const penColors = colors(r.penColors, d.penColors);
	const highlightColors = colors(r.highlightColors, d.highlightColors);
	const penWidths = widths(r.penWidths, d.penWidths);
	const penWidth = num(r.penWidth, d.penWidth, MIN_PEN_WIDTH, MAX_PEN_WIDTH);
	return {
		penColors,
		penColor: penColors.includes(String(r.penColor).toLowerCase()) ? String(r.penColor).toLowerCase() : penColors[0],
		penWidths,
		penWidth: penWidths.includes(penWidth) ? penWidth : penWidths[Math.min(1, penWidths.length - 1)],
		highlightColors,
		highlightColor: highlightColors.includes(String(r.highlightColor).toLowerCase()) ? String(r.highlightColor).toLowerCase() : highlightColors[0],
		highlightWidth: num(r.highlightWidth, d.highlightWidth, 4, 40),
		eraserSize: num(r.eraserSize, d.eraserSize, 6, 80),
		palmRejection: typeof r.palmRejection === "boolean" ? r.palmRejection : d.palmRejection,
		autosave: typeof r.autosave === "boolean" ? r.autosave : d.autosave,
		openByDefault: typeof r.openByDefault === "boolean" ? r.openByDefault : d.openByDefault,
		smoothStrokes: typeof r.smoothStrokes === "boolean" ? r.smoothStrokes : d.smoothStrokes,
		fullPenRate: typeof r.fullPenRate === "boolean" ? r.fullPenRate : d.fullPenRate,
	};
}

export class PdfInkSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PdfInkPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Open PDFs with PDF Ink")
			.setDesc("Every PDF in the vault opens in this viewer (already open tabs keep their viewer). Off: use the file menu or the command.")
			.addToggle((t) =>
				t.setValue(s.openByDefault).onChange(async (v) => {
					s.openByDefault = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Autosave")
			.setDesc("Write your strokes into the PDF a few seconds after you stop. Otherwise save with Ctrl/Cmd+S or when closing.")
			.addToggle((t) =>
				t.setValue(s.autosave).onChange(async (v) => {
					s.autosave = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Stylus mode")
			.setDesc("Fingers scroll and pinch to zoom; only the stylus draws. Off: fingers draw too (a tablet without a pen). Also on the toolbar.")
			.addToggle((t) =>
				t.setValue(s.palmRejection).onChange(async (v) => {
					s.palmRejection = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Smooth strokes")
			.setDesc("Before a stroke is saved, fit a smooth curve through its pen samples. Off: straight segments between samples, as EmbedPDF draws them.")
			.addToggle((t) =>
				t.setValue(s.smoothStrokes).onChange(async (v) => {
					s.smoothStrokes = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Use the pen's full sample rate")
			.setDesc("Feed every pen sample into the stroke, not just one per screen frame. Off if strokes look wrong on your device.")
			.addToggle((t) =>
				t.setValue(s.fullPenRate).onChange(async (v) => {
					s.fullPenRate = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Eraser size")
			.setDesc("Diameter of the eraser, in screen pixels.")
			.addSlider((sl) =>
				sl.setLimits(6, 80, 2).setValue(s.eraserSize).setDynamicTooltip().onChange(async (v) => {
					s.eraserSize = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Highlighter width")
			.setDesc("In PDF points.")
			.addSlider((sl) =>
				sl.setLimits(4, 40, 1).setValue(s.highlightWidth).setDynamicTooltip().onChange(async (v) => {
					s.highlightWidth = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Pen widths")
			.setDesc(`One width per line, in PDF points (${MIN_PEN_WIDTH} to ${MAX_PEN_WIDTH}). Shown on the toolbar thin to thick.`)
			.addTextArea((t) => {
				t.setValue(s.penWidths.join("\n"));
				t.inputEl.rows = 3;
				t.onChange(async (v) => {
					const list = widths(v.split(/[\s,]+/).filter(Boolean), DEFAULT_SETTINGS.penWidths);
					s.penWidths = list;
					if (!list.includes(s.penWidth)) s.penWidth = list[0];
					await this.plugin.saveSettings();
				});
			});

		this.colorList(containerEl, "Pen colours", "One hex colour per line, e.g. #e03131. Shown on the toolbar in this order.", "penColors", "penColor");
		this.colorList(containerEl, "Highlighter colours", "One hex colour per line.", "highlightColors", "highlightColor");
	}

	private colorList(containerEl: HTMLElement, name: string, desc: string, key: "penColors" | "highlightColors", current: "penColor" | "highlightColor") {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((t) => {
				t.setValue(s[key].join("\n"));
				t.inputEl.rows = 4;
				t.onChange(async (v) => {
					const list = colors(v.split(/[\s,]+/).filter(Boolean), DEFAULT_SETTINGS[key]);
					s[key] = list;
					if (!list.includes(s[current])) s[current] = list[0];
					await this.plugin.saveSettings();
				});
			});
	}
}
