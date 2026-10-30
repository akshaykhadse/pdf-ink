// Builds main.js (the plugin), styles.css and pdfium.wasm into the repo root;
// `node scripts/build.mjs test` also builds the browser test harness.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const mode = process.argv[2] ?? "development";
const prod = mode === "production";

const common = {
	bundle: true,
	format: "cjs",
	target: "es2022",
	platform: "browser",
	jsx: "automatic",
	jsxImportSource: "preact",
	logLevel: "info",
	treeShaking: true,
	// EmbedPDF's worker engine inlines its worker; the wasm comes from the plugin folder.
	define: { "import.meta.url": "undefined" },
};

await esbuild.build({
	...common,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	sourcemap: prod ? false : "inline",
	minify: prod,
	outfile: "main.js",
});

copyFileSync("src/styles.css", "styles.css");
copyFileSync("node_modules/@embedpdf/pdfium/dist/pdfium.wasm", "pdfium.wasm");
console.log("styles.css and pdfium.wasm written");

if (mode === "test") {
	mkdirSync("test/out", { recursive: true });
	await esbuild.build({
		...common,
		entryPoints: ["test/harness.tsx"],
		alias: { obsidian: "./test/obsidian-shim.ts" },
		sourcemap: "inline",
		outfile: "test/out/harness.js",
	});
}
