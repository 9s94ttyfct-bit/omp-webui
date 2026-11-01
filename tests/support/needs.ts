import { capabilities, platformId, UNAVAILABLE } from "../../server/platform/capabilities.ts";
import type { Capability } from "../../shared/platform.ts";

/**
 * What a test may need of the machine it runs on: a capability of the server (`server/platform/capabilities.ts`), or
 * something only the test itself needs. A test that needs one skips where it is missing (`test.skipIf(!has.posixShell)`);
 * a file all of whose tests need it says so in a line of its own, `// needs: <name>[, <name>…]`, and is left out where
 * one is missing (scripts/test-shard.ts).
 */

/** What only tests need, and why it is missing where it is. */
const HARNESS = {
	posixShell: {
		has: platformId !== "win32",
		why: "its stand-ins for other programs are POSIX shell scripts or POSIX tools, which Windows does not run",
	},
	posixModes: {
		has: platformId !== "win32",
		why: "it checks POSIX permission bits (0600, 0700), which Windows does not have",
	},
	posixPaths: {
		has: platformId !== "win32",
		why: "it lays out a Mac's folders with POSIX paths (the move to another Mac), which Windows does not have",
	},
} as const;

export type Need = Capability | keyof typeof HARNESS;

/** Whether this machine has each need. */
export const has: Record<Need, boolean> = {
	...capabilities,
	...(Object.fromEntries(Object.entries(HARNESS).map(([name, need]) => [name, need.has])) as Record<
		keyof typeof HARNESS,
		boolean
	>),
};

/** Why a need is missing where it is. */
export function whyMissing(need: Need): string {
	return need in HARNESS ? HARNESS[need as keyof typeof HARNESS].why : UNAVAILABLE[need as Capability];
}

/** The needs a test file says all its tests have (`// needs: a, b`); throws on a name that is none. */
export function fileNeeds(text: string): Need[] {
	const line = /^\/\/ needs: (.+)$/m.exec(text);
	if (!line) return [];
	return line[1].split(",").map((name) => {
		const need = name.trim();
		if (!(need in has)) throw new Error(`"// needs: ${line[1]}" names nothing a test can need: ${need}`);
		return need as Need;
	});
}
