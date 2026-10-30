import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_BUDGET_KIB } from "../../scripts/check-entry-size.ts";
import { entryModules, entryScripts, measureEntry, report } from "../../scripts/lib/entry-size.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What Vite writes: the page's own inline script, the entry, its preloads, a stylesheet. */
const INDEX_HTML = `<!doctype html>
<html><head>
<script>(() => { const src = "/not-a-file.js"; })();</script>
<script type="module" crossorigin src="/assets/index-AAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/app-BBB.js">
<link href="/assets/rolldown-runtime-CCC.js" rel="modulepreload" crossorigin>
<link rel="modulepreload" crossorigin href="/assets/app-BBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-DDD.css">
<link rel="icon" type="image/png" href="/favicon.png">
<script src="/assets/classic.js"></script>
<script type="module" data-src="/assets/elsewhere.js"></script>
</head><body><div id="root"></div></body></html>`;

/** Bytes that gzip cannot shrink: the size on the wire is then the size written, whatever the compressor does. */
function noise(bytes: number): Uint8Array {
	const out = new Uint8Array(bytes);
	for (let at = 0; at < bytes; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(bytes, at + 65536)));
	return out;
}

/** A build output: `<dist>/web/index.html` naming `assets` (file → bytes), and the module record when given. */
function build(assets: Record<string, Uint8Array>, record?: Record<string, Record<string, number>>): string {
	const dist = mkdtempSync(join(tmpdir(), "ompw-entry-size-"));
	dirs.push(dist);
	mkdirSync(join(dist, "web", "assets"), { recursive: true });
	const links = Object.keys(assets)
		.map((f, i) =>
			i === 0 ? `<script type="module" src="/${f}"></script>` : `<link rel="modulepreload" href="/${f}">`,
		)
		.join("\n");
	writeFileSync(join(dist, "web", "index.html"), `<html><head>${links}</head><body></body></html>`);
	for (const [file, bytes] of Object.entries(assets)) writeFileSync(join(dist, "web", file), bytes);
	if (record) writeFileSync(join(dist, "chunk-modules.json"), JSON.stringify(record));
	return dist;
}

async function check(args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "scripts", "check-entry-size.ts"), ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out + err };
}

describe("entryScripts", () => {
	test("is the module script and the modulepreload links, once each, in the page's order", () => {
		expect(entryScripts(INDEX_HTML)).toEqual([
			"assets/index-AAA.js",
			"assets/app-BBB.js",
			"assets/rolldown-runtime-CCC.js",
		]);
	});

	test("a page served from a base path names the same files", () => {
		const html = '<script type="module" src="/omp/assets/index-AAA.js"></script>';
		expect(entryScripts(html)).toEqual(["omp/assets/index-AAA.js"]);
	});
});

describe("measureEntry", () => {
	test("is each file's gzip as Bun makes it", () => {
		const main = new TextEncoder().encode("export const a = 1;\n".repeat(500));
		const dist = build({ "assets/index-AAA.js": main, "assets/app-BBB.js": noise(4096) });
		const files = measureEntry(join(dist, "web"));
		expect(files.map((f) => f.file)).toEqual(["assets/index-AAA.js", "assets/app-BBB.js"]);
		expect(files[0].gzip).toBe(Bun.gzipSync(main).length);
		expect(files[0].gzip).toBeLessThan(main.length / 10);
		expect(files[1].gzip).toBeGreaterThan(4096);
	});

	test("a page that loads no script is an error, not an entry of nothing", () => {
		const dist = mkdtempSync(join(tmpdir(), "ompw-entry-size-"));
		dirs.push(dist);
		mkdirSync(join(dist, "web"));
		writeFileSync(join(dist, "web", "index.html"), "<html><body></body></html>");
		expect(() => measureEntry(join(dist, "web"))).toThrow("nothing to measure");
	});
});

