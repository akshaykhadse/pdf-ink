// An Obsidian (Lucide) icon as a Preact element. `name` may list fallbacks
// separated by "|" for icons that older Obsidian versions do not ship.
import { setIcon } from "obsidian";
import { useLayoutEffect, useRef } from "preact/hooks";

export function Icon({ name }: { name: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		for (const candidate of name.split("|")) {
			setIcon(el, candidate);
			if (el.querySelector("svg")) return;
		}
	}, [name]);
	return <span class="pdf-ink-icon" ref={ref} />;
}
