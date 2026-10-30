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
	}
}

let enginePromise: Promise<any> | null = null;

window.run = async (pdfUrl = "/sample.pdf") => {
	const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
	window.currentBytes = bytes;
	const saved: Uint8Array[] = (window.saved = []);
	const file = Object.assign(new TFile(), { name: "sample.pdf", basename: "sample", path: "sample.pdf", extension: "pdf" });
	const handlers: Record<string, any> = (window.handlers = {});
	const app = {
		workspace: { on: (name: string, cb: any) => ((handlers["workspace:" + name] = cb), {}) },
		scope: {},
		vault: {
			on: (name: string, cb: any) => ((handlers["vault:" + name] = cb), {}),
			readBinary: async () => window.currentBytes!.slice().buffer,
			modifyBinary: async (_f: any, buf: ArrayBuffer) => {
				saved.push(new Uint8Array(buf));
				window.currentBytes = new Uint8Array(buf);
			},
		},
	};
	window.settings ??= normalizeSettings({ ...DEFAULT_SETTINGS, autosave: false });
	enginePromise ??= (async () => {
		const wasm = await (await fetch("/pdfium.wasm")).arrayBuffer();
		const url = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
		return createPdfiumEngine(url, { fontFallback: null });
	})();
	const plugin = { settings: window.settings, saveSettings: async () => {}, getEngine: () => enginePromise };
	const leaf: any = { app };
	const view = new PdfInkView(leaf, plugin as any);
	(view as any).file = file;
	await (view as any).open(document.getElementById("content"));
	await view.onLoadFile(file as any);
	window.view = view;
	window.file = file;
	return "ok";
};
