import { afterAll, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleError, type LifecycleOptions, OmpLifecycle } from "../../server/omp/lifecycle.ts";
import type { Holds, OmpState } from "../../shared/omp-install.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import {
	makeToolbin,
	ompState,
	placeBrewOmp,
	startFakeRegistry,
	writeFakeBrew,
	writeFakeCurl,
	writeOmpTemplate,
} from "../support/fake-install.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * omp's life as the server runs it — missing, installed from the first-run screen, found broken, looked up for a
 * newer release, updated when no conversation is working — against launchers and installers that are shell
 * scripts, and a registry that is a local server. The machine's own omp, brew and registry are never touched.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-lifecycle-"));
let n = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

/*
 * A test that lives for seconds by design carries its own limit, `}, 60_000);`: it follows a fake install to its end
 * (`brew` sleeps `seconds` twice, fetching and installing: 6 s for `seconds: 3`, 24 s for `seconds: 12`), or waits out
 * a `ps` that does not answer (`COMMAND_MS` is 2 s, and a taken-over job asks more than once). Bun's default is 5 s per
 * test, which is what `bun test <file>` gives; the scripts pass `--timeout 30000`, which a file run by hand does not
 * get (#744). A test that is over its limit is only reported failed: its body goes on, and what it has put on `PATH`
 * and on `Date.now` stays in place for the tests after it. The limit is above every `pollUntil` deadline in the test,
 * so that a job that does not end fails saying what it waited for.
 */

interface Fixture {
	dir: string;
	home: string;
	prefix: string;
	toolbin: string;
	env: Record<string, string>;
	state: ReturnType<typeof ompState>;
	template: string;
	sent: ServerMessage[];
	activated: string[];
	/** What the conversations are doing now (`OmpHost.busy`): a test sets the kind it needs. */
	busy: Holds;
	make(opts?: LifecycleOptions): OmpLifecycle;
	/** The last state the lifecycle announced. */
	last(): OmpState;
	logOf(job: string): string;
}

/** A home, a Homebrew prefix on PATH (empty), and the programs the scripts need, all under one temp directory. */
function fixture(version = "18.12.0"): Fixture {
	const dir = join(root, `case${++n}`);
	const home = join(dir, "home");
	const prefix = join(dir, "prefix");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(dir, "data"), { recursive: true });
	const toolbin = makeToolbin(join(dir, "toolbin"));
	const state = ompState(join(dir, "state"), version);
	const template = writeOmpTemplate(join(dir, "omp-template"), state.dir, null);
	const env = { PATH: [join(prefix, "bin"), toolbin].join(":"), HOME: home };
	const sent: ServerMessage[] = [];
	const activated: string[] = [];
	const busy: Holds = { working: 0, asking: 0, paused: 0 };
	const f: Fixture = {
		dir,
		home,
		prefix,
		toolbin,
		env,
		state,
		template,
		sent,
		activated,
		busy,
		make: (opts = {}) =>
			new OmpLifecycle(
				fakeConfig(join(dir, "data"), "omp"),
				{
					busy: () => ({ ...busy }),
					activate: async (bin) => {
						activated.push(bin);
						return "unused";
					},
					broadcast: (m) => sent.push(m),
				},
				{ env, home, checkEnabled: false, tickMs: 15, ...opts },
			),
		last: () => {
			const m = sent.findLast((x) => x.t === "omp");
			if (m?.t !== "omp") throw new Error("nothing announced yet");
			return m.state;
		},
		logOf: (job) =>
			sent
				.filter((m) => m.t === "omp_log" && m.job === job)
				.map((m) => (m.t === "omp_log" ? m.text : ""))
				.join(""),
	};
	return f;
}

/** A fake `brew` on PATH that installs `version` into the prefix. */
function withBrew(f: Fixture, version = "18.12.0") {
	const log = join(f.dir, "brew.log");
	writeFakeBrew(join(f.toolbin, "brew"), { prefix: f.prefix, template: f.template, version, log });
	return { log };
}

test("without omp the server is told so, and offers the ways to install it", async () => {
	const f = fixture();
	const omp = f.make();
	await omp.init();
	expect(omp.ready).toBe(false);
	const s = omp.state();
	expect(s.status).toBe("missing");
	expect(s.bin).toBeNull();
	expect(s.searched).toEqual([
		join(f.prefix, "bin"),
		f.toolbin,
		join(f.home, ".local", "bin"),
		join(f.home, ".bun", "bin"),
	]);
	// `sh` and `bun` are in the toolbin; brew and curl are not.
	expect(s.options.map((o) => [o.id, o.available])).toEqual([
		["homebrew", false],
		["installer", false],
		["bun", true],
	]);
});

test("an omp that does not run is reported as broken, with what it said", async () => {
	const f = fixture();
	mkdirSync(join(f.prefix, "bin"), { recursive: true });
	const bin = join(f.prefix, "bin", "omp");
	writeFileSync(bin, "#!/bin/sh\necho 'dyld: Library not loaded' >&2\nexit 1\n");
	chmodSync(bin, 0o755);
	const omp = f.make();
	await omp.init();
	const s = omp.state();
	expect(s.status).toBe("broken");
	expect(s.error).toContain("Library not loaded");
	expect(s.bin).toBe(bin);
	expect(s.options.length).toBeGreaterThan(0);
});

test("an omp that exits cleanly runs, even when its version text is in a format this cannot read", async () => {
	const f = fixture();
	mkdirSync(join(f.prefix, "bin"), { recursive: true });
	const bin = join(f.prefix, "bin", "omp");
	writeFileSync(bin, "#!/bin/sh\necho 'omp next-build'\n");
	chmodSync(bin, 0o755);
	const omp = f.make();
	await omp.init();
	// Not turned away for a version it cannot parse; whether it is supported is simply not known.
	expect(omp.ready).toBe(true);
	expect(omp.state()).toMatchObject({ status: "ready", version: "omp next-build", compat: { verdict: "unknown" } });
});

test("'Look again' reads the environment again first, so an omp a shell file now puts on PATH is found", async () => {
	const f = fixture();
	const late = join(f.dir, "late", "bin");
	let reads = 0;
	const omp = f.make({
		refreshEnv: async () => {
			reads++;
			f.env.PATH = [late, f.env.PATH].join(":");
		},
	});
	await omp.init();
	expect(omp.ready).toBe(false);
	// The user edits a shell file, which puts a directory with omp on PATH (here: the launcher appears in it).
	mkdirSync(late, { recursive: true });
	writeOmpTemplate(join(late, "omp"), f.state.dir, null);
	await omp.recheck();
	expect(reads).toBe(1);
	expect(omp.ready).toBe(true);
	expect(f.activated).toEqual([join(late, "omp")]);
});

