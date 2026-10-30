import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_LIMITS, type FolderFile, type FolderSaved } from "../../shared/folder.ts";
import { CSRF_HEADER, ERROR_HEADER, type FileTransfer, type TransferRecord } from "../../shared/transfer.ts";
import { type AccessKey, AUD, EMAIL, HOSTNAME, type Jwks, makeKey, startJwks, TEAM } from "../support/access-jwt.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { pollUntil } from "../support/poll.ts";
import { type RemoteClient, remoteClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The editor's save (`POST /api/folder/file`) against the real server, as the two kinds of page that come to it: the one on this
 * computer and one that came through the tunnel (Cloudflare Access, as its email). What the token and the CSRF header ask, what
 * the switch in Settings (`fileTransfer`) lets each of them do and that it is looked at again on every request, what the read
 * says of a file it may be saved over (`etag`, `editable`), what a save is made from, what no save is let into, and what the
 * audit log says. The rules of the save itself are in `tests/unit/folder-edit.test.ts`.
 *
 *   work/
 *     proj/        the conversation's folder
 *     outside.txt  outside it
 */

const root = mkdtempSync(join(tmpdir(), "ompw-edit-http-"));
const settingsFile = join(root, "remote.json");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let remote: RemoteClient;
let work: string;
let proj: string;
let file: string;

function setTransfer(value: FileTransfer): void {
	writeFileSync(
		settingsFile,
		JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL], fileTransfer: value }),
	);
}

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	setTransfer("full");
	s = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settingsFile, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url },
		{ login: false },
	);
	remote = remoteClient(s, key);
	work = realpathSync(s.work);
	proj = join(work, "proj");
	for (const [name, text] of [
		["notes.md", "# Notes\n\nfirst\n"],
		["src/app.ts", "export const a = 1;\n"],
		[".github/workflows/ci.yml", "on: push\n"],
		[".env", "TOKEN=abc\n"],
	] as const) {
		mkdirSync(join(proj, name, ".."), { recursive: true });
		writeFileSync(join(proj, name), text);
	}
	writeFileSync(join(work, "outside.txt"), "outside");
	symlinkSync(join(work, "outside.txt"), join(proj, "link-out"));
	file = writeChatSession(s.agentDir, {
		n: 95,
		title: "Edit probe",
		cwd: proj,
		turns: [{ prompt: "hi", reply: "ok" }],
	});
}, 90_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface Ask {
	/** Leave the token out (default: sent). */
	token?: boolean;
	/** Leave the CSRF header out (default: sent). */
	csrf?: boolean;
	method?: string;
}

interface Page {
	name: string;
	who: string;
	send(path: string, body?: string, ask?: Ask): Promise<Response>;
}

const here: Page = {
	name: "this computer",
	who: "local",
	send: (path, body, ask = {}) =>
		fetch(`${s.url}${path}`, {
			method: ask.method ?? (body === undefined ? "GET" : "POST"),
			headers: {
				...(ask.token === false ? {} : { "x-omp-webui-token": s.accessToken }),
				...(ask.csrf === false ? {} : { [CSRF_HEADER]: "1" }),
			},
			body,
			redirect: "manual",
		}),
};
const tunnel: Page = {
	name: "the tunnel",
	who: EMAIL,
	send: (path, body, ask = {}) =>
		remote.fetch(
			path,
			{
				token: ask.token,
				method: ask.method ?? (body === undefined ? "GET" : "POST"),
				headers: ask.csrf === false ? {} : { [CSRF_HEADER]: "1" },
			},
			body,
		),
};

