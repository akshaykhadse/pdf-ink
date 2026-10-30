// Pure-function checks for src/ink.ts (built to test/out/ink.cjs by scripts/build.mjs test).
const assert = require("node:assert/strict");
const { smoothStroke } = require("./out/ink.cjs");

let failed = false;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed = true;
		console.log(`FAIL ${name}: ${e.message}`);
	}
};

check("a sparse circle is resampled close to the circle", () => {
	const raw = [];
	for (let i = 0; i <= 12; i++) raw.push({ x: 100 * Math.cos((i / 12) * 2 * Math.PI), y: 100 * Math.sin((i / 12) * 2 * Math.PI) });
	const out = smoothStroke(raw);
	assert.ok(out.length > 60, `only ${out.length} points`);
	for (const p of out) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 100) < 2.5, "point off the circle");
	for (const p of raw) assert.ok(out.some((q) => q.x === p.x && q.y === p.y), "an original sample was dropped");
});

check("a straight run keeps its points", () => {
	const line = [];
	for (let i = 0; i < 50; i++) line.push({ x: i * 2, y: 0 });
	assert.equal(smoothStroke(line).length, 50);
});

if (failed) process.exit(1);
