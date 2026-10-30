import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Server } from "bun";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * What the macOS app makes of the server's own stream (macos/shellevents.swift, #627): the menu bar icon's counts and the
 * notifications come from it, so that neither needs a window or a page. Compiled with the `swiftc` the app is built with, a
 * harness (tests/support/swift/shell-events/main.swift) reads lines as the network cuts them, and follows servers the test
 * stands up as the app follows the real one: it asks with its token and the Mac's language, reads again when the response
 * ends, follows the server to another address, tries again when it is refused, and stops when it is told to. What the server
 * says is `shell-events.test.ts` (unit) and `tests/contract/shell-events.test.ts`. Foundation only: no window, no window server.
 */

const here = import.meta.dir;
const dir = tempDir("ompw-shell-events-");
const harness = join(dir, "shell-events-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;

/** What a server was asked, in order, and what it is doing now. */
interface Seen {
	requests: { url: string; token: string | null; at: number }[];
	/** Responses that are open now. */
	open: number;
	/** Responses the reader let go of. */
	cancelled: number;
}

const servers: Server<undefined>[] = [];

/** A server whose `/api/shell/events` answers with `answer(n)` for the n-th request (1-based): lines, and whether it stays open. */
function serve(answer: (n: number) => Response | { lines: string[]; keepOpen: boolean }): {
	origin: string;
	seen: Seen;
} {
	const seen: Seen = { requests: [], open: 0, cancelled: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			seen.requests.push({ url: req.url, token: req.headers.get("x-omp-webui-token"), at: Date.now() });
			const made = answer(seen.requests.length);
			if (made instanceof Response) return made;
			seen.open++;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const line of made.lines) controller.enqueue(encoder.encode(`${line}\n`));
						if (!made.keepOpen) {
							controller.close();
							seen.open--;
						}
					},
					cancel() {
						seen.cancelled++;
						seen.open--;
					},
				}),
				{ headers: { "content-type": "application/x-ndjson" } },
			);
		},
	});
	servers.push(server);
	return { origin: `http://127.0.0.1:${server.port}`, seen };
}

const STATE_A = '{"t":"state","working":1,"asking":0,"epoch":"E1"}';
const NOTICE =
	'{"t":"attention","seq":3,"id":"L1","kind":"finished","title":"Fix the build","body":"Finished","liveId":"L1","file":"/s/a.jsonl"}';

const a = serve((n) =>
	n === 1
		? // A heartbeat, a line this app does not know, and a damaged one, between what it understands.
			{ lines: [STATE_A, "", '{"t":"later","x":1}', "not json", NOTICE, ""], keepOpen: false }
		: { lines: ['{"t":"state","working":0,"asking":1,"epoch":"E1"}'], keepOpen: true },
);
const b = serve(() => ({ lines: ['{"t":"state","working":5,"asking":4,"epoch":"E2"}'], keepOpen: true }));
const refused = serve(() => new Response("Forbidden", { status: 403 }));

interface Report {
	pure: {
		parsed: unknown[];
		pieces: string[][];
		endless: { first: string[]; after: string[] };
		request: {
			url: string;
			token: string;
			method: string;
			timeout: number;
			cookies: boolean;
			english: string;
			resumed: string;
			half: string;
		};
		codes: string[];
	};
	stream: {
		heard: Record<string, unknown>[];
		marks: Record<string, number>;
		silentAfterStop: boolean;
		/** When `stop()` was called, in ms since the epoch. */
		stoppedAt: number;
	};
}

let report: Report;
beforeAll(async () => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/quit.swift"),
			join(here, "../../macos/notifications.swift"),
			join(here, "../../macos/shellevents.swift"),
			join(here, "../support/swift/shell-events/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	const run = Bun.spawn([harness, a.origin, b.origin, refused.origin], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	if (code !== 0) throw new Error(`harness exited ${code}: ${err}`);
	report = JSON.parse(out) as Report;
}, 240_000);
afterAll(async () => {
	for (const server of servers) await server.stop(true);
});

test.skipIf(!mac)("a line is a state or a notice with what each needs; anything else is nothing", () => {
	const [
		full,
		negative,
		text,
		missing,
		noEpoch,
		emptyEpoch,
		asking,
		finished,
		seqZero,
		noSeq,
		noId,
		noLive,
		badTitle,
		later,
		noType,
		damaged,
		array,
		empty,
		newer,
		counted,
		clamped,
	] = report.pure.parsed;
	// A server from before `paused`, `menuIcon`, `questions` and `finished`: nothing paused, the icon wanted (the default), no
	// question open and no run finished.
	expect(full).toEqual({
		t: "state",
		working: 2,
		asking: 1,
		paused: 0,
		menuIcon: true,
		questions: 0,
		finished: 0,
		epoch: "E1",
	});
	expect(newer).toEqual({
		t: "state",
		working: 0,
		asking: 0,
		paused: 3,
		menuIcon: false,
		questions: 0,
		finished: 0,
		epoch: "E1",
	});
	// The open questions and the finished runs (#705), as the server counts them; counts that cannot be are none.
	expect(counted).toEqual({
		t: "state",
		working: 1,
		asking: 2,
		paused: 0,
		menuIcon: true,
		questions: 3,
		finished: 7,
		epoch: "E1",
	});
	expect(clamped).toEqual({
		t: "state",
		working: 0,
		asking: 0,
		paused: 0,
		menuIcon: true,
		questions: 0,
		finished: 0,
		epoch: "E1",
	});
	// Counts that cannot be: no count. A state that does not say whose run it is is not one.
	for (const bad of [negative, text, missing, noEpoch, emptyEpoch]) expect(bad).toBe("nil");
	expect(asking).toEqual({ t: "attention", seq: 4, id: "L", title: "T", body: "B", liveId: "L", file: "/s/a.jsonl" });
	// A conversation with no file yet is still one to open, by its process.
	expect(finished).toEqual({ t: "attention", seq: 1, id: "L", title: "T", body: "B", liveId: "L", file: null });
	// A notice with no number (what the app would say it has read), nothing to replace, nothing to open, or words that are not text
	// is not shown.
	for (const bad of [seqZero, noSeq, noId, noLive, badTitle]) expect(bad).toBe("nil");
	// What a newer server says, and damage, are passed over.
	for (const other of [later, noType, damaged, array, empty]) expect(other).toBe("nil");
});

