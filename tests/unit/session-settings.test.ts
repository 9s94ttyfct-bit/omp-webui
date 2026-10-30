import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Config } from "../../server/config.ts";
import type { Live } from "../../server/live.ts";
import { ProcessOverlay } from "../../server/omp/approval.ts";
import { type ParkedRecord, ParkedStore } from "../../server/omp/parked.ts";
import { configuredSettings, flagValues, scopeOf } from "../../server/omp/session-settings.ts";
import {
	type ConfigValue,
	choiceOf,
	configKey,
	isChoice,
	SESSION_DEFAULTS,
	sessionSettingsOf,
	UNREPORTED,
} from "../../shared/session-defaults.ts";

/**
 * What a conversation's omp uses of the controls it cannot report (auto-retry, cache warming), worked out by the server:
 * the choices omp's settings stand for, and how `omp config list` is made to read what the process reads.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-settings-")));
	dirs.push(dir);
	return dir;
}

test("the controls omp cannot report are the two it only lets a client set, and each says which omp setting holds it", () => {
	expect([...UNREPORTED]).toEqual(["autoRetry", "cacheWarming"]);
	expect(configKey("autoRetry")).toBe("retry.enabled");
	expect(configKey("cacheWarming")).toBe("providers.cacheWarming");
	// Every one has a default to make: the star writes the very setting that is read.
	for (const setting of UNREPORTED) expect(Object.hasOwn(SESSION_DEFAULTS, setting)).toBe(true);
});

test("omp's setting values are the words of the control's choices, and nothing else is one", () => {
	expect(choiceOf("autoRetry", true)).toBe("on");
	expect(choiceOf("autoRetry", false)).toBe("off");
	expect(choiceOf("autoRetry", "true")).toBeUndefined();
	expect(choiceOf("autoRetry", undefined)).toBeUndefined();
	for (const mode of ["off", "streaming", "idle"]) expect(choiceOf("cacheWarming", mode)).toBe(mode);
	expect(choiceOf("cacheWarming", "always")).toBeUndefined();
	expect(choiceOf("cacheWarming", true)).toBeUndefined();

	expect(isChoice("autoRetry", "on")).toBe(true);
	expect(isChoice("autoRetry", "streaming")).toBe(false);
	expect(isChoice("cacheWarming", "idle")).toBe(true);
	expect(isChoice("cacheWarming", 3)).toBe(false);
});

test("a record of what a process was told keeps what is a choice and drops the rest", () => {
	expect(sessionSettingsOf({ autoRetry: "off", cacheWarming: "streaming" })).toEqual({
		autoRetry: "off",
		cacheWarming: "streaming",
	});
	expect(sessionSettingsOf({ autoRetry: "maybe", cacheWarming: "idle", other: "x" })).toEqual({ cacheWarming: "idle" });
	expect(sessionSettingsOf({ autoRetry: true })).toEqual({});
	for (const nothing of [null, undefined, "off", 7, []]) expect(sessionSettingsOf(nothing)).toEqual({});
});

test("the flag's values are read as the command line gives them, in order, up to --", () => {
	const args = [
		"--resume",
		"a.jsonl",
		"--config",
		"one.yml",
		"--config=two.yml",
		"--model",
		"x",
		"--",
		"--config",
		"three.yml",
	];
	expect(flagValues(args, "--config")).toEqual(["one.yml", "two.yml"]);
	expect(flagValues(args, "--profile")).toEqual([]);
	// A flag with nothing after it has no value.
	expect(flagValues(["--config"], "--config")).toEqual([]);
});

test("the config files go in PI_CONFIG_FILES in the order omp reads them, and a profile is passed on; the server's overlay is not one of them", () => {
	const none = scopeOf([], { PI_CODING_AGENT_DIR: "/agent" });
	expect(none).toEqual({ env: { PI_CODING_AGENT_DIR: "/agent" } });

	const mine = scopeOf(["--config", "own.yml", "--profile", "work", "--config=more.yml"], {
		PI_CODING_AGENT_DIR: "/agent",
		PI_CONFIG_FILES: ["/etc/a.yml", "/etc/b.yml"].join(delimiter),
	});
	// The environment's files, then the `--config` flags: the last one a setting is in is the one omp uses.
	expect(mine.env?.PI_CONFIG_FILES).toBe(["/etc/a.yml", "/etc/b.yml", "own.yml", "more.yml"].join(delimiter));
	expect(mine.env?.PI_CODING_AGENT_DIR).toBe("/agent");
	expect(mine.flags).toEqual(["--profile", "work"]);

	// The last `--profile` is the one omp takes.
	expect(scopeOf(["--profile=a", "--profile", "b"], {}).flags).toEqual(["--profile", "b"]);
});

/**
 * An omp that logs how it was run and answers `config list --json` the way the test's `answers` says (each setting by its
 * key, with its `value`). As omp does, it refuses a config file it is told to load (`PI_CONFIG_FILES`) that is not there;
 * `fail` makes it exit 1, `hang` never answer.
 */
