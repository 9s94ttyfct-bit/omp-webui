import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { commandOf } from "../../server/instance.ts";
import { RemoteStore } from "../../server/remote-config.ts";
import { Tunnel, TunnelError, type TunnelTimings } from "../../server/remote-tunnel.ts";
import type { RemoteStatus } from "../../shared/remote.ts";
import { connectedPlan, emit, FAKE_TUNNEL_ID, LOG, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * The tunnel against a stand-in for `cloudflared` (tests/support/fake-cloudflared.ts): every command it runs, how it
 * reads what the program says, and that it comes back, goes away and never leaves one behind.
 */

const AUD = "b".repeat(64);
const HOST = "omp.example.com";
const FAST: Partial<TunnelTimings> = { backoffMs: [40, 80, 160], stableMs: 400, stopGraceMs: 3000, loginUrlMs: 8000 };

interface Seen {
	at: number;
	status: RemoteStatus;
}

const dirs: string[] = [];
const tunnels: Tunnel[] = [];
const strays: Subprocess[] = [];
afterEach(async () => {
	for (const t of tunnels.splice(0)) await t.close();
	for (const p of strays.splice(0)) p.kill("SIGKILL");
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(o: { installed?: boolean; timings?: Partial<TunnelTimings>; port?: number; host?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-tunnel-"));
	dirs.push(dir);
	const fake = makeFakeCloudflared(join(dir, "fake"), { installed: o.installed });
	const dataDir = join(dir, "data");
	const store = new RemoteStore(join(dataDir, "remote.json"));
	const seen: Seen[] = [];
	const make = () => {
		const tunnel = new Tunnel({
			dataDir,
			port: () => o.port ?? 4242,
			host: o.host,
			store,
			env: {
				PATH: process.env.PATH,
				OMP_WEBUI_CLOUDFLARED: fake.bin,
				OMP_WEBUI_BREW: fake.brew,
			},
			home: fake.home,
			onStatus: (status) => seen.push({ at: Date.now(), status }),
			timings: { ...FAST, ...o.timings },
		});
		tunnels.push(tunnel);
		return tunnel;
	};
	const signIn = () => {
		mkdirSync(join(fake.home, ".cloudflared"), { recursive: true });
		writeFileSync(join(fake.home, ".cloudflared", "cert.pem"), "cert");
	};
	return { dir, dataDir, fake, store, seen, tunnel: make(), make, signIn, yml: join(dataDir, "cloudflared.yml") };
}

/** A tunnel that is set up and complete in its settings: only `start` is left. */
async function ready(w: ReturnType<typeof world>) {
	w.signIn();
	w.store.patch({ hostname: HOST, team: "example", aud: AUD, emails: ["me@example.com"] });
	await w.tunnel.setup();
}

const states = (w: { seen: Seen[] }) => w.seen.map((s) => s.status.state);
const connected = (w: ReturnType<typeof world>) =>
	pollUntil(() => w.tunnel.status().state === "connected", "the tunnel to connect");

async function refused(work: Promise<unknown>): Promise<TunnelError> {
	const error = await work.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(TunnelError);
	return error as TunnelError;
}

describe("finding cloudflared", () => {
	test("the program OMP_WEBUI_CLOUDFLARED names is the only one: another on PATH is not used", () => {
		const w = world({ installed: false });
		expect(w.tunnel.installed()).toBe(false);
		const onPath = join(w.dir, "pathbin");
		mkdirSync(onPath);
		writeFileSync(join(onPath, "cloudflared"), "#!/bin/sh\n");
		chmodSync(join(onPath, "cloudflared"), 0o755);
		const t = new Tunnel({
			dataDir: w.dataDir,
			port: () => 1,
			store: w.store,
			env: { PATH: onPath, OMP_WEBUI_CLOUDFLARED: w.fake.bin },
			home: w.fake.home,
		});
		expect(t.installed()).toBe(false);
	});

	test("without an override it is looked for on PATH, then where Homebrew puts it", () => {
		const w = world({ installed: false });
		const onPath = join(w.dir, "pathbin");
		mkdirSync(onPath);
		const t = new Tunnel({
			dataDir: w.dataDir,
			port: () => 1,
			store: w.store,
			env: { PATH: onPath },
			home: w.fake.home,
			extraDirs: [],
		});
		expect(t.installed()).toBe(false);
		writeFileSync(join(onPath, "cloudflared"), "#!/bin/sh\n");
		// A file that cannot be run is not the program.
		expect(t.installed()).toBe(false);
		chmodSync(join(onPath, "cloudflared"), 0o755);
		expect(t.installed()).toBe(true);
	});

	test("logged in is the certificate cloudflared leaves in ~/.cloudflared", () => {
		const w = world();
		expect(w.tunnel.loggedIn()).toBe(false);
		w.signIn();
		expect(w.tunnel.loggedIn()).toBe(true);
	});
});

describe("install", () => {
	test("runs brew, tells what it prints while it runs, and the program is there afterwards", async () => {
		const w = world({ installed: false });
		w.fake.setBrewSeconds(0.5);
		await w.tunnel.install();
		expect(w.fake.brewCalls()).toEqual(["install cloudflared"]);
		expect(w.tunnel.installed()).toBe(true);
		const said = w.seen.map((s) => s.status.message ?? "");
		expect(said.some((m) => m.includes("Fetching cloudflared"))).toBe(true);
		expect(said.some((m) => m.includes("Pouring cloudflared"))).toBe(true);
		// What was said while it ran is not left on the card after it.
		expect(w.tunnel.status()).toEqual({ state: "off" });
		expect(w.seen.at(-1)?.status).toEqual({ state: "off" });
	});

	test("with the program there already nothing is run", async () => {
		const w = world();
		await w.tunnel.install();
		expect(w.fake.brewCalls()).toEqual([]);
	});

	test("a failed install says why, in brew's own last words, and the program is still not there", async () => {
		const w = world({ installed: false });
		w.fake.fail("brew");
		const error = await refused(w.tunnel.install());
		expect(error.message).toContain("no available formula");
		expect(w.tunnel.installed()).toBe(false);
		expect(w.tunnel.status()).toEqual({ state: "off" });
	});

	test("without Homebrew it says to install cloudflared another way, and runs nothing", async () => {
		const w = world({ installed: false });
		const t = new Tunnel({
			dataDir: w.dataDir,
			port: () => 1,
			store: w.store,
			env: { PATH: process.env.PATH, OMP_WEBUI_CLOUDFLARED: w.fake.bin, OMP_WEBUI_BREW: join(w.dir, "nope") },
			home: w.fake.home,
		});
		const error = await refused(t.install());
		expect(error.message).toContain("Homebrew");
		expect(error.status).toBe(400);
	});

	test("a brew that never ends is stopped at its limit", async () => {
		const w = world({ installed: false, timings: { installMs: 300 } });
		w.fake.setBrewSeconds(30);
		const started = Date.now();
		const error = await refused(w.tunnel.install());
		expect(Date.now() - started).toBeLessThan(5000);
		expect(error.message).toContain("did not finish");
		expect(w.tunnel.installed()).toBe(false);
	});

	test("while one step runs another is refused, not run beside it", async () => {
		const w = world({ installed: false });
		w.fake.setBrewSeconds(0.6);
		const first = w.tunnel.install();
		const error = await refused(w.tunnel.install());
		expect(error.status).toBe(409);
		await first;
		expect(w.fake.brewCalls()).toEqual(["install cloudflared"]);
	});
});

describe("login", () => {
	test("answers with the URL cloudflared prints and goes on waiting; the login is done when the certificate is there", async () => {
		const w = world();
		w.fake.setLoginUrl("https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Fx");
		const url = await w.tunnel.login();
		expect(url).toBe("https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Fx");
		expect(w.tunnel.loggedIn()).toBe(false);
		expect(w.tunnel.status().message).toContain("log in");
		const before = w.seen.length;
		w.fake.approveLogin();
		await pollUntil(() => w.tunnel.loggedIn(), "the certificate");
		// The page is told that the login ended, though the tunnel's state did not change.
		await pollUntil(() => w.seen.length > before && w.tunnel.status().message === undefined, "the status to be pushed");
	});

	test("a second ask while the first waits gets the same URL and starts nothing", async () => {
		const w = world();
		const first = await w.tunnel.login();
		expect(await w.tunnel.login()).toBe(first);
		expect(w.fake.calls().filter((c) => c === "tunnel login")).toHaveLength(1);
	});

	test("a login that fails says why", async () => {
		const w = world();
		w.fake.fail("login");
		const error = await refused(w.tunnel.login());
		expect(error.message).toContain("connection refused");
		expect(w.tunnel.loggedIn()).toBe(false);
	});

	test("a program that prints no URL is stopped and the ask fails", async () => {
		const w = world({ timings: { loginUrlMs: 300 } });
		w.fake.fail("login-silent");
		const error = await refused(w.tunnel.login());
		expect(error.message).toContain("URL");
		// Not left waiting: the next ask starts a new one.
		w.fake.fail("login-silent", false);
		expect(await w.tunnel.login()).toContain("https://");
	});

	test("a login that ends badly after the URL was given is told on the status", async () => {
		const w = world();
		w.fake.fail("login-ends-badly");
		await w.tunnel.login();
		w.fake.approveLogin();
		await pollUntil(() => (w.tunnel.status().message ?? "").includes("login"), "the failure to be told");
		expect(w.tunnel.status().message).toContain("callback never came");
		expect(w.tunnel.loggedIn()).toBe(false);
	});

	test("a program that is there but cannot be run is a refused step, not a server error", async () => {
		const w = world();
		writeFileSync(w.fake.bin, "#!/no/such/interpreter\n");
		chmodSync(w.fake.bin, 0o755);
		const error = await refused(w.tunnel.login());
		expect(error.status).toBe(502);
		expect(error.message).toContain("could not be run");
		// And the ask can be made again.
		const again = await refused(w.tunnel.login());
		expect(again.message).toContain("could not be run");
	});

	test("without the program it says to install it first", async () => {
		const w = world({ installed: false });
		const error = await refused(w.tunnel.login());
		expect(error.message).toContain("install");
	});

	test("closing the server ends a login that waits", async () => {
		const w = world();
		await w.tunnel.login();
		await w.tunnel.close();
		w.fake.approveLogin();
		// Something that must NOT happen in another process: there is no event to await, so a real wait (a late event can only make this pass, never flake).
		await Bun.sleep(400);
		expect(w.fake.hasCert()).toBe(false);
	});
});

describe("create, route and set up", () => {
	test("create makes the tunnel, keeps its id and name, and reads the id from what cloudflared says", async () => {
		const w = world();
		w.signIn();
		const id = await w.tunnel.create("omp-webui-test");
		expect(id).toBe(FAKE_TUNNEL_ID);
		expect(w.fake.calls()).toEqual(["tunnel create omp-webui-test"]);
		expect(w.store.read().tunnelId).toBe(FAKE_TUNNEL_ID);
		expect(w.store.read().tunnelName).toBe("omp-webui-test");
		expect(w.fake.hasCredentials()).toBe(true);
	});

	test("an id that is not an id is never kept or put in a command line", async () => {
		const w = world();
		w.signIn();
		w.fake.setTunnelId("--config=/etc/passwd");
		await refused(w.tunnel.create("omp-webui-test"));
		expect(w.store.read().tunnelId).toBeUndefined();
	});

	test("a refused create says why and keeps nothing", async () => {
		const w = world();
		w.signIn();
		w.fake.fail("create");
		const error = await refused(w.tunnel.create("omp-webui-test"));
		expect(error.message).toContain("unauthorized");
		expect(w.store.read().tunnelId).toBeUndefined();
	});

	test("a command that gives no answer is stopped at its limit", async () => {
		const w = world({ timings: { quickMs: 300 } });
		w.signIn();
		w.fake.fail("hang");
		const started = Date.now();
		const error = await refused(w.tunnel.create("omp-webui-test"));
		expect(Date.now() - started).toBeLessThan(5000);
		expect(error.message).toContain("no answer");
		expect(error.status).toBe(504);
	});

	test("route points the hostname at the tunnel", async () => {
		const w = world();
		w.signIn();
		await w.tunnel.create("t");
		await w.tunnel.route(HOST);
		expect(w.fake.calls().at(-1)).toBe(`tunnel route dns ${FAKE_TUNNEL_ID} ${HOST}`);
	});

	test("a hostname that already has a record is refused in words the person can act on", async () => {
		const w = world();
		w.signIn();
		await w.tunnel.create("t");
		w.fake.fail("route-exists");
		const error = await refused(w.tunnel.route(HOST));
		expect(error.status).toBe(409);
		expect(error.message).toContain(HOST);
		expect(error.message).toContain("already");
	});

	test("setup creates the tunnel, routes the hostname, and writes the configuration cloudflared runs with", async () => {
		const w = world({ port: 4711 });
		await ready(w);
		expect(w.fake.calls()).toEqual([
			`tunnel create omp-webui-omp-example-com`,
			`tunnel route dns ${FAKE_TUNNEL_ID} ${HOST}`,
		]);
		const yml = readFileSync(w.yml, "utf8");
		expect(yml).toContain(`tunnel: "${FAKE_TUNNEL_ID}"`);
		expect(yml).toContain(
			`credentials-file: ${JSON.stringify(join(w.fake.home, ".cloudflared", `${FAKE_TUNNEL_ID}.json`))}`,
		);
		expect(yml).toContain(`- hostname: "${HOST}"`);
		expect(yml).toContain(`service: "http://127.0.0.1:4711"`);
		// The last rule answers everything that is not the hostname.
		expect(yml.trimEnd().endsWith(`- service: http_status:404`)).toBe(true);
		expect(statSync(w.yml).mode & 0o777).toBe(0o600);
	});

	test("the configuration points at the address the server listens on: another bind address, a bracketed IPv6 one", async () => {
		for (const [host, service] of [
			["192.168.1.5", "http://192.168.1.5:4711"],
			["::1", "http://[::1]:4711"],
			["0.0.0.0", "http://127.0.0.1:4711"],
			["::", "http://[::1]:4711"],
		] as const) {
			const w = world({ port: 4711, host });
			await ready(w);
			expect(readFileSync(w.yml, "utf8"), host).toContain(`service: "${service}"`);
		}
	});

	test("setting up again changes nothing and runs nothing: a record that is there is the one set up before", async () => {
		const w = world();
		await ready(w);
		const calls = w.fake.calls();
		w.fake.fail("route-exists");
		await w.tunnel.setup();
		expect(w.fake.calls()).toEqual(calls);
	});

	test("a new hostname is routed, on the tunnel that exists", async () => {
		const w = world();
		await ready(w);
		w.store.patch({ hostname: "other.example.com" });
		await w.tunnel.setup();
		expect(w.fake.calls().filter((c) => c.startsWith("tunnel create"))).toHaveLength(1);
		expect(w.fake.calls().at(-1)).toBe(`tunnel route dns ${FAKE_TUNNEL_ID} other.example.com`);
		expect(readFileSync(w.yml, "utf8")).toContain(`hostname: "other.example.com"`);
	});

	test("a route that failed after the tunnel was made is retried without making another tunnel", async () => {
		const w = world();
		w.signIn();
		w.store.patch({ hostname: HOST });
		w.fake.fail("route-exists");
		const error = await refused(w.tunnel.setup());
		expect(error.status).toBe(409);
		expect(w.store.read().tunnelId).toBe(FAKE_TUNNEL_ID);
		w.fake.fail("route-exists", false);
		await w.tunnel.setup();
		expect(w.fake.calls().filter((c) => c.startsWith("tunnel create"))).toHaveLength(1);
		expect(existsSync(w.yml)).toBe(true);
	});

	test("a tunnel of that name that the account has and this machine has the credentials of is taken over, not created again", async () => {
		const w = world();
		w.signIn();
		w.store.patch({ hostname: HOST });
		const name = "omp-webui-omp-example-com";
		const existing = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		w.fake.existingTunnel(existing, name);
		mkdirSync(join(w.fake.home, ".cloudflared"), { recursive: true });
		writeFileSync(join(w.fake.home, ".cloudflared", `${existing}.json`), "{}");
		await w.tunnel.setup();
		expect(w.store.read().tunnelId).toBe(existing);
		expect(w.store.read().tunnelName).toBe(name);
		expect(w.fake.calls()).toContain(`tunnel list --name ${name} --output json`);
		expect(w.fake.calls().at(-1)).toBe(`tunnel route dns ${existing} ${HOST}`);
		expect(readFileSync(w.yml, "utf8")).toContain(`tunnel: "${existing}"`);
	});

	test("a tunnel of that name whose credentials are not on this machine says exactly what to do", async () => {
		const w = world();
		w.signIn();
		w.store.patch({ hostname: HOST });
		const name = "omp-webui-omp-example-com";
		w.fake.existingTunnel("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name);
		const error = await refused(w.tunnel.setup());
		expect(error.status).toBe(409);
		expect(error.message).toContain(name);
		expect(error.message).toContain(`cloudflared tunnel delete ${name}`);
		expect(w.store.read().tunnelId).toBeUndefined();
		expect(w.fake.calls().some((c) => c.startsWith("tunnel route"))).toBe(false);
	});

	test("a refused create that no tunnel of that name explains is the refusal as it was", async () => {
		const w = world();
		w.signIn();
		w.store.patch({ hostname: HOST });
		w.fake.existingTunnel("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "another-name");
		const error = await refused(w.tunnel.setup());
		expect(error.message).toContain("already exists");
		expect(w.store.read().tunnelId).toBeUndefined();
	});
	test("setup needs the program, the login and a hostname, and says which is missing", async () => {
		const noProgram = world({ installed: false });
		expect((await refused(noProgram.tunnel.setup())).message).toContain("install");
		const noLogin = world();
		noLogin.store.patch({ hostname: HOST });
		expect((await refused(noLogin.tunnel.setup())).message).toContain("log in");
		const noHost = world();
		noHost.signIn();
		expect((await refused(noHost.tunnel.setup())).message).toContain("hostname");
		for (const w of [noProgram, noLogin, noHost]) expect(w.fake.calls()).toEqual([]);
	});
});

describe("starting and the state it reports", () => {
	test("start runs cloudflared on the configuration, is `starting` at once and `connected` when it registers", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.start();
		expect(w.tunnel.status().state).toBe("starting");
		await connected(w);
		expect(w.fake.runs()).toBe(1);
		expect(w.fake.calls().at(-1)).toBe(`tunnel --no-autoupdate --config ${w.yml} run ${FAKE_TUNNEL_ID}`);
		expect(w.fake.runConfig(1)).toContain("http://127.0.0.1:4242");
		expect(w.tunnel.status()).toEqual({ state: "connected" });
		expect(states(w)).toEqual(expect.arrayContaining(["starting", "connected"]));
		// It starts remote access: the settings say it is wanted.
		expect(w.store.read().enabled).toBe(true);
	});

	test("starting twice runs one cloudflared", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.start();
		await w.tunnel.start();
		await connected(w);
		expect(w.fake.runs()).toBe(1);
	});

	test("start refuses what cannot work: no program, no tunnel yet, settings that are not complete", async () => {
		const noProgram = world({ installed: false });
		expect((await refused(noProgram.tunnel.start())).message).toContain("install");

		const noTunnel = world();
		noTunnel.store.patch({ hostname: HOST, team: "t", aud: AUD, emails: ["a@b.co"] });
		expect((await refused(noTunnel.tunnel.start())).message).toContain("Set up");

		const incomplete = world();
		await ready(incomplete);
		incomplete.store.patch({ team: "", emails: [] });
		const error = await refused(incomplete.tunnel.start());
		expect(error.status).toBe(400);
		expect(error.message).toContain("team");
		expect(error.message).toContain("emails");
		// Nothing was enabled, and nothing ran.
		expect(incomplete.store.read().enabled).toBe(false);
		for (const w of [noProgram, noTunnel, incomplete]) expect(w.fake.runs()).toBe(0);
	});

	test("a tunnel whose credentials are gone does not start, and says so", async () => {
		const w = world();
		await ready(w);
		rmSync(join(w.fake.home, ".cloudflared", `${FAKE_TUNNEL_ID}.json`));
		const error = await refused(w.tunnel.start());
		expect(error.message).toContain("credentials");
		expect(w.fake.runs()).toBe(0);
	});

	test("what the tunnel says is read with its colours and timestamps taken off", async () => {
		const w = world();
		await ready(w);
		w.fake.setPlan(
			emit(
				"\u001b[90m2026-10-21T09:00:00Z\u001b[0m \u001b[32mINF\u001b[0m Starting tunnel",
				"\u001b[90m2026-10-21T09:00:01Z\u001b[0m \u001b[31mERR\u001b[0m Unable to reach the origin service",
			),
		);
		await w.tunnel.start();
		await pollUntil(() => w.tunnel.status().state === "error", "the error");
		expect(w.tunnel.status().message).toBe("Unable to reach the origin service");
	});

	/** What the page was told, in order, with the message each time. */
	const told = (w: { seen: Seen[] }) =>
		w.seen.map((s) => `${s.status.state}${s.status.message ? `: ${s.status.message}` : ""}`);

	test("one of two connections going leaves it `connected`; only the last one going makes it `starting` again", async () => {
		const w = world({ timings: { backoffMs: [60_000] } });
		await ready(w);
		// The unregistered connection, then an error line (it changes no state while connected, but the exit's message repeats it: it was read), then the end.
		w.fake.setPlan([
			...emit(LOG.starting, LOG.registered(0), LOG.registered(1), LOG.unregistered(0), LOG.error("marker")),
			"exit 1",
		]);
		await w.tunnel.start();
		await pollUntil(() => w.seen.some((s) => s.status.message?.includes("exited")), "the end of the run");
		expect(told(w).some((t) => t.includes("marker"))).toBe(true);
		// From `connected` to the end there was no `starting`: one connection was still there.
		expect(states(w).slice(0, 3)).toEqual(["starting", "connected", "error"]);
	});

	test("the last connection going is `starting` again, and it says it reconnects", async () => {
		const w = world();
		await ready(w);
		w.fake.setPlan(emit(LOG.starting, LOG.registered(0), LOG.registered(1), LOG.unregistered(0), LOG.unregistered(1)));
		await w.tunnel.start();
		await pollUntil(() => w.seen.some((s) => s.status.message?.includes("econnect")), "the reconnection to be told");
		expect(states(w)).toEqual(["starting", "connected", "starting"]);
		expect(w.tunnel.status().state).toBe("starting");
	});

	test("an error before any connection is the state `error` with the message, a connection after it clears it", async () => {
		const w = world();
		await ready(w);
		w.fake.setPlan(emit(LOG.starting, LOG.error("Unable to reach the origin service"), LOG.registered(0)));
		await w.tunnel.start();
		await connected(w);
		const error = w.seen.find((s) => s.status.state === "error");
		expect(error?.status.message).toBe("Unable to reach the origin service connIndex=0 event=0 ip=198.41.200.1");
		expect(states(w)).toEqual(["starting", "error", "connected"]);
		expect(w.tunnel.status()).toEqual({ state: "connected" });
	});

	test("an error while connected is not an outage: cloudflared retries by itself", async () => {
		const w = world({ timings: { backoffMs: [60_000] } });
		await ready(w);
		w.fake.setPlan([...connectedPlan(), ...emit(LOG.error("Failed to refresh DNS local resolver")), "exit 1"]);
		await w.tunnel.start();
		await pollUntil(() => w.seen.some((s) => s.status.state === "error"), "the end of the run");
		// The first `error` is the process ending, not the error line that came while it was connected.
		const first = w.seen.find((s) => s.status.state === "error");
		expect(first?.status.message).toContain("exited with code 1");
		expect(states(w)).toEqual(["starting", "connected", "error"]);
	});

	test("a state that has not changed is not announced again", async () => {
		const w = world({ timings: { backoffMs: [60_000] } });
		await ready(w);
		// Four connections register, then the run ends: by then every line was read.
		w.fake.setPlan([...connectedPlan(), "exit 1"]);
		await w.tunnel.start();
		await pollUntil(() => w.seen.some((s) => s.status.state === "error"), "the end of the run");
		expect(states(w).filter((s) => s === "connected")).toHaveLength(1);
	});
});

describe("restarting", () => {
	/** The wait before each start of the run `n` (from the error that ended the one before it to the `starting` after it). */
	const waits = (seen: Seen[]) => {
		const out: number[] = [];
		let endedAt: number | null = null;
		for (const s of seen) {
			if (s.status.state === "error") endedAt ??= s.at;
			else if (s.status.state === "starting" && endedAt !== null) {
				out.push(s.at - endedAt);
				endedAt = null;
			}
		}
		return out;
	};

	test("a cloudflared that exits is started again after a wait that grows, and the state says why meanwhile", async () => {
		const w = world({ timings: { backoffMs: [60, 250, 250], stableMs: 60_000 } });
		await ready(w);
		for (const n of [1, 2, 3]) w.fake.setPlan(emit(LOG.error(`attempt ${n} failed`)).concat("exit 1"), n);
		await w.tunnel.start();
		await connected(w);
		expect(w.fake.runs()).toBe(4);
		const gaps = waits(w.seen);
		expect(gaps).toHaveLength(3);
		expect(gaps[0]).toBeGreaterThanOrEqual(55);
		expect(gaps[1]).toBeGreaterThanOrEqual(240);
		expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0);
		const errors = w.seen.filter((s) => s.status.state === "error").map((s) => s.status.message ?? "");
		expect(errors.some((m) => m.includes("exited") && m.includes("code 1") && m.includes("starting it again"))).toBe(
			true,
		);
		expect(errors.some((m) => m.includes("attempt 1 failed"))).toBe(true);
	});

	test("a run that stayed up long enough starts the waits over", async () => {
		const w = world({ timings: { backoffMs: [100, 400, 5000], stableMs: 300 } });
		await ready(w);
		w.fake.setPlan(emit(LOG.error("one")).concat("exit 1"), 1);
		w.fake.setPlan(emit(LOG.error("two")).concat("exit 1"), 2);
		// The third connects, stays up past `stableMs`, then dies: the wait after it is the first wait again, not the third.
		w.fake.setPlan([...emit(LOG.starting, LOG.registered(0)), "sleep 0.6", "exit 1"], 3);
		await w.tunnel.start();
		await pollUntil(() => w.fake.runs() === 4, "the fourth start", 10_000);
		const gaps = waits(w.seen);
		expect(gaps[1]).toBeGreaterThanOrEqual(390);
		expect(gaps[2]).toBeLessThan(2000);
	});

	test("stop ends it for good: no start follows, also while it waits to be started again", async () => {
		const w = world({ timings: { backoffMs: [500], stableMs: 60_000 } });
		await ready(w);
		w.fake.setPlan(emit(LOG.error("down")).concat("exit 1"));
		await w.tunnel.start();
		await pollUntil(() => w.tunnel.status().state === "error", "the failure");
		await w.tunnel.stop();
		expect(w.tunnel.status()).toEqual({ state: "off" });
		// Something that must NOT happen in another process (a start after the wait): a real wait, longer than the wait it rules out.
		await Bun.sleep(900);
		expect(w.fake.runs()).toBe(1);
		expect(w.tunnel.status()).toEqual({ state: "off" });
	});
});

describe("stopping", () => {
	test("stop ends the process with a signal it can answer, and the state is off", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.start();
		await connected(w);
		const pid = w.fake.runPid(1);
		await w.tunnel.stop();
		expect(processExists(pid)).toBe(false);
		expect(w.fake.events()).toContain("term 1");
		expect(w.tunnel.status()).toEqual({ state: "off" });
		// Something that must NOT happen in another process (a restart after the wait): a real wait, longer than the wait it rules out.
		await Bun.sleep(300);
		expect(w.fake.runs()).toBe(1);
	});

	test("stop with nothing running is not an error, and a stopped tunnel can start again", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.stop();
		await w.tunnel.start();
		await connected(w);
		await w.tunnel.stop();
		await w.tunnel.start();
		await pollUntil(() => w.fake.runs() === 2 && w.tunnel.status().state === "connected", "the second run");
	});

	test("a cloudflared that ignores the polite signal is killed after the grace", async () => {
		const w = world({ timings: { stopGraceMs: 300 } });
		await ready(w);
		// A run that ignores SIGTERM and carries on.
		w.fake.fail("ignore-term");
		await w.tunnel.start();
		await connected(w);
		const pid = w.fake.runPid(1);
		const started = Date.now();
		await w.tunnel.stop();
		expect(processExists(pid)).toBe(false);
		expect(w.fake.events()).not.toContain("term 1");
		// It was given its grace first.
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
	});

	test("close ends the tunnel and what was left of an earlier install or login", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.start();
		await connected(w);
		const pid = w.fake.runPid(1);
		await w.tunnel.close();
		expect(processExists(pid)).toBe(false);
	});
});

