/**
 * Stamp (image) rendering.
 *
 * EmbedPDF draws a stamp by asking the engine to render its appearance, but it asks as soon as the
 * annotation appears in the layer, before the create has been committed to PDFium, so the request fails
 * ("annotation not found") and the stamp stays an empty box until the page is reopened. This renderer
 * shows the picture's own bytes at once when they are known (a picked image), and otherwise asks
 * the engine only once the annotation has been committed, asking again after each change of its size.
 */
import { useEffect, useState } from "preact/hooks";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { createRenderer, useAnnotationCapability } from "@embedpdf/plugin-annotation/preact";

/** The image bytes of stamps made in this session, by annotation id. */
const sources = new Map<string, Blob>();

export function rememberStampSource(id: string, data: unknown) {
	if (data instanceof Blob) sources.set(id, data);
	else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) sources.set(id, new Blob([data as BlobPart]));
}

export function forgetStampSource(id: string) {
	sources.delete(id);
}

function StampImage({ annotation, documentId, pageIndex, scale, isSelected, onClick }: any) {
	const o = annotation.object;
	const { provides } = useAnnotationCapability();
	const [url, setUrl] = useState<string | null>(null);
	const own = o.rotation ? undefined : sources.get(o.id);
	const committed = annotation.commitState !== "new";
	const { width, height } = o.rect.size;
	useEffect(() => {
		if (own) {
			const u = URL.createObjectURL(own);
			setUrl(u);
			return () => URL.revokeObjectURL(u);
		}
		if (!provides || !committed) return;
		let u: string | null = null;
		const task = provides.forDocument(documentId).renderAnnotation({ pageIndex, annotation: o, options: { scaleFactor: scale, dpr: window.devicePixelRatio || 1 } });
		task.wait(
			(blob: Blob) => setUrl((u = URL.createObjectURL(blob))),
			() => {}
		);
		return () => {
			if (u) URL.revokeObjectURL(u);
			else task.abort?.({ code: 0, message: "unmounted" });
		};
	}, [own, provides, committed, documentId, pageIndex, o.id, scale, width, height]);
	return (
		<div style={{ position: "absolute", width: "100%", height: "100%", zIndex: 2, pointerEvents: !onClick || isSelected ? "none" : "auto", cursor: onClick ? "pointer" : "default" }} onPointerDown={onClick}>
			{url && <img src={url} draggable={false} style={{ width: "100%", height: "100%", display: "block", objectFit: "fill" }} />}
		</div>
	);
}

export const stampRenderer = createRenderer<any>({
	id: "pdf-ink-stamp",
	matches: (a) => a.type === PdfAnnotationSubtype.STAMP,
	render: (props) => <StampImage {...props} />,
});
