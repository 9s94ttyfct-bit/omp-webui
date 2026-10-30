import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The server bundles as the macOS app compiles it (`bun build --compile --minify`). A file imported both as a module and
 * `with { type: "text" }` breaks the bundle ("No matching export … for import default") while every source-mode test
 * still passes, which is how v0.11.11's first app build failed; this catches it without compiling a binary.
 */
test("the server, its family, search and GPU workers bundle as the app builds them", async () => {
	const root = join(import.meta.dir, "..", "..");
	const built = await Bun.build({
		entrypoints: [
			"server/main.ts",
			"server/family-worker.ts",
			"server/search-index-worker.ts",
			"server/host-gpu-worker.ts",
		].map((f) => join(root, f)),
		target: "bun",
		minify: true,
		throw: false,
	});
	expect(built.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
	expect(built.success).toBe(true);
}, 60_000);

/**
 * A worker the server starts by a relative URL (`new Worker(new URL("./x.ts", import.meta.url))`) is in the compiled binary
 * only as an entry point of its own: left out of `scripts/app.ts`'s compile, it builds and runs from source and is missing in
 * the app ("ModuleNotFound … (entry point)"), where the host load's GPU thread, or the search or the family worker, is simply
 * gone. Every such worker must be an entry point of the app's compile, and of the bundle test above.
 */
test("every worker the server starts by URL is an entry point of the app's compile", () => {
	const root = join(import.meta.dir, "..", "..");
	const started = new Set<string>();
	for (const file of new Bun.Glob("server/**/*.ts").scanSync({ cwd: root })) {
		const text = readFileSync(join(root, file), "utf8");
		for (const m of text.matchAll(/new Worker\(\s*new URL\("\.\/([\w-]+\.ts)"/g)) {
			started.add(join(dirname(file), m[1] as string));
		}
	}
	expect([...started].sort()).toEqual([
		"server/family-worker.ts",
		"server/host-gpu-worker.ts",
		"server/search-index-worker.ts",
	]);
	const app = readFileSync(join(root, "scripts", "app.ts"), "utf8");
	const bundleTest = readFileSync(import.meta.path, "utf8");
	for (const worker of started) {
		const name = worker.slice("server/".length);
		expect(app, `scripts/app.ts compiles ${worker}`).toContain(`join(root, "server", "${name}")`);
		expect(bundleTest, `the bundle test builds ${worker}`).toContain(`"${worker}"`);
	}
});
