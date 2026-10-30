// Pure-function checks, run with node after bundling (test/out/units.cjs).
import { smoothStroke } from "../src/ink";
import { fillTemplate, linkText, parseSubpath, rectFromParam, rectParam, union } from "../src/links";
import { normalizeSettings, parseColors, parseNumbers } from "../src/settings";
import { annotationHit } from "../src/guard";
import { dotSize } from "../src/toolbar";

let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ": " + JSON.stringify(detail) : ""}`);
	if (!ok) failed = true;
};

// links
const r = rectParam({ x: 10, y: 20, width: 100, height: 50 }, 842);
check("rectParam flips y into PDF space as left,bottom,right,top", r === "10,772,110,822", r);
const back = rectFromParam(r, 842);
check("rectFromParam round-trips", !!back && back.x === 10 && back.y === 20 && back.width === 100 && back.height === 50, back);
check("rectFromParam accepts swapped corners", JSON.stringify(rectFromParam("110,822,10,772", 842)) === JSON.stringify(back));
check("rectFromParam rejects garbage", rectFromParam("1,2,x,4", 842) === null && rectFromParam("1,2,3", 842) === null);
check("parseSubpath reads page and rect", JSON.stringify(parseSubpath("#page=3&rect=1,2,3,4")) === JSON.stringify({ page: 3, rect: "1,2,3,4", selection: null }));
check("parseSubpath tolerates no hash and selection", JSON.stringify(parseSubpath("page=2&selection=1,0,2,5")) === JSON.stringify({ page: 2, rect: null, selection: "1,0,2,5" }));
check("parseSubpath ignores a bad page", parseSubpath("#page=abc").page === null && parseSubpath(null).page === null);
check("fillTemplate substitutes and keeps unknowns", fillTemplate("[[{{file}}#page={{page}}&rect={{rect}}|{{text}}]] {{nope}}", { file: "a.pdf", path: "x/a.pdf", page: 2, rect: "1,2,3,4", text: "hi", color: "ff0000" }) === "[[a.pdf#page=2&rect=1,2,3,4|hi]] {{nope}}");
check("linkText flattens whitespace and link characters", linkText("  a\n b|c [d]  ") === "a b c  d");
check("union covers all rects", JSON.stringify(union([{ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 2, height: 2 }])) === JSON.stringify({ x: 0, y: 0, width: 7, height: 7 }) && union([]) === null);

// settings
check("parseNumbers sorts, dedupes and bounds", JSON.stringify(parseNumbers("4, 1 2 2 100 -1 abc", 0.25, 40)) === "[1,2,4]");
check("parseColors keeps valid hex only", JSON.stringify(parseColors("#FF0000, red, #00ff00 #00FF00")) === JSON.stringify(["#ff0000", "#00ff00"]));
const s = normalizeSettings({ pen: { color: "nope", width: 500, opacity: 2 } as any, penWidths: [], textLinkFormats: [{ name: "x" }] as any });
check("normalizeSettings repairs bad values", s.pen.color === "#1e1e1e" && s.pen.width === 40 && s.pen.opacity === 1 && s.penWidths.length === 3 && s.textLinkFormats.length === 3, s.pen);
check("normalizeSettings keeps good values", normalizeSettings({ stylusMode: false, linkTarget: "sidecar", sidecarFolder: "/notes/" }).stylusMode === false && normalizeSettings({ linkTarget: "sidecar" }).linkTarget === "sidecar" && normalizeSettings({ sidecarFolder: "/notes/" }).sidecarFolder === "notes");

// ink
const sm = smoothStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }]);
check("smoothStroke adds vertices on bends and keeps the originals", sm.length > 4 && sm[0].x === 0 && sm[sm.length - 1].x === 20, sm.length);
check("smoothStroke leaves a straight line alone", smoothStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]).length === 3);
check("smoothStroke drops duplicate samples", smoothStroke([{ x: 0, y: 0 }, { x: 0, y: 0.01 }, { x: 0, y: 0 }]).length === 1);

// eraser hit test
const ink = { type: 15, strokeWidth: 2, inkList: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] };
check("annotationHit finds an ink segment within the radius", annotationHit(ink, 5, 2, 1.5) && !annotationHit(ink, 5, 5, 1.5));
const hl = { type: 9, segmentRects: [{ origin: { x: 0, y: 0 }, size: { width: 10, height: 4 } }] };
check("annotationHit finds a highlight box", annotationHit(hl, 11, 2, 2) && !annotationHit(hl, 15, 2, 2));
check("annotationHit ignores other types", !annotationHit({ type: 1, rect: { origin: { x: 0, y: 0 }, size: { width: 9, height: 9 } } }, 1, 1, 5));

// toolbar
check("dotSize grows with width and stays within bounds", dotSize(0.25) >= 4 && dotSize(1) < dotSize(4) && dotSize(40) <= 22);

if (failed) process.exit(1);
