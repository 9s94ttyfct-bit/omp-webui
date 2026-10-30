/**
 * Preloaded into the real server by tests/contract/stray-errors.test.ts (`BUN_OPTIONS=--preload`): once the server has
 * printed its ready line, it meets the two stray errors that used to end it, and says it did (`STRAYS_FIRED` on
 * stdout, after both have been thrown).
 */
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
	log(...args);
	if (typeof args[0] === "string" && args[0].startsWith("OMPW_READY ")) {
		console.log = log;
		setTimeout(() => void Promise.reject(new Error("stray-rejection")), 50);
		setTimeout(() => {
			throw new Error("stray-timer");
		}, 60);
		setTimeout(() => log("STRAYS_FIRED"), 120);
	}
};
