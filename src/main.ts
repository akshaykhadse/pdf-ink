import { Menu, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type { PdfEngine } from "@embedpdf/models";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";
import { DEFAULT_SETTINGS, PdfInkSettingTab, Settings, normalizeSettings } from "./settings";
import type { ReadingPosition } from "./viewer";
import { PdfInkView, VIEW_TYPE } from "./view";
import { openSidecar } from "./links";

export default class PdfInkPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** One PDFium worker for every open view; created when the first PDF opens. */
	private engine: Promise<PdfEngine> | null = null;
	private wasmUrl: string | null = null;
	/** Set when this plugin currently owns the .pdf extension in Obsidian's view registry. */
	private ownsPdfExtension = false;
	/** The view type that owned .pdf before this plugin took it (normally Obsidian's "pdf"). */
	private previousPdfView = "pdf";

	/** Last reading position per PDF path, kept beside the settings in data.json. */
	positions: Record<string, StoredPosition> = {};
	private positionsTimer: ReturnType<typeof setTimeout> | null = null;

	async onload() {
		const raw = await this.loadData();
		this.settings = normalizeSettings(raw);
		this.positions = readPositions(raw?.positions);
		this.addSettingTab(new PdfInkSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new PdfInkView(leaf, this));
		this.applyOpenByDefault();

		const withView = (fn: (view: PdfInkView) => void) => (checking: boolean) => {
			const view = this.app.workspace.getActiveViewOfType(PdfInkView);
			if (!view) return false;
			if (!checking) fn(view);
			return true;
		};
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
		this.addCommand({ id: "save-annotations", name: "Save annotations into the PDF", checkCallback: withView((v) => void v.saveNow(true)) });
		this.addCommand({ id: "toggle-fullscreen", name: "Toggle full screen", checkCallback: withView((v) => v.setFullscreen(!v.isFullscreen())) });
		this.addCommand({
			id: "open-sidecar",
			name: "Open sidecar note",
			checkCallback: withView((v) => {
				if (v.file) void openSidecar(this.app, this.settings, v.file, v.leaf).catch((e) => new Notice(`PDF Ink: ${e?.message ?? e}`));
			}),
		});
		this.addCommand({ id: "paste-image", name: "Paste image from clipboard", checkCallback: withView((v) => void v.pasteImage()) });
		this.addCommand({ id: "toggle-stylus-mode", name: "Toggle stylus mode", checkCallback: withView((v) => (v as any).handle?.tools.setStylusMode(!this.settings.stylusMode)) });

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const pos = this.positions[oldPath];
				if (!pos) return;
				delete this.positions[oldPath];
				this.positions[file.path] = pos;
				this.schedulePositionsSave();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.positions[file.path]) return;
				delete this.positions[file.path];
				this.schedulePositionsSave();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				menu.addItem((item) => item.setTitle("Open in PDF Ink").setIcon("pen-tool").onClick(() => void this.openInInk(file)));
			})
		);
	}

	async onunload() {
		// Save what the open views hold before the engine goes away.
		// Views are flushed but not detached: Obsidian keeps the leaves and restores them when the plugin reloads.
		const views = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const timeout = new Promise<void>((r) => setTimeout(r, 4000));
		await Promise.race([Promise.all(views.map((leaf) => (leaf.view as PdfInkView).flush().catch(() => {}))), timeout]);
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
		document.body.removeClass("pdf-ink-fullscreen-active", "pdf-ink-fullscreen-hide-chrome");
	}

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
				const current = registry.typeByExtension?.pdf;
				if (typeof current === "string" && current !== VIEW_TYPE) this.previousPdfView = current;
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
			registry.registerExtensions(["pdf"], this.previousPdfView);
		} catch (e) {
			console.warn("[pdf-ink] could not restore the PDF view", e);
		}
	}

	positionFor(path: string): ReadingPosition | null {
		const p = this.positions[path];
		return p ? { page: p.page, y: p.y } : null;
	}

	rememberPosition(path: string, pos: ReadingPosition) {
		const old = this.positions[path];
		if (old && old.page === pos.page && old.y === pos.y) return;
		this.positions[path] = { page: pos.page, y: pos.y, at: Date.now() };
		this.schedulePositionsSave();
	}

	private schedulePositionsSave() {
		if (this.positionsTimer) clearTimeout(this.positionsTimer);
		this.positionsTimer = setTimeout(() => {
			this.positionsTimer = null;
			void this.saveSettings(false);
		}, 2000);
	}

	/** Persists the settings and the reading positions; `fromTab` pushes the settings into the open viewers too. */
	async saveSettings(fromTab = true) {
		await this.saveData({ ...this.settings, positions: prunePositions(this.positions) });
		if (!fromTab) return;
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

interface StoredPosition extends ReadingPosition {
	at: number;
}

const MAX_POSITIONS = 500;

function readPositions(raw: unknown): Record<string, StoredPosition> {
	const out: Record<string, StoredPosition> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [path, v] of Object.entries(raw as Record<string, any>)) {
		if (!v || typeof v !== "object") continue;
		const page = Number(v.page), y = Number(v.y), at = Number(v.at);
		if (!Number.isFinite(page) || page < 1 || !Number.isFinite(y)) continue;
		out[path] = { page: Math.floor(page), y: Math.max(0, y), at: Number.isFinite(at) ? at : 0 };
	}
	return out;
}

/** The most recent entries only, so data.json does not grow forever. */
function prunePositions(all: Record<string, StoredPosition>): Record<string, StoredPosition> {
	const entries = Object.entries(all);
	if (entries.length <= MAX_POSITIONS) return all;
	entries.sort((a, b) => b[1].at - a[1].at);
	return Object.fromEntries(entries.slice(0, MAX_POSITIONS));
}
