import { FileView, Notice, Scope, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type PdfInkPlugin from "./main";
import { PageAction, ReadingPosition, ViewerHandle, mountViewer } from "./viewer";
import { PageEdit, editPdfPages } from "./pages";
import { ConfirmModal } from "./settings";
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
	/** Bumped on every change, so a save can tell whether something changed while it ran. */
	private changes = 0;
	private saving: Promise<boolean> | null = null;
	private ignoreModifyUntil = 0;
	private readonly requestAutosave: () => void;
	private readonly requestBacklinks: () => void;
	private fullscreen = false;
	/** A link target that arrived before the document was open. */
	private pendingSubpath: string | null = null;
	/** True while the remembered position is being restored after opening. */
	private restoring = false;
	/** Notes that linked to this PDF at the last backlink scan. */
	private backlinkSources = new Set<string>();

	constructor(leaf: WorkspaceLeaf, readonly plugin: PdfInkPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "s", () => {
			void this.saveNow(true);
			return false;
		});
		// Undo, redo and delete, unless a text box or an input has the keys.
		const key = (fn: () => void) => () => {
			if (this.editingPages) return false;
			const el: any = this.containerEl.ownerDocument.activeElement;
			if (el?.isContentEditable || el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return true;
			if (!this.handle) return true;
			fn();
			return false;
		};
		this.scope.register(["Mod"], "z", key(() => this.handle?.tools.undo()));
		this.scope.register(["Mod", "Shift"], "z", key(() => this.handle?.tools.redo()));
		this.scope.register(["Mod"], "y", key(() => this.handle?.tools.redo()));
		this.scope.register([], "Delete", key(() => this.handle?.tools.deleteSelected()));
		this.scope.register([], "Backspace", key(() => this.handle?.tools.deleteSelected()));
		this.scope.register([], "Escape", () => {
			if (!this.fullscreen) return true;
			this.setFullscreen(false);
			return false;
		});
		this.requestAutosave = debounce(() => void this.saveNow(false), AUTOSAVE_QUIET_MS, true);
		this.requestBacklinks = debounce(() => this.handle?.refreshBacklinks(), 400, true);
	}

	/** The open document's tools, once it is open. */
	get tools() {
		return this.handle?.tools ?? null;
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
		if (on) this.containerEl.style.setProperty("--pdf-ink-safe-top", `${this.statusBarInset()}px`);
		this.containerEl.toggleClass("pdf-ink-fullscreen", on);
		const body = this.containerEl.ownerDocument.body; // the pane may live in a pop-out window
		body.toggleClass("pdf-ink-fullscreen-active", on);
		body.toggleClass("pdf-ink-fullscreen-hide-chrome", on && this.plugin.settings.fullscreenHidesChrome);
		this.handle?.tools.notify();
		if (on) this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
		(this.containerEl.ownerDocument.defaultView ?? window).dispatchEvent(new Event("resize"));
	}

	/**
	 * Android draws the status bar over the web view and reports no
	 * env(safe-area-inset-top); Obsidian keeps its own UI below the bar, so
	 * the main container's top edge is the inset. Measured before the pane
	 * goes fixed.
	 */
	private statusBarInset(): number {
		const doc = this.containerEl.ownerDocument;
		if (!doc.body.classList.contains("is-mobile")) return 0;
		const main = doc.querySelector(".horizontal-main-container") ?? doc.querySelector(".app-container");
		return Math.max(0, Math.round(main?.getBoundingClientRect().top ?? 0));
	}

	// ----------------------------------------------------------------- loading

	/**
	 * The layout settles some time after the document opens (and EmbedPDF may
	 * scroll to the top once more): keep asking until the viewer reports the
	 * wanted spot, correcting for the viewport gap, then leave it alone.
	 */
	private restoreWhenLaidOut(handle: ViewerHandle, pos: ReadingPosition, token: number) {
		let tries = 0;
		let y = pos.y;
		this.restoring = true;
		const done = () => (this.restoring = false);
		const tick = () => {
			if (token !== this.openToken || this.handle !== handle) return done();
			const got = handle.position();
			if (got && got.page === pos.page && Math.abs(got.y - pos.y) <= 1) return done();
			// Already scrolled as far up as it goes: the rest is the viewport gap.
			if (got && got.page === pos.page && y === 0 && got.y >= pos.y && got.y - pos.y < 30) return done();
			if (got && got.page === pos.page && Math.abs(got.y - pos.y) < 60) y = Math.max(0, y - (got.y - pos.y));
			handle.restore({ page: pos.page, y });
			if (++tries < 25) setTimeout(tick, 120);
			else done();
		};
		setTimeout(tick, 150);
	}

	private unmountViewer() {
		const pos = this.restoring ? null : this.handle?.position();
		if (pos && this.file) this.plugin.rememberPosition(this.file.path, pos);
		this.restoring = false;
		this.openToken++;
		this.unmount?.();
		this.unmount = null;
		this.handle = null;
		this.dirty = false;
	}

	/** Opens `file` in a new viewer; after a page edit, with the new bytes, the spot to show and the zoom to keep. */
	private async loadPdf(file: TFile, reopen?: { bytes: ArrayBuffer; position: ReadingPosition; zoom: unknown }) {
		const token = ++this.openToken;
		this.unmountViewer();
		this.openToken = token;
		this.rootEl.empty();
		this.rootEl.addClass("is-loading");
		// A remembered spot: the layout's first scroll reports must not overwrite it before it is restored.
		const remembered = reopen?.position ?? (this.pendingSubpath ? null : this.plugin.positionFor(file.path));
		this.restoring = !!remembered && (remembered.page > 1 || remembered.y > 0);
		try {
			const [engine, bytes] = await Promise.all([this.plugin.getEngine(), reopen?.bytes ?? this.app.vault.readBinary(file)]);
			if (token !== this.openToken) return;
			const mounted = mountViewer(this.rootEl, {
				engine,
				bytes,
				name: file.name,
				host: {
					settings: () => this.plugin.settings,
					saveSettings: () => this.plugin.saveSettingsSoon(),
					onChange: () => this.markDirty(),
					setFullscreen: (on) => this.setFullscreen(on),
					isFullscreen: () => this.fullscreen,
					linkVars: (page, rect, text, color) => this.linkVars(file, page, rect, text, color),
					deliverLink: (text) => deliverLink(this.app, this.plugin.settings, file, text),
					backlinks: () => this.backlinks(file),
					openBacklink: (link: Backlink) => void openBacklink(this.app, link),
					openSidecar: () => void openSidecar(this.app, this.plugin.settings, file, this.leaf).catch((e) => new Notice(`PDF Ink: ${e?.message ?? e}`)),
					// The layout's first scroll events report the top of the document: not until the old spot is restored.
					positionChanged: (pos) => !this.restoring && this.plugin.rememberPosition(file.path, pos),
					penLog: (text) => void this.plugin.appendPenLog(text),
					editPages: (action) => this.requestPageEdit(action),
				},
				onReady: (handle) => {
					if (token !== this.openToken) return;
					this.handle = handle;
					this.rootEl.removeClass("is-loading");
					// A zoom the reader set by hand survives a page edit; fit width, the default, comes back by itself.
					if (typeof reopen?.zoom === "number") handle.setZoomLevel(reopen.zoom);
					if (this.pendingSubpath) {
						const sub = this.pendingSubpath;
						this.pendingSubpath = null;
						setTimeout(() => handle.goTo(sub), 150);
					} else if (this.restoring && remembered) {
						// Back to where the reader left this file (the plugin remembers it; EmbedPDF does not).
						this.restoreWhenLaidOut(handle, remembered, token);
					} else {
						this.restoring = false;
					}
				},
				onError: (e) => {
					this.restoring = false;
					console.error("[pdf-ink] open failed", e);
					new Notice(`PDF Ink couldn't open ${file.name}: ${e.message}`);
				},
			});
			this.unmount = mounted.unmount;
		} catch (e: any) {
			this.restoring = false;
			console.error("[pdf-ink] open failed", e);
			new Notice(`PDF Ink couldn't open ${file.name}: ${e?.message ?? e}`);
		}
	}

	// ------------------------------------------------------------------- pages

	/** From the toolbar or a command: acts on the page in view. Deleting asks first. */
	requestPageEdit(action: PageAction) {
		const handle = this.handle;
		if (!handle || this.editingPages) return;
		const { page, pages } = handle.tools.state();
		if (action === "delete") {
			if (pages <= 1) return void new Notice("A PDF needs at least one page.");
			new ConfirmModal(this.app, "Delete page", `Delete page ${page} of ${pages}, with everything written on it? Links to later pages will point one page off.`, "Delete", () => void this.editPages({ kind: "delete", index: page - 1 })).open();
			return;
		}
		const size = handle.pageSize(page - 1);
		if (!size) return;
		void this.editPages({ kind: "insert", at: action === "insertAfter" ? page : page - 1, ...size });
	}

	/** True while a page is added or deleted: commands and keys leave the document alone. */
	editingPages = false;

	/**
	 * Saves the PDF with the page added or removed and reopens it at that page.
	 * EmbedPDF 2.15's viewer cannot change its page list, so the open document
	 * is replaced; the undo history starts afresh, as after reopening the file.
	 */
	async editPages(edit: PageEdit): Promise<boolean> {
		const file = this.file;
		if (!file || !this.handle || this.editingPages) return false;
		this.editingPages = true;
		// No strokes while the copy is made: they would not be in it.
		this.rootEl.inert = true;
		this.rootEl.addClass("is-busy");
		try {
			// Waits for an autosave in flight, then holds off others until the new file is open.
			await new Promise((r) => setTimeout(r, 80));
			while (this.saving) await this.saving;
			const handle = this.handle;
			if (!handle || file !== this.file) return false;
			let result: { bytes: ArrayBuffer; position: ReadingPosition; zoom: unknown } | null = null;
			const work = (this.saving = (async () => {
				try {
					// Nothing unsaved: the file on disk is the document, and reading it is quicker than exporting.
					const [engine, current] = await Promise.all([this.plugin.getEngine(), this.dirty ? handle.save() : this.app.vault.readBinary(file)]);
					const bytes = await editPdfPages(engine, current, edit);
					if (handle !== this.handle || file !== this.file) return false;
					this.ignoreModifyUntil = Date.now() + 2000;
					await this.app.vault.modifyBinary(file, bytes);
					this.ignoreModifyUntil = Date.now() + 1000;
					this.dirty = false;
					const page = edit.kind === "insert" ? edit.at + 1 : Math.min(edit.index + 1, handle.tools.state().pages - 1);
					result = { bytes, position: { page, y: 0 }, zoom: handle.zoomLevel() };
					return true;
				} catch (e: any) {
					console.error("[pdf-ink] page edit failed", e);
					new Notice(`PDF Ink couldn't ${edit.kind === "insert" ? "add the page" : "delete the page"}: ${e?.message ?? e}`);
					return false;
				}
			})());
			try {
				await work;
			} finally {
				if (this.saving === work) this.saving = null;
			}
			if (!result) return false;
			const done: { bytes: ArrayBuffer; position: ReadingPosition; zoom: unknown } = result;
			await this.loadPdf(file, done);
			new Notice(`${edit.kind === "insert" ? `Added a blank page ${done.position.page}` : `Deleted page ${edit.index + 1}`}. Undo starts afresh; links to later pages are now one page off.`, 6000);
			return true;
		} finally {
			this.editingPages = false;
			this.rootEl.inert = false;
			this.rootEl.removeClass("is-busy");
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
		this.changes++;
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
			// A change made while the PDF is exported may be missing from these bytes: it stays dirty.
			const changesBefore = this.changes;
			try {
				const bytes = await handle.save();
				if (handle !== this.handle || file !== this.file) {
					console.warn("[pdf-ink] file changed while saving; nothing written");
					return false;
				}
				if (this.changes === changesBefore) this.dirty = false;
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
		if (!closing && this.dirty && this.plugin.settings.autosave) this.requestAutosave();
		// Closing: write what changed during this save as well.
		else if (closing && ok && this.dirty) return this.saveNow(false, true);
		return ok;
	}
}
