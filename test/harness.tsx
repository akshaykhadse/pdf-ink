// Browser harness: a PdfInkView with a mocked app and vault, driven by test/viewer.cjs.
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";
import { TFile } from "obsidian";
import { PdfInkView } from "../src/view";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

declare global {
	interface Window {
		run: (pdfUrl?: string) => Promise<string>;
		view: PdfInkView;
		saved: Uint8Array[];
		file: TFile;
		handlers: Record<string, any>;
		currentBytes?: Uint8Array;
		settings: any;
		positions: any;
		clipboard: string[];
		notes: Record<string, string>;
		links: any[];
		opened: any[];
	}
}

let enginePromise: Promise<any> | null = null;

window.run = async (pdfUrl = "/sample.pdf") => {
	const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
	window.currentBytes = bytes;
	const saved: Uint8Array[] = (window.saved = []);
	const file = Object.assign(new TFile(), { name: "sample.pdf", basename: "sample", path: "docs/sample.pdf", extension: "pdf", parent: { path: "docs" } });
	const handlers: Record<string, any> = (window.handlers = {});
	window.clipboard = [];
	window.notes ??= {};
	window.links ??= [];
	window.opened = [];
	(navigator as any).clipboard = { writeText: async (t: string) => void window.clipboard.push(t) };
	const files: Record<string, any> = {};
	const app = {
		workspace: {
			on: (name: string, cb: any) => ((handlers["workspace:" + name] = cb), {}),
			getLeavesOfType: () => [],
			getLeaf: () => ({ openFile: async (f: any, o: any) => void window.opened.push([f.path, o]) }),
			createLeafBySplit: () => ({ openFile: async (f: any) => void window.opened.push(["split", f.path]) }),
			revealLeaf: () => {},
			setActiveLeaf: () => {},
		},
		scope: {},
		metadataCache: {
			on: (name: string, cb: any) => ((handlers["meta:" + name] = cb), {}),
			fileToLinktext: (f: TFile) => f.basename + "." + f.extension,
			resolvedLinks: {} as Record<string, Record<string, number>>,
			getFileCache: (f: any) => ({ links: window.links.filter((l) => l.source === f.path), embeds: [] }),
			getFirstLinkpathDest: (link: string) => (link === "sample.pdf" || link === "docs/sample.pdf" ? file : null),
		},
		vault: {
			on: (name: string, cb: any) => ((handlers["vault:" + name] = cb), {}),
			readBinary: async () => window.currentBytes!.slice().buffer,
			modifyBinary: async (_f: any, buf: ArrayBuffer) => {
				saved.push(new Uint8Array(buf));
				window.currentBytes = new Uint8Array(buf);
			},
			getAbstractFileByPath: (p: string) => files[p] ?? (window.links.some((l) => l.source === p) ? Object.assign(new TFile(), { path: p, name: p.split("/").pop(), basename: p.split("/").pop()!.replace(/\.md$/, ""), extension: "md" }) : null),
			create: async (p: string, data: string) => {
				window.notes[p] = data;
				return (files[p] = Object.assign(new TFile(), { path: p, name: p.split("/").pop(), basename: p.split("/").pop()!.replace(/\.md$/, ""), extension: "md" }));
			},
			createFolder: async () => {},
			process: async (f: any, fn: (d: string) => string) => (window.notes[f.path] = fn(window.notes[f.path] ?? "")),
		},
	};
	for (const l of window.links) ((app.metadataCache.resolvedLinks[l.source] ??= {})[file.path] = 1);
	window.settings ??= normalizeSettings({ ...DEFAULT_SETTINGS, autosave: false });
	enginePromise ??= (async () => {
		const wasm = await (await fetch("/pdfium.wasm")).arrayBuffer();
		const url = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
		return createPdfiumEngine(url, { fontFallback: null });
	})();
	window.positions ??= {};
	const plugin = { settings: window.settings, saveSettings: async () => {}, getEngine: () => enginePromise, positionFor: (p: string) => window.positions[p] ?? null, rememberPosition: (p: string, pos: any) => (window.positions[p] = pos) };
	const leaf: any = { app };
	const view = new PdfInkView(leaf, plugin as any);
	(view as any).file = file;
	await (view as any).open(document.getElementById("content"));
	await view.onLoadFile(file as any);
	window.view = view;
	window.file = file;
	return "ok";
};
