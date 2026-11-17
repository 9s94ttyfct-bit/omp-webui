// needs: posixShell
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `bun run parity` is CI's check that every omp command, flag and slash command has its place in the page. An omp whose
 * help or command list the inventory cannot read lists nothing, and nothing is not parity: the step fails.
 */
const dir = mkdtempSync(join(tmpdir(), "ompw-parity-script-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an omp whose help and command list read as nothing fails the parity step", () => {
	const omp = join(dir, "omp");
	writeFileSync(
		omp,
		[
			"#!/bin/sh",
			'if [ "$1" = "--help" ]; then echo "Usage: omp [options]"; exit 0; fi',
			`echo '{"type":"ready"}'`,
			"read -r line",
			`echo '{"type":"response","id":"inv","data":{"commands":[]}}'`,
			"read -r line",
			"",
		].join("\n"),
	);
	chmodSync(omp, 0o755);
	const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "..", "scripts", "parity.ts")], {
		env: { ...process.env, OMP_BIN: omp },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(r.stdout.toString()).toContain("omp listed no command, flag, slash");
	expect(r.exitCode).toBe(1);
});
