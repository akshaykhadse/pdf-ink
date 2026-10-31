# PDF Ink

An Obsidian plugin for annotating PDFs with a stylus, built on the
[EmbedPDF](https://www.embedpdf.com) headless engine (PDFium) with its own UI.

## Tools

One tool is active at a time, picked on the floating toolbar:

| Tool | What it does | EmbedPDF |
| --- | --- | --- |
| Hand | Drag to pan; one finger scrolls, two fingers pinch to zoom | native pan mode |
| Pointer | Select text (link / highlight / copy menu); tap an annotation to select it; drag a box to select several | native pointer mode and marquee |
| Pen | Freehand ink with colour, width and opacity | native `ink` tool |
| Highlighter | Translucent freehand marker | native `inkHighlighter` tool |
| Text highlighter | Select text to highlight it | native `highlight` tool |
| Eraser | Remove the strokes and highlights the pointer crosses; pressing the pen's side button while hovering switches to the eraser, pressing it again returns to the previous tool | plugin addition |
| Area link | Drag a box; copy it as a link or embed | native capture marquee, link formatting is a plugin addition |

**Stylus mode** (toolbar button, off by default): fingers pan and scroll while
only the pen draws. Off: a finger draws too, unless the hand or pointer tool is
active.

The toolbar is the pane's only bar: Obsidian's view header (back/forward
arrows and the pane menu) is hidden for PDF Ink panes.

**Full screen**: the PDF pane covers the Obsidian window, with only the
toolbar left. `Esc` or the button leaves.

**Last position**: the plugin remembers where you were in each PDF (page and
offset, saved in its data file, moved on rename) and goes back there when the
file is opened again. EmbedPDF itself does not keep this.

## Links

Text selections and areas become PDF++-style links such as
`[[paper.pdf#page=3&rect=72,500,300,560|the selected text]]`. The `page` and
`rect` parameters are what PDF++ and Obsidian's built-in viewer understand,
so the links open there too. Formats are templates in the settings with
`{{file}}`, `{{path}}`, `{{page}}`, `{{rect}}`, `{{text}}` and `{{color}}`.

Links from notes to a page area are drawn as boxes on the page; clicking one
opens the note at the link. Following a link into the PDF scrolls to the page
and flashes the area.

A **sidecar note** (`Open sidecar note`) opens beside the PDF; copied links
can go to the clipboard, the sidecar note, or both.

Note: rect coordinates assume the page box starts at the origin; on PDFs
with an offset CropBox the position can differ from PDF++ by that offset.
PDF++'s `selection=` parameter encodes pdf.js text-layer offsets, which
cannot be produced from PDFium's text geometry. PDF Ink writes `rect` links
for text selections instead, and shows backlinks only for links that carry a
`rect`.

## Not native to EmbedPDF

These are plugin additions on top of EmbedPDF: stylus mode and finger
scrolling while a drawing tool is active, the eraser, the pen's side button,
stroke smoothing, feeding the pen's full sample rate to strokes, grouped undo
for multi-deletes, link formatting, backlinks, the sidecar note and the
full-screen mode.

## Install

Copy `main.js`, `styles.css`, `manifest.json` and `pdfium.wasm` from a
release into `<vault>/.obsidian/plugins/pdf-ink/` and enable the plugin.
Turn on *Open PDFs with PDF Ink* in the settings to make it the default PDF
viewer, or use *Open in PDF Ink* from a PDF's file menu.

## Build

```
npm install
npm run build   # main.js, styles.css, pdfium.wasm
npm test        # unit checks and headless-Chromium end-to-end checks
```