test("installing with Homebrew streams the install, finds omp afterwards, adopts it and begins the setup", async () => {
	const f = fixture();
	const { log } = withBrew(f);
	const omp = f.make();
	await omp.init();
	omp.startInstall("homebrew");

	// Running at once, with the command the screen showed.
	const running = f.last();
	expect(running.job).toMatchObject({
		kind: "install",
		method: "homebrew",
		state: "running",
		command: "brew install can1357/tap/omp",
	});
	await pollUntil(() => f.last().job?.state === "done", "the install to end");

	const done = f.last();
	expect(done.status).toBe("ready");
	expect(done.version).toBe("18.12.0");
	expect(done.job).toMatchObject({ state: "done", exitCode: 0, version: "18.12.0", error: null });
	expect(done.install).toMatchObject({ method: "homebrew", updatable: true });
	expect(done.options).toEqual([]);
	// The first-time setup is next, and survives a restart of the server.
	expect(done.onboarding).toBe(true);
	expect(JSON.parse(readFileSync(join(f.dir, "data", "omp.json"), "utf8"))).toMatchObject({ onboarding: true });
	// What the install printed reached the page as it came; everything that holds omp's path was told.
	expect(f.logOf(done.job?.id ?? "")).toContain("==> Installing omp");
	expect(omp.snapshot().log).toContain("omp was successfully installed!");
	expect(f.activated).toEqual([join(f.prefix, "bin", "omp")]);
	expect(readFileSync(log, "utf8")).toContain("brew install can1357/tap/omp");

	// Finishing the setup clears the install that led to it.
	omp.setOnboarding(false);
	expect(f.last().onboarding).toBe(false);
	expect(f.last().job).toBeNull();
});

test("omp installed where PATH does not reach (the installer's ~/.local/bin) is found there", async () => {
	const f = fixture();
	// A fake `curl` whose installer puts the launcher in ~/.local/bin, as omp's installer does.
	writeFakeCurl(join(f.toolbin, "curl"), { template: f.template, log: join(f.dir, "curl.log") });
	const omp = f.make();
	await omp.init();
	omp.startInstall("installer");
	await pollUntil(() => f.last().job?.state === "done", "the install to end");
	expect(f.last().bin).toBe(join(f.home, ".local", "bin", "omp"));
	expect(readFileSync(join(f.dir, "curl.log"), "utf8")).toContain("https://omp.sh/install");
	// The server's own PATH now reaches it, for the omp processes it starts.
	expect(f.env.PATH.split(":")[0]).toBe(join(f.home, ".local", "bin"));
});

test("an installer download that fails fails the job with curl's own message, not 'omp was not found'", async () => {
	const f = fixture();
	const unreachable = join(f.dir, "unreachable");
	writeFileSync(unreachable, "");
	writeFakeCurl(join(f.toolbin, "curl"), {
		template: f.template,
		log: join(f.dir, "curl.log"),
		downloadFailFlag: unreachable,
	});
	// A temp directory of its own: nothing the installer downloaded may be left in it.
	const tmp = join(f.dir, "tmp");
	mkdirSync(tmp);
	f.env.TMPDIR = tmp;
	const omp = f.make();
	await omp.init();
	omp.startInstall("installer");
	await pollUntil(() => f.last().job?.state === "failed", "the install to fail");
	const job = f.last().job;
	expect(job?.exitCode).toBe(6);
	expect(job?.error).toContain("exited with code 6");
	expect(job?.error).toContain("curl: (6) Could not resolve host: omp.sh");
	expect(job?.error).not.toContain("was not found afterwards");
	expect(f.last().status).toBe("missing");
	expect(readdirSync(tmp)).toEqual([]);

	// Back online, the same option installs, and the file it downloaded is gone afterwards too.
	rmSync(unreachable);
	omp.cancel();
	omp.startInstall("installer");
	await pollUntil(() => f.last().job?.state === "done", "the second install to end");
	expect(readdirSync(tmp)).toEqual([]);
});

test("a failed install says what failed and can be dismissed to try again", async () => {
	const f = fixture();
	withBrew(f);
	mkdirSync(f.prefix, { recursive: true });
	writeFileSync(join(f.prefix, ".fail"), "");
	const omp = f.make();
	await omp.init();
	omp.startInstall("homebrew");
	await pollUntil(() => f.last().job?.state === "failed", "the install to fail");
	const failed = f.last();
	expect(failed.status).toBe("missing");
	expect(failed.job?.exitCode).toBe(1);
	expect(failed.job?.error).toContain("exited with code 1");
	expect(failed.job?.error).toContain("simulated install failure");
	expect(failed.onboarding).toBe(false);

	// Dismissed, the screen is back to its options; a second try works.
	omp.cancel();
	expect(f.last().job).toBeNull();
	rmSync(join(f.prefix, ".fail"));
	omp.startInstall("homebrew");
	await pollUntil(() => f.last().job?.state === "done", "the second install to end");
	expect(f.last().status).toBe("ready");
});

test("an installer that succeeds without leaving omp anywhere findable is a failure that names where it looked", async () => {
	const f = fixture();
	writeFileSync(join(f.toolbin, "brew"), "#!/bin/sh\necho done\nexit 0\n");
	chmodSync(join(f.toolbin, "brew"), 0o755);
	const omp = f.make();
	await omp.init();
	omp.startInstall("homebrew");
	await pollUntil(() => f.last().job?.state === "failed", "the install to fail");
	expect(f.last().job?.error).toContain("omp was not found afterwards");
	expect(f.last().job?.error).toContain(join(f.home, ".local", "bin"));
	expect(f.last().status).toBe("missing");
});

test("only the table's install methods run, and only where omp is missing and nothing else is running", async () => {
	const f = fixture();
	withBrew(f);
	const omp = f.make();
	await omp.init();
	expect(() => omp.startInstall("rm -rf /")).toThrow(LifecycleError);
	expect(() => omp.startInstall("bun-but-not-installed")).toThrow("Unknown install method");
	expect(() => omp.startInstall("installer")).toThrow("curl was not found");
	omp.startInstall("homebrew");
	expect(() => omp.startInstall("homebrew")).toThrow("already running");
	await pollUntil(() => f.last().job?.state === "done", "the install to end");
	expect(() => omp.startInstall("homebrew")).toThrow("already installed");
});

test("a running install can be cancelled", async () => {
	const f = fixture();
	// `brew` that takes a while and leaves a marker when it gets past the wait.
	writeFileSync(join(f.toolbin, "brew"), `#!/bin/sh\necho started\nsleep 5\ntouch "${f.dir}/finished"\n`);
	chmodSync(join(f.toolbin, "brew"), 0o755);
	const omp = f.make();
	await omp.init();
	omp.startInstall("homebrew");
	await pollUntil(() => omp.snapshot().log.includes("started"), "the install to start");
	omp.cancel();
	await pollUntil(() => f.last().job?.state === "failed", "the install to stop");
	expect(f.last().job?.error).toBe("Cancelled");
	expect(existsSync(join(f.dir, "finished"))).toBe(false);
});

