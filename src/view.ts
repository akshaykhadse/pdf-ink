import { FileView, Notice, Scope, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type PdfInkPlugin from "./main";
import { ViewerHandle, mountViewer } from "./viewer";
import { Backlink, LinkVars, collectBacklinks, deliverLink, openBacklink, openSidecar } from "./links";

export const VIEW_TYPE = "pdf-ink";

/** Autosave waits this long after the last change. */
const AUTOSAVE_QUIET_MS = 2500;

export class PdfInkView extends FileView {
	allowNoFile = false;
	private rootEl!: HTMLElement;
	private unmount: (() => void) | null = null;
	private handle: ViewerHandle | null = null;
	/** Bumped per open, so a load that finishes after the file changed is dropped. */
	private openToken = 0;
	dirty = false;
	private saving: Promise<boolean> | null = null;
	private ignoreModifyUntil = 0;
	private readonly requestAutosave: () => void;
	private readonly requestBacklinks: () => void;
	private fullscreen = false;
	/** A link target that arrived before the document was open. */
	private pendingSubpath: string | null = null;
	/** Notes that linked to this PDF at the last backlink scan. */
	private backlinkSources = new Set<string>();

	constructor(leaf: WorkspaceLeaf, readonly plugin: PdfInkPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "s", () => {
			void this.saveNow(true);
			return false;
		});
		this.scope.register([], "Escape", () => {
			if (!this.fullscreen) return true;
			this.setFullscreen(false);
			return false;
		});
		this.requestAutosave = debounce(() => void this.saveNow(false), AUTOSAVE_QUIET_MS, true);
		this.requestBacklinks = debounce(() => this.handle?.refreshBacklinks(), 400, true);
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
				if (!this.dirty) void this.loadPdf(file);
				else new Notice(`${file.name} changed elsewhere; your unsaved annotations will be written over that version.`, 8000);
			})
		);
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestBacklinks()));
		this.registerEvent(
			this.app.metadataCache.on("changed", (changed) => {
				// Only notes that link (or linked) to this PDF matter, not every keystroke in the vault.
				const pdf = this.file?.path;
				if (!pdf) return;
				const linksNow = !!this.app.metadataCache.resolvedLinks[changed.path]?.[pdf];
				if (linksNow || this.backlinkSources.has(changed.path)) this.requestBacklinks();
			})
		);
	}

	async onClose() {
		this.setFullscreen(false);
		await this.flush();
		this.unmountViewer();
		await super.onClose();
	}

	async onLoadFile(file: TFile) {
		await this.loadPdf(file);
	}

	async onUnloadFile() {
		await this.flush();
		this.unmountViewer();
	}

	/** Obsidian passes the link's "#page=..&rect=.." here when a link to the PDF is followed. */
	setEphemeralState(state: any) {
		const subpath: string | undefined = state?.subpath;
		if (typeof subpath === "string" && subpath) {
			if (this.handle) this.handle.goTo(subpath);
			else this.pendingSubpath = subpath;
		}
		super.setEphemeralState(state);
	}

	/** Saves pending changes, if any. */
	async flush() {
		// A stroke becomes an annotation a moment after the pen lifts.
		await new Promise((r) => setTimeout(r, 80));
		while (this.saving) await this.saving;
		if (this.dirty) await this.saveNow(false, true);
	}

	/** Settings changed in the settings tab: push them into the open viewer. */
	settingsChanged() {
		this.handle?.applySettings();
	}

	// ---------------------------------------------------------------- full screen

	isFullscreen() {
		return this.fullscreen;
	}

	/** Full screen inside Obsidian: the pane covers the window; Esc or the button leaves. */
	setFullscreen(on: boolean) {
		if (this.fullscreen === on) return;
		this.fullscreen = on;
		this.containerEl.toggleClass("pdf-ink-fullscreen", on);
		const body = this.containerEl.ownerDocument.body; // the pane may live in a pop-out window
		body.toggleClass("pdf-ink-fullscreen-active", on);
		body.toggleClass("pdf-ink-fullscreen-hide-chrome", on && this.plugin.settings.fullscreenHidesChrome);
		this.handle?.tools.notify();
		if (on) this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
		(this.containerEl.ownerDocument.defaultView ?? window).dispatchEvent(new Event("resize"));
	}

	// ----------------------------------------------------------------- loading

	private unmountViewer() {
		this.openToken++;
		this.unmount?.();
		this.unmount = null;
		this.handle = null;
		this.dirty = false;
	}

	private async loadPdf(file: TFile) {
		const token = ++this.openToken;
		this.unmountViewer();
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
				host: {
					settings: () => this.plugin.settings,
					saveSettings: () => void this.plugin.saveSettings(),
					onChange: () => this.markDirty(),
					setFullscreen: (on) => this.setFullscreen(on),
					isFullscreen: () => this.fullscreen,
					linkVars: (page, rect, text, color) => this.linkVars(file, page, rect, text, color),
					deliverLink: (text) => deliverLink(this.app, this.plugin.settings, file, text),
					backlinks: () => this.backlinks(file),
					openBacklink: (link: Backlink) => void openBacklink(this.app, link, file.path),
					openSidecar: () => void openSidecar(this.app, this.plugin.settings, file, this.leaf).catch((e) => new Notice(`PDF Ink: ${e?.message ?? e}`)),
				},
				onReady: (handle) => {
					if (token !== this.openToken) return;
					this.handle = handle;
					this.rootEl.removeClass("is-loading");
					if (this.pendingSubpath) {
						const sub = this.pendingSubpath;
						this.pendingSubpath = null;
						setTimeout(() => handle.goTo(sub), 150);
					}
				},
				onError: (e) => {
					console.error("[pdf-ink] open failed", e);
					new Notice(`PDF Ink couldn't open ${file.name}: ${e.message}`);
				},
			});
			this.unmount = mounted.unmount;
		} catch (e: any) {
			console.error("[pdf-ink] open failed", e);
			new Notice(`PDF Ink couldn't open ${file.name}: ${e?.message ?? e}`);
		}
	}

	private linkVars(file: TFile, page: number, rect: string, text: string, color: string): LinkVars {
		const sidecar = this.plugin.settings.sidecarFolder ? `${this.plugin.settings.sidecarFolder}/x.md` : file.path;
		return { file: this.app.metadataCache.fileToLinktext(file, sidecar), path: file.path, page, rect, text, color };
	}

	private backlinks(file: TFile): Backlink[] {
		if (!this.plugin.settings.showBacklinks) return [];
		try {
			const links = collectBacklinks(this.app, file);
			this.backlinkSources = new Set(links.map((l) => l.sourcePath));
			return links;
		} catch (e) {
			console.warn("[pdf-ink] backlinks", e);
			return [];
		}
	}

	// ------------------------------------------------------------------ saving

	private markDirty() {
		this.dirty = true;
		if (this.plugin.settings.autosave) this.requestAutosave();
	}

	/** Writes the PDF with its annotations back to the vault. */
	async saveNow(manual: boolean, closing = false): Promise<boolean> {
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
