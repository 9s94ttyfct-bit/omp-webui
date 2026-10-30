import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../server/config.ts";
import type { Live } from "../../server/live.ts";
import { ApprovalStore, ProcessOverlay } from "../../server/omp/approval.ts";
import { type ParkedRecord, ParkedStore } from "../../server/omp/parked.ts";
import { heldBy } from "../../server/omp/session-defaults.ts";
import {
	type Definition,
	defaultWrites,
	SESSION_DEFAULT_KEYS,
	SESSION_DEFAULTS,
	serviceTierFamily,
	type Write,
} from "../../shared/session-defaults.ts";

/**
 * "Set as default" in the session controls: which omp settings each control writes, and how a running process is held
 * at what it has while the global config changes under it (`ProcessOverlay.pin`) and across a server restart.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-defaults-"));
	dirs.push(dir);
	return dir;
}

test("each control writes the omp settings it stands for, and nothing that is not a choice of it", () => {
	expect(defaultWrites("autoCompaction", "off")).toEqual([{ key: "compaction.enabled", value: false }]);
	expect(defaultWrites("autoRetry", "on")).toEqual([{ key: "retry.enabled", value: true }]);
	expect(defaultWrites("steeringMode", "one-at-a-time")).toEqual([{ key: "steeringMode", value: "one-at-a-time" }]);
	expect(defaultWrites("interruptMode", "wait")).toEqual([{ key: "interruptMode", value: "wait" }]);
	expect(defaultWrites("cacheWarming", "streaming")).toEqual([{ key: "providers.cacheWarming", value: "streaming" }]);

	expect(defaultWrites("steeringMode", "on")).toBeNull();
	expect(defaultWrites("cacheWarming", "")).toBeNull();
	expect(defaultWrites("steeringMode", true)).toBeNull();
	// Slow mode is global in omp already, and a name that is not a control (or is an object's own) is no control either.
	for (const setting of ["slowMode", "toString", "__proto__", "constructor", undefined, 7])
		expect(defaultWrites(setting, "on")).toBeNull();
});

test("fast mode is the tier of the conversation's own family only, and off clears a fast tier and nothing else (#486)", () => {
	for (const family of ["anthropic", "openai", "google"] as const) {
		expect(defaultWrites("fastMode", "on", family)).toEqual([{ key: `tier.${family}`, value: "priority" }]);
		expect(defaultWrites("fastMode", "off", family)).toEqual([
			{ key: `tier.${family}`, value: "none", over: ["priority", "ultrafast"] },
		]);
	}
	// No family, no tier to set.
	expect(defaultWrites("fastMode", "on")).toBeNull();
	expect(defaultWrites("fastMode", "off", null)).toBeNull();
});

test("the family of a model is the one omp's /fast acts on; models whose family omp works out from what they are have none here (#486)", () => {
	expect(serviceTierFamily({ provider: "anthropic", api: "anthropic-messages" })).toBe("anthropic");
	// A Claude model reached through another provider's Anthropic API (a proxy, Bedrock) is Anthropic's.
	expect(serviceTierFamily({ provider: "my-proxy", api: "anthropic-messages" })).toBe("anthropic");
	expect(serviceTierFamily({ provider: "openai", api: "openai-responses" })).toBe("openai");
	expect(serviceTierFamily({ provider: "openai-codex", api: "openai-codex-responses" })).toBe("openai");
	expect(serviceTierFamily({ provider: "google", api: "google-generative-ai" })).toBe("google");
	expect(serviceTierFamily({ provider: "google-vertex", api: "google-vertex" })).toBe("google");
	// OpenRouter and local servers: omp looks at the model, which `get_state` does not say.
	expect(serviceTierFamily({ provider: "openrouter", api: "openai-completions" })).toBeNull();
	expect(serviceTierFamily({ provider: "omlx", api: "openai-completions" })).toBeNull();
	expect(serviceTierFamily(undefined)).toBeNull();
	expect(serviceTierFamily({})).toBeNull();
});

test("the settings an overlay may be asked to hold are exactly the ones a default writes", () => {
	const families = [null, "anthropic", "openai", "google"] as const;
	const written = Object.values(SESSION_DEFAULTS).flatMap((d: Definition) =>
		d.values.flatMap((v) => families.flatMap((f) => (d.writes(v, f) ?? []).map((w) => w.key))),
	);
	expect(Object.keys(SESSION_DEFAULT_KEYS).sort()).toEqual([...new Set(written)].sort());
	expect(Object.keys(SESSION_DEFAULT_KEYS)).toContain("tier.google");
});

test("an overlay holds a process at its settings as nested keys beside its usage wait, and a value held is never replaced", async () => {
	const file = join(scratch(), "L1.yml");
	const overlay = new ProcessOverlay(file, "always-ask", 0, true);

	await overlay.pin({ "compaction.enabled": true, steeringMode: "one-at-a-time", "retry.enabled": true });
	const text = readFileSync(file, "utf8");
	// `retry` is one mapping: the usage wait and the pinned setting under it.
	expect(text).toContain('compaction:\n  enabled: true\nsteeringMode: "one-at-a-time"\n');
	expect(text).toContain("retry:\n  enabled: true\n  waitForUsageReset: true\n");
	expect(text.match(/^retry:/gm)).toHaveLength(1);
	expect(text).toContain("  approvalMode: always-ask\n");

	// A later default finds the process holding what it had: the config's value then is not what the process has had.
	await overlay.pin({ steeringMode: "all", "compaction.enabled": false, interruptMode: "wait" });
	expect(overlay.pins).toEqual({
		"compaction.enabled": true,
		steeringMode: "one-at-a-time",
		"retry.enabled": true,
		interruptMode: "wait",
	});
	expect(readFileSync(file, "utf8")).toContain('interruptMode: "wait"');
	expect(readFileSync(file, "utf8")).not.toContain("steeringMode: all");
	// What the file says is what the server holds in memory: the settings of a running process are never read back from it.
	expect(overlay.settings).toEqual({ ...overlay.pins, "retry.waitForUsageReset": true });

	// The usage wait going back to omp's own leaves the pin of `retry.enabled` under `retry`.
	await overlay.setWait(null);
	expect(readFileSync(file, "utf8")).toContain("retry:\n  enabled: true\n");
	expect(readFileSync(file, "utf8")).not.toContain("waitForUsageReset");
	expect(overlay.settings).toEqual(overlay.pins);
});

test("an overlay with no pins reads as it always did", () => {
	const file = join(scratch(), "L1.yml");
	new ProcessOverlay(file, "yolo", 0, false);
	expect(readFileSync(file, "utf8")).toBe(
		[
			"# Generated by omp-webui for one conversation; omp reloads it when it changes.",
			"tools:",
			"  approval:",
			"    propose_goal: allow",
			"  approvalMode: yolo",
			"retry:",
			"  waitForUsageReset: false",
			"",
		].join("\n"),
	);
});

test("the pins of a paused conversation are recorded and written back when the next server takes it over; a damaged entry costs only itself", () => {
	const data = scratch();
	const file = join(data, "L1.yml");
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
	const pins = { steeringMode: "all", "compaction.enabled": false };
	store.save({ ...base, overlay: { file, mode: null, pins } });
	const read = store.list()[0];
	expect(read.overlay?.pins).toEqual(pins);

	new ApprovalStore("omp", data, 0).restore(file, null, null, null, [], read.overlay?.pins);
	expect(readFileSync(file, "utf8")).toContain('steeringMode: "all"\n');
	expect(readFileSync(file, "utf8")).toContain("compaction:\n  enabled: false\n");

	// A record an older server wrote has none; a setting that is not one a default writes, or a value that is no scalar, is dropped.
	store.save({ ...base, overlay: { file, mode: null } });
	expect(store.list()[0].overlay?.pins).toEqual({});
	store.save({
		...base,
		overlay: {
			file,
			mode: null,
			pins: { steeringMode: "all", "tools.approvalMode": "yolo", followUpMode: { a: 1 } } as never,
		},
	});
	expect(store.list()[0].overlay?.pins).toEqual({ steeringMode: "all" });
});

/** An omp whose `config get <key> --json` says `value` for every key (the configuration of the folder). */
function ompSaying(value: string): Config {
	const bin = join(scratch(), "omp");
	writeFileSync(bin, `#!/bin/sh\necho '{"value": ${value}}'\n`);
	chmodSync(bin, 0o755);
	// Only what `heldBy` reads of a configuration and a conversation is given.
	return { ompBin: bin, dataDir: tmpdir() } as Config;
}
const conversation = (args: string[]) =>
	// The server's own overlay is on the command line of every process; the user's flags are `ownArgs` (see `Live`).
	({ info: { cwd: tmpdir(), args: ["--config", "/data/omp-overlay.yml", ...args] }, ownArgs: args }) as unknown as Live;
