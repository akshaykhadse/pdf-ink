// Builds main.js, styles.css and pdfium.wasm into the repo root.
// `node scripts/build.mjs production` minifies; `node scripts/build.mjs test`
// also builds the browser test harness into test/out/.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

/**
 * Small source patches to EmbedPDF, applied while bundling (not native; each
 * one removes work that grows with the number of annotations in the PDF).
 * The build fails if a pattern is missing, so an EmbedPDF update cannot
 * silently drop a patch.
 */
const PATCHES = [
	{
		file: /@embedpdf[\\/]plugin-annotation[\\/]dist[\\/]index\.js$/,
		why: "the state emitter deep-compares the whole annotation state (every annotation in the PDF) on each change; it only emits when the state object changed, so identity is enough",
		find: "this.state$ = createScopedEmitter((documentId, state) => ({ documentId, state }));",
		replace: "this.state$ = createScopedEmitter((documentId, state) => ({ documentId, state }), { equality: (a, b) => a === b });",
	},
	{
		file: /@embedpdf[\\/]plugin-annotation[\\/]dist[\\/]index\.js$/,
		why: "committing a stroke rebuilt the whole annotation map entry by entry; copy it once and replace only the committed entries",
		find: "      const committedSet = new Set(committedUids);\n      const cleaned = {};\n      let stillHasPending = false;\n      for (const [uid, ta] of Object.entries(docState.byUid)) {\n        if (committedSet.has(uid)) {\n          cleaned[uid] = {\n            ...ta,\n            commitState: ta.commitState === \"dirty\" || ta.commitState === \"new\" || ta.commitState === \"moved\" ? \"synced\" : ta.commitState\n          };\n        } else {\n          cleaned[uid] = ta;\n          if (ta.commitState === \"new\" || ta.commitState === \"dirty\" || ta.commitState === \"moved\" || ta.commitState === \"deleted\") {\n            stillHasPending = true;\n          }\n        }\n      }",
		replace: "      const committedSet = new Set(committedUids);\n      const cleaned = { ...docState.byUid };\n      for (const uid of committedSet) {\n        const ta = cleaned[uid];\n        if (!ta) continue;\n        cleaned[uid] = {\n          ...ta,\n          commitState: ta.commitState === \"dirty\" || ta.commitState === \"new\" || ta.commitState === \"moved\" ? \"synced\" : ta.commitState\n        };\n      }\n      let stillHasPending = false;\n      for (const uid in cleaned) {\n        if (committedSet.has(uid)) continue;\n        const cs = cleaned[uid].commitState;\n        if (cs === \"new\" || cs === \"dirty\" || cs === \"moved\" || cs === \"deleted\") {\n          stillHasPending = true;\n          break;\n        }\n      }",
	},
	{
		file: /@embedpdf[\\/]plugin-annotation[\\/]dist[\\/]index\.js$/,
		why: "the commit scan allocated an [id, annotation] pair for every annotation in the PDF; iterate the keys instead",
		find: "for (const [uid, ta] of Object.entries(docState.byUid)) {",
		replace: "for (const uid in docState.byUid) { const ta = docState.byUid[uid];",
	},
];

const embedPdfPatches = {
	name: "embedpdf-patches",
	setup(build) {
		build.onLoad({ filter: /@embedpdf[\\/].*\.js$/ }, (args) => {
			const mine = PATCHES.filter((p) => p.file.test(args.path));
			if (!mine.length) return undefined;
			let code = readFileSync(args.path, "utf8");
			for (const p of mine) {
				if (!code.includes(p.find)) throw new Error(`EmbedPDF patch no longer applies (${p.why}): ${args.path}`);
				code = code.split(p.find).join(p.replace);
				p.applied = true;
			}
			return { contents: code, loader: "js" };
		});
		build.onEnd(() => {
			const missed = PATCHES.filter((p) => !p.applied);
			if (missed.length) throw new Error(`EmbedPDF patches not applied: ${missed.map((p) => p.find).join(" | ")}`);
		});
	},
};

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
	plugins: [embedPdfPatches],
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
	await esbuild.build({ ...common, entryPoints: ["test/units.ts"], alias: { obsidian: "./test/obsidian-shim.ts" }, outfile: "test/out/units.cjs" });
	await esbuild.build({
		...common,
		entryPoints: ["test/harness.tsx"],
		alias: { obsidian: "./test/obsidian-shim.ts" },
		sourcemap: "inline",
		outfile: "test/out/harness.js",
	});
}
