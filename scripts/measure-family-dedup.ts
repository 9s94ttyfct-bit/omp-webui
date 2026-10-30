import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { FamilyCache } from "../server/family.ts";
import { parseSessionText } from "../server/sessions/parse.ts";
import { SessionStore } from "../server/sessions/store.ts";
import type { SessionEntry } from "../shared/protocol.ts";
import { writeBigSession } from "../tests/support/big-session.ts";
import { onShutdown } from "./lib/shutdown.ts";

/**
 * What a family of a conversation and its forks costs the server: the size of the body that goes out (compressed and
 * not) and the time it takes to build, with the shared path sent once and with every file whole.
 *
 * `bun scripts/measure-family-dedup.ts [bytes] [forks] [whole|shared]` — the last word builds only that one, so the
 * peak memory of the process (`/usr/bin/time -l`) is that build's.
 *
 * A 50 MB conversation and three forks of it: 200 MB uncompressed and 77 MB gzip every time any member of the family
 * was written to; 50 MB and 19 MB with the shared path sent once.
 */

const BYTES = Number(process.argv[2] ?? 50 * 1024 * 1024);
const FORKS = Number(process.argv[3] ?? 3);

const STAMP = "2026-01-08T00:00:00.000Z";
const entry = (id: string, parentId: string | null, text: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId,
		timestamp: STAMP,
		message: { role: "user", content: [{ type: "text", text }] },
	}) as SessionEntry;

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-measure-")));
/** The conversation and its forks are hundreds of MB: they go with the run, also when it is stopped by a signal. */
const cleanup = onShutdown(() => rmSync(root, { recursive: true, force: true }));
const base = realpathSync(writeBigSession(root, BYTES));
const lastId = (file: string) => (parseSessionText(readFileSync(file, "utf8")).entries.at(-1) as SessionEntry).id;
const files = [base];
for (let n = 1; n <= FORKS; n++) {
	const lines = readFileSync(base, "utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0] as string);
	const id = `01a00000-0000-7000-8000-0000000000f${n}`;
	lines[0] = JSON.stringify({ ...header, id, parentSession: base });
	const file = join(dirname(base), `2026-01-08T00-0${n}-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		`${[...lines, JSON.stringify(entry(`fork${n}-a`, lastId(base), `work of fork ${n}`))].join("\n")}\n`,
	);
	files.push(file);
}

const store = new SessionStore(join(root, "sessions"), join(root, "index.db"));
await store.list();
const cache = new FamilyCache(store);

const ask = async (dedup: boolean, have: string[] = []) => {
	const started = performance.now();
	const res = await cache.respond(
		new Request("http://x/", {
			headers: {
				"accept-encoding": "gzip",
				...(dedup ? { "x-family-dedup": "1" } : {}),
				...(have.length ? { "x-family-have": have.join(",") } : {}),
			},
		}),
		base,
	);
	const gz = new Uint8Array(await res.arrayBuffer());
	const took = performance.now() - started;
	return { gz: gz.byteLength, plain: gunzipSync(gz).byteLength, took, body: gz };
};

/** `whole` or `shared`: one build, so that the peak memory of the process is that build's. */
const only = process.argv[4];
if (only) {
	const one = await ask(only === "shared");
	console.log(`${only}: ${one.plain} uncompressed, ${one.gz} gzip, ${one.took.toFixed(0)} ms`);
	store.close();
	process.exit(0);
}

// A cold build for each: the cache would answer the second one from what it kept.
const whole = await ask(false);
const shared = await ask(true);

const baseBytes = readFileSync(base).length;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`conversation: ${mb(baseBytes)}, ${files.length} files (${FORKS} forks)`);
console.log(`every file whole : ${mb(whole.plain)} uncompressed, ${mb(whole.gz)} gzip, ${whole.took.toFixed(0)} ms`);
console.log(`shared path once : ${mb(shared.plain)} uncompressed, ${mb(shared.gz)} gzip, ${shared.took.toFixed(0)} ms`);
console.log(
	`the shared path once is ${(whole.plain / shared.plain).toFixed(2)}x smaller uncompressed, ${(whole.gz / shared.gz).toFixed(2)}x smaller gzip`,
);

// A tab that views the conversation holds the family it was sent. A fork is written to: what does the tab download?
interface Sent {
	members: { tag?: string }[];
}
const sent: Sent = JSON.parse(gunzipSync(shared.body).toString());
const held = sent.members.flatMap((m) => (m.tag ? [m.tag] : []));
const forkFile = files[2] as string;
writeFileSync(
	forkFile,
	`${readFileSync(forkFile, "utf8")}${JSON.stringify(entry("fork2-late", "fork2-a", "a later answer"))}\n`,
);
const written = await ask(true, held);
console.log(
	`a fork written to, viewing the conversation: ${mb(written.plain)} uncompressed, ${mb(written.gz)} gzip, ${written.took.toFixed(0)} ms`,
);
store.close();
await cleanup();