const writeOf = (key: string, value: string | boolean): Write[] => [{ key, value }];

test("a process is held at what it says it has, not at what the configuration says, so a --config or --profile of its own is respected (#487)", async () => {
	const cfg = ompSaying('"one-at-a-time"');
	const writes = writeOf("steeringMode", "all");
	// The folder's configuration says one at a time; this process was told `all` by its own file and says so.
	expect(
		await heldBy(cfg, conversation(["--config=own.yml"]), "steeringMode", writes, null, { steeringMode: "all" }),
	).toEqual({ steeringMode: "all" });
	expect(await heldBy(cfg, conversation([]), "steeringMode", writes, null, { steeringMode: "one-at-a-time" })).toEqual({
		steeringMode: "one-at-a-time",
	});
	// Auto-compaction as the process reports it.
	expect(
		await heldBy(cfg, conversation([]), "autoCompaction", writeOf("compaction.enabled", false), null, {
			autoCompactionEnabled: true,
		}),
	).toEqual({ "compaction.enabled": true });
});

test("what omp does not report is the folder's configuration, except for a process with a configuration of its own (#487)", async () => {
	const cfg = ompSaying("true");
	const writes = writeOf("retry.enabled", false);
	expect(await heldBy(cfg, conversation([]), "autoRetry", writes, null, { steeringMode: "all" })).toEqual({
		"retry.enabled": true,
	});
	// A process that has not answered is held the same way.
	expect(await heldBy(cfg, conversation(["--model", "x"]), "autoRetry", writes, null, null)).toEqual({
		"retry.enabled": true,
	});
	for (const args of [["--config=a.yml"], ["--config", "a.yml"], ["--profile=work"], ["--profile", "work"]])
		expect(await heldBy(cfg, conversation(args), "autoRetry", writes, null, null)).toEqual({});
	// A flag that only starts with the same letters is not one.
	expect(await heldBy(cfg, conversation(["--configure-x"]), "autoRetry", writes, null, null)).toEqual({
		"retry.enabled": true,
	});
});

