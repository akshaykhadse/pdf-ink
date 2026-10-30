import { FileView, Notice, Scope, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type PdfInkPlugin from "./main";
import { ViewerHandle, mountViewer } from "./app";

export const VIEW_TYPE = "pdf-ink";

/** Autosave waits this long after the last change. */
const AUTOSAVE_QUIET_MS = 2500;

export class PdfInkView extends FileView {
	allowNoFile = false;
	private rootEl!: HTMLElement;
	private unmount: (() => void) | null = null;
	private refresh: (() => void) | null = null;
	private handle: ViewerHandle | null = null;
	/** Bumped per open, so a load that finishes after the file changed is dropped. */
	private openToken = 0;
	private dirty = false;
	private saving: Promise<boolean> | null = null;
	private ignoreModifyUntil = 0;
	private readonly requestAutosave: () => void;

	constructor(leaf: WorkspaceLeaf, readonly plugin: PdfInkPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "s", () => {
			void this.save(true);
			return false;
		});
		this.requestAutosave = debounce(() => void this.save(false), AUTOSAVE_QUIET_MS, true);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return this.file?.basename ?? "PDF Ink";
	}

	getIcon() {
		return "pen-tool";
	}

	canAcceptExtension(extension: string) {
		return extension === "pdf";
	}

	async onOpen() {
		await super.onOpen();
		this.contentEl.empty();
		this.contentEl.addClass("pdf-ink-content");
		this.rootEl = this.contentEl.createDiv({ cls: "pdf-ink-root" });
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file !== this.file || !(file instanceof TFile)) return;
				if (Date.now() < this.ignoreModifyUntil || this.saving) return;
				// Changed elsewhere (sync, another device): show the file as it is now.
				if (!this.dirty) void this.open(file);
				else new Notice(`${file.name} changed elsewhere; your unsaved strokes will be written over that version.`, 8000);
			})
		);
	}

	async onClose() {
		await this.flush();
		this.close();
		await super.onClose();
	}

	async onLoadFile(file: TFile) {
		await this.open(file);
	}

	async onUnloadFile() {
		await this.flush();
		this.close();
	}

	/** Saves pending changes, if any. */
	async flush() {
		// A stroke becomes an annotation a moment after the pen lifts.
		await new Promise((r) => setTimeout(r, 80));
		while (this.saving) await this.saving;
		if (this.dirty) await this.save(false, true);
	}

	/** Settings changed in the settings tab: push them into the open viewer. */
	settingsChanged() {
		this.handle?.applySettings();
		this.refresh?.();
	}

	private close() {
		this.openToken++;
		this.unmount?.();
		this.unmount = null;
		this.refresh = null;
		this.handle = null;
		this.dirty = false;
	}

	private async open(file: TFile) {
		const token = ++this.openToken;
		this.close();
		this.openToken = token;
		this.rootEl.empty();
		this.rootEl.addClass("is-loading");
		try {
			const [engine, bytes] = await Promise.all([this.plugin.getEngine(), this.app.vault.readBinary(file)]);
			if (token !== this.openToken) return;
			const mounted = mountViewer(this.rootEl, {
				engine,
				bytes,
				name: file.name,
				settings: this.plugin.settings,
				onReady: (handle) => {
					if (token !== this.openToken) return;
					this.handle = handle;
					this.rootEl.removeClass("is-loading");
				},
				onChange: () => this.markDirty(),
				onError: (e) => {
					console.error("[pdf-ink] open failed", e);
					new Notice(`PDF Ink couldn't open ${file.name}: ${e.message}`);
				},
				onSettingsChange: () => void this.plugin.saveSettings(),
			});
			this.unmount = mounted.unmount;
			this.refresh = mounted.refresh;
		} catch (e: any) {
			console.error("[pdf-ink] open failed", e);
			new Notice(`PDF Ink couldn't open ${file.name}: ${e?.message ?? e}`);
		}
	}

	private markDirty() {
		this.dirty = true;
		if (this.plugin.settings.autosave) this.requestAutosave();
	}

	/** Writes the PDF with its annotations back to the vault. */
	async save(manual: boolean, closing = false): Promise<boolean> {
		while (this.saving) await this.saving;
		const file = this.file;
		const handle = this.handle;
		if (!file || !handle) return false;
		if (!this.dirty) {
			if (manual) new Notice("Nothing to save.");
			return true;
		}
		const saving = (this.saving = (async () => {
			try {
				const bytes = await handle.save();
				if (handle !== this.handle || file !== this.file) {
					console.warn("[pdf-ink] file changed while saving; nothing written");
					return false;
				}
				this.dirty = false;
				this.ignoreModifyUntil = Date.now() + 2000;
				await this.app.vault.modifyBinary(file, bytes);
				this.ignoreModifyUntil = Date.now() + 1000;
				if (manual) new Notice(`Saved ${file.name}`);
				return true;
			} catch (e: any) {
				if (handle === this.handle && file === this.file) this.dirty = true;
				console.error("[pdf-ink] save failed", e);
				new Notice(`PDF Ink couldn't save: ${e?.message ?? e}`);
				return false;
			}
		})());
		let ok = false;
		try {
			ok = await saving;
		} finally {
			if (this.saving === saving) this.saving = null;
		}
		if (!ok && !closing && this.dirty && this.plugin.settings.autosave) this.requestAutosave();
		return ok;
	}
}