test("an install keeps running when the server that started it goes away, and the next server finishes the job", async () => {
	const f = fixture();
	withBrew(f);
	// Slower than the test's own steps, so the first server is gone while brew still works.
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		seconds: 1.2,
	});
	const first = f.make();
	await first.init();
	first.startInstall("homebrew");
	await pollUntil(() => first.snapshot().log.includes("==> Fetching"), "the install to be under way");
	expect(first.runningJob()).toEqual({ kind: "install", command: "brew install can1357/tap/omp" });
	first.stop(); // the server goes away; the job is not its to end

	// A second server on the same data dir takes the job over where it stands: running, not forgotten.
	const second = f.make();
	await second.init();
	expect(second.ready).toBe(false);
	expect(second.state().job).toMatchObject({ kind: "install", method: "homebrew", state: "running" });
	expect(second.snapshot().log).toContain("==> Fetching");
	second.start();
	await pollUntil(() => f.last().job?.state === "done", "the install to end", 15_000);
	second.stop();
	expect(f.last()).toMatchObject({ status: "ready", version: "18.12.0", onboarding: true });
	expect(f.activated).toEqual([join(f.prefix, "bin", "omp")]);
	// What brew said after the first server was gone reached the second.
	expect(f.logOf(f.last().job?.id ?? "")).toContain("omp was successfully installed!");
	// Done is done: a third server finds no job.
	const third = f.make();
	await third.init();
	expect(third.state().job).toBeNull();
});

test("an install whose start time could not be read is still taken over, and finishes (#507)", async () => {
	const f = fixture();
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		// Long enough that the installer is still working when the next server looks at the job.
		seconds: 12,
	});
	// A `ps` that cannot answer in time, as one on a machine whose process table cannot be read: the server that
	// starts the job is not told when its process began, and must not read that as "the job is over".
	const bin = join(f.dir, "blind-bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), `#!/bin/sh\n/bin/sleep 60\n`);
	chmodSync(join(bin, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		const first = f.make();
		await first.init();
		first.startInstall("homebrew");
		await pollUntil(() => first.snapshot().log.includes("==> Fetching"), "the install to be under way");
		first.stop(); // the server goes away; the job is not its to end
		// The record keeps the job's process, though its start time was never read.
		const record = JSON.parse(readFileSync(join(f.dir, "data", "omp-job", "job.json"), "utf8"));
		expect(record.process.pid).toBeGreaterThan(0);

		// The next server takes the job over where it stands: it is not forgotten, and it is not settled as stopped
		// while the installer is still working.
		const second = f.make();
		await second.init();
		expect(second.state().job).toMatchObject({ kind: "install" });
		expect(second.state().job?.state).not.toBe("failed");
		second.start();
		await pollUntil(() => f.last().job?.state === "done", "the install to end", 30_000);
		second.stop();
		expect(f.last()).toMatchObject({ status: "ready", version: "18.12.0" });
	} finally {
		process.env.PATH = path;
	}
}, 60_000);

test("the record of a running job is written at once, not after a `ps` that cannot answer (#536)", async () => {
	const f = fixture();
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		seconds: 20,
	});
	// A `ps` that takes longer than the limit of one, as one on a machine whose process table cannot be read: the
	// record of the job must be there all the same, or a server that goes away leaves the job to nobody.
	const bin = join(f.dir, "slow-bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), `#!/bin/sh\n/bin/sleep 11\n`);
	chmodSync(join(bin, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		const first = f.make();
		await first.init();
		first.startInstall("homebrew");
		// The record is there while the `ps` is still being waited for: it is written before it is asked.
		await pollUntil(
			() => {
				try {
					const record = JSON.parse(readFileSync(join(f.dir, "data", "omp-job", "job.json"), "utf8"));
					return typeof record.process?.pid === "number" && record.process.pid > 0;
				} catch {
					return false;
				}
			},
			"the job's record to be written with its process",
			5_000,
		);
		first.stop();
	} finally {
		process.env.PATH = path;
	}
});

test("a record whose process cannot be told from a stranger settles, and the stranger is left alone (#543)", async () => {
	const f = fixture();
	// A process that is none of the job's: the system gave the job's id to it.
	const stranger = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
	const jobDir = join(f.dir, "data", "omp-job");
	mkdirSync(jobDir, { recursive: true });
	// The record of a job whose process could not be told from a stranger: its start time is not known.
	writeFileSync(
		join(jobDir, "job.json"),
		JSON.stringify({
			version: 1,
			kind: "install",
			method: "homebrew",
			command: "brew install can1357/tap/omp",
			auto: false,
			startedAt: Date.now() - 5000,
			before: null,
			process: { pid: stranger.pid, started: "", marker: join(jobDir, "exit") },
		}),
	);
	try {
		const omp = f.make();
		await omp.init();
		// The job is settled: the process on that id is not the job's, and a job that cannot be confirmed never
		// settles, so the page would show an install running that is not.
		await pollUntil(() => omp.state().job?.state !== "running", "the job to be settled", 20_000);
		expect(omp.state().job?.state).toBe("failed");
		// The stranger is left alone: it is not the job's process, and the job's group is not signalled.
		omp.cancel();
		await Bun.sleep(200);
		expect(stranger.signalCode).toBeNull();
		expect(stranger.exitCode).toBeNull();
	} finally {
		stranger.kill("SIGKILL");
	}
});

test("an install that ended while no server ran is settled by the next one, as if it had been watched", async () => {
	const f = fixture();
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		seconds: 0.5,
	});
	const first = f.make();
	await first.init();
	first.startInstall("homebrew");
	await pollUntil(() => first.snapshot().log.includes("==> Fetching"), "the install to be under way");
	first.stop(); // the server goes away; the job is not its to end
	await pollUntil(() => existsSync(join(f.dir, "data", "omp-job", "exit")), "brew to end on its own", 15_000);

	const second = f.make();
	await second.init();
	// Settled within `init`: omp is found, the job is over, and the first-time setup is pending.
	expect(second.ready).toBe(true);
	expect(second.state()).toMatchObject({ status: "ready", onboarding: true });
	expect(second.state().job).toMatchObject({ kind: "install", state: "done", version: "18.12.0" });
	expect(second.snapshot().log).toContain("omp was successfully installed!");
	expect(existsSync(join(f.dir, "data", "omp-job"))).toBe(false);
});

test("a job that is gone without having said how it ended is reported as stopped", async () => {
	const f = fixture();
	writeFileSync(join(f.toolbin, "brew"), `#!/bin/sh\necho started\nsleep 30\n`);
	chmodSync(join(f.toolbin, "brew"), 0o755);
	const first = f.make();
	await first.init();
	first.startInstall("homebrew");
	await pollUntil(() => first.snapshot().log.includes("started"), "the install to start");
	first.stop(); // the server goes away; the job is not its to end
	// The machine went down, or something killed the job's whole group.
	const record = JSON.parse(readFileSync(join(f.dir, "data", "omp-job", "job.json"), "utf8"));
	process.kill(-record.process.pid, "SIGKILL");
	await pollUntil(() => {
		try {
			process.kill(record.process.pid, 0);
			return false;
		} catch {
			return true;
		}
	}, "the job to be gone");

	const second = f.make();
	await second.init();
	expect(second.state().job).toMatchObject({ kind: "install", state: "failed", exitCode: null });
	expect(second.state().job?.error).toContain("was stopped before it finished");
	expect(second.state().job?.error).toContain("started");
	expect(second.ready).toBe(false);
});

