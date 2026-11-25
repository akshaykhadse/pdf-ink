// Pure-function checks, run with node after bundling (test/out/units.cjs).
import { smoothStroke } from "../src/ink";
import { fillTemplate, linkText, parseSubpath, rectFromParam, rectParam, union } from "../src/links";
import { DEFAULT_SETTINGS, defaultSettings, normalizeSettings, parseColors, parseNumbers } from "../src/settings";
import { annotationHit, tapHit } from "../src/guard";
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
const fresh = defaultSettings();
fresh.penColors.push("#000000");
fresh.textLinkFormats[0].template = "changed";
fresh.pen.width = 9;
check("defaultSettings returns a copy that shares nothing with the defaults", DEFAULT_SETTINGS.penColors.length === 6 && DEFAULT_SETTINGS.textLinkFormats[0].template.startsWith("[[") && DEFAULT_SETTINGS.pen.width === 2 && JSON.stringify(defaultSettings()) === JSON.stringify(DEFAULT_SETTINGS));

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
check("dotSize grows with width and stays within bounds", dotSize(0.25) >= 2 && dotSize(1) < dotSize(4) && dotSize(40) <= 10);

if (failed) process.exit(1);

// tapHit: what a pointer-tool tap selects
const box = (x: number, y: number, w: number, h: number) => ({ origin: { x, y }, size: { width: w, height: h } });
check("tapHit: a stroke by its path, as the eraser", tapHit(ink, 5, 2, 1.5) && !tapHit(ink, 5, 5, 1.5));
check("tapHit: a line by its segment, not its whole box", tapHit({ type: 4, rect: box(0, 0, 10, 10), linePoints: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }, strokeWidth: 1 }, 5, 5.5, 1) && !tapHit({ type: 4, rect: box(0, 0, 10, 10), linePoints: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }, strokeWidth: 1 }, 9, 1, 1));
check("tapHit: a hollow box by its outline, a filled one inside", tapHit({ type: 5, rect: box(0, 0, 20, 20), strokeWidth: 2 }, 0.5, 10, 1) && !tapHit({ type: 5, rect: box(0, 0, 20, 20), strokeWidth: 2 }, 10, 10, 1) && tapHit({ type: 5, rect: box(0, 0, 20, 20), color: "#ff0000" }, 10, 10, 1));
check("tapHit: a hollow ellipse by its outline", tapHit({ type: 6, rect: box(0, 0, 20, 10), strokeWidth: 1 }, 10, 0.2, 1) && !tapHit({ type: 6, rect: box(0, 0, 20, 10), strokeWidth: 1 }, 10, 5, 1));
check("tapHit: text and images by their box", tapHit({ type: 3, rect: box(0, 0, 20, 10) }, 10, 5, 1) && !tapHit({ type: 13, rect: box(0, 0, 20, 10) }, 30, 5, 1));
