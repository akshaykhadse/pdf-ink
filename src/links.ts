/**
 * PDF++-style links. A text selection or an area becomes
 * `[[file.pdf#page=N&rect=left,bottom,right,top|text]]`: `page` and `rect` are
 * the parameters PDF++ and Obsidian's own viewer understand, with the rect in
 * PDF user space (origin bottom-left, PDF points). PDF++'s `selection=` offsets
 * come from pdf.js's text layer and cannot be produced from PDFium's glyph
 * geometry, so text links carry the selection's bounding rect instead.
 */
import { App, MarkdownView, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { Settings } from "./settings";

/** A rectangle in EmbedPDF's page space: PDF points from the page's top-left corner. */
export interface PageRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LinkVars {
	/** Link text for the PDF (what goes inside [[ ]]). */
	file: string;
	/** Vault path of the PDF. */
	path: string;
	/** 1-based page number. */
	page: number;
	/** "left,bottom,right,top" in PDF user space. */
	rect: string;
	text: string;
	color: string;
}

const r1 = (n: number) => String(Math.round(n * 10) / 10);

/** EmbedPDF page rect → PDF++ `rect=` value (PDF user space, y up). */
export function rectParam(rect: PageRect, pageHeight: number): string {
	return [rect.x, pageHeight - (rect.y + rect.height), rect.x + rect.width, pageHeight - rect.y].map(r1).join(",");
}

/** PDF++ `rect=` value → EmbedPDF page rect. */
export function rectFromParam(value: string, pageHeight: number): PageRect | null {
	const n = value.split(",").map(Number);
	if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
	const [l, b, r, t] = n;
	const left = Math.min(l, r), right = Math.max(l, r), bottom = Math.min(b, t), top = Math.max(b, t);
	return { x: left, y: pageHeight - top, width: right - left, height: top - bottom };
}

export function union(rects: PageRect[]): PageRect | null {
	if (!rects.length) return null;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const r of rects) {
		x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function fillTemplate(template: string, vars: LinkVars): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => {
		const v = (vars as any)[key];
		return v === undefined || v === null ? m : String(v);
	});
}

/** Text as it goes into a wiki link's display part: one line, no pipes or brackets. */
export function linkText(text: string): string {
	return text.replace(/\s+/g, " ").replace(/[|[\]]/g, " ").trim();
}

export interface Subpath {
	page: number | null;
	/** `rect=` as written (PDF user space). */
	rect: string | null;
	selection: string | null;
}

/** Parses "#page=3&rect=1,2,3,4" (the leading # is optional). */
export function parseSubpath(subpath: string | null | undefined): Subpath {
	const out: Subpath = { page: null, rect: null, selection: null };
	if (!subpath) return out;
	const s = subpath.startsWith("#") ? subpath.slice(1) : subpath;
	for (const part of s.split("&")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const key = part.slice(0, i).trim().toLowerCase();
		const value = decodeURIComponent(part.slice(i + 1).trim());
		if (key === "page") {
			const n = parseInt(value, 10);
			if (Number.isFinite(n) && n >= 1) out.page = n;
		} else if (key === "rect") out.rect = value;
		else if (key === "selection") out.selection = value;
	}
	return out;
}

// ----------------------------------------------------------------- backlinks

export interface Backlink {
	sourcePath: string;
	/** 0-based line of the link in the note. */
	line: number;
	page: number;
	rect: string | null;
	display: string;
}

/** Links from notes to this PDF that name a page (with a rect where there is one). */
export function collectBacklinks(app: App, pdf: TFile): Backlink[] {
	const out: Backlink[] = [];
	const resolved = app.metadataCache.resolvedLinks;
	for (const sourcePath of Object.keys(resolved)) {
		if (!resolved[sourcePath]?.[pdf.path]) continue;
		const source = app.vault.getAbstractFileByPath(sourcePath);
		if (!(source instanceof TFile)) continue;
		const cache = app.metadataCache.getFileCache(source);
		for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
			const hash = ref.link.indexOf("#");
			if (hash < 0) continue;
			const target = app.metadataCache.getFirstLinkpathDest(ref.link.slice(0, hash), sourcePath);
			if (target?.path !== pdf.path) continue;
			const sub = parseSubpath(ref.link.slice(hash));
			if (!sub.page) continue;
			out.push({ sourcePath, line: ref.position.start.line, page: sub.page, rect: sub.rect, display: ref.displayText ?? "" });
		}
	}
	return out;
}

