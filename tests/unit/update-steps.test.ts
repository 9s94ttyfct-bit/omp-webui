import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attach, detach, download, stage, UpdateCancelled, UpdateError } from "../../server/update/steps.ts";
import { buildFixtures, disposeFixtures, type Fixtures } from "../support/update-fixtures.ts";

/**
 * The steps of an install that touch the outside (#571): the download (its size and SHA-256, a stall, a cancel), mounting
 * the disk image read-only, and copying the app out of it. Downloads come from a local server; the images are real
 * (`hdiutil`), the apps in them signed for real.
 */

const mac = process.platform === "darwin" && Bun.which("hdiutil") !== null && Bun.which("codesign") !== null;
const root = mkdtempSync(join(tmpdir(), "ompw-steps-"));
let fixtures: Fixtures;

// Two throwaway certificates and four disk images: some seconds of `openssl`, `codesign` and `hdiutil`.
beforeAll(async () => {
	if (mac) fixtures = await buildFixtures(join(root, "fx"), ["good", "quarantined", "noApp", "garbage"]);
}, 120_000);
afterAll(() => {
	if (mac) disposeFixtures(fixtures);
	rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ download

const BODY = Buffer.from("installer bytes ".repeat(4096));
const SHA = createHash("sha256").update(BODY).digest("hex");

interface Source {
	url: string;
	stop(): void;
}

/** A server whose `/file` is `serve`'s answer. */
function serving(serve: (req: Request) => Response | Promise<Response>): Source {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
	return { url: `http://127.0.0.1:${server.port}/file`, stop: () => void server.stop(true) };
}

let counter = 0;
const dest = () => join(root, `download-${++counter}.part`);

function options(source: Source, over: Partial<Parameters<typeof download>[0]> = {}) {
	const received: number[] = [];
	return {
		received,
		opts: {
			url: source.url,
			dest: dest(),
			size: BODY.length,
			sha256: SHA,
			signal: new AbortController().signal,
			onProgress: (n: number) => received.push(n),
			...over,
		},
	};
}

const refusedWith = async (run: Promise<unknown>) => {
	try {
		await run;
	} catch (e) {
		return e;
	}
	return null;
};

test("a download is written whole, counted as it comes, and is the size and hash the release lists", async () => {
	const source = serving(() => new Response(BODY));
	try {
		const { opts, received } = options(source);
		await download(opts);
		expect(readFileSync(opts.dest).equals(BODY)).toBe(true);
		expect(received.at(-1)).toBe(BODY.length);
		expect([...received].sort((a, b) => a - b)).toEqual(received);
	} finally {
		source.stop();
	}
});

test("a download without a listed digest is checked by its size alone", async () => {
	const source = serving(() => new Response(BODY));
	try {
		const { opts } = options(source, { sha256: null });
		await download(opts);
		expect(existsSync(opts.dest)).toBe(true);
	} finally {
		source.stop();
	}
});

test("a download of another size than the release lists is refused, and is not kept", async () => {
	const shorter = serving(() => new Response(BODY.subarray(0, 100), { headers: { "content-length": "100" } }));
	const longer = serving(() => new Response(Buffer.concat([BODY, Buffer.from("extra")])));
	try {
		for (const source of [shorter, longer]) {
			const { opts } = options(source);
			const error = await refusedWith(download(opts));
			expect(error).toBeInstanceOf(UpdateError);
			expect((error as UpdateError).code).toBe("size");
			expect((error as UpdateError).params.expected).toBe(BODY.length);
			expect(existsSync(opts.dest)).toBe(false);
		}
	} finally {
		shorter.stop();
		longer.stop();
	}
});

test("a download whose hash is not the listed one is refused with both hashes, and is not kept", async () => {
	const damaged = Buffer.from(BODY);
	damaged[10] = damaged[10] === 0 ? 1 : 0;
	const source = serving(() => new Response(damaged));
	try {
		const { opts } = options(source);
		const error = (await refusedWith(download(opts))) as UpdateError;
		expect(error.code).toBe("digest");
		expect(error.params).toEqual({ expected: SHA, actual: createHash("sha256").update(damaged).digest("hex") });
		expect(existsSync(opts.dest)).toBe(false);
	} finally {
		source.stop();
	}
});

test("a server that answers with an error, or not at all, is a failed download that says which", async () => {
	const missing = serving(() => new Response("no", { status: 404 }));
	try {
		const error = (await refusedWith(download(options(missing).opts))) as UpdateError;
		expect([error.code, error.params]).toEqual(["download", { reason: "http", status: 404 }]);
	} finally {
		missing.stop();
	}
	const gone = serving(() => new Response(BODY));
	gone.stop();
	const refused = (await refusedWith(download(options(gone).opts))) as UpdateError;
	expect([refused.code, refused.params]).toEqual(["download", { reason: "network" }]);
});

test("a download that stops coming is given up on, not waited for", async () => {
	const stalls = serving(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(BODY.subarray(0, 1000));
						// never more, never closed
					},
				}),
				{ headers: { "content-length": String(BODY.length) } },
			),
	);
	try {
		const { opts } = options(stalls, { idleMs: 150 });
		const started = Date.now();
		const error = (await refusedWith(download(opts))) as UpdateError;
		expect([error.code, error.params]).toEqual(["download", { reason: "stalled" }]);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(existsSync(opts.dest)).toBe(false);
	} finally {
		stalls.stop();
	}
});

