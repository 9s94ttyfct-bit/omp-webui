import { expect, test } from "bun:test";
import { sanitize } from "../../web/src/lib/feedback.ts";

/**
 * A real-clock budget, not an ordinary correctness test: cleaning a pasted text must not take longer than a quarter of a
 * second, and what a test process gets of the CPU depends on what else runs (the parallel pool gives each worker part of
 * a core), so the same text takes any time at all there. The `test:all`/`test:contract` scripts run this phase after
 * their pool, while the other suites are idle (see family.test.ts). What the budget protects is that no pattern of
 * `sanitize` is quadratic (or worse) in a long run of what it looks for: 10,000 repeats are linear in a few
 * milliseconds and take seconds when they are not.
 */

const HOME = "/Users/jdoe";
const USER = "jdoe";

test("a long run of dots, dashes or letters is cleaned in linear time", () => {
	for (const unit of [
		"a.",
		"a-",
		"a@",
		"token",
		"https:/",
		"-----BEGIN ",
		"-----BEGIN PRIVATE KEY-----\n",
		"curl -u ",
		"curl -u a:",
		"password: ",
		"password is ",
		"ya29.",
		"hooks.slack.com/services/",
		"eyJabcdefgh.",
	]) {
		const text = unit.repeat(10_000);
		const t0 = performance.now();
		sanitize(text, HOME, USER);
		expect(performance.now() - t0, unit).toBeLessThan(250);
	}
});
