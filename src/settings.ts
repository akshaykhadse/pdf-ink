import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfInkPlugin from "./main";

export interface Settings {
	/** Pen colours offered on the toolbar. */
	penColors: string[];
	penColor: string;
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
}

export const PEN_WIDTHS: { name: string; width: number }[] = [
	{ name: "Fine", width: 1 },
	{ name: "Medium", width: 2 },
	{ name: "Bold", width: 4 },
];

export const DEFAULT_SETTINGS: Settings = {
	penColors: ["#1b1b1b", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5"],
	penColor: "#1b1b1b",
	penWidth: 2,
	highlightColors: ["#ffe066", "#8ce99a", "#74c0fc", "#faa2c1"],
	highlightColor: "#ffe066",
	highlightWidth: 14,
	eraserSize: 20,
	palmRejection: true,
	autosave: true,
	openByDefault: false,
};

const HEX = /^#[0-9a-f]{6}$/i;

function colors(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const out = value.filter((c): c is string => typeof c === "string" && HEX.test(c)).map((c) => c.toLowerCase());
	return out.length ? [...new Set(out)] : [...fallback];
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
	return {
		penColors,
		penColor: penColors.includes(String(r.penColor).toLowerCase()) ? String(r.penColor).toLowerCase() : penColors[0],
		penWidth: num(r.penWidth, d.penWidth, 0.5, 20),
		highlightColors,
		highlightColor: highlightColors.includes(String(r.highlightColor).toLowerCase()) ? String(r.highlightColor).toLowerCase() : highlightColors[0],
		highlightWidth: num(r.highlightWidth, d.highlightWidth, 4, 40),
		eraserSize: num(r.eraserSize, d.eraserSize, 6, 80),
		palmRejection: typeof r.palmRejection === "boolean" ? r.palmRejection : d.palmRejection,
		autosave: typeof r.autosave === "boolean" ? r.autosave : d.autosave,
		openByDefault: typeof r.openByDefault === "boolean" ? r.openByDefault : d.openByDefault,
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
			.setName("Palm rejection")
			.setDesc("While a pen tool is active, fingers scroll and pinch to zoom; only the stylus draws.")
			.addToggle((t) =>
				t.setValue(s.palmRejection).onChange(async (v) => {
					s.palmRejection = v;
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