test("a cancelled download stops at once and leaves nothing: it is no failure", async () => {
	const slow = serving(
		() =>
			new Response(
				new ReadableStream({
					async pull(controller) {
						// A slow link: it is the time between pieces that gives the cancel something to interrupt.
						await Bun.sleep(40);
						controller.enqueue(BODY.subarray(0, 2048));
					},
				}),
				{ headers: { "content-length": String(BODY.length) } },
			),
	);
	try {
		const cancel = new AbortController();
		const second = Promise.withResolvers<void>();
		const { opts, received } = options(slow, { signal: cancel.signal });
		const progress = opts.onProgress;
		opts.onProgress = (n) => {
			progress(n);
			if (received.length === 2) second.resolve();
		};
		const run = download(opts);
		await second.promise;
		cancel.abort();
		expect(await refusedWith(run)).toBeInstanceOf(UpdateCancelled);
		expect(existsSync(opts.dest)).toBe(false);
	} finally {
		slow.stop();
	}
});

// ------------------------------------------------------------------ redirects

/** A `fetch` that answers each address from `routes` (a redirect names its place), and records what it was asked. */
function routed(routes: Record<string, Response | (() => Response)>) {
	const asked: { url: string; redirect: RequestRedirect | undefined }[] = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		asked.push({ url: String(url), redirect: init?.redirect });
		const answer = routes[String(url)];
		if (!answer) return new Response("nothing here", { status: 404 });
		return typeof answer === "function" ? answer() : answer;
	}) as unknown as typeof fetch;
	return { fetcher, asked };
}
const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const START = "https://github.com/9s94ttyfct-bit/omp-webui/releases/download/v9.0.0/omp-webui-v9.0.0.dmg";
const STORAGE = "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x";

test("a download follows GitHub's own redirect (github.com, then its asset storage) and is the same file", async () => {
	const { fetcher, asked } = routed({ [START]: redirectTo(STORAGE), [STORAGE]: () => new Response(BODY) });
	const source = { url: START, stop() {} };
	const { opts } = options(source, { fetch: fetcher });
	await download(opts);
	expect(readFileSync(opts.dest).equals(BODY)).toBe(true);
	expect(asked.map((a) => a.url)).toEqual([START, STORAGE]);
	// Every hop is followed by the download itself, never by fetch: it is what makes each one checkable.
	expect(asked.every((a) => a.redirect === "manual")).toBe(true);
});

test("a redirect to anywhere else is refused naming the host, and nothing is written or asked of it", async () => {
	for (const [target, host] of [
		["http://127.0.0.1:9/file", "127.0.0.1:9"],
		["http://objects.githubusercontent.com/file", "objects.githubusercontent.com"],
		["https://evil.example/file", "evil.example"],
		["https://github.com.evil.example/file", "github.com.evil.example"],
		["file:///etc/passwd", "?"],
	] as const) {
		const { fetcher, asked } = routed({ [START]: redirectTo(target), [target]: () => new Response(BODY) });
		const { opts, received } = options({ url: START, stop() {} }, { fetch: fetcher });
		const error = (await refusedWith(download(opts))) as UpdateError;
		expect(error, target).toBeInstanceOf(UpdateError);
		expect([error.code, error.params.reason], target).toEqual(["download", "redirect"]);
		expect(error.params.host, target).toBe(host);
		expect(
			asked.map((a) => a.url),
			target,
		).toEqual([START]);
		expect(received, target).toEqual([]);
		expect(existsSync(opts.dest), target).toBe(false);
	}
});

test("a redirect that names no place, an address that is none, or a chain that never ends, is refused too", async () => {
	const none = routed({ [START]: () => new Response(null, { status: 302 }) });
	expect(
		((await refusedWith(download(options({ url: START, stop() {} }, { fetch: none.fetcher }).opts))) as UpdateError)
			.params.reason,
	).toBe("redirect");
	const garbled = routed({ [START]: redirectTo("https://") });
	expect(
		((await refusedWith(download(options({ url: START, stop() {} }, { fetch: garbled.fetcher }).opts))) as UpdateError)
			.params.reason,
	).toBe("redirect");
	// github.com -> storage -> storage … : three hops are allowed, a fourth is not.
	const loop = routed({ [START]: redirectTo(STORAGE), [STORAGE]: redirectTo(STORAGE) });
	const error = (await refusedWith(
		download(options({ url: START, stop() {} }, { fetch: loop.fetcher }).opts),
	)) as UpdateError;
	expect([error.code, error.params.reason]).toEqual(["download", "redirect"]);
	expect(loop.asked.length).toBe(4);
});