describe("a cloudflared a crashed server left behind", () => {
	async function leftover(w: ReturnType<typeof world>) {
		const proc = spawn([w.fake.bin, "tunnel", "--no-autoupdate", "--config", w.yml, "run", FAKE_TUNNEL_ID], {
			env: { PATH: process.env.PATH, HOME: w.fake.home },
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		strays.push(proc);
		await pollUntil(() => w.fake.runs() === 1, "the leftover to start");
		const command = commandOf(proc.pid) as string;
		writeFileSync(join(w.dataDir, "cloudflared.pid"), JSON.stringify({ pid: proc.pid, command }));
		return proc;
	}

	test("is stopped before the new one starts, so the hostname never goes to a server that is gone", async () => {
		const w = world();
		await ready(w);
		const old = await leftover(w);
		await w.tunnel.start();
		await connected(w);
		await pollUntil(() => !processExists(old.pid), "the leftover to end");
		expect(w.fake.runs()).toBe(2);
	});

	test("is left alone when its pid now belongs to another program", async () => {
		const w = world();
		await ready(w);
		const other = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", detached: true });
		strays.push(other);
		writeFileSync(
			join(w.dataDir, "cloudflared.pid"),
			JSON.stringify({ pid: other.pid, command: "cloudflared tunnel run" }),
		);
		await w.tunnel.start();
		await connected(w);
		expect(processExists(other.pid)).toBe(true);
	});

	test("a clean stop leaves no record", async () => {
		const w = world();
		await ready(w);
		await w.tunnel.start();
		await connected(w);
		expect(existsSync(join(w.dataDir, "cloudflared.pid"))).toBe(true);
		await w.tunnel.stop();
		expect(existsSync(join(w.dataDir, "cloudflared.pid"))).toBe(false);
	});

	test("Stop ends the one a crashed server left, and keeps its record until it has", async () => {
		const w = world();
		await ready(w);
		const old = await leftover(w);
		// This server's tunnel was never started: nothing of its own runs, and the one left behind carries the hostname.
		await w.tunnel.stop();
		await pollUntil(() => !processExists(old.pid), "the leftover to end");
		expect(w.tunnel.status()).toEqual({ state: "off" });
		expect(existsSync(join(w.dataDir, "cloudflared.pid"))).toBe(false);
		expect(w.fake.runs()).toBe(1);
	});

	test("Stop leaves a program alone whose pid is not the recorded one's, and forgets the stale record", async () => {
		const w = world();
		await ready(w);
		const other = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", detached: true });
		strays.push(other);
		writeFileSync(
			join(w.dataDir, "cloudflared.pid"),
			JSON.stringify({ pid: other.pid, command: "cloudflared tunnel run" }),
		);
		await w.tunnel.stop();
		expect(processExists(other.pid)).toBe(true);
		expect(existsSync(join(w.dataDir, "cloudflared.pid"))).toBe(false);
	});

	test("reapLeftover ends it without a start: what a server does when it comes up", async () => {
		const w = world();
		await ready(w);
		const old = await leftover(w);
		await w.tunnel.reapLeftover();
		// A child of this process that was killed is gone once the runtime has collected it.
		await pollUntil(() => !processExists(old.pid), "the leftover to end");
		expect(existsSync(join(w.dataDir, "cloudflared.pid"))).toBe(false);
	});
});
