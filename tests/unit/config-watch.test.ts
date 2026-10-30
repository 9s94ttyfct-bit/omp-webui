import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigWatchFs, watchOmpConfig } from "../../server/omp/config-watch.ts";

/**
 * The server learns when omp's config.yml was written, however omp writes it.
 *
 * What the watcher does with the events it is given is tested against a scripted file system and a fake clock: nothing
 * waits for the platform. The platform's own events are not something a test can wait for: macOS drops file events
 * while it is busy with other files' (another test run, a build), and this test failed that way under a parallel run
 * (no event within 3 s, in about two of five writes when ten processes churned files). So the real file system gets one
 * test that writes again until it is told, and nothing here asserts that an event does *not* come from it.
 */

const AGENT = "/agent";

/** A file system whose directory exists or not, and whose events the test sends. */
function scripted(present = true) {
	let exists = present;
	let listener: (event: string, name: string | null) => void = () => {};
	const opened: string[] = [];
	let closed = 0;
	const fs: ConfigWatchFs = {
		exists: () => exists,
		watch: (dir, onEvent) => {
			opened.push(dir);
			listener = onEvent;
			return {
				close: () => {
					closed++;
				},
			};
		},
	};
	return {
		fs,
		opened,
		closed: () => closed,
		/** The directory comes to exist. */
		appear: () => {
			exists = true;
		},
		emit: (event: string, name: string | null) => listener(event, name),
	};
}

describe("what the watcher does with the events it is given", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("a config.yml replaced by rename (how omp saves) is a change; a burst of writes is one", () => {
		const s = scripted();
		let calls = 0;
		const stop = watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			s.fs,
		);
		expect(s.opened).toEqual([AGENT]);
		for (let i = 0; i < 3; i++) {
			s.emit("rename", `config.yml.tmp${i}`);
			s.emit("rename", "config.yml");
		}
		// The burst is not over until it has been quiet for the debounce.
		jest.advanceTimersByTime(149);
		expect(calls).toBe(0);
		jest.advanceTimersByTime(1);
		expect(calls).toBe(1);
		jest.advanceTimersByTime(60_000);
		expect(calls).toBe(1);

		// A write after the burst is a change of its own; a write that keeps the burst going moves its end.
		s.emit("change", "config.yml");
		jest.advanceTimersByTime(100);
		s.emit("change", "config.yml");
		jest.advanceTimersByTime(149);
		expect(calls).toBe(1);
		jest.advanceTimersByTime(1);
		expect(calls).toBe(2);
		stop();
	});

	test("other files in the agent directory, and an event with no name, are not a config change", () => {
		const s = scripted();
		let calls = 0;
		watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			s.fs,
		);
		s.emit("change", "models.yml");
		s.emit("rename", "agent.db");
		s.emit("change", "config.yml.tmp");
		s.emit("change", null);
		jest.advanceTimersByTime(60_000);
		expect(calls).toBe(0);
	});

	test("an agent directory created after start is watched once it exists, and announced", () => {
		const s = scripted(false);
		let calls = 0;
		watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			s.fs,
		);
		// Polled for, once a second, until it is there.
		jest.advanceTimersByTime(5000);
		expect(s.opened).toEqual([]);
		s.appear();
		jest.advanceTimersByTime(999);
		expect(s.opened).toEqual([]);
		jest.advanceTimersByTime(1);
		expect(s.opened).toEqual([AGENT]);
		// What was in it already is a change: omp may have written the file before the directory could be watched.
		jest.advanceTimersByTime(150);
		expect(calls).toBe(1);
		// And it is not polled for any more.
		jest.advanceTimersByTime(5000);
		expect(s.opened).toEqual([AGENT]);

		s.emit("rename", "config.yml");
		jest.advanceTimersByTime(150);
		expect(calls).toBe(2);
	});

	test("stopping closes the watch, drops a change still waiting, and ends the poll for a directory that never came", () => {
		const s = scripted();
		let calls = 0;
		const stop = watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			s.fs,
		);
		s.emit("rename", "config.yml");
		stop();
		jest.advanceTimersByTime(60_000);
		expect(calls).toBe(0);
		expect(s.closed()).toBe(1);

		const late = scripted(false);
		const stopLate = watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			late.fs,
		);
		stopLate();
		late.appear();
		jest.advanceTimersByTime(60_000);
		expect(late.opened).toEqual([]);
		expect(calls).toBe(0);
	});

	test("a directory that cannot be watched is no error: the views refresh by themselves", () => {
		const s = scripted();
		const failing: ConfigWatchFs = {
			exists: s.fs.exists,
			watch: () => {
				throw new Error("EMFILE: too many open files");
			},
		};
		let calls = 0;
		const stop = watchOmpConfig(
			AGENT,
			() => {
				calls++;
			},
			failing,
		);
		jest.advanceTimersByTime(60_000);
		expect(calls).toBe(0);
		expect(() => stop()).not.toThrow();
	});
});

test("on the real file system a config.yml replaced by rename is reported", async () => {
	const root = mkdtempSync(join(tmpdir(), "ompw-cfgwatch-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	const reported = Promise.withResolvers<void>();
	let told = false;
	const stop = watchOmpConfig(agent, () => {
		told = true;
		reported.resolve();
	});
	let writes = 0;
	try {
		// How omp saves: a temporary file renamed over config.yml. The file system may not tell (see the top of this file),
		// so it is written again until it does; what ends the loop is the report, and the wait for one is only how long a
		// write is given before the next. There is no event for a change the platform dropped.
		while (!told) {
			if (writes === 50) throw new Error("the file system reported no change in 50 writes of config.yml");
			writeFileSync(join(agent, "config.yml.tmp"), `modelRoles: {default: a/b${writes++}}\n`);
			renameSync(join(agent, "config.yml.tmp"), join(agent, "config.yml"));
			await Promise.race([reported.promise, Bun.sleep(400)]);
		}
	} finally {
		stop();
		rmSync(root, { recursive: true, force: true });
	}
	expect(writes).toBeGreaterThan(0);
}, 30_000);