/** An update that ended, with its status written, while no server ran: what an earlier server left in `omp-job`. */
function finishedUpdate(f: Fixture): string {
	placeBrewOmp(f.prefix, f.template, "18.12.0");
	const dir = join(f.dir, "data", "omp-job");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "job.json"),
		JSON.stringify({
			version: 1,
			kind: "update",
			method: "homebrew",
			command: "omp update",
			auto: false,
			startedAt: Date.now() - 1000,
			before: "18.11.0",
			process: null,
		}),
	);
	writeFileSync(join(dir, "output.log"), "Updated to 18.12.0.\n");
	writeFileSync(join(dir, "exit"), "0");
	return dir;
}

test("a job that cannot be settled at start-up does not stop the server, and is not met again by the next start (#310)", async () => {
	const f = fixture("18.12.0");
	const jobDir = finishedUpdate(f);
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		// The page's socket registry is what failed in the real server: announcing how the job ended threw.
		const broken = new OmpLifecycle(
			fakeConfig(join(f.dir, "data"), "omp"),
			{
				busy: () => ({ working: 0, asking: 0, paused: 0 }),
				activate: async () => "unused",
				broadcast: () => {
					throw new ReferenceError("Cannot access 'broadcastAll' before initialization.");
				},
			},
			{ env: f.env, home: f.home, checkEnabled: false, tickMs: 15 },
		);
		await broken.init();
		expect(broken.ready).toBe(true);
		expect(existsSync(jobDir)).toBe(false);
		expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toContain("could not settle the omp update");
	} finally {
		logged.mockRestore();
	}
	const next = f.make();
	await next.init();
	expect(next.ready).toBe(true);
	expect(next.state().job).toBeNull();
});

test("a job whose files cannot be followed is moved to omp-job.failed, says so on the page, and is gone for the next start (#310)", async () => {
	const f = fixture("18.12.0");
	const jobDir = finishedUpdate(f);
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		const omp = f.make();
		// `follow` is private; making the following of a job throw is not otherwise possible from outside.
		const inner = omp as unknown as { follow: () => Promise<void> };
		inner.follow = async () => {
			throw new Error("the output file cannot be read");
		};
		await omp.init();
		expect(omp.ready).toBe(true);
		expect(existsSync(jobDir)).toBe(false);
		expect(readFileSync(join(f.dir, "data", "omp-job.failed", "output.log"), "utf8")).toContain("Updated to 18.12.0.");
		const job = omp.state().job;
		expect(job).toMatchObject({ kind: "update", state: "failed", errorInfo: { code: "jobNotSettled" } });
		expect(job?.error).toContain("the output file cannot be read");
		expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toContain("omp-job.failed");
	} finally {
		logged.mockRestore();
	}
	const next = f.make();
	await next.init();
	expect(next.state().job).toBeNull();
});

test("an update a server started is taken over too, and still has to change the version", async () => {
	const { f, omp } = await installed("18.12.0", "18.13.0");
	f.state.setUpdateSeconds(1);
	omp.startUpdate(false);
	await pollUntil(() => f.state.updateCalls().length === 1, "omp update to start");
	omp.stop(); // the server goes away; the job is not its to end

	const second = f.make();
	await second.init();
	expect(second.state().job).toMatchObject({ kind: "update", state: "running" });
	second.start();
	await pollUntil(() => f.last().job?.state === "done", "the update to end", 15_000);
	second.stop();
	// The version it had before is the first server's, not what the second one saw after the update.
	expect(f.last()).toMatchObject({ version: "18.13.0" });
	expect(f.last().job).toMatchObject({ kind: "update", state: "done", version: "18.13.0" });
});

test("a job taken over is followed without stopping the server: timers keep running while `ps` is slow (#460)", async () => {
	const f = fixture();
	writeFileSync(join(f.toolbin, "brew"), `#!/bin/sh\necho started\nsleep 30\n`);
	chmodSync(join(f.toolbin, "brew"), 0o755);
	const first = f.make();
	await first.init();
	first.startInstall("homebrew");
	await pollUntil(() => first.snapshot().log.includes("started"), "the install to start");
	first.stop(); // the server goes away; the job is not its to end
	const record = JSON.parse(readFileSync(join(f.dir, "data", "omp-job", "job.json"), "utf8"));

	// A `ps` that takes 0.6 s to say when a process started, as one does on a machine that is busy.
	const bin = join(f.dir, "slow-bin");
	const calls = join(f.dir, "ps-calls");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "ps"),
		`#!/bin/sh\ncase "$*" in *lstart*) echo x >> ${calls}; /bin/sleep 0.6;; esac\nexec /bin/ps "$@"\n`,
	);
	chmodSync(join(bin, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	let longestGap = 0;
	try {
		const second = f.make();
		await second.init();
		second.start();
		// A real timer: what is measured is how long the event loop stands still, which a fake clock cannot show.
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			longestGap = Math.max(longestGap, now - last);
			last = now;
		}, 10);
		try {
			await pollUntil(
				() => existsSync(calls) && readFileSync(calls, "utf8").split("\n").filter(Boolean).length >= 3,
				"the job to be looked at again and again",
				15_000,
			);
		} finally {
			clearInterval(timer);
		}
		expect(second.state().job).toMatchObject({ kind: "install", state: "running" });
		second.stop();
	} finally {
		process.env.PATH = path;
		process.kill(-record.process.pid, "SIGKILL");
	}
	// The server never stood still for a look: a blocking `ps` leaves a gap as long as itself.
	expect(longestGap).toBeLessThan(300);
});

/** A directory with a `ps` in it that runs `script` (`exec /bin/ps "$@"` is the real one); the caller puts it on a PATH. */
function psShim(f: Fixture, script: string): string {
	const bin = join(f.dir, `ps-bin${++n}`);
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), `#!/bin/sh\n${script}\n`);
	chmodSync(join(bin, "ps"), 0o755);
	return bin;
}

/**
 * Run `work` with such a `ps` first on this process's PATH. What looks `ps` up when it runs (`Bun.spawn`) finds it; what
 * looked it up when the process started (`Bun.spawnSync`) does not.
 */
async function withPs<T>(f: Fixture, script: string, work: () => Promise<T>): Promise<T> {
	const bin = psShim(f, script);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		return await work();
	} finally {
		process.env.PATH = path;
	}
}

/** A `ps` that cannot say when a process started (the machine is loaded), and answers anything else as `ps` does. */
const BLIND_START = `case "$*" in *lstart*) /bin/sleep 30;; esac\nexec /bin/ps "$@"`;

