// needs: posixShell
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSession } from "../../server/export.ts";
import { removeScratch } from "../support/scratch.ts";

/** An export runs with the flags its conversation runs with: omp reads a profile's images from the profile's agent directory (#358). */

const dir = mkdtempSync(join(tmpdir(), "ompw-export-flags-"));
afterAll(() => removeScratch(dir));

/** An omp that records its arguments and writes a small page where the last argument says. */
function fakeOmp(): { bin: string; calls: () => string[] } {
	const bin = join(dir, "omp");
	writeFileSync(
		bin,
		`#!/bin/sh
echo "$*" >> "${dir}/calls"
for last; do :; done
echo "<html><body>exported</body></html>" > "$last"
`,
	);
	chmodSync(bin, 0o755);
	return { bin, calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) };
}

test("the export is run with the flags of the conversation, before --export", async () => {
	const omp = fakeOmp();
	const data = join(dir, "data");
	mkdirSync(data, { recursive: true });
	await exportSession(omp.bin, data, join(dir, "a.jsonl"), ["--profile=work"]);
	await exportSession(omp.bin, data, join(dir, "b.jsonl"));
	const [first, second] = omp.calls();
	expect(first?.startsWith("--profile=work --export " + join(dir, "a.jsonl"))).toBe(true);
	expect(second?.startsWith("--export " + join(dir, "b.jsonl"))).toBe(true);
});