describe("entryModules", () => {
	test("shares each file's gzip out by code length, and names a package once", () => {
		const files = [
			{ file: "assets/a.js", gzip: 1000 },
			{ file: "assets/b.js", gzip: 400 },
		];
		const modules = entryModules(files, {
			"assets/a.js": {
				"web/src/App.tsx": 100,
				"node_modules/.bun/lucide-react@1.0.0/node_modules/lucide-react/dist/esm/icons/plus.mjs": 100,
				"node_modules/.bun/lucide-react@1.0.0/node_modules/lucide-react/dist/esm/icons/pencil.mjs": 100,
				"node_modules/.bun/@radix-ui+react-dialog@1.0.0/node_modules/@radix-ui/react-dialog/dist/index.mjs": 100,
			},
			"assets/b.js": { "web/src/App.tsx": 50, "web/src/lib/api.ts": 150 },
			"assets/not-in-the-entry.js": { "web/src/Huge.tsx": 1e9 },
		});
		expect(modules).toEqual([
			{ id: "lucide-react (package)", gzip: 500 },
			{ id: "web/src/App.tsx", gzip: 250 + 100 },
			{ id: "web/src/lib/api.ts", gzip: 300 },
			{ id: "@radix-ui/react-dialog (package)", gzip: 250 },
		]);
	});

	test("without a record of the build there is no list", () => {
		expect(entryModules([{ file: "assets/a.js", gzip: 1000 }], {})).toEqual([]);
	});
});

describe("report", () => {
	const files = [{ file: "assets/index-AAA.js", gzip: 300 * 1024 }];

	test("one line while the entry fits", () => {
		const { ok, text } = report(files, [], 300);
		expect(ok).toBe(true);
		expect(text).toBe("first-load JS 300.0 KiB gzip in 1 file (budget 300 KiB): ok");
	});

	test("over the budget it says by how much, which files, and the modules, biggest first", () => {
		const modules = [
			{ id: "react-dom (package)", gzip: 200 * 1024 },
			{ id: "web/src/components/NewChat.tsx", gzip: 12 * 1024 },
		];
		const { ok, text } = report(files, modules, 228);
		expect(ok).toBe(false);
		expect(text).toContain("OVER by 72.0 KiB");
		expect(text).toContain("assets/index-AAA.js");
		expect(text.indexOf("react-dom (package)")).toBeLessThan(text.indexOf("web/src/components/NewChat.tsx"));
		expect(text).toContain("200.0 KiB  react-dom (package)");
		expect(text).toContain("ENTRY_BUDGET_KIB");
	});

	test("a list longer than the report's keeps its first and counts the rest", () => {
		const many = Array.from({ length: 45 }, (_, i) => ({ id: `web/src/m${i}.ts`, gzip: (100 - i) * 1024 }));
		const { text } = report(files, many, 1);
		expect(text).toContain("web/src/m29.ts");
		expect(text).not.toContain("web/src/m30.ts");
		expect(text).toContain("… and 15 more");
	});

	test("without a module record it says to build", () => {
		expect(report(files, [], 1).text).toContain("bun run build");
	});
});

describe("bun scripts/check-entry-size.ts", () => {
	test("passes, in one line, while the entry is within the budget", async () => {
		const dist = build({ "assets/index-AAA.js": noise(10 * 1024) });
		const { code, out } = await check(["--dist", dist]);
		expect(code).toBe(0);
		expect(out).toContain(`(budget ${ENTRY_BUDGET_KIB} KiB): ok`);
	});

	test("fails above the default budget, and lists the modules the entry is made of", async () => {
		const dist = build(
			{ "assets/index-AAA.js": noise((ENTRY_BUDGET_KIB + 1) * 1024), "assets/app-BBB.js": noise(1024) },
			{ "assets/index-AAA.js": { "web/src/components/Sidebar.tsx": 3, "node_modules/react-dom/index.js": 1 } },
		);
		const { code, out } = await check(["--dist", dist]);
		expect(code).toBe(1);
		expect(out).toContain("OVER by");
		expect(out).toContain(`budget ${ENTRY_BUDGET_KIB} KiB`);
		expect(out).toContain("web/src/components/Sidebar.tsx");
		expect(out).toContain("react-dom (package)");
	});

	test("--budget moves the line", async () => {
		const dist = build({ "assets/index-AAA.js": noise(10 * 1024) });
		expect((await check(["--dist", dist, "--budget", "11"])).code).toBe(0);
		expect((await check(["--dist", dist, "--budget", "9"])).code).toBe(1);
	});
});
