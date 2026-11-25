/**
 * Adding and deleting pages. EmbedPDF 2.15 has the PDFium calls (importPages,
 * deletePage) but no viewer support for a page list that changes, and no call
 * that makes a blank page. So the edit runs on a separate copy of the PDF in
 * the engine, never on the open document, and the view then reopens the
 * result. Nothing here runs unless a page is added or deleted.
 */
import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { settle } from "./viewer";

export type PageEdit =
	/** A blank page of the given size (PDF points) becomes page index `at`. */
	| { kind: "insert"; at: number; width: number; height: number }
	/** Page index `index` is removed with everything on it. */
	| { kind: "delete"; index: number };

/** A one-page PDF with an empty page of the given size, written by hand. */
export function blankPagePdf(width: number, height: number): Uint8Array {
	const n = (v: number) => (Math.round(v * 100) / 100).toString();
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(width)} ${n(height)}] /Resources << >> /Contents 4 0 R >>`,
		"<< /Length 0 >>\nstream\n\nendstream",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

let seq = 0;

/** Applies one page edit to a copy of `bytes` and returns the new PDF. */
export async function editPdfPages(engine: PdfEngine, bytes: ArrayBuffer, edit: PageEdit): Promise<ArrayBuffer> {
	const opened: PdfDocumentObject[] = [];
	const open = async (content: ArrayBuffer) => {
		const doc = await settle<PdfDocumentObject>(engine.openDocumentBuffer({ id: `pdf-ink-pages-${Date.now()}-${++seq}`, content }) as any);
		opened.push(doc);
		return doc;
	};
	try {
		const doc = await open(bytes);
		if (edit.kind === "delete") {
			if (doc.pageCount <= 1) throw new Error("a PDF needs at least one page");
			if (edit.index < 0 || edit.index >= doc.pageCount) throw new Error(`there is no page ${edit.index + 1}`);
			await settle(engine.deletePage(doc, edit.index) as any);
		} else {
			const blank = await open(blankPagePdf(edit.width, edit.height).buffer as ArrayBuffer);
			await settle(engine.importPages(doc, blank, [0], Math.max(0, Math.min(doc.pageCount, edit.at))) as any);
		}
		return await settle<ArrayBuffer>(engine.saveAsCopy(doc) as any);
	} finally {
		for (const doc of opened) await settle(engine.closeDocument(doc) as any).catch(() => {});
	}
}
