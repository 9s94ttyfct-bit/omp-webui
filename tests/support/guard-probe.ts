import { guardAgainstStrayErrors } from "../../server/crash-guard.ts";

/**
 * A process that meets stray errors, for tests/unit/crash-guard.test.ts.
 *
 *   probe <mode> <errors> [limit [windowMs [gapMs]]]
 *
 * It fires `errors` stray errors (alternately a promise nobody awaits and an exception thrown from a timer, `gapMs`
 * apart), then, 300 ms after the last, prints `serving` and exits 0. `mode` is `guarded` (the guard is installed; its
 * storm handler prints `storm` and exits 0) or `bare` (nothing installed, as the server was).
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
for (let i = 0; i < count; i++) {
	const at = i * gap;
	if (i % 2 === 0) setTimeout(() => void Promise.reject(new Error(`stray-rejection-${i}`)), at);
	else
		setTimeout(() => {
			throw new Error(`stray-timer-${i}`);
		}, at);
}
setTimeout(
	() => {
		console.log("serving");
		process.exit(0);
	},
	(count - 1) * gap + 300,
);
