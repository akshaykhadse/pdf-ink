# PDF Ink

An [Obsidian](https://obsidian.md) plugin for writing on PDFs with a stylus. Pen, highlighter and eraser; the strokes are saved as standard ink annotations inside the PDF file, so any other PDF reader shows them too.

Built on [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) (Apache-2.0), which renders pages with PDFium compiled to WebAssembly and provides the annotation tools. The plugin adds its own toolbar, stylus handling and the vault integration.

## Features

- Pen in your own colours and widths (both editable in settings), freehand highlighter, text highlighter (select text to mark it), eraser, undo and redo. Strokes are smoothed through the pen's samples (can be switched off).
- Stylus mode (toolbar button): fingers scroll and pinch to zoom while a pen tool is active; only the stylus draws. Switch it off to draw with fingers.
- The pen's side button (S Pen, Surface Pen) arms the eraser for the next stroke.
- Autosave into the PDF a few seconds after the last stroke, or save with Ctrl/Cmd+S.
- Works on desktop and on Android and iOS tablets. No network access: fonts, the PDF engine and the viewer all ship in the plugin folder.

## Install (manual)

Copy `main.js`, `styles.css`, `manifest.json` and `pdfium.wasm` from a release into `<vault>/.obsidian/plugins/pdf-ink/`, then enable the plugin in **Settings → Community plugins**.

Open a PDF through its file menu ("Open in PDF Ink"), the command palette, or turn on **Open PDFs with PDF Ink** in the plugin's settings.

## Build

```sh
npm install
npm run build   # main.js, styles.css, pdfium.wasm
npm test        # headless Chromium checks (needs Playwright's Chromium)
```

## License

MIT. EmbedPDF and PDFium are included under their own licences (Apache-2.0 and BSD-3-Clause).
