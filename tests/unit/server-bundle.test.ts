import { expect, test } from "bun:test";
import { join } from "node:path";
import { SERVER_WORKERS } from "../../scripts/lib/server-compile.ts";

/**
 * The server bundles as the packages compile it (`bun build --compile --minify`, scripts/lib/server-compile.ts). A file
 * imported both as a module and `with { type: "text" }` breaks the bundle ("No matching export … for import default") while
 * every source-mode test still passes, which is how v0.11.11's first app build failed; this catches it without compiling a
 * binary. That the workers are the ones the server starts is tests/unit/server-compile.test.ts's.
 */
test("the server and its workers bundle as the packages build them", async () => {
	const root = join(import.meta.dir, "..", "..");
	const built = await Bun.build({
		entrypoints: ["main.ts", ...SERVER_WORKERS].map((f) => join(root, "server", f)),
		target: "bun",
		minify: true,
		throw: false,
	});
	expect(built.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
	expect(built.success).toBe(true);
}, 60_000);