/** The clock, `skew` ms ahead of the real one: the minute a fallback waits for passes without the test waiting it. */
function skewedClock(): { skew: (ms: number) => void; restore: () => void } {
	const real = Date.now.bind(Date);
	let ahead = 0;
	const spy = spyOn(Date, "now").mockImplementation(() => real() + ahead);
	return {
		skew: (ms) => {
			ahead = ms;
		},
		restore: () => spy.mockRestore(),
	};
}

test("a job this server started is not settled as unconfirmed while its process runs, however long `ps` is silent (#559)", async () => {
	const f = fixture();
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		seconds: 3,
	});
	const clock = skewedClock();
	try {
		await withPs(f, BLIND_START, async () => {
			const omp = f.make();
			await omp.init();
			omp.startInstall("homebrew");
			await pollUntil(() => omp.snapshot().log.includes("==> Fetching"), "the install to be under way");
			clock.skew(61_000);
			await Bun.sleep(600);
			// Its process is the server's own child: it is running, and the page says so.
			expect(omp.state().job?.state).toBe("running");
			expect(existsSync(join(f.dir, "data", "omp-job"))).toBe(true);
			await pollUntil(() => f.last().job?.state === "done", "the install to end", 20_000);
			expect(f.last()).toMatchObject({ status: "ready", version: "18.12.0" });
			omp.stop();
		});
	} finally {
		clock.restore();
	}
}, 60_000);

test("a job taken over, whose process carries its marker, is waited for however long its start time is not learned (#559)", async () => {
	const f = fixture();
	writeFakeBrew(join(f.toolbin, "brew"), {
		prefix: f.prefix,
		template: f.template,
		version: "18.12.0",
		log: join(f.dir, "brew.log"),
		seconds: 3,
	});
	const clock = skewedClock();
	try {
		await withPs(f, BLIND_START, async () => {
			const first = f.make();
			await first.init();
			first.startInstall("homebrew");
			await pollUntil(() => first.snapshot().log.includes("==> Fetching"), "the install to be under way");
			first.stop(); // the server goes away; the job is not its to end
			const record = JSON.parse(readFileSync(join(f.dir, "data", "omp-job", "job.json"), "utf8"));
			expect(record.process.started).toBe("");

			const second = f.make();
			await second.init();
			second.start();
			// The first looks at the job are made, and the time they began is noted, before the minute passes.
			await Bun.sleep(400);
			clock.skew(61_000);
			await Bun.sleep(600);
			expect(second.state().job?.state).toBe("running");
			await pollUntil(() => f.last().job?.state === "done", "the install to end", 20_000);
			second.stop();
		});
	} finally {
		clock.restore();
	}
}, 60_000);

/** The record of a job running as `pid`, with the start time `started` (none: it was never learned) and no status file. */
function writeRecord(f: Fixture, pid: number, started = ""): void {
	const jobDir = join(f.dir, "data", "omp-job");
	mkdirSync(jobDir, { recursive: true });
	writeFileSync(
		join(jobDir, "job.json"),
		JSON.stringify({
			version: 1,
			kind: "install",
			method: "homebrew",
			command: "brew install can1357/tap/omp",
			auto: false,
			startedAt: Date.now() - 5000,
			before: null,
			process: { pid, started, marker: join(jobDir, "exit") },
		}),
	);
}

test("a record without a start time whose process is gone is settled at once, not after a minute (#561)", async () => {
	const f = fixture();
	const finished = Bun.spawn(["true"]);
	await finished.exited;
	writeRecord(f, finished.pid);
	const omp = f.make();
	await omp.init();
	await pollUntil(() => omp.state().job?.state === "failed", "the job to be settled", 3_000);
	expect(omp.state().job?.error).toContain("was stopped before it finished");
	expect(existsSync(join(f.dir, "data", "omp-job"))).toBe(false);
});

test("a `ps` that gives no answer does not say the process is gone: the job keeps waiting (#561)", async () => {
	const f = fixture();
	const finished = Bun.spawn(["true"]);
	await finished.exited;
	writeRecord(f, finished.pid);
	// A `ps` that fails as one does when it cannot read the process table: not "no such process".
	await withPs(f, "exit 3", async () => {
		const omp = f.make();
		await omp.init();
		await Bun.sleep(400);
		expect(omp.state().job?.state).toBe("running");
	});
});

/**
 * A job an earlier server left running, as its record says: a shell that carries the job's status file in its command
 * line (as the job's wrapper does, `JOB_WRAPPER`) and runs `sleep 40` in a process group of its own.
 */