// ------------------------------------------------------------------ mount and stage

/** Whether `path` is a mount point right now (what is mounted is the truth, not what the code thinks it did). */
const mounted = (path: string) =>
	Bun.spawnSync(["mount"])
		.stdout.toString()
		.includes(` on ${Bun.spawnSync(["realpath", path]).stdout.toString().trim()} (`);

async function withImage<T>(dmg: string, use: (mount: string) => Promise<T>): Promise<T> {
	const mount = mkdtempSync(join(root, "mount-"));
	try {
		await attach(dmg, mount);
		return await use(mount);
	} finally {
		await detach(mount);
		rmSync(mount, { recursive: true, force: true });
	}
}

test.skipIf(!mac)("the image is mounted read-only, and detaching it leaves nothing mounted", async () => {
	const mount = mkdtempSync(join(root, "mount-"));
	await attach(fixtures.installers.good?.dmg as string, mount);
	try {
		expect(mounted(mount)).toBe(true);
		expect(existsSync(join(mount, "omp-webui.app", "Contents", "Info.plist"))).toBe(true);
		// Nothing can be written to it: the app inside cannot be altered between the checks and the copy.
		expect(() => writeFileSync(join(mount, "omp-webui.app", "changed"), "x")).toThrow();
	} finally {
		await detach(mount);
	}
	expect(mounted(mount)).toBe(false);
	rmSync(mount, { recursive: true, force: true });
});

test.skipIf(!mac)("a file that is no disk image does not mount, and says what hdiutil said", async () => {
	const mount = mkdtempSync(join(root, "mount-"));
	const error = (await refusedWith(attach(fixtures.installers.garbage?.dmg as string, mount))) as UpdateError;
	expect(error.code).toBe("mount");
	expect(String(error.params.detail)).not.toBe("");
	expect(mounted(mount)).toBe(false);
	rmSync(mount, { recursive: true, force: true });
});

test.skipIf(!mac)(
	"the app is copied out whole, still signed, and without the quarantine mark macOS put on it",
	async () => {
		const dir = mkdtempSync(join(root, "install-"));
		const staged = join(dir, "omp-webui.app.updating");
		await withImage(fixtures.installers.quarantined?.dmg as string, async (mount) => {
			// The image really holds a quarantined app: without that the check below would prove nothing.
			const before = Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", join(mount, "omp-webui.app")]);
			expect(before.exitCode).toBe(0);
			await stage(mount, "omp-webui.app", staged);
		});
		for (const path of [staged, join(staged, "Contents", "MacOS", "omp-webui")]) {
			expect(Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", path]).exitCode, path).not.toBe(0);
		}
		expect(Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", staged]).exitCode).toBe(0);
	},
);

test.skipIf(!mac)("an image without the app is refused as having none, and nothing is copied", async () => {
	const dir = mkdtempSync(join(root, "install-"));
	const staged = join(dir, "omp-webui.app.updating");
	await withImage(fixtures.installers.noApp?.dmg as string, async (mount) => {
		const error = (await refusedWith(stage(mount, "omp-webui.app", staged))) as UpdateError;
		expect([error.code, error.params]).toEqual(["noApp", { name: "omp-webui.app" }]);
	});
	expect(existsSync(staged)).toBe(false);
});

test.skipIf(!mac)("a folder the user cannot write is refused before anything is copied, naming it", async () => {
	const dir = mkdtempSync(join(root, "locked-"));
	chmodSync(dir, 0o555);
	try {
		await withImage(fixtures.installers.good?.dmg as string, async (mount) => {
			const error = (await refusedWith(
				stage(mount, "omp-webui.app", join(dir, "omp-webui.app.updating")),
			)) as UpdateError;
			expect([error.code, error.params]).toEqual(["notWritable", { dir }]);
		});
		expect(existsSync(join(dir, "omp-webui.app.updating"))).toBe(false);
	} finally {
		chmodSync(dir, 0o755);
	}
});

test.skipIf(!mac)("not enough room next to the app is refused with what is needed and what is free", async () => {
	const dir = mkdtempSync(join(root, "install-"));
	const staged = join(dir, "omp-webui.app.updating");
	await withImage(fixtures.installers.good?.dmg as string, async (mount) => {
		const error = (await refusedWith(stage(mount, "omp-webui.app", staged, () => 1000))) as UpdateError;
		expect(error.code).toBe("space");
		expect(error.params.free).toBe(1000);
		expect(error.params.needed as number).toBeGreaterThan(1000);
		// A file system that cannot say how much is free is no reason to refuse.
		await stage(mount, "omp-webui.app", staged, () => null);
	});
	expect(existsSync(join(staged, "Contents", "Info.plist"))).toBe(true);
	mkdirSync(join(dir, "unused"), { recursive: true });
});
