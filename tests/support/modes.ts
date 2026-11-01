import { expect } from "bun:test";
import { statSync } from "node:fs";
import { platformId } from "../../server/platform/capabilities.ts";

/**
 * That the file or folder at `path` has the permission bits `mode` (`0o600`: this user's alone). Windows has no such bits
 * (a file there is read-only or not, and who may read it is the profile folder's access list), so there it checks nothing.
 */
export function expectMode(path: string, mode: number, label?: string): void {
	if (platformId === "win32") return;
	expect(statSync(path).mode & 0o777, label).toBe(mode);
}