function jobLeftRunning(f: Fixture, started = ""): Bun.Subprocess {
	const proc = Bun.spawn(["/bin/sh", "-c", "sleep 40; :", "sh", join(f.dir, "data", "omp-job", "exit")], {
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	writeRecord(f, proc.pid, started);
	return proc;
}

/** Stop what a test left running in a group of its own, wherever the test ended. */
function reap(proc: Bun.Subprocess): void {
	try {
		process.kill(-proc.pid, "SIGKILL");
	} catch {
		// gone, as it should be
	}
}

test("cancelling a job taken over does not stop the server while `ps` is slow, and stops the job's group once its command line says it is the job's (#560)", async () => {
	const f = fixture();
	const job = jobLeftRunning(f);
	try {
		// A `ps` that takes 0.8 s to say what a process runs, and cannot say when it started. It is on the PATH the server
		// *starts* with: `Bun.spawnSync` looks `ps` up there and not in `process.env.PATH` as changed later, so only a
		// server of its own (a child process) can tell whether the cancel waits for the `ps` it asks.
		const bin = psShim(f, `case "$*" in *lstart*) exit 3;; *command=*) /bin/sleep 0.8;; esac\nexec /bin/ps "$@"`);
		const script = join(f.dir, "cancel-taken-over.ts");
		writeFileSync(
			script,
			`import { OmpLifecycle } from ${JSON.stringify(join(import.meta.dir, "../../server/omp/lifecycle.ts"))};
const [dataDir, home, path] = process.argv.slice(2);
const omp = new OmpLifecycle(
	{ ompBin: "omp", agentDir: dataDir, sessionsDir: dataDir, dataDir, host: "127.0.0.1", port: 0, distDir: dataDir, autoPort: false, parentPid: null },
	{ busy: () => ({ working: 0, asking: 0, paused: 0 }), activate: async () => "unused", broadcast: () => {} },
	{ env: { PATH: path, HOME: home }, home, checkEnabled: false, tickMs: 15 },
);
await omp.init();
omp.start();
// A real timer: what is measured is how long the event loop stands still, which a fake clock cannot show.
let gap = 0;
let last = performance.now();
const timer = setInterval(() => {
	const now = performance.now();
	gap = Math.max(gap, now - last);
	last = now;
}, 10);
omp.cancel();
const deadline = Date.now() + 10000;
while (omp.state().job?.state === "running" && Date.now() < deadline) await Bun.sleep(20);
clearInterval(timer);
const job = omp.state().job;
omp.stop();
console.log(JSON.stringify({ gap, state: job?.state, error: job?.error }));
`,
		);
		const child = Bun.spawn([process.execPath, script, join(f.dir, "data"), f.home, f.env.PATH], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(await child.exited, err).toBe(0);
		const ran: { gap: number; state?: string; error?: string | null } = JSON.parse(out);
		// A cancel that waited for `ps` leaves a gap as long as `ps` took.
		expect(ran.gap).toBeLessThan(300);
		expect(ran).toMatchObject({ state: "failed", error: "Cancelled" });
		// Its command line carried the job's marker: its group was signalled.
		await pollUntil(() => !processExists(job.pid), "the job's process to be gone");
	} finally {
		reap(job);
	}
});

test("cancelling a job taken over whose process `ps` cannot be asked in time settles it and signals nothing (#560)", async () => {
	const f = fixture();
	const job = jobLeftRunning(f);
	try {
		const second = f.make();
		await withPs(f, `case "$*" in *lstart* | *command=*) /bin/sleep 30;; esac\nexec /bin/ps "$@"`, async () => {
			await second.init();
			second.start();
			second.cancel();
			await pollUntil(() => second.state().job?.state === "failed", "the job to be settled", 10_000);
			expect(second.state().job?.error).toBe("Cancelled");
			// Not confirmed as the job's, so not signalled.
			expect(processExists(job.pid)).toBe(true);
			second.stop();
		});
	} finally {
		reap(job);
	}
}, 60_000);

test("cancelling a job whose id a stranger now has settles the job and leaves the stranger alone (#543)", async () => {
	const f = fixture();
	// The stranger: a process in a group of its own that is none of the job's, and carries no status file.
	const stranger = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore", detached: true });
	try {
		// What `ps` says of when it started, as the server asks for it: the record is then as good as one the job's own
		// process would have, and only the command line tells the stranger from the job.
		const started = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(stranger.pid)], {
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		})
			.stdout.toString()
			.trim();
		expect(started).not.toBe("");
		writeRecord(f, stranger.pid, started);
		const omp = f.make();
		await omp.init();
		expect(omp.state().job?.state).toBe("running");
		omp.start();
		omp.cancel();
		await pollUntil(() => omp.state().job?.state === "failed", "the job to be settled", 10_000);
		expect(omp.state().job?.error).toBe("Cancelled");
		// Signalled, it would be gone by now: the job is settled when its process is seen to be gone, or at once, not before.
		expect(stranger.signalCode).toBeNull();
		expect(processExists(stranger.pid)).toBe(true);
		omp.stop();
	} finally {
		reap(stranger);
	}
});

test("a job that ends while its start time is being asked is settled with the status it wrote, not as stopped (#566)", async () => {
	const f = fixture();
	const status = join(f.dir, "data", "omp-job", "exit");
	mkdirSync(join(f.dir, "data", "omp-job"), { recursive: true });
	// A job as the wrapper runs it: its status goes to the file when its command is over, and the shell ends with it.
	const job = Bun.spawn(["/bin/sh", "-c", 'sleep 1.5; printf %s 0 > "$1"', "sh", status], {
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	try {
		const started = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(job.pid)], {
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		})
			.stdout.toString()
			.trim();
		writeRecord(f, job.pid, started);
		// A busy machine: the first look at the job is answered at once (it runs), and the next takes until the job has
		// written its status and gone — `ended` has read the status file (nothing yet) by then, and must not take the
		// process's going for "it was killed".
		const asked = join(f.dir, "asked");
		const bin = psShim(
			f,
			`case "$*" in *lstart*)
  if [ -e "${asked}" ]; then while [ ! -e "${status}" ]; do /bin/sleep 0.05; done; /bin/sleep 0.3; else : > "${asked}"; fi;;
esac
exec /bin/ps "$@"`,
		);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		try {
			const omp = f.make();
			await omp.init();
			expect(omp.state().job?.state).toBe("running");
			omp.start();
			await pollUntil(() => omp.state().job?.state !== "running", "the job to be settled", 15_000);
			expect(omp.state().job).toMatchObject({ exitCode: 0 });
			expect(omp.state().job?.error ?? "").not.toContain("was stopped before it finished");
			omp.stop();
		} finally {
			process.env.PATH = path;
		}
	} finally {
		reap(job);
	}
});

// ------------------------------------------------------------------ updates

/** A Homebrew-installed omp at `version`, with a registry that says `latest` is the newest, looked up once. */
async function installed(version: string, latest: string, opts: LifecycleOptions = {}) {
	const f = fixture(version);
	placeBrewOmp(f.prefix, f.template, version);
	f.state.setUpdateTo(latest);
	const registry = await startFakeRegistry(latest);
	const omp = f.make({ ...opts, fetch: opts.fetch });
	f.env.npm_config_registry = registry.url;
	f.env.PI_BUILD_URL = registry.url;
	await omp.init();
	await omp.check();
	return { f, omp, registry };
}

test("a newer release is found on the registry and described with its release notes", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	expect(registry.hits).toEqual(["/@oh-my-pi%2fpi-coding-agent/latest"]);
	expect(omp.state().release).toMatchObject({
		latest: "18.13.0",
		newer: true,
		source: "npm",
		compat: "supported",
		changelogUrl: "https://github.com/can1357/oh-my-pi/releases/tag/v18.13.0",
	});
	expect(f.last().checking).toBe(false);
	await registry.stop();
});

test("being up to date, or ahead of the release, is not an update", async () => {
	const same = await installed("18.12.0", "18.12.0");
	expect(same.omp.state().release?.newer).toBe(false);
	expect(() => same.omp.startUpdate(false)).toThrow("up to date");
	await same.registry.stop();
	const ahead = await installed("18.14.0-canary.1", "18.13.0");
	expect(ahead.omp.state().release?.newer).toBe(false);
	await ahead.registry.stop();
});

/** An omp that says `channel` for `config get update.channel` (null: that command fails) and logs the folder it was asked in. */
function ompOnChannel(f: Fixture, channel: string | null): string {
	mkdirSync(join(f.prefix, "bin"), { recursive: true });
	const bin = join(f.prefix, "bin", "omp");
	const log = join(f.dir, "channel-asked");
	writeFileSync(
		bin,
		`#!/bin/sh
case "$1 $2 $3" in
  "config get update.channel")
    pwd -P >> "${log}"
    ${channel === null ? `echo "config is locked" >&2; exit 1` : `echo ${channel}; exit 0`} ;;
esac
[ "$1" = "--version" ] && echo "omp/18.12.0"
exit 0
`,
	);
	chmodSync(bin, 0o755);
	return log;
}

test("the release is looked up on the channel omp's `update.channel` names, read where `omp update` runs (#446)", async () => {
	for (const [setting, tag] of [
		["canary", "canary"],
		["stable", "latest"],
		// What omp itself takes for stable: a value it does not know, and a setting that cannot be read.
		["beta", "latest"],
		[null, "latest"],
	] as const) {
		const f = fixture("18.12.0");
		const log = ompOnChannel(f, setting);
		const asked: string[] = [];
		const omp = f.make({
			fetch: async (input) => {
				asked.push(String(input));
				return new Response(JSON.stringify({ version: tag === "canary" ? "18.13.0-canary.1" : "18.12.4" }));
			},
		});
		await omp.init();
		await omp.check();
		expect([setting, asked]).toEqual([setting, [`https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/${tag}`]]);
		expect(omp.state().release).toMatchObject({
			latest: tag === "canary" ? "18.13.0-canary.1" : "18.12.4",
			newer: true,
		});
		// `omp update` runs in the home directory and reads the setting there: so does the look-up.
		expect(readFileSync(log, "utf8").trim()).toBe(realpathSync(f.home));
	}
});