const read = async (page: Page, path: string) => {
	const res = await page.send(`/api/folder/file?${new URLSearchParams({ file, path })}`);
	return { status: res.status, body: (await res.json()) as FolderFile & { error?: string } };
};
/** The text file `path`, as the read gives it (the test fails if it is not one). */
const text = async (page: Page, path: string) => {
	const { body } = await read(page, path);
	if (body.kind !== "text") throw new Error(`${path} is not text`);
	return body;
};
const save = async (page: Page, path: string, text: string, etag: string, ask?: Ask) => {
	const res = await page.send("/api/folder/file", JSON.stringify({ file, path, text, etag }), ask);
	return {
		status: res.status,
		code: res.headers.get(ERROR_HEADER),
		body: (await res.json()) as FolderSaved & { code?: string; error?: string },
	};
};
const onDisk = (path: string) => readFileSync(join(proj, path), "utf8");
const logged = (): TransferRecord[] => {
	try {
		return readFileSync(join(s.root, "data", "transfers.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as TransferRecord);
	} catch {
		return [];
	}
};

describe("who may ask", () => {
	test("a save needs the token and the CSRF header; the conversation must be one the server knows", async () => {
		const { etag } = await text(here, "notes.md");
		expect((await save(here, "notes.md", "x", etag, { token: false })).status).toBe(401);
		expect((await save(here, "notes.md", "x", etag, { csrf: false })).status).toBe(403);
		expect(onDisk("notes.md")).toBe("# Notes\n\nfirst\n");
		const unknown = await here.send(
			"/api/folder/file",
			JSON.stringify({ file: join(work, "not-a-session.jsonl"), path: "notes.md", text: "x", etag }),
		);
		expect(unknown.status).toBe(404);
		// A read of the route is a read, and any other method of it is not one.
		expect((await here.send(`/api/folder/file?${new URLSearchParams({ file, path: "notes.md" })}`)).status).toBe(200);
		const put = await here.send("/api/folder/file", "{}", { method: "PUT" });
		expect(put.status).toBe(405);
	});

	test("through the tunnel Access is needed as well", async () => {
		const { etag } = await text(tunnel, "notes.md");
		const noJwt = await remote.fetch(
			"/api/folder/file",
			{ jwt: null, method: "POST", headers: { [CSRF_HEADER]: "1" } },
			JSON.stringify({ file, path: "notes.md", text: "x", etag }),
		);
		expect(noJwt.status).toBe(403);
		expect(onDisk("notes.md")).toBe("# Notes\n\nfirst\n");
	});

	test("the setting is looked at on every request: a page that may not upload is not offered the editor and is refused", async () => {
		try {
			const { etag } = await text(tunnel, "notes.md");
			for (const [setting, code] of [
				["download", "uploadOff"],
				["off", "off"],
			] as const) {
				setTransfer(setting);
				const answer = await read(tunnel, "notes.md");
				expect(answer.body, setting).toMatchObject({ kind: "text", editable: false });
				const refused = await save(tunnel, "notes.md", "x", etag);
				expect([refused.status, refused.code], setting).toEqual([403, code]);
				expect(onDisk("notes.md")).toBe("# Notes\n\nfirst\n");
				// This computer's page is not the setting's.
				expect((await read(here, "notes.md")).body).toMatchObject({ editable: true });
			}
			setTransfer("full");
			expect((await read(tunnel, "notes.md")).body).toMatchObject({ editable: true });
		} finally {
			setTransfer("full");
		}
	});
});

describe("saving what a page opened", () => {
	for (const page of [here, tunnel]) {
		test(`${page.name}: the read gives the etag, a save names it and answers the next, and the log says who`, async () => {
			const path = `src/saved-by-${page.who === "local" ? "local" : "tunnel"}.ts`;
			writeFileSync(join(proj, path), "one\n");
			const first = await text(page, path);
			expect(first).toMatchObject({ kind: "text", editable: true, text: "one\n", truncated: false });
			const saved = await save(page, path, "one\ntwo\n", first.etag);
			expect(saved.status).toBe(200);
			expect(onDisk(path)).toBe("one\ntwo\n");
			expect(saved.body).toMatchObject({ size: 8 });
			// What the next read says is what the save answered, and it is the file the next save is made from.
			const second = await text(page, path);
			expect(second).toMatchObject({ text: "one\ntwo\n", etag: saved.body.etag });
			expect((await save(page, path, "three\n", second.etag)).status).toBe(200);
			expect(onDisk(path)).toBe("three\n");
			await pollUntil(
				() => logged().some((l) => l.kind === "edit" && l.who === page.who && l.path === path && l.size === 6),
				"the log line of the save",
			);
			expect(logged().findLast((l) => l.kind === "edit" && l.path === path)).toMatchObject({
				kind: "edit",
				who: page.who,
				root: proj,
				size: 6,
				status: "ok",
			});
		});
	}

	test("a file that changed meanwhile is a 409 with the etag it has now; saving again with it overwrites, and nothing else is touched", async () => {
		writeFileSync(join(proj, "src/shared.ts"), "mine\n");
		const { etag } = await text(here, "src/shared.ts");
		writeFileSync(join(proj, "src/shared.ts"), "theirs\n");
		const stale = await save(here, "src/shared.ts", "mine, changed\n", etag);
		expect([stale.status, stale.code]).toEqual([409, "conflict"]);
		expect(onDisk("src/shared.ts")).toBe("theirs\n");
		const now = (await text(here, "src/shared.ts")).etag;
		expect(stale.body).toMatchObject({ code: "conflict", etag: now });
		expect((await save(here, "src/shared.ts", "mine, changed\n", now)).status).toBe(200);
		expect(onDisk("src/shared.ts")).toBe("mine, changed\n");
	});

	test("a text file is saved with the permissions it had", async () => {
		const path = "src/mode.txt";
		writeFileSync(join(proj, path), "a");
		Bun.spawnSync(["chmod", "600", join(proj, path)]);
		const { etag } = await text(here, path);
		expect((await save(here, path, "b", etag)).status).toBe(200);
		expect(statSync(join(proj, path)).mode & 0o777).toBe(0o600);
	});
});

describe("what no save is let into", () => {
	for (const page of [here, tunnel]) {
		test(`${page.name}: not outside the folder, not what CI runs, not a secret`, async () => {
			for (const [path, code] of [
				["../outside.txt", "outside"],
				["link-out", "outside"],
				[`${work}/outside.txt`, "outside"],
				[".github/workflows/ci.yml", "protected"],
				[".env", "secret"],
			] as const) {
				const refused = await save(page, path, "changed", "0".repeat(64));
				expect([refused.status, refused.code, refused.body.code], path).toEqual([403, code, code]);
			}
			expect(readFileSync(join(work, "outside.txt"), "utf8")).toBe("outside");
			expect(onDisk(".github/workflows/ci.yml")).toBe("on: push\n");
			expect(onDisk(".env")).toBe("TOKEN=abc\n");
		});

		test(`${page.name}: not a file that is not there, nor a folder, nor more text than a file is edited at`, async () => {
			expect((await save(page, "src/new-file.ts", "x", "0".repeat(64))).status).toBe(404);
			expect((await save(page, "src", "x", "0".repeat(64))).status).toBe(415);
			const { etag } = await text(page, "notes.md");
			const big = await save(page, "notes.md", "x".repeat(FOLDER_LIMITS.editBytes + 1), etag);
			expect([big.status, big.code]).toEqual([413, "tooLarge"]);
			expect(onDisk("notes.md")).toBe("# Notes\n\nfirst\n");
			expect(() => readFileSync(join(proj, "src/new-file.ts"))).toThrow();
		});
	}

	test("the read does not offer the editor for what a save would refuse, nor for a file it cut, nor for one that is not UTF-8", async () => {
		writeFileSync(join(proj, "huge.txt"), "line of text\n".repeat(FOLDER_LIMITS.textBytes / 13 + 1000));
		writeFileSync(
			join(proj, "latin1.txt"),
			Buffer.concat([Buffer.from("plain ascii text before the accent ".repeat(4)), Buffer.from([0xe9, 0x0a])]),
		);
		for (const [path, editable] of [
			["notes.md", true],
			[".github/workflows/ci.yml", false],
			[".env", false],
			["huge.txt", false],
			["latin1.txt", false],
		] as const) {
			const answer = await read(here, path);
			expect(answer.status, path).toBe(200);
			expect(answer.body, path).toMatchObject({ kind: "text", editable });
		}
	});
});
