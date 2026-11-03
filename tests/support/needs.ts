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
		why: "its stand-ins for other programs are POSIX shell scripts or POSIX tools (sh, ps, mkfifo), which Windows does not run",
	},
	posixModes: {
		has: platformId !== "win32",
		why: "it checks POSIX permission bits (0600, 0700, read-only folders), which Windows does not have",
	},
	posixPaths: {
		has: platformId !== "win32",
		why: "its fixtures or the code it checks know POSIX paths only (the guard's risk classifier, the move to another Mac, folders like /tmp/x in omp's sessions)",
	},
	posixFiles: {
		has: platformId !== "win32",
		why: "it uses what Windows files do not do: named pipes, symbolic links made without privilege, execute bits, or a file replaced or removed while it is open",
	},
	posixSignals: {
		has: platformId !== "win32",
		why: "it checks how a process ended by a signal is told, or a server ended by a signal it did not send; Windows only terminates a process",
	},
	windowsLauncher: {
		has: platformId === "win32" && Boolean(process.env.OMPW_LAUNCHER_EXE) && Boolean(process.env.OMPW_NEXT_ZIP),
		why: "it installs an update of the built Windows launcher: Windows, with OMPW_LAUNCHER_EXE (the built omp-webui.exe) and OMPW_NEXT_ZIP (a build of it as a later release, zipped), which CI's windows-launcher job sets",
	},
	isolatedHome: {
		has: platformId !== "win32",
		why: "omp keeps its plugins under the home folder, which on Windows is the user profile (USERPROFILE): the test server's own HOME does not move it, so the runner's real ~/.omp would be the test's",
	},
	notWindowsYet: {
		has: platformId !== "win32",
		why: "it fails on Windows for a cause not found yet (an open issue of the Windows CI legs, see docs/TECHNICAL.md)",
	},
	lanPeer: {
		has: platformId !== "win32",
		why: "a page from the network is stood in for by a connection from this computer's own network address, which Windows refuses to make to 127.0.0.1 (EADDRNOTAVAIL)",
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