// ------------------------------------------------------------------- sidecar

export function sidecarPath(settings: Settings, pdf: TFile): string {
	const folder = settings.sidecarFolder || pdf.parent?.path || "";
	const name = `${pdf.basename}${settings.sidecarSuffix}.md`;
	return normalizePath(folder && folder !== "/" ? `${folder}/${name}` : name);
}

async function ensureFolder(app: App, path: string) {
	const parts = path.split("/").slice(0, -1);
	let cur = "";
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!(app.vault.getAbstractFileByPath(cur) instanceof TFolder)) await app.vault.createFolder(cur).catch(() => {});
	}
}

/** The sidecar note for a PDF, created if missing. */
export async function ensureSidecar(app: App, settings: Settings, pdf: TFile): Promise<TFile> {
	const path = sidecarPath(settings, pdf);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) return existing;
	await ensureFolder(app, path);
	const link = app.metadataCache.fileToLinktext(pdf, path);
	try {
		return await app.vault.create(path, `# ${pdf.basename}\n\nNotes on [[${link}]].\n\n`);
	} catch (e) {
		// Two quick links can race to create it; the first one wins.
		const again = app.vault.getAbstractFileByPath(path);
		if (again instanceof TFile) return again;
		throw e;
	}
}

/** Opens the sidecar beside the PDF's leaf (reuses it if it is already open). */
export async function openSidecar(app: App, settings: Settings, pdf: TFile, besideLeaf: any): Promise<void> {
	const note = await ensureSidecar(app, settings, pdf);
	const open = app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === note.path);
	if (open) {
		app.workspace.revealLeaf(open);
		return;
	}
	const leaf = app.workspace.createLeafBySplit(besideLeaf, "vertical");
	await leaf.openFile(note, { active: false });
}

/** Inserts text into the sidecar: at the cursor if the note is open in an editor, else at the end. */
export async function insertIntoSidecar(app: App, settings: Settings, pdf: TFile, text: string): Promise<void> {
	const note = await ensureSidecar(app, settings, pdf);
	const view = app.workspace.getLeavesOfType("markdown").map((l) => l.view as MarkdownView).find((v) => v.file?.path === note.path);
	if (view?.editor) {
		const editor = view.editor;
		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		const prefix = cursor.ch > 0 && !/\s$/.test(lineText.slice(0, cursor.ch)) ? " " : "";
		editor.replaceRange(prefix + text + "\n", cursor);
		editor.setCursor({ line: cursor.line + 1 + (text.match(/\n/g)?.length ?? 0), ch: 0 });
		return;
	}
	await app.vault.process(note, (data) => (data.endsWith("\n") || data.length === 0 ? data : data + "\n") + text + "\n");
}

/** Sends a formatted link where the settings say: clipboard, sidecar note, or both. */
export async function deliverLink(app: App, settings: Settings, pdf: TFile, text: string): Promise<void> {
	const target = settings.linkTarget;
	if (target === "clipboard" || target === "both") {
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			console.warn("[pdf-ink] clipboard", e);
		}
	}
	if (target === "sidecar" || target === "both") await insertIntoSidecar(app, settings, pdf, text);
	new Notice(target === "clipboard" ? "Link copied" : target === "sidecar" ? "Link added to the sidecar note" : "Link copied and added to the sidecar note", 1500);
}

/** Opens the note a backlink came from, at its line. */
export async function openBacklink(app: App, link: Backlink, pdfPath: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(link.sourcePath);
	if (!(file instanceof TFile)) return;
	const open = app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === file.path);
	const leaf = open ?? app.workspace.getLeaf("tab");
	await leaf.openFile(file, { eState: { line: link.line } });
	app.workspace.revealLeaf(leaf);
	void pdfPath;
}
