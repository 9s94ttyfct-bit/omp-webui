import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The server survives a stray error (#373): Bun ends a process on a rejected promise nobody handles and on an
 * exception thrown from a timer, so without the guard one failed git probe or one socket that closed under a send ended
 * every conversation and, in the macOS app, the window. Each case runs a real Bun process (tests/support/guard-probe.ts).
 * The real server's own start is tests/contract/stray-errors.test.ts.
 */

const probe = join(import.meta.dir, "../support/guard-probe.ts");

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(["bun", probe, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out, err };
}

test("without the guard the first stray error ends the process (the premise: what the server used to do)", async () => {
	const r = await run("bare", "2");
	expect(r.code).not.toBe(0);
	expect(r.out).not.toContain("serving");
});

test("a rejected promise nobody awaits and an exception thrown from a timer are logged, with their stacks, and survived", async () => {
	const r = await run("guarded", "2");
	expect(r.code).toBe(0);
	expect(r.out).toContain("serving");
	expect(r.err).toContain("unhandled promise rejection; the server keeps running");
	expect(r.err).toContain("stray-rejection-0");
	expect(r.err).toContain("uncaught exception; the server keeps running");
	expect(r.err).toContain("stray-timer-1");
	expect(r.err).toContain("guard-probe.ts"); // the stack of the throw site is there, not only the message
	expect(r.out).not.toContain("storm");
});

test("errors that keep coming within the window stop the server for a clean start", async () => {
	// Four errors at once, a limit of three: the third one stops it (the fourth never gets its turn).
	const r = await run("guarded", "4", "3");
	expect(r.out).toContain("storm");
	expect(r.out).not.toContain("serving");
	expect(r.err).toContain("3 stray errors within 60 s; stopping the server");
});

test("errors spread wider than the window never add up to a storm", async () => {
	// Limit 2 within 100 ms, errors 250 ms apart: each is alone in its window.
	const r = await run("guarded", "4", "2", "100", "250");
	expect(r.out).toContain("serving");
	expect(r.out).not.toContain("storm");
});