test.skipIf(!mac)(
	"the pieces of a response are cut into lines wherever the network cut them, characters included",
	() => {
		const state = '{"t":"state","working":1,"asking":0}';
		const note = '{"t":"attention","id":"é","title":"日本語","body":"B","liveId":"é","file":null}';
		// Heartbeats (empty lines) are no lines; a line that is not finished waits for its end.
		expect(report.pure.pieces).toEqual([[], [state], [], [], [], [note]]);
		// A line that never ends is not kept for ever, and the lines after it are read.
		expect(report.pure.endless.first).toEqual([]);
		expect(report.pure.endless.after).toEqual(['{"t":"state","working":0,"asking":0}']);
	},
);

test.skipIf(!mac)(
	"the app asks with its token and the Mac's language, and says it will give up on a silent response",
	() => {
		const { request } = report.pure;
		expect(request.url).toBe("http://127.0.0.1:7878/api/shell/events?lang=zh-CN");
		expect(request.english).toBe("http://127.0.0.1:7878/api/shell/events?lang=en");
		// Where the app was in the server's run: the epoch and the last notice it saw, told together.
		expect(request.resumed).toBe("http://127.0.0.1:7878/api/shell/events?lang=zh-CN&epoch=E%201&since=7");
		expect(request.half).toBe(request.url);
		expect(request.token).toBe("tok");
		expect(request.method).toBe("GET");
		// The server speaks every 15 s: three times that is a stalled response.
		expect(request.timeout).toBe(45);
		expect(request.cookies).toBe(false);
		expect(report.pure.codes).toEqual(["en", "zh-CN"]);
	},
);

test.skipIf(!mac)(
	"it follows the server: reads on after the response ends, moves to another address, tries again when refused, stops",
	() => {
		const { heard, marks, silentAfterStop, stoppedAt } = report.stream;
		// The first response: the state and the notice, the rest of its lines passed over; then it ended, and the next one began.
		expect(heard.slice(0, 3)).toEqual([
			{ t: "state", working: 1, asking: 0, paused: 0, menuIcon: true, questions: 0, finished: 0, epoch: "E1" },
			{ t: "attention", seq: 3, id: "L1", title: "Fix the build", body: "Finished", liveId: "L1", file: "/s/a.jsonl" },
			{ t: "state", working: 0, asking: 1, paused: 0, menuIcon: true, questions: 0, finished: 0, epoch: "E1" },
		]);
		expect(marks.afterA).toBe(3);
		// The same address again changed nothing; another address is followed, and the response of the first is let go.
		expect(a.seen.requests).toHaveLength(2);
		expect(heard[3]).toEqual({
			t: "state",
			working: 5,
			asking: 4,
			paused: 0,
			menuIcon: true,
			questions: 0,
			finished: 0,
			epoch: "E2",
		});
		expect(marks.afterB).toBe(4);
		expect(a.seen.cancelled).toBe(1);
		// Every request carried the token and the language.
		for (const seen of [a.seen, b.seen, refused.seen]) {
			for (const request of seen.requests) {
				expect(request.token).toBe("tok");
				expect(new URL(request.url).searchParams.get("lang")).toBe("zh-CN");
			}
		}
		// What the reader says of where it was in the server's run: nothing at first, then the epoch and the last notice it saw
		// (the server decides whether they are its own), and a new epoch starts again from none.
		const where = (request: { url: string }) => {
			const params = new URL(request.url).searchParams;
			return [params.get("epoch"), params.get("since")];
		};
		expect(a.seen.requests.map(where)).toEqual([
			[null, null],
			["E1", "3"],
		]);
		expect(b.seen.requests.map(where)).toEqual([["E1", "3"]]);
		expect(new Set(refused.seen.requests.map((r) => where(r).join("/")))).toEqual(new Set(["E2/0"]));
		// A server that refuses is asked again and again, and nothing from it is heard.
		expect(refused.seen.requests.length).toBeGreaterThan(2);
		expect(heard).toHaveLength(4);
		// Stopped: the response is let go, and nothing is read or asked afterwards (the harness went on for half a second, trying
		// every 50 ms were it still trying; a request already on its way when it stopped is not counted).
		expect(b.seen.cancelled).toBe(1);
		expect(silentAfterStop).toBe(true);
		expect(refused.seen.requests.filter((r) => r.at > stoppedAt + 100)).toEqual([]);
	},
);
