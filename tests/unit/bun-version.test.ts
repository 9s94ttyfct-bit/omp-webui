import { expect, test } from "bun:test";
import { bunMeetsMinimum, MIN_BUN } from "../../server/bun-version.ts";

/** Bun 1.3 starts omp-webui once and then never again (#306): an older Bun is refused with the version that is needed. */

test("a Bun older than the minimum is refused, the minimum and newer are not", () => {
	for (const old of ["1.3.0", "1.3.13", "1.2.9", "0.9.0"]) expect(bunMeetsMinimum(old), old).toBe(false);
	for (const fine of [MIN_BUN, "1.4.4", "1.10.0", "2.0.0"]) expect(bunMeetsMinimum(fine), fine).toBe(true);
});

test("a canary or a build of the minimum is read by its numbers", () => {
	expect(bunMeetsMinimum("1.4.5-canary.20261101+abc123")).toBe(true);
	expect(bunMeetsMinimum("1.3.13-canary.20261101+abc123")).toBe(false);
	expect(bunMeetsMinimum("1.4")).toBe(true);
});

test("the version this suite runs on is one omp-webui accepts", () => {
	expect(bunMeetsMinimum(Bun.version)).toBe(true);
});
