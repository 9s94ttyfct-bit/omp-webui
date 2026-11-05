import { guardAgainstStrayErrors } from "../../server/crash-guard.ts";

/**
 * A process that meets stray errors, for tests/unit/crash-guard.test.ts.
 *
 *   probe <mode> <errors> [limit [windowMs [gapMs]]]
 *
 * It fires `errors` stray errors (alternately a promise nobody awaits and an exception thrown from a timer, each `gapMs`
 * after the one before it), then, 300 ms after the last, prints `serving` and exits 0. `mode` is `guarded` (the guard is
 * installed; its storm handler prints `storm` and exits 0) or `bare` (nothing installed, as the server was).
 */
const [mode, errorCount, limit, windowMs, gapMs] = process.argv.slice(2);
if (mode === "guarded") {
	guardAgainstStrayErrors({
		onStorm: () => {
			console.log("storm");
			process.exit(0);
		},
		...(limit ? { limit: Number(limit) } : {}),
		...(windowMs ? { windowMs: Number(windowMs) } : {}),
	});
}
const gap = Number(gapMs ?? 0);
const count = Number(errorCount);
/**
 * The `i`-th error, `gap` after the one before it has happened: timers set for fixed times from the start fire together after
 * a stall of a loaded machine (seen on Windows), which brought errors meant to be apart into one window.
 */
function fire(i: number): void {
	if (i === count) {
		setTimeout(() => {
			console.log("serving");
			process.exit(0);
		}, 300);
		return;
	}
	setTimeout(
		() => {
			fire(i + 1);
			if (i % 2 === 0) void Promise.reject(new Error(`stray-rejection-${i}`));
			else throw new Error(`stray-timer-${i}`);
		},
		i === 0 ? 0 : gap,
	);
}
fire(0);