test("a registry that is down leaves the last answer alone and keeps the error for Settings", async () => {
	const { omp, registry } = await installed("18.12.0", "18.13.0");
	registry.setDown(true);
	await omp.check();
	const s = omp.state();
	expect(s.releaseError).toContain("HTTP 503");
	expect(s.release?.latest).toBe("18.13.0");
	registry.setDown(false);
	await omp.check();
	expect(omp.state().releaseError).toBeNull();
	await registry.stop();
});

test("updating runs omp's own `omp update` for the omp it found, and moves to the version it leaves", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	omp.startUpdate(false);
	expect(f.last().job).toMatchObject({
		kind: "update",
		method: "homebrew",
		command: "omp update",
		state: "running",
		auto: false,
	});
	await pollUntil(() => f.last().job?.state === "done", "the update to end");
	const s = f.last();
	expect(s.version).toBe("18.13.0");
	expect(s.job).toMatchObject({ state: "done", version: "18.13.0" });
	// Nothing newer is left, and everything holding omp's path was told.
	expect(omp.state().release?.newer).toBe(false);
	expect(f.activated).toEqual([join(f.prefix, "bin", "omp")]);
	// `omp update` finds the install to update from PATH: this omp's directory came first.
	const [call] = f.state.updateCalls();
	expect(call.startsWith(`update PATH=${join(f.prefix, "bin")}:`)).toBe(true);
	await registry.stop();
});

test("every state the server sends is later than the one before it, and names the run of the server it came from", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	omp.startUpdate(false);
	// The answer to the request that started the update: the state of that moment, which the end of the update outdates.
	const answered = omp.snapshot().state;
	await pollUntil(() => f.last().job?.state === "done", "the update to end");
	const revs = f.sent.flatMap((m) => (m.t === "omp" ? [m.state.rev] : []));
	expect(revs.length).toBeGreaterThan(1);
	expect(revs).toEqual([...revs].sort((a, b) => a - b));
	expect(new Set(revs).size).toBe(revs.length);
	expect(answered.rev).toBeLessThan(f.last().rev);
	expect(f.last().boot).toBe(answered.boot);
	// Another run of the server counts on its own and says so.
	expect(f.make().state().boot).not.toBe(answered.boot);
	await registry.stop();
});

test("an update waits while a conversation is working, shows how many, and starts when none is", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.working = 2;
	omp.startUpdate(false);
	expect(f.last().job).toMatchObject({ state: "waiting", waiting: { working: 2, asking: 0, paused: 0 } });
	expect(f.state.updateCalls()).toEqual([]);
	f.busy.working = 1;
	await omp.tick();
	expect(f.last().job).toMatchObject({ state: "waiting", waiting: { working: 1, asking: 0, paused: 0 } });
	expect(f.state.updateCalls()).toEqual([]);
	f.busy.working = 0;
	await omp.tick();
	await pollUntil(() => f.last().job?.state === "done", "the update to run once idle");
	expect(f.last().version).toBe("18.13.0");
	await registry.stop();
});

test("a waiting update can be cancelled and then never runs", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.working = 1;
	omp.startUpdate(false);
	omp.cancel();
	expect(f.last().job).toBeNull();
	f.busy.working = 0;
	await omp.tick();
	expect(f.state.updateCalls()).toEqual([]);
	await registry.stop();
});

test("an update tells what it waits for — working, needing an answer, paused — and 'update anyway' stops waiting for the last two", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.working = 1;
	f.busy.asking = 1;
	f.busy.paused = 2;
	omp.startUpdate(false);
	expect(f.last().job).toMatchObject({
		state: "waiting",
		anyway: false,
		waiting: { working: 1, asking: 1, paused: 2 },
	});
	// The conversation that works finishes by itself; the paused ones and the one that asks do not: the job stays.
	f.busy.working = 0;
	await omp.tick();
	await omp.tick();
	expect(f.last().job).toMatchObject({ state: "waiting", waiting: { working: 0, asking: 1, paused: 2 } });
	expect(f.state.updateCalls()).toEqual([]);

	// "Update anyway" on the waiting update: nothing is working, so it runs now, whatever the others are doing.
	omp.startUpdate(false, false, true);
	await pollUntil(() => f.last().job?.state === "done", "the update to run");
	expect(f.state.updateCalls()).toHaveLength(1);
	expect(f.last().job).toMatchObject({ anyway: true, version: "18.13.0" });
	await registry.stop();
});

test("'update anyway' with a conversation still working waits for that one, and for no other", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.working = 1;
	f.busy.paused = 1;
	omp.startUpdate(false);
	omp.startUpdate(false, false, true);
	expect(f.last().job).toMatchObject({ state: "waiting", anyway: true });
	await omp.tick();
	expect(f.state.updateCalls()).toEqual([]);
	f.busy.working = 0;
	await omp.tick();
	await pollUntil(() => f.last().job?.state === "done", "the update to run");
	expect(f.state.updateCalls()).toHaveLength(1);
	await registry.stop();

	// Asked for that way from the start, with only paused conversations around, there is nothing to wait for.
	const again = await installed("18.12.0", "18.13.0");
	again.f.busy.paused = 1;
	again.omp.startUpdate(false, false, true);
	expect(again.f.last().job?.state).toBe("running");
	await pollUntil(() => again.f.last().job?.state === "done", "the update to run");
	await again.registry.stop();
});

test("an automatic update that something holds back says what, once, and runs when nothing does", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.paused = 1;
	f.busy.asking = 1;
	omp.setAutoUpdate(true);
	await omp.tick();
	expect(f.last().job).toBeNull();
	expect(f.last().autoWaitingFor).toEqual({ working: 0, asking: 1, paused: 1 });
	expect(f.state.updateCalls()).toEqual([]);
	// Told once, not at every tick.
	const told = f.sent.length;
	await omp.tick();
	await omp.tick();
	expect(f.sent.length).toBe(told);
	// A change in what holds it is told again.
	f.busy.asking = 0;
	await omp.tick();
	expect(f.last().autoWaitingFor).toEqual({ working: 0, asking: 0, paused: 1 });

	f.busy.paused = 0;
	await omp.tick();
	await pollUntil(() => f.last().job?.state === "done", "the automatic update to end");
	expect(f.last().autoWaitingFor).toBeNull();
	expect(f.last().job?.auto).toBe(true);
	await registry.stop();
});

