import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { gateTestCommand, gateWorkers } from "../../scripts/lib/test-workers.ts";

/**
 * The gate's `bun test` worker count (#1, audit A-016): `test:release`, `test:mac` and `test:live` run on a Mac that is
 * in use, so they take half the cores, not Bun's one worker per core.
 */

const ROOT = join(import.meta.dir, "..", "..");

test("the gate takes half the cores, rounded up, and never fewer than 2", () => {
	expect(gateWorkers(1)).toBe(2);
	expect(gateWorkers(2)).toBe(2);
	expect(gateWorkers(4)).toBe(2);
	expect(gateWorkers(5)).toBe(3);
	expect(gateWorkers(12)).toBe(6);
	expect(gateWorkers(13)).toBe(7);
});

test("OMPW_TEST_WORKERS sets the count; empty is unset, and anything but a whole number from 1 is refused", () => {
	expect(gateWorkers(12, { OMPW_TEST_WORKERS: "1" })).toBe(1);
	expect(gateWorkers(12, { OMPW_TEST_WORKERS: "12" })).toBe(12);
	expect(gateWorkers(12, { OMPW_TEST_WORKERS: "" })).toBe(6);
	for (const bad of ["0", "-2", "2.5", "all", " 4", "04"]) {
		expect(() => gateWorkers(12, { OMPW_TEST_WORKERS: bad })).toThrow(
			`OMPW_TEST_WORKERS must be a whole number from 1, not "${bad}"`,
		);
	}
});

test("the gate's command is `bun test --parallel=<count>` with the arguments after it", () => {
	const half = Math.max(2, Math.ceil(availableParallelism() / 2));
	expect(gateTestCommand(["--timeout", "30000", "tests/unit"], {})).toEqual([
		"bun",
		"test",
		`--parallel=${half}`,
		"--timeout",
		"30000",
		"tests/unit",
	]);
	expect(gateTestCommand(["x"], { OMPW_TEST_WORKERS: "3" })).toEqual(["bun", "test", "--parallel=3", "x"]);
});

test("test:release and test:live go through the gate's runner; test, test:contract and test:all keep one worker per core", () => {
	const scripts = pkg.scripts as Record<string, string>;
	for (const gate of ["test:release", "test:live"]) {
		expect(scripts[gate]).toContain("bun scripts/gate-test.ts ");
		expect(scripts[gate]).not.toContain("--parallel");
	}
	expect(scripts["test:mac"]).toContain("scripts/mac-tests.ts");
	for (const own of ["test", "test:contract", "test:all"]) expect(scripts[own]).toContain("bun test --parallel ");
});

test("scripts/gate-test.ts runs `bun test` with the cap and the arguments, and exits with its code", async () => {
	const stubs = mkdtempSync(join(tmpdir(), "ompw-gate-test-"));
	try {
		const out = join(stubs, "args");
		writeFileSync(join(stubs, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\nexit 7\n`);
		chmodSync(join(stubs, "bun"), 0o755);
		const proc = Bun.spawn([process.execPath, "scripts/gate-test.ts", "--timeout", "30000", "tests/unit"], {
			cwd: ROOT,
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, OMPW_TEST_WORKERS: "3" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(7);
		expect(await Bun.file(out).text()).toBe("test\n--parallel=3\n--timeout\n30000\ntests/unit\n");

		const refused = Bun.spawn([process.execPath, "scripts/gate-test.ts", "tests/unit"], {
			cwd: ROOT,
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, OMPW_TEST_WORKERS: "many" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await refused.exited).toBe(2);
		expect(await new Response(refused.stderr).text()).toContain("OMPW_TEST_WORKERS must be a whole number from 1");
	} finally {
		rmSync(stubs, { recursive: true, force: true });
	}
});
