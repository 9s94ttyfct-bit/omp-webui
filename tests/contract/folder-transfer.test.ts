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
import {
	type ArchivePlan,
	CSRF_HEADER,
	ERROR_HEADER,
	type FileTransfer,
	type TransferRecord,
	type UploadProgress,
	type UploadSaved,
} from "../../shared/transfer.ts";
import { type AccessKey, AUD, EMAIL, HOSTNAME, type Jwks, makeKey, startJwks, TEAM } from "../support/access-jwt.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { lanAddress, rawRequest } from "../support/lan-peer.ts";
import { pollUntil } from "../support/poll.ts";
import { remoteClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The file transfer (`/api/folder/download`, `archive`, `upload`; #614) against the real server, as the three kinds of page
 * that come to it: the one on this computer, one that came through the tunnel (Cloudflare Access, as its email), and one on
 * the network (the connection is from this computer's network address). What the token and the CSRF header ask, what the
 * switch in Settings (`fileTransfer` in the remote settings file) lets each of them do, that the switch is looked at again
 * on every request, what the audit log (`<data dir>/transfers.jsonl`) says and does not say, and that a page cannot reach
 * what it is not given by any of the routes. The rules of each route are in `tests/unit/folder-transfer.test.ts`.
 *
 *   work/
 *     proj/        the conversation's folder
 *       src/       app.ts, util/helper.ts, .env, a key
 *       .ssh/      a protected place
 *       link-out   a link that leads out
 *     outside.txt  outside it
 */

const LAN = lanAddress();
if (LAN === undefined) {
	console.warn(
		"folder-transfer: this computer has no IPv4 address on a network: the cases of a page on the network are skipped",
	);
}

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
const root = mkdtempSync(join(tmpdir(), "ompw-transfer-http-"));
const settingsFile = join(root, "remote.json");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let remote: ReturnType<typeof remoteClient>;
let work: string;
let proj: string;
let file: string;

/** What the person set in Settings › Remote access › File transfer: `undefined`: nothing (the default), `"broken"`: a file that cannot be trusted. */
function setTransfer(value?: FileTransfer | "broken"): void {
	if (value === "broken") {
		writeFileSync(settingsFile, "{ not json");
		return;
	}
	writeFileSync(
		settingsFile,
		JSON.stringify({
			enabled: true,
			hostname: HOSTNAME,
			team: TEAM,
			aud: AUD,
			emails: [EMAIL],
			...(value === undefined ? {} : { fileTransfer: value }),
		}),
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
		["README.md", "# Title\n\nSome words.\n"],
		["src/app.ts", "export const a = 1;\n"],
		["src/util/helper.ts", "export const h = 1;\n"],
		["src/.env", "SECRET=1\n"],
		["src/id_rsa.txt", KEY],
		[".env", "TOKEN=abc\n"],
		[".hidden.txt", "hidden but not secret\n"],
		[".ssh/config", "Host x\n"],
		["key.txt", KEY],
	] as const) {
		mkdirSync(join(proj, name, ".."), { recursive: true });
		writeFileSync(join(proj, name), text);
	}
	writeFileSync(join(work, "outside.txt"), "outside");
	symlinkSync(join(work, "outside.txt"), join(proj, "link-out"));
	file = writeChatSession(s.agentDir, {
		n: 94,
		title: "Transfer probe",
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
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	/** Leave the token out (default: sent). */
	token?: boolean;
	/** Leave the CSRF header out of a write (default: sent). */
	csrf?: boolean;
}

interface Page {
	name: string;
	/** What the log says it is. */
	who: string;
	send(path: string, ask?: Ask): Promise<Response>;
}

// The server asks the header of everything that is not a GET (a HEAD included), and the page sends it.
const writes = (ask: Ask): Record<string, string> =>
	ask.method && ask.method !== "GET" && ask.csrf !== false ? { [CSRF_HEADER]: "1" } : {};
const here: Page = {
	name: "this computer",
	who: "local",
	send: (path, ask = {}) =>
		fetch(`${s.url}${path}`, {
			method: ask.method ?? "GET",
			headers: {
				...(ask.token === false ? {} : { "x-omp-webui-token": s.accessToken }),
				...writes(ask),
				...ask.headers,
			},
			body: ask.body,
			redirect: "manual",
		}),
};
const tunnel: Page = {
	name: "the tunnel",
	who: EMAIL,
	send: (path, ask = {}) =>
		remote.fetch(path, { method: ask.method, token: ask.token, headers: { ...writes(ask), ...ask.headers } }, ask.body),
};
const network: Page = {
	name: "the network",
	who: `net:${LAN}`,
	send: (path, ask = {}) =>
		rawRequest({
			host: "127.0.0.1",
			port: Number(new URL(s.url).port),
			from: LAN,
			method: ask.method,
			path,
			headers: {
				...(ask.token === false ? {} : { "x-omp-webui-token": s.accessToken }),
				...writes(ask),
				...ask.headers,
			},
			body: ask.body,
		}),
};
/** Every kind of page; the one on the network only where there is a network to be on. */
const pages: Page[] = LAN === undefined ? [here, tunnel] : [here, tunnel, network];
const elsewhere = pages.filter((p) => p !== here);

const query = (over: Record<string, string> = {}) => new URLSearchParams({ file, ...over }).toString();
const get = (page: Page, path: string, ask: Ask = {}) => page.send(`/api/folder/download?${query({ path })}`, ask);
const failure = async (r: Response) => ({
	status: r.status,
	...((await r.json()) as { code: string }),
	header: r.headers.get(ERROR_HEADER),
});
const logFile = () => join(s.root, "data", "transfers.jsonl");
const logged = (): TransferRecord[] => {
	try {
		return readFileSync(logFile(), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as TransferRecord);
	} catch {
		return [];
	}
};
/** The line the log gets for what was just asked, which is written when the answer has been sent. */
async function lastLine(match: (r: TransferRecord) => boolean, what: string): Promise<TransferRecord> {
	let found: TransferRecord | undefined;
	await pollUntil(() => {
		found = logged().findLast(match);
		return found !== undefined;
	}, what);
	return found as TransferRecord;
}

describe("who may ask", () => {
	test("a request without the token is 401, as every route of the API; a cross-site one is refused", async () => {
		expect((await get(here, "README.md", { token: false })).status).toBe(401);
		expect((await get(here, "README.md", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
		expect((await get(here, "README.md", { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
		expect((await get(here, "README.md", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
	});

	test("through the tunnel Access is needed as well, and the page's own origin", async () => {
		const asked = (r: Parameters<typeof remote.fetch>[1]) =>
			remote.fetch(`/api/folder/download?${query({ path: "README.md" })}`, r);
		expect((await asked({})).status).toBe(200);
		expect((await asked({ jwt: null })).status).toBe(403);
		expect((await asked({ token: false })).status).toBe(401);
		expect((await asked({ origin: "https://evil.example.test" })).status).toBe(403);
		expect((await asked({ host: "evil.example.test" })).status).toBe(403);
	});

	test("a write needs the CSRF header: without it no upload, no ZIP, no cancel is made", async () => {
		for (const page of pages) {
			const bare = { method: "POST", csrf: false, body: "hello" } as const;
			expect(
				(await page.send(`/api/folder/upload?${query({ name: "nohdr.txt", size: "5" })}`, bare)).status,
				page.name,
			).toBe(403);
			expect(
				(await page.send(`/api/folder/archive`, { ...bare, body: JSON.stringify({ file, path: "src" }) })).status,
				page.name,
			).toBe(403);
			expect((await page.send(`/api/folder/upload/cancel`, { ...bare, body: "{}" })).status, page.name).toBe(403);
		}
		expect(() => readFileSync(join(proj, "nohdr.txt"))).toThrow();
	});

	test("a route that is not one of the transfer's is 404, and a read of a write route is 405", async () => {
		expect((await here.send(`/api/folder/download/nothing?${query()}`)).status).toBe(404);
		const wrong = await here.send(`/api/folder/archive?${query({ path: "src" })}`);
		expect(wrong.status).toBe(405);
		expect(wrong.headers.get("allow")).toBe("POST");
		expect((await here.send(`/api/folder/download?${query({ path: "README.md" })}`, { method: "POST" })).status).toBe(
			405,
		);
	});
});

describe("a file as a download", () => {
	for (const page of pages) {
		test(`${page.name}: the file whole, as an attachment that is saved and never shown; the log says who`, async () => {
			const r = await get(page, "README.md");
			expect(r.status).toBe(200);
			expect(await r.text()).toBe("# Title\n\nSome words.\n");
			expect(r.headers.get("content-disposition")).toMatch(
				/^attachment; filename="README\.md"; filename\*=UTF-8''README\.md$/,
			);
			expect(r.headers.get("content-type")).toBe("application/octet-stream");
			expect(r.headers.get("x-content-type-options")).toBe("nosniff");
			expect(r.headers.get("content-security-policy")).toBe("sandbox");
			expect(r.headers.get("cache-control")).toBe("no-store");
			expect(r.headers.get("accept-ranges")).toBe("bytes");
			// A body that is streamed is sent in pieces (Bun then leaves `content-length` out: the two never go together), so the
			// length of a GET is the body's, and what a HEAD answers is what the size is; when one is sent, it is the right one.
			const length = r.headers.get("content-length");
			if (length !== null) expect(length).toBe("21");
			expect(r.headers.get("etag")).toMatch(/^"\d+-\d+-\d+"$/);
			const line = await lastLine(
				(l) => l.kind === "download" && l.who === page.who && l.path === "README.md",
				"the log line of the download",
			);
			expect(line).toMatchObject({
				kind: "download",
				who: page.who,
				root: proj,
				path: "README.md",
				size: 21,
				status: "ok",
			});
		});

		test(`${page.name}: a part of it, and the rest of a file that did not arrive whole (If-Range)`, async () => {
			const first = await get(page, "README.md");
			const etag = first.headers.get("etag") as string;
			await first.arrayBuffer();
			const part = await get(page, "README.md", { headers: { range: "bytes=2-6", "if-range": etag } });
			expect(part.status).toBe(206);
			expect(part.headers.get("content-range")).toBe("bytes 2-6/21");
			expect(await part.text()).toBe("Title");
			const changed = await get(page, "README.md", { headers: { range: "bytes=2-6", "if-range": '"1-2-3"' } });
			expect(changed.status).toBe(200);
			expect((await changed.text()).length).toBe(21);
			const past = await get(page, "README.md", { headers: { range: "bytes=100-" } });
			expect(past.status).toBe(416);
			expect(past.headers.get("content-range")).toBe("bytes */21");
		});

		test(`${page.name}: HEAD says what a download would, without the bytes; a refused one carries its reason in a header`, async () => {
			const ok = await get(page, "README.md", { method: "HEAD" });
			expect(ok.status).toBe(200);
			expect(ok.headers.get("content-length")).toBe("21");
			expect(await ok.text()).toBe("");
			const no = await get(page, "link-out", { method: "HEAD" });
			expect(no.status).toBe(403);
			expect(no.headers.get(ERROR_HEADER)).toBe("outside");
		});
	}
});

describe("what no page is given", () => {
	for (const page of pages) {
		test(`${page.name}: nothing outside the conversation's folder, whatever the way to it`, async () => {
			for (const path of [
				"../outside.txt",
				"src/../../outside.txt",
				"/etc/passwd",
				"link-out",
				`${work}/outside.txt`,
			]) {
				expect(await failure(await get(page, path)), path).toMatchObject({
					status: 403,
					code: "outside",
					header: "outside",
				});
			}
			expect(await failure(await get(page, "src"))).toMatchObject({ status: 415, code: "notFile" });
			expect(await failure(await get(page, "nothing.txt"))).toMatchObject({ status: 404, code: "notFound" });
			expect(
				await failure(
					await page.send(
						`/api/folder/download?${query({ path: "README.md", file: join(work, "not-a-session.jsonl") })}`,
					),
				),
			).toMatchObject({
				status: 404,
			});
		});
	}

	for (const page of elsewhere) {
		test(`${page.name}: a secret, a private key and a protected place are not sent`, async () => {
			for (const path of [".env", "src/.env"])
				expect(await failure(await get(page, path)), path).toMatchObject({ status: 403, code: "secret" });
			// A key by what is in it, not what it is called.
			for (const path of ["key.txt", "src/id_rsa.txt"])
				expect(await failure(await get(page, path)), path).toMatchObject({ status: 403, code: "secret" });
			expect(await failure(await get(page, ".ssh/config"))).toMatchObject({ status: 403 });
			// A name that is only hidden is sent: the page was shown it, and it is not what a secret looks like.
			expect((await get(page, ".hidden.txt")).status).toBe(200);
		});
	}

	test("this computer's own page is given its own files, a key included; the outside it is never given", async () => {
		expect(await (await get(here, ".env")).text()).toBe("TOKEN=abc\n");
		expect((await get(here, "key.txt")).status).toBe(200);
		expect((await get(here, "../outside.txt")).status).toBe(403);
	});
});

describe("a folder as a ZIP", () => {
	for (const page of pages) {
		test(`${page.name}: the plan first, then the ZIP once, by the ticket, for who asked; a secret is left out`, async () => {
			const asked = await page.send("/api/folder/archive", {
				method: "POST",
				body: JSON.stringify({ file, path: "src" }),
			});
			expect(asked.status, await asked.clone().text()).toBe(200);
			const plan = (await asked.json()) as ArchivePlan;
			expect(plan).toMatchObject({ name: "src.zip", hidden: false, hiddenAllowed: true });
			expect(plan.files).toBeGreaterThanOrEqual(2);
			if (page !== here) expect(plan.skipped.secret).toBeGreaterThanOrEqual(2);
			const zip = await page.send(plan.url);
			expect(zip.status).toBe(200);
			expect(zip.headers.get("content-type")).toBe("application/zip");
			expect(zip.headers.get("content-disposition")).toMatch(/^attachment; filename="src\.zip"/);
			expect(zip.headers.get("x-content-type-options")).toBe("nosniff");
			const bytes = Buffer.from(await zip.arrayBuffer());
			expect(bytes.subarray(0, 2).toString()).toBe("PK");
			if (page !== here) {
				// The names are in the ZIP as the files they are; a secret's name is in none of it.
				expect(bytes.includes("src/app.ts")).toBe(true);
				expect(bytes.includes("TOKEN=abc")).toBe(false);
				expect(bytes.includes("OPENSSH PRIVATE KEY")).toBe(false);
			}
			expect(await failure(await page.send(plan.url))).toMatchObject({ status: 404, code: "gone" });
			const line = await lastLine((l) => l.kind === "zip" && l.who === page.who, "the log line of the ZIP");
			expect(line).toMatchObject({ kind: "zip", path: "src", status: "ok" });
		});
	}

	test("a ticket is for the one who asked: another page that holds the token is not given the ZIP", async () => {
		const plan = (await (
			await tunnel.send("/api/folder/archive", { method: "POST", body: JSON.stringify({ file, path: "src" }) })
		).json()) as ArchivePlan;
		expect(await failure(await here.send(plan.url))).toMatchObject({ status: 404, code: "gone" });
		expect((await tunnel.send(plan.url)).status).toBe(200);
	});
});

describe("an upload", () => {
	const up = (page: Page, name: string, text: string, over: Record<string, string> = {}) =>
		page.send(`/api/folder/upload?${query({ name, size: String(Buffer.byteLength(text)), ...over })}`, {
			method: "POST",
			body: text,
		});

	for (const page of pages) {
		const name = `from-${page.name.replaceAll(" ", "-")}.txt`;
		test(`${page.name}: a file is saved in the conversation's folder, never over one that is there; the log says who`, async () => {
			const saved = (await (await up(page, name, "hello")).json()) as UploadSaved;
			expect(saved).toMatchObject({ done: true, path: name, name, bytes: 5, replaced: false });
			expect(readFileSync(join(proj, name), "utf8")).toBe("hello");
			expect(statSync(join(proj, name)).mode & 0o111).toBe(0);
			const taken = await up(page, name, "again");
			expect(await failure(taken)).toMatchObject({ status: 409, code: "exists" });
			expect(readFileSync(join(proj, name), "utf8")).toBe("hello");
			const line = await lastLine(
				(l) => l.kind === "upload" && l.who === page.who && l.path === name && l.status === "ok",
				"the log line of the upload",
			);
			expect(line).toMatchObject({ kind: "upload", root: proj, size: 5, sha256: saved.sha256 });
		});

		test(`${page.name}: into a folder that is made, in pieces that are asked after, and not to a name that is hidden or a secret's`, async () => {
			const dir = `up-${page.name.replaceAll(" ", "-")}/deep`;
			const text = "abcdefghijkl";
			const first = await page.send(`/api/folder/upload?${query({ dir, name: "pieces.bin", size: "12" })}`, {
				method: "POST",
				body: text.slice(0, 5),
			});
			expect(first.status).toBe(202);
			const progress = (await first.json()) as UploadProgress;
			expect(progress).toMatchObject({ received: 5, size: 12 });
			const state = await page.send(`/api/folder/upload/state?id=${progress.id}`);
			expect(await state.json()).toMatchObject({ id: progress.id, received: 5 });
			const rest = await page.send(
				`/api/folder/upload?${query({ dir, name: "pieces.bin", size: "12", id: progress.id, offset: "5" })}`,
				{ method: "POST", body: text.slice(5) },
			);
			expect(await rest.json()).toMatchObject({ done: true, path: `${dir}/pieces.bin`, bytes: 12 });
			expect(readFileSync(join(proj, dir, "pieces.bin"), "utf8")).toBe(text);
			for (const bad of [".env", ".bashrc", ".ssh"]) expect((await up(page, bad, "x")).status, bad).toBe(403);
			expect((await up(page, "x.txt", "x", { dir: "../escape" })).status).toBe(403);
			expect((await up(page, "x.txt", "x", { dir: "link-out" })).status).toBe(403);
		});
	}

	test("a piece that is given up is cancelled, and no file is left", async () => {
		const first = await here.send(`/api/folder/upload?${query({ name: "given-up.bin", size: "10" })}`, {
			method: "POST",
			body: "12345",
		});
		const progress = (await first.json()) as UploadProgress;
		const cancelled = await here.send("/api/folder/upload/cancel", {
			method: "POST",
			body: JSON.stringify({ id: progress.id }),
		});
		expect(cancelled.status).toBe(200);
		expect(await failure(await here.send(`/api/folder/upload/state?id=${progress.id}`))).toMatchObject({
			status: 404,
			code: "gone",
		});
		expect(() => readFileSync(join(proj, "given-up.bin"))).toThrow();
	});
});

describe("what this computer lets another page do", () => {
	const meta = async (page: Page) =>
		((await (await page.send("/api/meta")).json()) as { fileTransfer: FileTransfer }).fileTransfer;
	const plan = (page: Page) =>
		page.send("/api/folder/archive", { method: "POST", body: JSON.stringify({ file, path: "src" }) });
	const upload = (page: Page, name: string) =>
		page.send(`/api/folder/upload?${query({ name, size: "1" })}`, { method: "POST", body: "x" });
	const composer = (page: Page, name: string) =>
		page.send(`/api/upload?${query({ name })}`, { method: "POST", body: "x" });

	test("full: all of it, and every kind of page is told so", async () => {
		setTransfer("full");
		for (const page of pages) {
			expect(await meta(page), page.name).toBe("full");
			expect((await get(page, "README.md")).status, page.name).toBe(200);
		}
	});

	test("download only: files go out and none comes in, on every route that takes one", async () => {
		setTransfer("download");
		for (const page of elsewhere) {
			expect(await meta(page), page.name).toBe("download");
			expect((await get(page, "README.md")).status, page.name).toBe(200);
			expect((await plan(page)).status, page.name).toBe(200);
			expect(await failure(await upload(page, "never-1.txt")), page.name).toMatchObject({
				status: 403,
				code: "uploadOff",
				header: "uploadOff",
			});
			expect(await failure(await composer(page, "never-2.txt")), page.name).toMatchObject({ status: 403, code: "off" });
		}
		expect(() => readFileSync(join(proj, "never-1.txt"))).toThrow();
		expect(() => readFileSync(join(proj, ".omp-webui"))).toThrow();
	});

	test("off: nothing goes out and nothing comes in; HEAD says why in a header", async () => {
		setTransfer("off");
		for (const page of elsewhere) {
			expect(await meta(page), page.name).toBe("off");
			expect(await failure(await get(page, "README.md")), page.name).toMatchObject({
				status: 403,
				code: "off",
				header: "off",
			});
			const head = await get(page, "README.md", { method: "HEAD" });
			expect(head.status, page.name).toBe(403);
			expect(head.headers.get(ERROR_HEADER), page.name).toBe("off");
			expect((await plan(page)).status, page.name).toBe(403);
			expect((await upload(page, "never-3.txt")).status, page.name).toBe(403);
			expect((await composer(page, "never-4.txt")).status, page.name).toBe(403);
			expect(await failure(await page.send("/api/folder/archive/0123456789abcdef0123456789abcdef"))).toMatchObject({
				status: 403,
				code: "off",
			});
			expect(
				await failure(await page.send("/api/folder/upload/state?id=0123456789abcdef0123456789abcdef")),
			).toMatchObject({ status: 403 });
		}
		expect(() => readFileSync(join(proj, "never-3.txt"))).toThrow();
	});

	test("this computer's own page is not held by it: it moves files whatever the setting says", async () => {
		for (const value of ["off", "download"] as const) {
			setTransfer(value);
			expect(await meta(here), value).toBe("full");
			expect((await get(here, "README.md")).status, value).toBe(200);
			expect((await upload(here, `mine-${value}.txt`)).status, value).toBe(200);
		}
	});

	test("the setting is looked at again on every request: no restart; a file nothing can be trusted of says no, no file at all says yes", async () => {
		const states: [FileTransfer | "broken" | undefined, number][] = [
			["off", 403],
			["full", 200],
			["broken", 403],
			["download", 200],
			[undefined, 200],
		];
		for (const [value, status] of states) {
			setTransfer(value);
			expect((await get(tunnel, "README.md")).status, String(value)).toBe(status);
		}
		setTransfer("full");
	});

	test("a page that is not on this computer cannot change the setting", async () => {
		setTransfer("download");
		const before = readFileSync(settingsFile, "utf8");
		for (const page of elsewhere) {
			const r = await page.send("/api/remote/config", {
				method: "POST",
				body: JSON.stringify({ enabled: true, hostname: HOSTNAME, fileTransfer: "full" }),
			});
			expect(r.status, page.name).toBe(403);
		}
		expect(readFileSync(settingsFile, "utf8")).toBe(before);
		setTransfer("full");
	});
});

describe("the log", () => {
	test("is the person's alone: the mode of the file is 0600; it holds no token, no query string and no file's text", async () => {
		// The line is written once the answer has been sent: read the answer, then wait for its line, so that it is in what
		// is checked here and does not land in the next test's part of the log.
		const before = logged().length;
		await (await get(here, "README.md")).arrayBuffer();
		await pollUntil(() => logged().length > before, "the download's line in the log");
		const text = readFileSync(logFile(), "utf8");
		expect(statSync(logFile()).mode & 0o777).toBe(0o600);
		expect(text).not.toContain(s.accessToken);
		expect(text).not.toContain("token");
		expect(text).not.toContain("?");
		expect(text).not.toContain("Some words");
		for (const line of text.split("\n").filter(Boolean)) {
			const entry = JSON.parse(line) as TransferRecord;
			expect(
				Object.keys(entry).every((k) =>
					["t", "kind", "who", "root", "path", "size", "files", "sha256", "status", "ms"].includes(k),
				),
				line,
			).toBe(true);
			expect(entry.t).toMatch(/^\d{4}-\d\d-\d\dT/);
		}
	});

	test("a request the person's rule said no to is in it, with who asked; one that only named nothing is not", async () => {
		setTransfer("full");
		const before = logged().length;
		await get(tunnel, ".env");
		await get(tunnel, "../outside.txt");
		await get(tunnel, "nothing.txt");
		await get(tunnel, "src");
		const added = logged().slice(before);
		expect(added.map((l) => [l.who, l.path, l.status])).toEqual([
			[EMAIL, ".env", "refused:secret"],
			[EMAIL, "../outside.txt", "refused:outside"],
		]);
		setTransfer("off");
		await get(tunnel, "README.md");
		setTransfer("full");
		expect(logged().at(-1)).toMatchObject({ who: EMAIL, path: "README.md", status: "refused:off" });
	});
});
