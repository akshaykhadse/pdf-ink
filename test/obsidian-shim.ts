// Just enough of the Obsidian API for the browser harness.
const P: any = typeof HTMLElement === "undefined" ? {} : HTMLElement.prototype;
P.createEl = function (tag: string, o?: any) {
	const el = document.createElement(tag);
	if (o?.cls) el.className = o.cls;
	if (o?.text) el.textContent = o.text;
	if (o?.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
	this.appendChild(el);
	return el;
};
P.createDiv = function (o?: any) {
	return this.createEl("div", o);
};
P.createSpan = function (o?: any) {
	return this.createEl("span", o);
};
P.empty = function () {
	this.replaceChildren();
};
P.addClass = function (...c: string[]) {
	this.classList.add(...c);
};
P.removeClass = function (...c: string[]) {
	this.classList.remove(...c);
};
P.toggleClass = function (c: string, on: boolean) {
	this.classList.toggle(c, on);
};
P.setText = function (t: string) {
	this.textContent = t;
};

export class Notice {
	constructor(message: string) {
		console.log("NOTICE:", message);
		((window as any).notices ??= []).push(message);
	}
}
export class Scope {
	constructor(_parent?: any) {}
	register() {}
}
export class TFile {
	name = "";
	basename = "";
	path = "";
	extension = "";
}
export class Plugin {}
export class Modal {
	constructor(_app: any) {}
}
export class PluginSettingTab {
	constructor(_app: any, _plugin: any) {}
}
export class Setting {
	constructor(_el: HTMLElement) {}
}
export class Menu {}
export class WorkspaceLeaf {}
export class FileView {
	app: any;
	leaf: any;
	file: TFile | null = null;
	scope: any;
	contentEl: HTMLElement;
	containerEl: HTMLElement;
	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf.app;
		this.contentEl = document.getElementById("content")!;
		this.containerEl = document.getElementById("leaf")!;
	}
	setEphemeralState(_s: any) {}
	registerEvent() {}
	// Obsidian's View owns open()/close() and calls onOpen()/onClose() from them;
	// a plugin view must not define methods with these names.
	async open(_parentEl: HTMLElement) {
		await this.onOpen();
	}
	async close() {
		await this.onClose();
	}
	async onOpen() {}
	async onClose() {}
}
export function setIcon(el: HTMLElement, icon: string) {
	el.dataset.icon = icon;
	el.innerHTML = '<svg class="svg-icon" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
}
export function setTooltip() {}
export function normalizePath(p: string) {
	return p;
}
export function debounce(fn: any, ms: number) {
	let t: any;
	const d: any = () => {
		clearTimeout(t);
		t = setTimeout(fn, ms);
	};
	d.cancel = () => clearTimeout(t);
	return d;
}
export class TFolder {
	path = "";
}
export class MarkdownView {
	file: TFile | null = null;
	editor: any = null;
}
export class Notice2 {}