function fakeOmp(answers: Record<string, unknown>, how: { fail?: boolean; hang?: boolean } = {}) {
	const dir = scratch();
	const bin = join(dir, "omp");
	const log = join(dir, "log");
	const listing = JSON.stringify(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])));
	writeFileSync(
		bin,
		[
			"#!/bin/sh",
			'printf \'%s\\t%s\\t%s\\t%s\\n\' "$PWD" "$PI_CODING_AGENT_DIR" "$PI_CONFIG_FILES" "$*" >> "$OMP_LOG"',
			...(how.hang ? ["exec sleep 30"] : []),
			`IFS=${delimiter}; for f in $PI_CONFIG_FILES; do [ -e "$f" ] || { echo "error: Config overlay not found: $f" >&2; exit 1; }; done`,
			...(how.fail ? ['echo "error: omp could not read its settings" >&2; exit 1'] : []),
			`echo '${listing}'`,
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	return { cfg: { ompBin: bin, dataDir: dir } as Config, log, dir };
}

/** The ways omp was run, one line each (see `fakeOmp`): folder, agent directory, config files, command line. */
const runs = (log: string): string[][] =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => line.split("\t"))
		: [];

/** Only what `configuredSettings` reads of a conversation: `overlay` is the one it holds its settings in. */
const conversation = (o: {
	cwd: string;
	env: Record<string, string>;
	ownArgs?: string[];
	overlay?: ProcessOverlay;
	overlaySettings?: Record<string, ConfigValue>;
}) =>
	({
		info: { liveId: "L1", cwd: o.cwd },
		env: o.env,
		ownArgs: o.ownArgs ?? [],
		get overlaySettings() {
			return o.overlay?.settings ?? o.overlaySettings ?? {};
		},
	}) as unknown as Live;

test("the settings a process loaded decide what it uses where it was told nothing: omp is asked once, in its folder, with its agent directory, files and profile", async () => {
	const { cfg, log } = fakeOmp({ "retry.enabled": false, "providers.cacheWarming": "streaming" });
	const folder = scratch();
	writeFileSync(join(folder, "own.yml"), "");
	const live = conversation({
		cwd: folder,
		env: { OMP_LOG: log, PI_CODING_AGENT_DIR: "/offline/agent" },
		ownArgs: ["--config", "own.yml", "--profile", "work"],
	});

	expect(await configuredSettings(cfg, live)).toEqual({ autoRetry: "off", cacheWarming: "streaming" });

	// One omp start answers for both controls, not one per control.
	const calls = runs(log);
	expect(calls).toHaveLength(1);
	const [cwd, agentDir, files, argv] = calls[0];
	expect(cwd).toBe(folder);
	expect(agentDir).toBe("/offline/agent");
	expect(files).toBe("own.yml");
	expect(argv).toBe("--profile work config list --json");
});

test("omp's defaults and every other value of a setting are what omp answers: a choice, or nothing", async () => {
	const defaults = fakeOmp({ "retry.enabled": true, "providers.cacheWarming": "idle" });
	const where = conversation({ cwd: scratch(), env: { OMP_LOG: defaults.log } });
	expect(await configuredSettings(defaults.cfg, where)).toEqual({ autoRetry: "on", cacheWarming: "idle" });

	// A value that is none of the choices is not one to show (omp itself falls back to its default for it).
	const odd = fakeOmp({ "retry.enabled": "yes", "providers.cacheWarming": "always" });
	expect(await configuredSettings(odd.cfg, conversation({ cwd: scratch(), env: { OMP_LOG: odd.log } }))).toEqual({});
});

