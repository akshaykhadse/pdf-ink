/**
 * Keeps EmbedPDF from redrawing every annotation on a page for each change (not native).
 *
 * EmbedPDF's annotation layer re-renders one container per annotation on the
 * page whenever the page's annotation state changes, and each re-render runs
 * the container's hooks again (handlers, drag listeners). A stroke changes
 * that state twice when it is saved (created, then synced with PDFium), so on
 * a page with a hundred strokes every pen lift costs two hundred container
 * renders, and the next stroke's pen-down waits behind them.
 *
 * The container is not exported, so it is recognised by its props when its
 * element is created and swapped for a wrapper that skips a render when no
 * data prop changed. Callback props are new closures on every render and are
 * ignored; the selected or edited annotation always renders, so its menu and
 * handles never use stale callbacks.
 */
import { Component, h, options, type ComponentType, type VNode } from "preact";

/** Props that change identity on every render and carry no data. */
const CALLBACKS = new Set(["onSelect", "onDoubleClick", "children", "selectionMenu", "groupSelectionMenu"]);

const wrappers = new WeakMap<ComponentType<any>, ComponentType<any>>();
let installed = false;
let enabled = true;
/** Set while a wrapper creates the real container's element, so it is not wrapped again. */
let bypass = false;

function isContainer(type: unknown, props: any): boolean {
	return typeof type === "function" && props != null && props.trackedAnnotation !== undefined && typeof props.onSelect === "function" && "isMultiSelected" in props && typeof props.children === "function";
}

function wrap(inner: ComponentType<any>): ComponentType<any> {
	let w = wrappers.get(inner);
	if (w) return w;
	class MemoAnnotation extends Component<any> {
		shouldComponentUpdate(next: any) {
			const prev = this.props;
			if (!enabled || prev.isSelected || next.isSelected || prev.isEditing || next.isEditing) return true;
			for (const k in next) {
				if (CALLBACKS.has(k) || typeof next[k] === "function") continue;
				if (next[k] !== prev[k]) return true;
			}
			for (const k in prev) if (!(k in next)) return true;
			return false;
		}
		render(props: any) {
			bypass = true;
			try {
				return h(inner as any, props);
			} finally {
				bypass = false;
			}
		}
	}
	w = MemoAnnotation as ComponentType<any>;
	wrappers.set(inner, w);
	return w;
}

/** Installs the vnode hook once; `on` turns the skipping on or off (for measuring). */
export function installAnnotationMemo(on = true): void {
	enabled = on;
	if (installed) return;
	installed = true;
	const prev = options.vnode;
	options.vnode = (vnode: VNode<any>) => {
		const t = vnode.type as any;
		if (!bypass && typeof t === "function" && t.__pdfInkMemo !== true && isContainer(t, vnode.props)) {
			const w = wrap(t) as any;
			w.__pdfInkMemo = true;
			(vnode as any).type = w;
		}
		if (prev) prev(vnode);
	};
}
