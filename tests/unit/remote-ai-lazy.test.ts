import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The AI help is part of the remote chain, which is loaded only when remote access is used (`server/remote-lazy.ts`): no
 * file the server runs at start imports it, or anything it brings in, as a value. A type import costs nothing at run time.
 */

const SERVER = join(import.meta.dir, "../../server");
const CHAIN = ["remote-ai", "remote-ai-guide", "remote-check", "remote-routes", "remote-tunnel", "remote-auth"];

/** The files of `dir` and below, as paths relative to the server directory. */
function sources(dir: string, base = ""): string[] {
	return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? sources(dir, join(base, e.name)) : e.name.endsWith(".ts") ? [join(base, e.name)] : [],
	);
}

test("nothing the server loads at start imports the remote chain as a value, the AI help included", () => {
	const chain = new RegExp(`from "(?:\\./|\\.\\./)(?:${CHAIN.join("|")})\\.ts"`);
	const eager: string[] = [];
	for (const file of sources(SERVER)) {
		// The chain's own files import each other; `remote-lazy.ts` imports the chain, but only with `import()`.
		if (CHAIN.some((name) => file === `${name}.ts`)) continue;
		for (const line of readFileSync(join(SERVER, file), "utf8").split("\n")) {
			if (line.startsWith("import ") && !line.startsWith("import type ") && chain.test(line))
				eager.push(`${file}: ${line}`);
		}
	}
	expect(eager).toEqual([]);
});

test("the one place that imports the AI help imports it with the chain, as the routes do", () => {
	const importers = sources(SERVER).filter((f) =>
		/from "\.\/remote-ai\.ts"/.test(readFileSync(join(SERVER, f), "utf8")),
	);
	expect(importers.sort()).toEqual(["remote-lazy.ts", "remote-routes.ts"]);
	// `remote-lazy.ts` only for its type.
	const lazy = readFileSync(join(SERVER, "remote-lazy.ts"), "utf8");
	expect(lazy).toMatch(/import type \{ RemoteAiHooks \} from "\.\/remote-ai\.ts";/);
});
