import { expect, test } from "bun:test";
import { surplus } from "../../server/live.ts";

/** Which omp processes the pool closes: a few unwatched idle ones stay warm, the rest go. */

const now = 1_000_000_000;
const proc = (name: string, ageS: number, o: { watched?: boolean; busy?: boolean } = {}) => ({
	name,
	lastActivity: now - ageS * 1000,
	busy: o.busy ?? false,
	subscribers: { size: o.watched ? 1 : 0 },
});
const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();

test("beyond the spare allowance the least recently active unwatched idle processes close", () => {
	const lives = [proc("a", 50), proc("b", 10), proc("c", 30), proc("d", 20), proc("e", 40), proc("f", 60)];
	expect(names(surplus(lives, now, 4))).toEqual(["a", "f"]);
});

test("watched and busy processes never close and do not use the spare allowance", () => {
	const lives = [
		proc("watched", 7200, { watched: true }),
		proc("busy", 7200, { busy: true }),
		proc("x", 30),
		proc("y", 20),
		proc("z", 10),
	];
	expect(surplus(lives, now, 2).map((l) => l.name)).toEqual(["x"]);
});

test("within the allowance only processes idle past 15 minutes close", () => {
	const lives = [proc("fresh", 14 * 60), proc("stale", 16 * 60)];
	expect(names(surplus(lives, now, 4))).toEqual(["stale"]);
});