test("what the process's overlay holds it at is the server's to say: over omp's files, and omp is asked for the rest only", async () => {
	const answers = { "retry.enabled": false, "providers.cacheWarming": "streaming" };
	const one = fakeOmp(answers);
	const held = conversation({ cwd: scratch(), env: { OMP_LOG: one.log }, overlaySettings: { "retry.enabled": true } });
	expect(await configuredSettings(one.cfg, held)).toEqual({ autoRetry: "on", cacheWarming: "streaming" });
	expect(runs(one.log)).toHaveLength(1);

	// Holding both, it needs no omp at all.
	const none = fakeOmp(answers);
	const both = conversation({
		cwd: scratch(),
		env: { OMP_LOG: none.log },
		overlaySettings: { "retry.enabled": true, "providers.cacheWarming": "off", "tools.approvalMode": "yolo" },
	});
	expect(await configuredSettings(none.cfg, both)).toEqual({ autoRetry: "on", cacheWarming: "off" });
	expect(runs(none.log)).toEqual([]);
});

test("the overlay file of a running process is not needed: with it taken away the panel reads what it read before (#600)", async () => {
	const omp = fakeOmp({ "retry.enabled": true, "providers.cacheWarming": "streaming" });
	// The overlay holds auto-retry off; cache warming is the config's.
	const overlay = new ProcessOverlay(join(scratch(), "L1.yml"), null, 0, null, null, [], { "retry.enabled": false });
	expect(overlay.settings).toEqual({ "retry.enabled": false });
	const live = conversation({ cwd: scratch(), env: { OMP_LOG: omp.log }, overlay });
	const read = { autoRetry: "off", cacheWarming: "streaming" };
	expect(await configuredSettings(omp.cfg, live)).toEqual(read);

	rmSync(overlay.file);
	expect(await configuredSettings(omp.cfg, live)).toEqual(read);
	// omp was never told to load it (it refuses a file that is not there, as the real one does).
	for (const [, , files] of runs(omp.log)) expect(files).toBe("");
});

test("a folder that is gone is read from the data directory, and what omp cannot say is left out, not guessed: what the process is held at stays", async () => {
	const quiet = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { cfg, log, dir } = fakeOmp({ "retry.enabled": true }, { fail: true });
		const gone = join(dir, "no-such-folder");
		expect(await configuredSettings(cfg, conversation({ cwd: gone, env: { OMP_LOG: log } }))).toEqual({});
		const held = conversation({
			cwd: gone,
			env: { OMP_LOG: log },
			overlaySettings: { "providers.cacheWarming": "off" },
		});
		expect(await configuredSettings(cfg, held)).toEqual({ cacheWarming: "off" });
		for (const [cwd] of runs(log)) expect(cwd).toBe(dir);
		expect(quiet).toHaveBeenCalledTimes(2);
	} finally {
		quiet.mockRestore();
	}
});

test("an omp that does not answer is given up on within its limit, and the reads behind it go on", async () => {
	const quiet = spyOn(console, "error").mockImplementation(() => {});
	try {
		const hung = fakeOmp({}, { hang: true });
		const fine = fakeOmp({ "retry.enabled": false, "providers.cacheWarming": "off" });
		const [stuck, behind] = await Promise.all([
			// The limit itself is what is tried, so it runs on the real clock.
			configuredSettings(hung.cfg, conversation({ cwd: scratch(), env: { OMP_LOG: hung.log } }), 500),
			configuredSettings(fine.cfg, conversation({ cwd: scratch(), env: { OMP_LOG: fine.log } })),
		]);
		expect(stuck).toEqual({});
		expect(behind).toEqual({ autoRetry: "off", cacheWarming: "off" });
		expect(quiet).toHaveBeenCalledTimes(1);
	} finally {
		quiet.mockRestore();
	}
});

test("a conversation paused with what it was told is recorded with it, and a damaged entry costs only itself", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	const base: ParkedRecord = {
		version: 1,
		liveId: "L1",
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: "/tmp/x.sock",
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full",
		startedAt: 1,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: null,
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
	store.save({ ...base, sessionSettings: { autoRetry: "off", cacheWarming: "streaming" } });
	expect(store.list()[0].sessionSettings).toEqual({ autoRetry: "off", cacheWarming: "streaming" });

	// A record an older server wrote has none.
	store.save(base);
	expect(store.list()[0].sessionSettings).toEqual({});
	store.save({ ...base, sessionSettings: { autoRetry: "perhaps", cacheWarming: "idle" } as never });
	expect(store.list()[0].sessionSettings).toEqual({ cacheWarming: "idle" });
});