test("nothing is reported as holding an automatic update that is off, or has nothing to install", async () => {
	const off = await installed("18.12.0", "18.13.0");
	off.f.busy.paused = 1;
	await off.omp.tick();
	expect(off.omp.state().autoWaitingFor).toBeNull();
	await off.registry.stop();
	const current = await installed("18.13.0", "18.13.0");
	current.f.busy.paused = 1;
	current.omp.setAutoUpdate(true);
	await current.omp.tick();
	expect(current.omp.state().autoWaitingFor).toBeNull();
	await current.registry.stop();
});

test("an update cannot be stopped once it runs", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.state.setUpdateSeconds(1);
	omp.startUpdate(false);
	await pollUntil(() => f.state.updateCalls().length === 1, "the update to start");
	expect(() => omp.cancel()).toThrow("half way");
	await pollUntil(() => f.last().job?.state === "done", "the update to end");
	await registry.stop();
});

test("a release outside the supported range needs the user's say-so, however it is asked for", async () => {
	const { f, omp, registry } = await installed("18.12.0", "19.0.0");
	expect(omp.state().release).toMatchObject({ latest: "19.0.0", newer: true, compat: "newer" });
	expect(() => omp.startUpdate(false)).toThrow("outside the versions this web UI supports");
	try {
		omp.startUpdate(false);
	} catch (e) {
		expect((e as LifecycleError).code).toBe("outside_compat");
		expect((e as LifecycleError).status).toBe(409);
	}
	expect(f.state.updateCalls()).toEqual([]);
	omp.startUpdate(true);
	await pollUntil(() => f.last().job?.state === "done", "the acknowledged update to end");
	// After updating, the installed omp is outside the range: the page warns at once.
	expect(f.last().compat).toEqual({ range: ">=18.11.0 <19.0.0", verdict: "newer" });
	await registry.stop();
});

test("on start, an installed omp outside the range is reported as such", async () => {
	const newer = fixture("19.2.0");
	placeBrewOmp(newer.prefix, newer.template, "19.2.0");
	const a = newer.make();
	await a.init();
	expect(a.state().compat.verdict).toBe("newer");
	const older = fixture("18.9.0");
	placeBrewOmp(older.prefix, older.template, "18.9.0");
	const b = older.make();
	await b.init();
	expect(b.state().compat.verdict).toBe("older");
	const ok = fixture("18.12.1");
	placeBrewOmp(ok.prefix, ok.template, "18.12.1");
	const c = ok.make();
	await c.init();
	expect(c.state().compat.verdict).toBe("supported");
});

test("an update that ends without changing the version, or fails, is a failure with the reason", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.state.noopUpdates(true);
	omp.startUpdate(false);
	await pollUntil(() => f.last().job?.state === "failed", "the update to fail");
	expect(f.last().job?.error).toContain("still reports 18.12.0");
	omp.cancel();
	f.state.noopUpdates(false);
	f.state.failUpdates(true);
	omp.startUpdate(false);
	await pollUntil(() => f.last().job?.state === "failed", "the update to fail again");
	expect(f.last().job?.error).toContain("exited with code 1");
	expect(f.last().job?.error).toContain("the release server is down");
	// The installed version is untouched, and the user can try again.
	expect(f.last().version).toBe("18.12.0");
	omp.cancel();
	f.state.failUpdates(false);
	omp.startUpdate(false);
	await pollUntil(() => f.last().job?.state === "done", "the third try to end");
	await registry.stop();
});

test("an omp that is updated elsewhere (a source checkout) is not updated from here", async () => {
	const f = fixture("18.12.0");
	// A script in no package and no Cellar: a checkout.
	mkdirSync(join(f.prefix, "bin"), { recursive: true });
	writeOmpTemplate(join(f.prefix, "bin", "omp"), f.state.dir, null);
	const registry = await startFakeRegistry("18.13.0");
	f.env.npm_config_registry = registry.url;
	const omp = f.make();
	await omp.init();
	await omp.check();
	expect(omp.state().install).toMatchObject({ method: "unknown", updatable: false });
	expect(() => omp.startUpdate(false)).toThrow("updated elsewhere");
	await registry.stop();
});

test("with 'Update omp automatically' the update happens by itself, but only when every conversation is idle", async () => {
	const { f, omp, registry } = await installed("18.12.0", "18.13.0");
	f.busy.working = 1;
	omp.setAutoUpdate(true);
	expect(f.last().autoUpdate).toBe(true);
	await omp.tick();
	expect(f.state.updateCalls()).toEqual([]);
	expect(f.last().job).toBeNull();
	f.busy.working = 0;
	await omp.tick();
	await pollUntil(() => f.last().job?.state === "done", "the automatic update to end");
	expect(f.last().job?.auto).toBe(true);
	expect(f.last().version).toBe("18.13.0");
	expect(f.last().job?.version).toBe("18.13.0");
	await registry.stop();
});

test("the setting is off by default, and is kept for the next start", async () => {
	const f = fixture();
	placeBrewOmp(f.prefix, f.template, "18.12.0");
	const first = f.make();
	await first.init();
	expect(first.state().autoUpdate).toBe(false);
	first.setAutoUpdate(true);
	const second = f.make();
	await second.init();
	expect(second.state().autoUpdate).toBe(true);
	second.setAutoUpdate(false);
	expect(f.make().state().autoUpdate).toBe(false);
});

test("nothing updates by itself while the setting is off, or into a version the web UI is not made for, or twice after a failure", async () => {
	// Off: an idle server with a newer release does nothing.
	const off = await installed("18.12.0", "18.13.0");
	await off.omp.tick();
	expect(off.f.state.updateCalls()).toEqual([]);
	await off.registry.stop();

	// On, but the release is a new major: the user decides that one.
	const major = await installed("18.12.0", "19.0.0");
	major.omp.setAutoUpdate(true);
	await major.omp.tick();
	expect(major.f.state.updateCalls()).toEqual([]);
	await major.registry.stop();

	// On, and the update fails: it is not tried again for the same release.
	const flaky = await installed("18.12.0", "18.13.0");
	flaky.f.state.failUpdates(true);
	flaky.omp.setAutoUpdate(true);
	await flaky.omp.tick();
	await pollUntil(() => flaky.f.last().job?.state === "failed", "the automatic update to fail");
	flaky.omp.cancel();
	await flaky.omp.tick();
	expect(flaky.f.state.updateCalls()).toHaveLength(1);
	expect(flaky.f.last().job).toBeNull();
	await flaky.registry.stop();
});

test("the server looks for a newer release by itself: soon after it starts, and again now and then", async () => {
	const f = fixture("18.12.0");
	placeBrewOmp(f.prefix, f.template, "18.12.0");
	const registry = await startFakeRegistry("18.13.0");
	f.env.npm_config_registry = registry.url;
	const on = f.make({ checkEnabled: true, checkIntervalMs: 60 });
	await on.init();
	on.start();
	await pollUntil(() => registry.hits.length >= 2, "the periodic look-ups", 10_000);
	expect(on.state().release?.latest).toBe("18.13.0");
	on.stop();
	await registry.stop();
});