test("fast mode holds the tier a process of the same family runs on, a fast one or not, and leaves other families alone (#486)", async () => {
	const claude = { model: { provider: "anthropic", api: "anthropic-messages" } };
	const gpt = { model: { provider: "openai", api: "openai-responses" } };
	const writes = writeOf("tier.anthropic", "priority");
	// The configuration says flex while the process is not fast: that is kept, not turned into "none".
	expect(
		await heldBy(ompSaying('"flex"'), conversation([]), "fastMode", writes, "anthropic", {
			...claude,
			fastModeEnabled: false,
		}),
	).toEqual({ "tier.anthropic": "flex" });
	// Fast on by an ultrafast tier the configuration has: kept, not turned into "priority".
	expect(
		await heldBy(ompSaying('"ultrafast"'), conversation([]), "fastMode", writes, "anthropic", {
			...claude,
			fastModeEnabled: true,
		}),
	).toEqual({ "tier.anthropic": "ultrafast" });
	// Fast only for this process (the configuration has none), or off while the configuration is fast.
	expect(
		await heldBy(ompSaying('"none"'), conversation([]), "fastMode", writes, "anthropic", {
			...claude,
			fastModeEnabled: true,
		}),
	).toEqual({ "tier.anthropic": "priority" });
	expect(
		await heldBy(ompSaying('"priority"'), conversation([]), "fastMode", writes, "anthropic", {
			...claude,
			fastModeEnabled: false,
		}),
	).toEqual({ "tier.anthropic": "none" });
	// A process on another provider does not run on this tier.
	expect(
		await heldBy(ompSaying('"none"'), conversation([]), "fastMode", writes, "anthropic", {
			...gpt,
			fastModeEnabled: true,
		}),
	).toEqual({});
});

test("fast mode leaves a process with a --config or --profile of its own alone: get_state does not say which tier it has (#498)", async () => {
	const gpt = { model: { provider: "openai", api: "openai-responses" } };
	const writes = writeOf("tier.openai", "priority");
	for (const args of [["--config=own.yml"], ["--config", "own.yml"], ["--profile=work"], ["--profile", "work"]]) {
		// Its file says flex (not fast) or ultrafast (fast); the global config says none.
		for (const fastModeEnabled of [false, true])
			expect(
				await heldBy(ompSaying('"none"'), conversation(args), "fastMode", writes, "openai", {
					...gpt,
					fastModeEnabled,
				}),
			).toEqual({});
	}
	// Without one of its own it is held as before.
	expect(
		await heldBy(ompSaying('"none"'), conversation([]), "fastMode", writes, "openai", {
			...gpt,
			fastModeEnabled: false,
		}),
	).toEqual({ "tier.openai": "none" });
});

test("the server's own --config overlay is not the user's: a conversation is held for what the user chose (#510)", async () => {
	const gpt = { model: { provider: "openai", api: "openai-responses" } };
	const writes = writeOf("tier.openai", "priority");
	// The server passes its own overlay to every process (see `launchArgs`), so the command line always holds a
	// --config. That one is the server's, and the conversation is still held.
	const withServerOverlay = { info: { cwd: tmpdir(), args: ["--config", "/data/omp-overlay.yml"] }, ownArgs: [] };
	expect(
		await heldBy(ompSaying('"none"'), withServerOverlay as unknown as Live, "fastMode", writes, "openai", {
			...gpt,
			fastModeEnabled: false,
		}),
	).toEqual({ "tier.openai": "none" });
	// A --config of the user's own is in `ownArgs`, and the conversation is left as it is.
	const withOwnConfig = {
		info: { cwd: tmpdir(), args: ["--config", "/data/omp-overlay.yml", "--config", "mine.yml"] },
		ownArgs: ["--config=mine.yml"],
	};
	expect(
		await heldBy(ompSaying('"none"'), withOwnConfig as unknown as Live, "fastMode", writes, "openai", {
			...gpt,
			fastModeEnabled: false,
		}),
	).toEqual({});
	// The same for a setting omp does not report.
	const retry = writeOf("retry.enabled", false);
	expect(await heldBy(ompSaying("true"), withServerOverlay as unknown as Live, "autoRetry", retry, null, null)).toEqual(
		{ "retry.enabled": true },
	);
	expect(await heldBy(ompSaying("true"), withOwnConfig as unknown as Live, "autoRetry", retry, null, null)).toEqual({});
});
