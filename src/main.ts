import { Menu, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type { PdfEngine } from "@embedpdf/models";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";
import { DEFAULT_SETTINGS, PdfInkSettingTab, Settings, normalizeSettings } from "./settings";
import { PdfInkView, VIEW_TYPE } from "./view";

export default class PdfInkPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** One PDFium worker for every open view; created when the first PDF opens. */
	private engine: Promise<PdfEngine> | null = null;
	private wasmUrl: string | null = null;

	async onload() {
		this.settings = normalizeSettings(await this.loadData());
		this.addSettingTab(new PdfInkSettingTab(this.app, this));

		this.registerView(VIEW_TYPE, (leaf) => new PdfInkView(leaf, this));
		this.applyOpenByDefault();

		this.addCommand({
			id: "open-with-pdf-ink",
			name: "Open current PDF in PDF Ink",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "pdf") return false;
				if (!checking) void this.openInInk(file);
				return true;
			},
		});
		this.addCommand({
			id: "save-annotations",
			name: "Save annotations into the PDF",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(PdfInkView);
				if (!view) return false;
				if (!checking) void view.saveNow(true);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				menu.addItem((item) =>
					item
						.setTitle("Open in PDF Ink")
						.setIcon("pen-tool")
						.onClick(() => void this.openInInk(file))
				);
			})
		);
	}

	async onunload() {
		// Save what the open views hold before the engine goes away.
		const views = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const timeout = new Promise<void>((r) => setTimeout(r, 4000));
		await Promise.race([Promise.all(views.map((leaf) => (leaf.view as PdfInkView).flush().catch(() => {}))), timeout]);
		for (const leaf of views) leaf.detach();
		const enginePromise = this.engine;
		this.engine = null;
		const engine = await Promise.race([enginePromise?.catch(() => null), timeout]);
		try {
			engine?.destroy?.();
		} catch (e) {
			console.warn("[pdf-ink] engine shutdown", e);
		}
		if (this.wasmUrl) URL.revokeObjectURL(this.wasmUrl);
		this.wasmUrl = null;
		this.restorePdfExtension();
	}

	/** Set when this plugin currently owns the .pdf extension in Obsidian's view registry. */
	private ownsPdfExtension = false;

	/**
	 * Makes .pdf files open here instead of the built-in viewer. Obsidian's own
	 * registerExtensions throws when the extension is already taken (and "pdf"
	 * always is, by the core viewer), so the registry is swapped by hand.
	 */
	applyOpenByDefault() {
		const registry = (this.app as any).viewRegistry;
		if (!registry?.unregisterExtensions || !registry?.registerExtensions) return;
		try {
			if (this.settings.openByDefault && !this.ownsPdfExtension) {
				registry.unregisterExtensions(["pdf"]);
				registry.registerExtensions(["pdf"], VIEW_TYPE);
				this.ownsPdfExtension = true;
			} else if (!this.settings.openByDefault) {
				this.restorePdfExtension();
			}
		} catch (e) {
			console.warn("[pdf-ink] could not change the .pdf view", e);
		}
	}

	/** Hands .pdf back to Obsidian's own viewer (unregistering alone leaves it with no view at all). */
	private restorePdfExtension() {
		if (!this.ownsPdfExtension) return;
		this.ownsPdfExtension = false;
		try {
			const registry = (this.app as any).viewRegistry;
			registry.unregisterExtensions(["pdf"]);
			registry.registerExtensions(["pdf"], "pdf");
		} catch (e) {
			console.warn("[pdf-ink] could not restore the PDF view", e);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyOpenByDefault();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as PdfInkView).settingsChanged();
	}

	async openInInk(file: TFile) {
		const leaf: WorkspaceLeaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	/** The shared PDFium engine, started on first use. */
	getEngine(): Promise<PdfEngine> {
		if (!this.engine) {
			this.engine = this.startEngine().catch((e) => {
				this.engine = null;
				throw e;
			});
		}
		return this.engine;
	}

	private async startEngine(): Promise<PdfEngine> {
		const dir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		const path = normalizePath(`${dir}/pdfium.wasm`);
		if (!(await this.app.vault.adapter.exists(path))) {
			new Notice("PDF Ink: pdfium.wasm is missing from the plugin folder.", 8000);
			throw new Error(`${path} not found`);
		}
		const bytes = await this.app.vault.adapter.readBinary(path);
		// A blob URL: the worker can't fetch from the vault, and nothing is loaded from the web.
		const wasmUrl = (this.wasmUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" })));
		try {
			return await createPdfiumEngine(wasmUrl, { fontFallback: null });
		} catch (e) {
			URL.revokeObjectURL(wasmUrl);
			this.wasmUrl = null;
			throw e;
		}
	}
}
