// needs: posixFiles
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { packTar, safeEntryPath, staysInside, TarUnpacker, tarSize, walkFolder } from "../../server/remote-run/tar.ts";
import {
	bytesText,
	describeCopy,
	parseRemoteCopyArgs,
	REMOTE_COPY_TOOL,
	RemoteCopyError,
	remoteCopyTool,
} from "../../shared/remote-copy.ts";
import { craftTar as craft } from "../support/tar.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * `remote_copy`'s contract (`shared/remote-copy.ts`) and the tar a folder goes as (`server/remote-run/tar.ts`): the tool as the
 * model is told of it, its arguments as they are checked, what a call is told; a folder packed and unpacked whole (folders,
 * files, links that stay inside, times and permissions), what the walk leaves out, and the entries an unpacker refuses before
 * writing anything of them.
 */

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 1000 };
const scratch = tempDir("ompw-remote-copy-");
let n = 0;
const fresh = (name: string) => {
	const dir = join(scratch, `${name}-${n++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Unpack `tar` into a new folder, in pieces of `piece` bytes (a tar arrives cut anywhere): what came of it, or what it threw. */
async function attempt(tar: Uint8Array, piece = 777, limits = LIMITS) {
	const dest = fresh("dest");
	const u = new TarUnpacker(dest, limits);
	try {
		for (let at = 0; at < tar.length; at += piece) await u.write(tar.subarray(at, at + piece));
		return { dest, ...(await u.end()), error: null };
	} catch (error) {
		await u.close();
		return { dest, files: 0, bytes: 0, error };
	}
}

async function unpack(tar: Uint8Array, piece = 777, limits = LIMITS) {
	const r = await attempt(tar, piece, limits);
	if (r.error) throw r.error;
	return r;
}

describe("the tool", () => {
	test("names the computers in an enum, and its description says both sides' paths, the limit and overwrite", () => {
		const tool = remoteCopyTool(["Server1", "Build box"]);
		expect(tool.name).toBe(REMOTE_COPY_TOOL);
		expect(tool.loadMode).toBe("essential");
		expect(tool.parameters).toMatchObject({
			properties: { computer: { enum: ["Server1", "Build box"] }, direction: { enum: ["to", "from"] } },
			required: ["computer", "direction", "local", "remote"],
			additionalProperties: false,
		});
		for (const words of ['"Server1"', "conversation's folder", "~/", "2 GB", "overwrite", "replaced whole"])
			expect(tool.description).toContain(words);
	});

	test("its arguments are checked, with words the model can act on", () => {
		const names = ["Server1"];
		expect(
			parseRemoteCopyArgs({ computer: "Server1", direction: "to", local: "dist", remote: "~/app" }, names),
		).toEqual({
			computer: "Server1",
			direction: "to",
			local: "dist",
			remote: "~/app",
			overwrite: false,
		});
		const ok = { computer: "Server1", direction: "from", local: "a", remote: "/b", overwrite: true };
		expect(parseRemoteCopyArgs(ok, names)).toMatchObject({ overwrite: true });
		const refused: [unknown, string][] = [
			[null, "Give the computer"],
			[{ ...ok, computer: "Other" }, '"Server1"'],
			[{ ...ok, direction: "up" }, "direction"],
			[{ ...ok, local: "" }, "local must be a path"],
			[{ ...ok, remote: 3 }, "remote must be a path"],
			[{ ...ok, remote: "/a\nb" }, "one line"],
			[{ ...ok, overwrite: "yes" }, "overwrite"],
		];
		for (const [args, words] of refused) {
			const r = parseRemoteCopyArgs(args, names);
			expect("error" in r ? r.error : "").toContain(words);
		}
	});

	test("a copy is told in one line, then where from and where to, on which computer", () => {
		const r = { kind: "folder" as const, files: 3, bytes: 1_234_567, leftOut: 0, replaced: false, ms: 2345 };
		expect(describeCopy("Server1", "to", { ...r, from: "/work/dist", to: "/srv/app" })).toBe(
			"Server1 · copied 3 files, 1.2 MB · 2.3s\nFrom: /work/dist (this computer)\nTo: /srv/app (Server1)",
		);
		const back = describeCopy("Server1", "from", { ...r, files: 1, leftOut: 2, replaced: true, from: "/a", to: "/b" });
		expect(back).toStartWith("Server1 · copied 1 file, 1.2 MB · 2.3s\nFrom: /a (Server1)\nTo: /b (this computer)\n");
		expect(back).toContain("replaced");
		expect(back).toContain("Left out: 2 entries");
		expect([bytesText(1), bytesText(999), bytesText(1500), bytesText(2_000_000_000)]).toEqual([
			"1 byte",
			"999 bytes",
			"1.5 KB",
			"2.0 GB",
		]);
	});
});

describe("what may be in a folder's tar", () => {
	test("a link stays inside when its target is relative and goes up no further than the folders above it", () => {
		expect(staysInside("a", "b")).toBe(true);
		expect(staysInside("a/b/l", "../../x/y")).toBe(true);
		expect(staysInside("a/l", "./x/../")).toBe(false);
		expect(staysInside("a/l", "../..")).toBe(false);
		expect(staysInside("l", "../x")).toBe(false);
		expect(staysInside("l", "/etc/passwd")).toBe(false);
		expect(staysInside("l", "C:/x")).toBe(false);
		expect(staysInside("a/l", "x/../../y")).toBe(false);
		expect(staysInside("l", "")).toBe(false);
	});

	test("an entry's name must stay in the folder", () => {
		expect(safeEntryPath("a/b/")).toBe("a/b");
		for (const bad of ["", "/", "/etc/x", "../x", "a/../../x", "a//b", "./a", "a\\b", "a\0b"])
			expect(safeEntryPath(bad)).toBeNull();
	});
});

describe("a folder packed and unpacked", () => {
	function tree(): string {
		const src = fresh("src");
		mkdirSync(join(src, "sub/deeper"), { recursive: true });
		writeFileSync(join(src, "a.txt"), "alpha\n");
		writeFileSync(join(src, "sub/deeper/b.bin"), Buffer.alloc(70_000, 7));
		writeFileSync(join(src, "empty"), "");
		writeFileSync(join(src, "sub", `${"long-name-".repeat(12)}ü.txt`), "long\n");
		writeFileSync(join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
		symlinkSync("deeper/b.bin", join(src, "sub/link"));
		symlinkSync("/etc/hosts", join(src, "outside"));
		symlinkSync("../..", join(src, "sub/up"));
		return src;
	}

	test("is the same folder: files, folders, links inside, permissions and times; links that lead out are left out", async () => {
		const src = tree();
		const walked = await walkFolder(src, LIMITS);
		expect(walked.leftOut).toBe(2);
		expect(walked.files).toBe(5);
		expect(walked.bytes).toBe(6 + 70_000 + 10 + 5);
		const tar = await bytesOf(packTar(src, walked.entries));
		expect(tar.length).toBe(tarSize(walked.entries));
		const { dest, files, bytes } = await unpack(tar);
		expect({ files, bytes }).toEqual({ files: 5, bytes: walked.bytes });
		expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha\n");
		expect(readFileSync(join(dest, "sub/deeper/b.bin")).equals(Buffer.alloc(70_000, 7))).toBe(true);
		expect(readFileSync(join(dest, "sub", `${"long-name-".repeat(12)}ü.txt`), "utf8")).toBe("long\n");
		expect(readFileSync(join(dest, "empty"), "utf8")).toBe("");
		expect(readlinkSync(join(dest, "sub/link"))).toBe("deeper/b.bin");
		expect(readFileSync(join(dest, "sub/link")).length).toBe(70_000);
		expect(
			existsSync(join(dest, "outside")) || lstatSync(join(dest, "outside"), { throwIfNoEntry: false }),
		).toBeFalsy();
		expect(lstatSync(join(dest, "sub/up"), { throwIfNoEntry: false })).toBeUndefined();
		expect(statSync(join(dest, "run.sh")).mode & 0o777).toBe(0o755);
		expect(Math.floor(statSync(join(dest, "a.txt")).mtimeMs / 1000)).toBe(
			Math.floor(statSync(join(src, "a.txt")).mtimeMs / 1000),
		);
		expect(readdirSync(dest).sort()).toEqual(["a.txt", "empty", "run.sh", "sub"]);
	});

	test.skipIf(Bun.which("tar") === null)("is a tar the system's own tar reads", async () => {
		const src = tree();
		const walked = await walkFolder(src, LIMITS);
		const file = join(fresh("tarfile"), "x.tar");
		writeFileSync(file, await bytesOf(packTar(src, walked.entries)));
		const out = fresh("systar");
		const r = Bun.spawnSync(["tar", "-xf", file, "-C", out]);
		expect(r.exitCode, r.stderr.toString()).toBe(0);
		expect(readFileSync(join(out, "sub", `${"long-name-".repeat(12)}ü.txt`), "utf8")).toBe("long\n");
		expect(readlinkSync(join(out, "sub/link"))).toBe("deeper/b.bin");
	});

	test("a file that changed size after the walk ends the tar with `changed`", async () => {
		const src = tree();
		const walked = await walkFolder(src, LIMITS);
		writeFileSync(join(src, "a.txt"), "now longer than it was\n");
		await expect(bytesOf(packTar(src, walked.entries))).rejects.toMatchObject({ code: "changed" });
	});

	test("more than the limits allow is refused by the walk and by the unpacker", async () => {
		const src = tree();
		await expect(walkFolder(src, { maxBytes: 1000, maxEntries: 1000 })).rejects.toMatchObject({ code: "tooLarge" });
		await expect(walkFolder(src, { maxBytes: 1e9, maxEntries: 3 })).rejects.toMatchObject({ code: "tooLarge" });
		const walked = await walkFolder(src, LIMITS);
		const tar = await bytesOf(packTar(src, walked.entries));
		await expect(unpack(tar, 512, { maxBytes: 1000, maxEntries: 1000 })).rejects.toMatchObject({ code: "tooLarge" });
	});
});

describe("an unpacker refuses, before writing it", () => {
	const refused = async (tar: Uint8Array, words: string) => {
		const { dest, error } = await attempt(tar);
		expect(error).toBeInstanceOf(RemoteCopyError);
		if (!(error instanceof RemoteCopyError)) return dest;
		expect(error.code).toBe("badArchive");
		expect(error.message).toContain(words);
		return dest;
	};

	test("a name with .. or an absolute one, and writes nothing outside", async () => {
		const outside = join(scratch, "escaped.txt");
		await refused(craft([{ name: "../escaped.txt", body: "x" }]), "leads out");
		await refused(craft([{ name: "/tmp/ompw-abs.txt", body: "x" }]), "leads out");
		await refused(craft([{ name: "a/../../escaped.txt", body: "x" }]), "leads out");
		expect(existsSync(outside)).toBe(false);
	});

	test("a link that leads out, and a name that goes through a link or a file", async () => {
		await refused(craft([{ name: "l", type: "2", link: "/etc" }]), "link that leads out");
		await refused(craft([{ name: "l", type: "2", link: "../x" }]), "link that leads out");
		const dest = await refused(
			craft([
				{ name: "d", type: "5" },
				{ name: "d/l", type: "2", link: ".." },
				{ name: "d/l/x", body: "through" },
			]),
			"leads through a link",
		);
		expect(existsSync(join(dest, "x"))).toBe(false);
		await refused(
			craft([
				{ name: "f", body: "1" },
				{ name: "f/x", body: "2" },
			]),
			"leads through a link or a file",
		);
	});

	test("a hard link, a device, a name given twice, and a tar cut short", async () => {
		await refused(craft([{ name: "h", type: "1", link: "x" }]), "not a file, a folder or a link");
		await refused(craft([{ name: "c", type: "3" }]), "not a file, a folder or a link");
		await refused(
			craft([
				{ name: "f", body: "1" },
				{ name: "f", body: "2" },
			]),
			"twice",
		);
		const whole = craft([{ name: "f", body: "123" }]);
		await refused(whole.subarray(0, 1024), "cut short");
	});

	test("folders no entry names count as entries: a few deep names cannot make millions of folders", async () => {
		const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
		const limits = { maxBytes: 1024, maxEntries: 10 };
		const { dest, error } = await attempt(craft([{ name: `${deep}/f`, body: "x" }]), 512, limits);
		expect(error).toMatchObject({ code: "tooLarge" });
		// It stopped at the limit: no more folders than that were made.
		let made = 0;
		for (let d = dest; existsSync(join(d, `d${made}`)); d = join(d, `d${made++}`));
		expect(made).toBeLessThanOrEqual(10);
		// Ten entries in all, named or not, are taken.
		const shallow = Array.from({ length: 9 }, (_, i) => `d${i}`).join("/");
		expect((await attempt(craft([{ name: `${shallow}/f`, body: "x" }]), 512, limits)).error).toBeNull();
	});
});
