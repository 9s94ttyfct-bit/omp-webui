import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The modules the first page load fetches are the ones `web/src/main.tsx` imports statically, and so on down: a
 * `lazy(() => import(...))` starts a chunk of its own. The tests that hold the first load to a shape (the history of a
 * conversation and the strings of the pages that load later are not in it) walk the same graph.
 */

export const ROOT = join(import.meta.dir, "..", "..");
export const WEB = join(ROOT, "web", "src");
const scanners = { ".ts": new Bun.Transpiler({ loader: "ts" }), ".tsx": new Bun.Transpiler({ loader: "tsx" }) };

/** The files a file imports with an `import` statement or an `export … from` (not `import()`, and not what is only a type); `@shared/…` is the repo's `shared/` folder. */
export function staticImports(file: string): string[] {
	const out: string[] = [];
	const scanner = file.endsWith(".tsx") ? scanners[".tsx"] : scanners[".ts"];
	for (const { path, kind } of scanner.scanImports(readFileSync(file, "utf8"))) {
		if (kind !== "import-statement") continue;
		const target = path.startsWith("@shared/")
			? join(ROOT, "shared", path.slice("@shared/".length))
			: path.startsWith(".")
				? resolve(dirname(file), path)
				: null;
		if (target && /\.tsx?$/.test(target) && existsSync(target)) out.push(target);
	}
	return out;
}

/** Every file of `web/src` (and the `shared/` files they import) the first page load reaches, by the modules each one imports, and one way each is reached. */
export function eager(): Map<string, string> {
	const reached = new Map<string, string>();
	const entry = join(WEB, "main.tsx");
	reached.set(entry, "");
	const queue = [entry];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		for (const next of staticImports(file)) {
			if (reached.has(next)) continue;
			reached.set(next, file);
			queue.push(next);
		}
	}
	return reached;
}

/** The chain of imports from the entry to `file`, for the failure message. */
export function chain(reached: Map<string, string>, file: string): string {
	const names: string[] = [];
	for (let at: string | undefined = file; at; at = reached.get(at)) names.push(at.slice(ROOT.length + 1));
	return names.reverse().join(" -> ");
}

/**
 * The chunks the home page (New chat) fetches by itself, as soon as its process is starting (`NewChat.tsx` preloads
 * them): what it shows from them is there within the first second, so their strings travel with the first page too.
 */
export const HOME_CHUNKS = ["NewChatPickers", "UIRequests", "Quota"].map((name) =>
	join(WEB, "components", `${name}.tsx`),
);

/** `eager()` and, past it, every module the home page's own chunks import (a module is reached by the first import that finds it). */
export function homeLoad(): Map<string, string> {
	const reached = eager();
	const queue = HOME_CHUNKS.filter((file) => !reached.has(file));
	for (const file of queue) reached.set(file, join(WEB, "components", "NewChat.tsx"));
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		for (const next of staticImports(file)) {
			if (reached.has(next)) continue;
			reached.set(next, file);
			queue.push(next);
		}
	}
	return reached;
}
