import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, RuntimeAsset } from "../../server/semantic/assets.ts";
import {
	type InstallOptions,
	install,
	installed,
	memberSafe,
	SemanticInstallError,
	treeContained,
} from "../../server/semantic/install.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * Getting semantic search's build and model: from the first address that gives the bytes the pins name, unpacked only when
 * every member stays inside its folder, and nothing left behind when it fails.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-seminstall-"));
const files = new Map<string, Buffer<ArrayBuffer>>();
const asked: string[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const path = new URL(req.url).pathname;
		asked.push(path);
		const body = files.get(path);
		return body ? new Response(body) : new Response("missing", { status: 404 });
	},
});
afterAll(() => {
	server.stop(true);
	removeScratch(root);
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** `tar -czf` of `make`'s tree (made in a fresh folder; tar run in `sub` of it), served at `/<name>`: the asset that names it. */
async function archive(
	name: string,
	make: (dir: string) => void,
	tarArgs: string[] = ["."],
	sub = ".",
): Promise<RuntimeAsset> {
	const dir = mkdtempSync(join(root, "tree-"));
	make(dir);
	const out = join(root, name);
	const p = Bun.spawnSync(["tar", "-czf", out, ...tarArgs], { cwd: join(dir, sub) });
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	const bytes = readFileSync(out);
	files.set(`/${name}`, bytes);
	return { name, urls: [url(`/${name}`)], size: bytes.length, sha256: sha(bytes), kind: "tar" };
}

function model(name: string, bytes: Buffer<ArrayBuffer> = Buffer.from("GGUF model bytes".repeat(64))): Asset {
	files.set(`/${name}`, bytes);
	return { name, urls: [url(`/${name}`)], size: bytes.length, sha256: sha(bytes) };
}

/** A build as llama.cpp publishes it: one folder, the server, a library under two names. */
const goodBuild = (name: string) =>
	archive(name, (dir) => {
		mkdirSync(join(dir, "llama-b1"));
		writeFileSync(join(dir, "llama-b1", "llama-server"), "#!/bin/sh\necho server\n");
		writeFileSync(join(dir, "llama-b1", "libggml.1.dylib"), "lib");
		symlinkSync("libggml.1.dylib", join(dir, "llama-b1", "libggml.dylib"));
	});

let n = 0;
function options(over: Partial<InstallOptions>): { dir: string; opts: InstallOptions; progress: number[] } {
	const progress: number[] = [];
	return {
		dir: join(root, `install-${++n}`),
		progress,
		opts: {
			signal: new AbortController().signal,
			onProgress: (received) => progress.push(received),
			build: "b1",
			freeBytes: () => null,
			...over,
		},
	};
}

async function failure(p: Promise<unknown>): Promise<SemanticInstallError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof SemanticInstallError) return e;
		throw e;
	}
	throw new Error("install did not fail");
}

test("the build and the model are downloaded, checked and put in place; a second install downloads nothing", async () => {
	const runtime = await goodBuild("good.tar.gz");
	const m = model("good.gguf");
	const { dir, opts, progress } = options({ runtime, model: m });
	const ready = await install(dir, opts);
	expect(ready).toEqual(installed(dir, m, "b1") as NonNullable<ReturnType<typeof installed>>);
	expect(readFileSync(ready.server, "utf8")).toContain("echo server");
	expect(readlinkSync(join(dir, "runtime-b1", "libggml.dylib"))).toBe("libggml.1.dylib");
	expect(progress.at(-1)).toBe(runtime.size + m.size);
	expect(existsSync(join(dir, "downloads"))).toBe(false);

	const before = asked.length;
	await install(dir, opts);
	expect(asked.length).toBe(before);
});

test("an address that fails is passed over for the next one", async () => {
	const runtime = await goodBuild("mirror.tar.gz");
	const m = model("mirror.gguf");
	const { dir, opts } = options({ runtime, model: { ...m, urls: [url("/gone.gguf"), ...m.urls] } });
	await install(dir, opts);
	expect(asked).toContain("/gone.gguf");
	expect(installed(dir, m, "b1")).not.toBeNull();
});

test("bytes that are not the pinned ones are refused, and nothing is left of them", async () => {
	const runtime = await goodBuild("pinned.tar.gz");
	const m = model("tampered.gguf");
	const { dir, opts } = options({ runtime, model: { ...m, sha256: "0".repeat(64) } });
	expect((await failure(install(dir, opts))).failure.code).toBe("verify");
	expect(existsSync(join(dir, "model"))).toBe(false);
	expect(existsSync(join(dir, "downloads"))).toBe(false);
});

test("an archive with a member outside its folder is not unpacked", async () => {
	const evil = await archive(
		"evil.tar.gz",
		(dir) => {
			mkdirSync(join(dir, "in"));
			writeFileSync(join(dir, "escaped"), "x");
			writeFileSync(join(dir, "in", "llama-server"), "x");
		},
		["-P", "llama-server", "../escaped"],
		"in",
	);
	const { dir, opts } = options({ runtime: evil, model: model("evil.gguf") });
	expect((await failure(install(dir, opts))).failure.code).toBe("unpack");
	expect(existsSync(join(dir, "runtime-b1"))).toBe(false);
	expect(existsSync(join(dir, "..", "escaped"))).toBe(false);
});

test("an archive with a link leading out of it is not put in place", async () => {
	const linked = await archive("linked.tar.gz", (dir) => {
		mkdirSync(join(dir, "llama-b1"));
		writeFileSync(join(dir, "llama-b1", "llama-server"), "x");
		symlinkSync("/etc/hosts", join(dir, "llama-b1", "hosts"));
	});
	const { dir, opts } = options({ runtime: linked, model: model("linked.gguf") });
	expect((await failure(install(dir, opts))).failure.code).toBe("unpack");
	expect(existsSync(join(dir, "runtime-b1"))).toBe(false);
});

test("an install that would not fit on the disk does not start", async () => {
	const runtime = await goodBuild("big.tar.gz");
	const { dir, opts } = options({ runtime, model: model("big.gguf"), freeBytes: () => 1024 });
	expect((await failure(install(dir, opts))).failure.code).toBe("space");
	expect(asked).not.toContain("/big.gguf");
});

test("a computer with no build is refused before anything is downloaded", async () => {
	const { dir, opts } = options({ runtime: null, model: model("none.gguf") });
	expect((await failure(install(dir, opts))).failure.code).toBe("unsupported");
	expect(asked).not.toContain("/none.gguf");
});

test("member names that unpack outside the folder are told apart", () => {
	for (const ok of ["llama-b1/", "llama-b1/llama-server", "./lib/x.dylib", "a..b"]) expect(memberSafe(ok)).toBe(true);
	for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a\\..\\x", "C:/x", "c:x", "a\0b"])
		expect(memberSafe(bad)).toBe(false);
});

test("a tree is contained when every link leads inside it", () => {
	const dir = mkdtempSync(join(root, "contained-"));
	mkdirSync(join(dir, "lib"));
	writeFileSync(join(dir, "lib", "a.1"), "x");
	symlinkSync("a.1", join(dir, "lib", "a"));
	symlinkSync("lib/a.1", join(dir, "top"));
	expect(treeContained(dir)).toBe(true);
	symlinkSync("../..", join(dir, "lib", "up"));
	expect(treeContained(dir)).toBe(false);
});
