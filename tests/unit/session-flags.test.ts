import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CliFlag } from "../../shared/protocol.ts";
import { surfaceFor } from "../parity/mapping.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What New chat offers as options of a conversation's process. A conversation started with `--profile` or `--session-dir`
 * keeps its transcript in another folder: the server remembers the folder it has started omp with, so those
 * conversations are listed, searched and reopened here like the others.
 */

let sessionFlags: (flags: CliFlag[]) => CliFlag[];
beforeAll(async () => {
	installGlobals();
	// The page's store reads `localStorage` when it is evaluated: after the globals are there.
	({ sessionFlags } = await import("../../web/src/components/NewChat.tsx"));
});
afterAll(restoreGlobals);

const flag = (name: string): CliFlag => ({ name, description: name });

test("the options of a new conversation offer the ones that keep its transcript in a known folder", () => {
	const offered = sessionFlags(
		["--model", "--profile", "--session-dir", "--thinking", "--no-skills"].map((name) => flag(name)),
	).map((f) => f.name);
	expect(offered).toEqual(["--model", "--profile", "--session-dir", "--thinking", "--no-skills"]);
});

test("they are the options of a new conversation, which is where the parity of the CLI puts them", () => {
	for (const name of ["--profile", "--session-dir"]) {
		const surface = surfaceFor({ kind: "flag", name, description: "" });
		expect(surface.kind, name).toBe("session-option");
	}
});
