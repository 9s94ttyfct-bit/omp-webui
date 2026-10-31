import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldMacName } from "../../shared/macs.ts";
import {
	ADDRESS_OK,
	ADDRESS_REFUSED,
	ADDRESS_SAME,
	NAME_DIFFERENT,
	NAME_OK,
	NAME_REFUSED,
	NAME_SAME,
} from "../support/mac-vectors.ts";

/**
 * The macOS app's list of other Macs and its windows onto them (macos/remotemacs.swift, macos/remotepolicy.swift,
 * macos/remotewindow.swift and macos/remotemenu.swift, #614, #628): which addresses and names a remote Mac may have (the cases
 * are tests/support/mac-vectors.ts, which the server's own parser is held to as well), the saved list as the app reads it (the
 * local server is the only one that writes the file: the app's store reads it again when it changed and never writes), the data
 * store a Mac's window signs in with (one for each Cloudflare team), what the app asks the server for and what it makes of the
 * answers (against a stub of the server's routes), what the page's switcher may ask, what a probe's answer means, which
 * navigations a remote window follows, how it is labelled and worded, and which requests its web view refuses. The harness
 * (tests/support/swift/remote/main.swift) runs the shell's own functions without a window and without the network. The tests that
 * need WebKit run in a window server session only, as macos-notify does: a windowless web view that tries to reach this
 * machine's loopback in every spelling a page could use, and the app's own menu, session and window objects, made as the app
 * makes them but never ordered in (so never on the screen), whose title, bar, layout, bridges, blocker and data stores are read.
 * They talk to a loopback server of their own that records what reaches it. What is shown (the sheets, the real sign-in against
 * Cloudflare) is checked by hand.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-remote-"));
const harness = join(dir, "remote-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
// A window server session: WKWebView needs one, a build on a remote shell or in CI has none.
const windowServer = mac && Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";

type Table = Record<string, string>;
/** What the harness says of a list it read: one entry for each Mac, in order. */
interface Listed {
	names: string[];
	hosts: string[];
	ids: string[];
	stores: string[];
	teams: string[];
	added: number[];
	last: number[];
}
/** What the harness says of a request the app made for a change. */
interface Shaped {
	method: string;
	url: string;
	token: string;
	app: string;
	type: string;
	body: string;
	timeout: number;
}
interface Report {
	addresses: Table;
	names: Table;
	/** The fold of each of `FOLD_INPUTS`, in that order: not a table, as a Swift dictionary treats two spellings of one character as one key. */
	folds: string[];
	list: Table;
	teamStores: {
		myteam: string;
		otherteam: string;
		a: string;
		stable: boolean;
		distinct: number;
		teams: number;
		bits: number[][];
		notTheMacs: boolean;
	};
	storeChoice: Record<string, boolean | string[]>;
	originRules: Record<string, boolean | string[]>;
	file: {
		missingReadsEmpty: boolean;
		missingFileStaysMissing: boolean;
		missingDirectoryReadsEmpty: boolean;
		missingDirectoryStaysMissing: boolean;
		fileName: string;
		legacy: Listed;
		server: Listed;
		serverTextHasLowerCaseIds: boolean;
		idsEitherCase: boolean;
		reread: Record<string, string[]>;
		garbageReadsEmpty: boolean;
		garbageUntouched: boolean;
		garbageDirectory: string[];
		unreadableReadsEmpty: boolean;
		unreadableRecovers: boolean;
		neverWrites: { text: boolean; mode: boolean; modified: boolean; listing: boolean; read: string[] };
		decodes: Record<string, { names: string[]; hosts?: string[]; teams?: string[]; last?: number[] }>;
	};
	requests: Record<string, Shaped | number>;
	replies: Table;
	noServer: Table;
	bridgeActions: Table;
	bridgeSenders: Table;
	bridgeHandler: Record<string, unknown>;
	probes: Table;
	teams: string[];
	verdicts: Table;
	phases: Table;
	popOut: boolean[];
	popOutNil: boolean;
	bridge: boolean[];
	titles: string[];
	strips: Record<string, [string, string]>;
	problems: string[];
	hues: { degrees: number[]; fixedTwice: number[]; fixed: number; seen: number[]; min: number; max: number };
	errorPage: string;
	errorPageZh: string;
	words: Record<string, [string, string]>;
	wordsMention: Record<string, [boolean, boolean]>;
	language: boolean[];
	attachment: boolean[];
	ruleCount: number;
	ruleActions: string[];
	blocked: string[];
	notBlocked: string[];
	externalNotBlocked: string[];
	externalBlocked: string[];
	teamToPin: string[];
	gestures: Record<string, boolean>;
	gestureEvents: boolean[];
	navigator: Record<string, string[]>;
	displayHost: string[];
	compiles?: { ok: boolean; error: string };
}

let report: Report;

async function run(args: string[]): Promise<string> {
	const proc = Bun.spawn([harness, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	expect(await proc.exited, err).toBe(0);
	return out;
}

/**
 * Loopback listeners that count the connections that reach each: one for each vector a page tries. Nothing answers (a connection
 * is closed at once), so a request that is let through can only connect, whatever its scheme: what was blocked never does.
 */
function listenForConnections(n: number) {
	const counts: number[] = new Array(n).fill(0);
	const servers = counts.map((_, i) =>
		Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					counts[i]++;
					socket.end();
				},
				data() {},
			},
		}),
	);
	return {
		counts,
		ports: servers.map((s) => String(s.port)),
		stop: () => {
			for (const s of servers) s.stop(true);
		},
	};
}

/** The identifier of the data store the Macs of a team share, worked out here on its own (SHA-256 of a name, UUID v5 in form). */
function teamStoreId(team: string): string {
	const hash = createHash("sha256").update(`omp-webui/remote-team/${team}`).digest().subarray(0, 16);
	hash[6] = (hash[6] & 0x0f) | 0x50;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = hash.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

/** Every name the fold is asked about: the shared cases' (a Swift dictionary would merge "Å" and "Å", so the harness answers in this order). */
const FOLD_INPUTS = [...new Set([...NAME_SAME, ...NAME_DIFFERENT].flat())];

beforeAll(async () => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/quit.swift"),
			join(here, "../../macos/downloads.swift"),
			join(here, "../../macos/navigation.swift"),
			join(here, "../../macos/notifications.swift"),
			join(here, "../../macos/popout.swift"),
			join(here, "../../macos/windowframe.swift"),
			join(here, "../../macos/remotemacs.swift"),
			join(here, "../../macos/remotenotify.swift"),
			join(here, "../../macos/remotemenu.swift"),
			join(here, "../../macos/remotepolicy.swift"),
			join(here, "../../macos/shellevents.swift"),
			join(here, "../../macos/remotewindow.swift"),
			join(here, "../../macos/webview.swift"),
			join(here, "../support/swift/remote/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	const scratch = mkdtempSync(join(dir, "files-"));
	// The addresses and names the harness says what each one is: the shared table's, in one file.
	writeFileSync(
		join(scratch, "vectors.json"),
		JSON.stringify({
			addresses: [...ADDRESS_SAME, ...Object.keys(ADDRESS_OK), ...Object.keys(ADDRESS_REFUSED)],
			names: [...Object.keys(NAME_OK), ...Object.keys(NAME_REFUSED)],
			folds: FOLD_INPUTS,
		}),
	);
	report = JSON.parse(await run(["pure", scratch, ...(windowServer ? ["webkit"] : [])])) as Report;
}, 240_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!mac)(
	"an address is the host of a public DNS name, in the shape the server's own hostname setting takes",
	() => {
		const a = report.addresses;
		// What people type for the same Mac, and the other addresses that are accepted.
		for (const same of ADDRESS_SAME) expect(a[same], JSON.stringify(same)).toBe("ok:omp.example.com");
		for (const [input, host] of Object.entries(ADDRESS_OK)) expect(a[input], JSON.stringify(input)).toBe(`ok:${host}`);
		// What is refused, and why.
		for (const [input, why] of Object.entries(ADDRESS_REFUSED)) expect(a[input], JSON.stringify(input)).toBe(why);
		// Every input the harness tried has an answer here.
		const tried = new Set([...ADDRESS_SAME, ...Object.keys(ADDRESS_OK), ...Object.keys(ADDRESS_REFUSED)]);
		expect(Object.keys(a).sort()).toEqual([...tried].sort());
	},
);

test.skipIf(!mac)("a name is one visible line of at most 60 characters", () => {
	const n = report.names;
	for (const [input, kept] of Object.entries(NAME_OK)) expect(n[input], JSON.stringify(input)).toBe(`ok:${kept}`);
	for (const [input, why] of Object.entries(NAME_REFUSED)) expect(n[input], JSON.stringify(input)).toBe(why);
	expect(Object.keys(n).sort()).toEqual([...Object.keys(NAME_OK), ...Object.keys(NAME_REFUSED)].sort());
});

test.skipIf(!mac)(
	"two names are one name when the server says so: the same fold as the server's, on the shared cases",
	() => {
		const f = new Map(FOLD_INPUTS.map((name, i) => [name, report.folds[i]]));
		expect(report.folds.length).toBe(FOLD_INPUTS.length);
		for (const [a, b] of NAME_SAME)
			expect(f.get(a), `${JSON.stringify(a)} and ${JSON.stringify(b)} are one name`).toBe(f.get(b));
		for (const [a, b] of NAME_DIFFERENT)
			expect(f.get(a), `${JSON.stringify(a)} and ${JSON.stringify(b)} are two`).not.toBe(f.get(b));
		// What the fold is, not only which names it equates: the same string the server's (`foldMacName`) makes of each.
		for (const [name, folded] of f) expect(folded, JSON.stringify(name)).toBe(foldMacName(name));
	},
);

test.skipIf(!mac)(
	"the list keeps names and addresses apart, and at most ten: what is typed is checked before the server is asked",
	() => {
		const l = report.list;
		expect(l.lookup).toBe("Mac B");
		expect(l.lookupUnknown).toBe("nil");
		// The name is kept trimmed and the address as its host.
		expect(l.newOk).toBe("ok:Mac C@c.example.com");
		// Case, accents and width do not make a name another one: the name is what tells two windows apart.
		expect(l.sameNameLowerCase).toBe("name:taken:Mac A");
		expect(l.sameNameAccents).toBe("name:taken:Mac A");
		expect(l.sameNameWidth).toBe("name:taken:Mac A");
		expect(l.sameHost).toBe("hostTaken:Mac A");
		expect(l.badName).toBe("name:empty");
		expect(l.badAddress).toBe("address:ipAddress");
		expect(l.renameToTaken).toBe("name:taken:Mac A");
		// A Mac may change the case of its own name, and keep it.
		expect(l.renameToOwnCase).toBe("ok:MAC A");
		expect(l.renameUnchanged).toBe("ok:Mac A");
		expect(l.renameInvalid).toBe("name:empty");
		expect(l.limit).toBe("10");
		expect(l.fullCount).toBe("10");
		expect(l.checkNewWhenFull).toBe("full");
	},
);

test.skipIf(!mac)(
	"the Macs of one Cloudflare team share one data store, named after the team and the same on every launch; any other Mac has its own",
	() => {
		const t = report.teamStores;
		// Pinned: another value would leave every saved sign-in behind (the store is found again by this identifier).
		expect(t.myteam).toBe("E28FD0A1-745B-54B3-9201-5F467AC7C1DF");
		expect(t.otherteam).toBe("589854E1-4320-52D7-9F2A-71AF267B8C01");
		expect(t.a).toBe("D44923C2-8719-5331-9FA6-72CE704A376F");
		// …and the same worked out here, without the app's code: SHA-256 of "omp-webui/remote-team/<team>", 16 bytes, UUID v5 bits.
		expect(t.myteam).toBe(teamStoreId("myteam"));
		expect(t.otherteam).toBe(teamStoreId("otherteam"));
		expect(t.a).toBe(teamStoreId("a"));
		expect(t.stable).toBe(true);
		// One for each team (the longest team name too), none the identifier of a Mac, version 5 and the RFC variant (10).
		expect(t.distinct).toBe(t.teams);
		expect(t.notTheMacs).toBe(true);
		for (const [version, variant] of t.bits) expect([version, variant]).toEqual([5, 2]);
		expect(t.bits).toHaveLength(t.teams);
		const c = report.storeChoice;
		expect(c.teamMacUsesTeamStore).toBe(true);
		expect(c.sameTeamShares).toBe(true);
		expect(c.otherTeamDiffers).toBe(true);
		expect(c.teamIsNotOwn).toBe(true);
		// A Mac whose team is not known has the store of its own, and no other Mac's is it.
		expect(c.noTeamUsesOwn).toBe(true);
		expect(c.noTeamsDiffer).toBe(true);
		// Forgetting a Mac deletes a store only when no Mac that is left uses it, and always the one the Mac had of its own.
		expect(c.forgetWhileTeamStays).toEqual(["own:s1"]);
		expect(c.forgetLastOfTeam).toEqual(["team:myteam", "own:s1"]);
		expect(c.forgetNoTeam).toEqual(["own:s4"]);
		expect(c.forgetOnlyMac).toEqual(["team:otherteam", "own:s3"]);
	},
);

test.skipIf(!mac)(
	"forgetting a Mac whose team's store stays takes out what is its own: its cookies by host, and a page-storage record only when no Mac that is left shares it",
	() => {
		const r = report.originRules;
		// A cookie is the Mac's own when it is for its host (written with or without the leading dot): not a parent domain's, a
		// sibling's, a longer name's that ends the same way, or a child's.
		expect(r.cookieOwnHost).toBe(true);
		expect(r.cookieOwnDotHostAnyCase).toBe(true);
		expect(r.cookieParentIsNot).toBe(true);
		expect(r.cookieSiblingIsNot).toBe(true);
		expect(r.cookieLongerNameIsNot).toBe(true);
		expect(r.cookieChildIsNot).toBe(true);
		// A record is named for a registrable domain: it holds the host's page storage when it is the host or a domain above it, and
		// not when it only ends the same way.
		expect(r.recordOfTheDomain).toBe(true);
		expect(r.recordOfTheHost).toBe(true);
		expect(r.recordLookalikeIsNot).toBe(true);
		// A sibling in the same store under the same domain keeps the record whole (it cannot be cut by host) and the last Mac of
		// the domain takes it; a Mac of another team (another store) does not count; a record that holds nothing of the Mac stays.
		expect(r.siblingKeepsTheRecord).toEqual([]);
		expect(r.lastOfTheDomainTakesIt).toEqual(["example.com", "a.example.com"]);
		expect(r.otherStoreDoesNotCount).toEqual(["example.com"]);
		expect(r.noRecordNoRemoval).toEqual([]);
	},
);

const seconds = (stamp: string) => Date.parse(stamp) / 1000;

test.skipIf(!mac)(
	"the list is the file as it is now: read again when it changed, an empty list when there is none",
	() => {
		const f = report.file;
		expect(f.fileName).toBe("remote-macs.json");
		// No file, and no data dir: an empty list, and nothing made.
		expect(f.missingReadsEmpty).toBe(true);
		expect(f.missingFileStaysMissing).toBe(true);
		expect(f.missingDirectoryReadsEmpty).toBe(true);
		expect(f.missingDirectoryStaysMissing).toBe(true);
		// What the server writes (it replaces the file whole, so a change is a new inode) and what a person edits in place are both seen
		// by the next read; a file that looks as it did (same time, same size) is not read again.
		expect(f.reread).toEqual({
			beforeFile: [],
			afterFirstWrite: ["Alpha"],
			afterReplace: ["Alpha", "Beta"],
			afterEditInPlace: ["Beta"],
			sameStamp: ["Beta"],
			freshReaderSeesIt: ["Bola"],
			afterGarbage: [],
			afterRepair: ["Alpha"],
		});
		// A file that is garbage is no Mac and no error; one that cannot be opened is none either, until it can.
		expect(f.garbageReadsEmpty).toBe(true);
		expect(f.unreadableReadsEmpty).toBe(true);
		expect(f.unreadableRecovers).toBe(true);
	},
);

test.skipIf(!mac)("the app never writes the list: nothing of the file or its directory changes when it is read", () => {
	const f = report.file;
	expect(f.neverWrites).toEqual({ text: true, mode: true, modified: true, listing: true, read: ["Alpha", "Beta"] });
	// A file that cannot be trusted is not moved aside (`.damaged`), not rewritten, not touched.
	expect(f.garbageUntouched).toBe(true);
	expect(f.garbageDirectory).toEqual(["remote-macs.json"]);
});

test.skipIf(!mac)(
	"the file v0.11.12 wrote (capital identifiers) and the one the server writes (lower case) read as the same list; what does not fit is left out",
	() => {
		const f = report.file;
		const expected: Listed = {
			names: ["Mac A", "Mac B"],
			hosts: ["omp.example.com", "b.example.com"],
			ids: ["3F2504E0-4F89-11D3-9A0C-0305E82C3301", "9B2D5C1E-0A6F-4C58-8E21-5D3B7A9F4E10"],
			stores: ["7C9E6679-7425-40DE-944B-E07FC1F90AE7", "1E4F8A22-6B3C-4D79-A0E5-C2F7B9D81A34"],
			teams: ["myteam", "nil"],
			added: [seconds("2026-10-23T09:00:00Z"), seconds("2026-10-23T09:30:00Z")],
			last: [seconds("2027-01-15T08:00:00Z"), -1],
		};
		expect(f.legacy).toEqual(expected);
		expect(f.server).toEqual(expected);
		expect(f.serverTextHasLowerCaseIds).toBe(true);
		expect(f.idsEitherCase).toBe(true);
		const d = f.decodes;
		expect(d.good).toEqual({
			names: ["A", "B"],
			hosts: ["a.example.com", "b.example.com"],
			teams: ["nil", "nil"],
			last: [-1, seconds("2026-10-24T01:02:03Z")],
		});
		expect(d.empty.names).toEqual([]);
		expect(d.goodTeam.teams).toEqual(["myteam"]);
		expect(d.fractionalDate.names).toEqual(["A"]);
		// An entry that does not fit is left out; the others are read.
		expect(d.badHost).toEqual({ names: ["B"], hosts: ["b.example.com"], teams: ["nil"], last: [-1] });
		for (const bad of ["badId", "badStore", "badName"]) expect(d[bad].names, bad).toEqual(["B"]);
		expect(d.badDate.names).toEqual([]);
		expect(d.notAnEntry.names).toEqual([]);
		// An address that is not already in its canonical form is not the one the window would load.
		expect(d.upperHost.names).toEqual([]);
		// Parts of a record that do not fit are left out of it, and the record stays.
		expect(d.badLastConnected).toEqual({ names: ["A"], hosts: ["a.example.com"], teams: ["nil"], last: [-1] });
		expect(d.badTeam).toEqual({ names: ["A"], hosts: ["a.example.com"], teams: ["nil"], last: [-1] });
		expect(d.teamNotAString.teams).toEqual(["nil"]);
		// Names, hosts, ids and stores are unique: the first stays.
		for (const dup of ["duplicateName", "duplicateHost", "duplicateId", "duplicateStore"]) {
			expect(d[dup].names, dup).toEqual(["A"]);
		}
		expect(d.tooMany.names).toEqual(Array.from({ length: 10 }, (_, i) => `M${i}`));
		// Another version's file, or no list at all: nothing is read of it.
		for (const none of ["version2", "noVersion", "notAnObject", "notJSON", "emptyData"]) {
			expect(d[none].names, none).toEqual([]);
		}
	},
);

test.skipIf(!mac)("the app asks the server for a change by the routes, headers and bodies the server takes", () => {
	const r = report.requests as Record<string, Shaped> & { shortTimeout: number; defaultTimeout: number };
	const id = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
	const origin = "http://127.0.0.1:7878";
	const route = (name: string, method: string, path: string, body: unknown) => {
		const request = r[name];
		expect(request.method, name).toBe(method);
		expect(request.url, name).toBe(`${origin}${path}`);
		// The launch's token signs in, the app's header says it is not a page, and a body is JSON; every request has all three.
		expect([request.token, request.app, request.type], name).toEqual(["launch-token", "1", "application/json"]);
		expect(request.timeout, name).toBe(5);
		expect(request.body === "<none>" ? undefined : JSON.parse(request.body), name).toEqual(body);
	};
	route("add", "POST", "/api/macs", { name: "Studio", address: "studio.example.com" });
	// The name and the address go as they were typed (the server checks them again), and the team only when it is known.
	route("addWithTeam", "POST", "/api/macs", {
		name: 'Café "quoted" 💻',
		address: "https://Studio.example.com/",
		team: "myteam",
	});
	route("rename", "POST", `/api/macs/${id}/rename`, { name: "Mac Z" });
	route("remove", "DELETE", `/api/macs/${id}`, undefined);
	route("connected", "POST", `/api/macs/${id}/connected`, undefined);
	route("pin", "POST", `/api/macs/${id}/team`, { team: "myteam" });
	expect(r.defaultTimeout).toBe(5);
	expect(r.shortTimeout).toBe(0.5);
});

test.skipIf(!mac)(
	"what the server answers a change is a Mac, a refusal in its words, or nothing the app can read",
	() => {
		const a = report.replies;
		expect(a.mac).toBe("ok:Mac A@omp.example.com#nil");
		expect(a.macWithTeam).toBe("ok:Mac A@omp.example.com#myteam");
		// A refusal carries the status and the server's words; nothing else of the answer is used (the sheets word the problem themselves).
		expect(a.refusedWithProblem).toBe("refused:400:Another Mac is already called “Mac A”");
		expect(a.notFound).toBe("refused:404:No such Mac");
		expect(a.forbidden).toBe("refused:403:The list of Macs is changed on this computer only");
		expect(a.wrongMethod).toBe("refused:405:POST required");
		// An answer with no words of its own, or that is no JSON, is its status.
		expect(a.emptyMessage).toBe("refused:400:HTTP 400");
		expect(a.notJSON).toBe("refused:502:HTTP 502");
		expect(a.removedEmptyBody).toBe("refused:500:HTTP 500");
		// A 200 that is not what the route says is a refusal too: nothing is taken as done that was not said to be.
		const unreadable = "refused:200:The answer could not be read";
		for (const name of ["okButNotJSON", "okButNoMac", "okButBadRecord", "removedNotOk"])
			expect(a[name], name).toBe(unreadable);
		expect(a.removed).toBe("ok:removed");
		expect(a.removedNotFound).toBe("refused:404:No such Mac");
		// No server (the app has not started it yet, or it stopped): every change is `unreachable`, answered after the call returned.
		expect(report.noServer).toEqual({
			add: "unreachable",
			rename: "unreachable",
			remove: "unreachable",
			calledBackAtOnce: "false",
		});
	},
);

test.skipIf(!mac)(
	"the client against a stub of the server's routes: what it sends, what it makes of the answers, and a server that is not there",
	async () => {
		const known = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
		const missing = "00000000-0000-4000-8000-000000000404";
		interface Seen {
			method: string;
			path: string;
			token: string | null;
			app: string | null;
			type: string | null;
			body: unknown;
		}
		const seen: Seen[] = [];
		const record = (name: string, host: string, team: string | null) => ({
			id: known,
			name,
			host,
			team,
			storeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
			added: "2026-10-24T10:00:00Z",
			lastConnected: null,
		});
		const json = (data: unknown, status = 200) => Response.json(data, { status });
		const taken = {
			error: "Another Mac is already called “Mac A”",
			problem: { kind: "name", code: "taken", taken: "Mac A" },
		};
		const stub = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				const text = await req.text();
				const body = text === "" ? null : (JSON.parse(text) as Record<string, string>);
				seen.push({
					method: req.method,
					path: url.pathname,
					token: req.headers.get("x-omp-webui-token"),
					app: req.headers.get("x-omp-webui"),
					type: req.headers.get("content-type"),
					body,
				});
				const [, , , id, action] = url.pathname.split("/");
				if (url.pathname === "/api/macs") {
					if (body?.name === "Taken") return json(taken, 400);
					return json({ mac: record(body?.name ?? "", body?.address ?? "", body?.team ?? null) });
				}
				if (id === missing) return json({ error: "No such Mac" }, 404);
				if (req.method === "DELETE") return json({ ok: true });
				if (action === "rename") {
					return body?.name === "Taken"
						? json(taken, 400)
						: json({ mac: record(body?.name ?? "", "omp.example.com", null) });
				}
				return json({ mac: record("Mac A", "omp.example.com", action === "team" ? (body?.team ?? null) : null) });
			},
		});
		// A port that nothing listens on: one that was open a moment ago.
		const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const deadPort = gone.port;
		gone.stop(true);
		// A server that takes the request and never answers.
		let hangSeen = 0;
		const hang = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				hangSeen++;
				return new Promise<Response>(() => {});
			},
		});
		try {
			const out = JSON.parse(await run(["client", String(stub.port), String(deadPort), String(hang.port)])) as {
				results: Record<string, string>;
				onMainQueue: boolean;
				hangWaited: number;
			};
			const taken400 = "refused:400:Another Mac is already called “Mac A”";
			expect(out.results).toEqual({
				add: "ok:Studio@studio.example.com#myteam",
				addNoTeam: "ok:Plain@plain.example.com#nil",
				addRefused: taken400,
				rename: "ok:Renamed@omp.example.com#nil",
				renameRefused: taken400,
				renameMissing: "refused:404:No such Mac",
				remove: "ok:removed",
				removeMissing: "refused:404:No such Mac",
				deadAdd: "unreachable",
				deadRename: "unreachable",
				deadRemove: "unreachable",
				hangAdd: "unreachable",
			});
			// Every answer comes on the main queue, which is where the sheets are.
			expect(out.onMainQueue).toBe(true);
			// A server that does not answer is given the time the client was told to wait, not the five seconds, and not none.
			expect(out.hangWaited).toBeGreaterThan(0.4);
			expect(out.hangWaited).toBeLessThan(4.5);
			expect(hangSeen).toBe(1);
			// What the stub saw, in the order the calls were made (the three that are not waited for may arrive in any order).
			const sequential = seen.slice(0, 8).map((s) => [s.method, s.path, s.body]);
			expect(sequential).toEqual([
				["POST", "/api/macs", { name: "Studio", address: "studio.example.com", team: "myteam" }],
				["POST", "/api/macs", { name: "Plain", address: "plain.example.com" }],
				["POST", "/api/macs", { name: "Taken", address: "t.example.com" }],
				["POST", `/api/macs/${known}/rename`, { name: "Renamed" }],
				["POST", `/api/macs/${known}/rename`, { name: "Taken" }],
				["POST", `/api/macs/${missing}/rename`, { name: "Anything" }],
				["DELETE", `/api/macs/${known}`, null],
				["DELETE", `/api/macs/${missing}`, null],
			]);
			const unwaited = seen
				.slice(8)
				.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.body)}`)
				.sort();
			expect(unwaited).toEqual(
				[
					`POST /api/macs/${known}/connected null`,
					`POST /api/macs/${known}/team {"team":"myteam"}`,
					`POST /api/macs/${missing}/connected null`,
				].sort(),
			);
			// Nothing else reached the stub, and every request had the token, the app's header and a JSON content type.
			expect(seen).toHaveLength(11);
			for (const s of seen) {
				expect([s.token, s.app, s.type], `${s.method} ${s.path}`).toEqual(["launch-token-1", "1", "application/json"]);
			}
		} finally {
			stub.stop(true);
			hang.stop(true);
		}
	},
	60_000,
);

test.skipIf(!mac)(
	"the page's switcher may ask the app for two things: to open a saved Mac by its id, and to add one",
	() => {
		const id = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
		// Only the id of a Mac (in either case), never an address, and nothing else is a request.
		expect(report.bridgeActions).toEqual({
			open: `open:${id}`,
			openLower: `open:${id}`,
			openNoId: "nil",
			openBadId: "nil",
			openEmptyId: "nil",
			openNumberId: "nil",
			openNullId: "nil",
			openHost: "nil",
			openUrl: "nil",
			add: "add",
			// What else a message carries is not read.
			addExtra: "add",
			remove: "nil",
			rename: "nil",
			upperType: "nil",
			emptyType: "nil",
			numberType: "nil",
			noType: "nil",
			string: "nil",
			list: "nil",
			null: "nil",
			number: "nil",
			empty: "nil",
		});
		// Only the UI's own page, in its main frame: the server's origin, its port, its scheme.
		expect(report.bridgeSenders).toEqual({
			own: "allowed",
			subframe: "refused",
			otherPort: "refused",
			otherHost: "refused",
			remoteHost: "refused",
			https: "refused",
			noOrigin: "refused",
			noPort: "refused",
		});
		// The handler answers every message; the app is asked only for a good one, and the sheet comes after the answer.
		const h = report.bridgeHandler;
		expect(h.openSaved).toBe("ok:true");
		expect(h.openUnknown).toBe("ok:false");
		for (const refused of ["openBad", "wrongType", "notAnObject", "foreignPort", "subframe"]) {
			expect(h[refused], refused).toBe("ok:false");
		}
		// Both well-formed asks reached the app (it says whether the Mac is its own); the five refusals never did.
		expect(h.openedAfterRefusals).toEqual([id, "00000000-0000-4000-8000-000000000404"]);
		expect(h.shownAfterRefusals).toBe(0);
		expect(h.add).toBe("ok:true");
		expect(h.shownBeforeNextTurn).toBe(0);
		expect(h.shownAfterNextTurn).toBe(1);
	},
);

test.skipIf(!mac)("a probe's answer says whether Access is in front, which team, and what else it can be", () => {
	const p = report.probes;
	// Access redirects to its team's sign-in: that names the team (lower case), whichever 3xx it is.
	expect(p.access).toBe("access:myteam");
	expect(p.accessUpper).toBe("access:myteam");
	expect(p.accessOther3xx).toBe("access:myteam");
	// A redirect is Access only to https://<team>.cloudflareaccess.com.
	expect(p.relative).toBe("redirected:omp.example.com");
	expect(p.elsewhere).toBe("redirected:evil.example");
	expect(p.http).toBe("redirected:myteam.cloudflareaccess.com");
	expect(p.dottedTeam).toBe("redirected:a.b.cloudflareaccess.com");
	expect(p.bareAccessDomain).toBe("redirected:cloudflareaccess.com");
	expect(p.noLocation).toBe("redirected:");
	expect(p.forbidden).toBe("forbidden");
	expect(p.ok).toBe("open:200");
	expect(p.notFound).toBe("httpError:404");
	expect(p.badGateway).toBe("httpError:502");
	expect(p.tunnelDown).toBe("httpError:530");
	for (const [name, why] of Object.entries({
		offline: "offline",
		lost: "offline",
		noHost: "hostNotFound",
		dns: "hostNotFound",
		timeout: "timedOut",
		untrusted: "secure",
		secure: "secure",
		cannotConnect: "other",
		unknown: "other",
	})) {
		expect(p[name], name).toBe(`unreachable:${why}`);
	}
	expect(report.teams).toEqual(["myteam", "myteam", "nil", "nil", "nil", "nil"]);
});

/** What a window onto omp.example.com (team myteam) does with each navigation, by phase: loading / signing in / connected. */
const verdicts: Record<string, [string, string, string]> = {
	own: ["allow", "allow", "allow"],
	ownUpper: ["allow", "allow", "allow"],
	ownPort443: ["allow", "allow", "allow"],
	ownTrailingDot: ["allow", "allow", "allow"],
	// The same name on another port is not the Mac's page.
	ownOtherPort: ["cancel", "signInStep", "cancel"],
	ownOtherPortClicked: ["openExternally", "signInStep", "openExternally"],
	// Never http in the window; a clicked link goes to the browser.
	ownHTTP: ["cancel", "cancel", "cancel"],
	ownHTTPClicked: ["openExternally", "cancel", "openExternally"],
	// The pinned team's sign-in, in any phase (a session that ended asks again while connected).
	team: ["signIn:myteam", "signIn:myteam", "signIn:myteam"],
	// With no team pinned yet the first sign-in seen is the Mac's; after that, or once connected, another is refused.
	teamUnpinned: ["signIn:myteam", "signInStep", "teamMismatch:myteam.cloudflareaccess.com"],
	otherTeam: Array(3).fill("teamMismatch:otherteam.cloudflareaccess.com") as [string, string, string],
	otherTeamUnpinned: ["signIn:otherteam", "signInStep", "teamMismatch:otherteam.cloudflareaccess.com"],
	teamPort: ["cancel", "cancel", "cancel"],
	teamWithDot: ["cancel", "cancel", "cancel"],
	// An identity provider is followed while signing in; otherwise it is the browser's, for a clicked link only.
	idp: ["cancel", "signInStep", "cancel"],
	idpClicked: ["openExternally", "signInStep", "openExternally"],
	accessApex: ["cancel", "signInStep", "cancel"],
	lookalike: ["cancel", "signInStep", "cancel"],
	pathLookalike: ["cancel", "signInStep", "cancel"],
	// An address with a user name or a password says one host and means another: never followed.
	userinfoToEvil: ["cancel", "cancel", "cancel"],
	userinfoToOwn: ["cancel", "cancel", "cancel"],
	mailto: ["cancel", "cancel", "cancel"],
	mailtoClicked: ["openExternally", "openExternally", "openExternally"],
	blank: ["allow", "allow", "allow"],
	blob: ["allow", "allow", "allow"],
	file: ["cancel", "cancel", "cancel"],
	data: ["cancel", "cancel", "cancel"],
	javascript: ["cancel", "cancel", "cancel"],
	ssh: ["cancel", "cancel", "cancel"],
	retry: ["cancel", "cancel", "cancel"],
	nil: ["allow", "allow", "allow"],
	// A frame inside the page is the page's own business, and never opens anything outside the window.
	frameAnywhere: ["allow", "allow", "allow"],
	frameHTTP: ["cancel", "cancel", "cancel"],
	frameData: ["allow", "allow", "allow"],
	frameFile: ["cancel", "cancel", "cancel"],
	frameMailto: ["cancel", "cancel", "cancel"],
	// A link that was clicked goes to the browser, but never an address of this Mac or its network (the browser has no blocker),
	// and never while signing in.
	loopbackClicked: ["cancel", "cancel", "cancel"],
	loopbackHTTPClicked: ["cancel", "cancel", "cancel"],
	localhostClicked: ["cancel", "cancel", "cancel"],
	localhostDotClicked: ["cancel", "cancel", "cancel"],
	lanClicked: ["cancel", "cancel", "cancel"],
	singleLabelClicked: ["cancel", "cancel", "cancel"],
	localClicked: ["cancel", "cancel", "cancel"],
	multicastClicked: ["cancel", "cancel", "cancel"],
	publicHTTPClicked: ["openExternally", "cancel", "openExternally"],
};

test.skipIf(!mac)(
	"a remote window follows the Mac's page and its sign-in, and nothing a page of that Mac points it at",
	() => {
		const phases = ["loading", "signingIn", "connected"];
		const seen = new Set<string>();
		for (const [name, expected] of Object.entries(verdicts)) {
			expect(
				phases.map((p) => report.verdicts[`${name}/${p}`]),
				name,
			).toEqual(expected);
			for (const p of phases) seen.add(`${name}/${p}`);
		}
		// No case of the harness is left without an expectation.
		expect(Object.keys(report.verdicts).sort()).toEqual([...seen].sort());
	},
);

test.skipIf(!mac)(
	"the window moves to signing in or connected only when a page is committed, and a page nothing led to is not kept",
	() => {
		const p = report.phases;
		// The Mac's own page is connected; Access's endpoints on its address (a Mac can serve anything there) change nothing.
		expect(p.own).toBe("connected");
		expect(p.ownDeep).toBe("connected");
		expect(p.accessEndpoint).toBe("signingIn");
		expect(p.accessEndpointWhenConnected).toBe("connected");
		expect(p.accessEndpointWhenLoading).toBe("loading");
		// The pinned team's sign-in is the sign-in, also when a session ended while connected; another team's is not kept.
		expect(p.team).toBe("signingIn");
		expect(p.teamWhenConnected).toBe("signingIn");
		expect(p.otherTeam).toBe("unexpected");
		expect(p.otherTeamWhenSigningIn).toBe("unexpected");
		// A Mac with no team pinned takes the first sign-in it shows, not one that comes after it is connected.
		expect(p.teamUnpinnedLoading).toBe("signingIn");
		expect(p.teamUnpinnedSigningIn).toBe("signingIn");
		expect(p.teamUnpinnedConnected).toBe("unexpected");
		// An identity provider's page is the sign-in from the sign-in page, or by the redirect the window saw; nothing else.
		expect(p.idp).toBe("signingIn");
		expect(p.idpLoading).toBe("unexpected");
		expect(p.idpConnected).toBe("unexpected");
		expect(p.idpLoadingViaHop).toBe("signingIn");
		expect(p.idpConnectedViaHop).toBe("signingIn");
		// The window's own pages (about:blank), http and no address change nothing.
		expect(p.blank).toBe("connected");
		expect(p.blankLoading).toBe("loading");
		expect(p.http).toBe("connected");
		expect(p.httpForeign).toBe("signingIn");
		expect(p.nil).toBe("signingIn");
		// Only a sign-in that is committed in a window that has not yet shown the Mac's page is kept as the Mac's team.
		expect(report.teamToPin).toEqual(["myteam", "nil", "nil", "nil", "nil", "nil", "nil", "nil"]);
	},
);

test.skipIf(!mac)(
	"a link goes to another app, or the page to full screen, only on a real click or key in the window: once per event, a link a second",
	() => {
		const g = report.gestures;
		expect(g.noEvent).toBe(false);
		expect(g.same).toBe(true);
		expect(g["after0.9"]).toBe(true);
		expect(g["after1.0"]).toBe(false);
		expect(g.after5).toBe(false);
		// An event that has not happened yet (the clock went back, a stale stamp) is no click.
		expect(g.before).toBe(false);
		expect(g.olderEventDoesNotLowerIt).toBe(true);
		// One event, one use: a link opens, then the same event opens no other link and does not go full screen either.
		expect([g.firstOpen, g.freshAfterUse, g.secondOpenSameEvent, g.fullScreenSameEvent]).toEqual([
			true,
			false,
			false,
			false,
		]);
		// A link waits a second after the last one even for a new event; the clock going back does not lock it for good.
		expect([g.openTooSoon, g.openAfterASecond, g.clockWentBack]).toEqual([false, true, true]);
		// Full screen uses its event up as well: once, and no link behind it.
		expect([g.fullScreenFirst, g.fullScreenSecond, g.openAfterFullScreen]).toEqual([true, false, false]);
		expect(g.staleConsume).toBe(false);
		// Which events are a gesture: a mouse button, Return, keypad Enter and Space once; never a held key, a letter, Esc or Tab.
		expect(report.gestureEvents).toEqual([true, true, true, true, true, false, false, false, false, false]);
		const [short, exactly, over, evil, small] = report.displayHost;
		expect(short).toBe("omp.example.com");
		expect(exactly).toBe("a".repeat(40));
		expect(over).toBe(`…${"a".repeat(39)}`);
		// What a name is judged by is its end: a long host that begins like a well-known one shows how it ends.
		expect(evil).toBe(`…${"x".repeat(26)}.evil.example`);
		expect(evil).toHaveLength(40);
		expect(small).toBe("….com");
	},
);

test.skipIf(!mac)(
	"the sign-in is followed only along a redirect chain that ends at the Mac's own address: the Mac's own address closes it",
	() => {
		const n = report.navigator;
		// Own address, the team's sign-in, the provider's redirect: nothing of the team is shown, and the page is `signingIn`.
		const signIn = ["decide own → allow", "start → go", "decide team → signIn:myteam", "redirect"];
		expect(n.redirectChain).toEqual([...signIn, "decide idp → signInStep", "redirect", "commit idp → signingIn pin=-"]);
		expect(n.redirectChainTwoProviders).toEqual([
			...signIn,
			"decide idp → signInStep",
			"redirect",
			"decide idp2 → signInStep",
			"redirect",
			"commit idp2 → signingIn pin=-",
		]);
		// The team's page was shown: from there the person, or the page's own redirect, goes on to the provider.
		expect(n.teamPageThenProvider).toEqual([
			...signIn,
			"commit team → signingIn pin=-",
			"decide idp → signInStep",
			"start → go",
			"redirect",
			"commit idp → signingIn pin=-",
		]);
		// The provider hands back to the team, the team to the Mac's own authorisation: `connected` when the Mac's page is shown.
		expect(n.providerCallbackBack).toEqual([
			...signIn,
			"commit team → signingIn pin=-",
			"decide idp → signInStep",
			"redirect",
			"commit idp → signingIn pin=-",
			"decide team → signIn:myteam",
			"redirect",
			"decide ownAuth → allow",
			"redirect",
			"decide own → allow",
			"redirect",
			"commit own → connected pin=-",
		]);
		expect(n.ownLegConnected.at(-1)).toBe("commit own → connected pin=-");
		// A navigation of the page's own after the team's sign-in (a decision then a start, with no redirect) is stopped at its start…
		expect(n.redirectThenStart.slice(-2)).toEqual(["decide idp → signInStep", "start → stop"]);
		expect(n.scriptNavigationRacing.slice(-2)).toEqual(["decide evil → signInStep", "start → stop"]);
		// …and one that comes after the sign-in's load failed or was cancelled finds no chain.
		expect(n.scriptNavigationAfterFail.slice(-3)).toEqual(["start → go", "fail", "decide evil → cancel"]);
		expect(n.failureEndsChain.slice(-2)).toEqual(["fail", "decide evil → cancel"]);
		// The Mac's own address closes the chain: a redirect behind it, to anywhere, is no step of the sign-in. Not the next
		// provider, not another site, whether it is decided (cancelled) or only committed (`unexpected`, the page replaced).
		const ownLeg = [...signIn, "decide ownAuth → allow", "redirect"];
		expect(n.ownLegThenEvil).toEqual([...ownLeg, "decide evil → cancel"]);
		expect(n.ownLegThenIdp).toEqual([...ownLeg, "decide idp → cancel"]);
		expect(n.ownLegThenEvilCommitted).toEqual([...ownLeg, "commit evil → unexpected evil.example (loading)"]);
		// A page of another site that nothing led to is not kept, and the window starts over.
		expect(n.strayCommit).toEqual([
			"decide own → allow",
			"commit own → connected pin=-",
			"commit evil → unexpected evil.example (loading)",
			"decide own → allow",
		]);
		// The team of a Mac with none is kept from a sign-in page that was shown, never from one only decided or from the Mac's own.
		expect(n.pinFromCommit.at(-1)).toBe("commit team → signingIn pin=myteam");
		expect(n.pinKnown.at(-1)).toBe("commit team → signingIn pin=-");
		expect(n.noPinFromDecision.at(-1)).toBe("commit own → connected pin=-");
		// A session that ended while connected: the sign-in again, in the same window.
		expect(n.signInAgain.at(-1)).toBe("commit idp → signingIn pin=-");
	},
);

test.skipIf(!windowServer)(
	"WebKit's own callback order, recorded over http: a redirect is decided and reported with no start of its own, a page's navigation is decided and starts",
	async () => {
		const page = (title: string, body: string) =>
			new Response(`<!doctype html><title>${title}</title>${body}`, { headers: { "content-type": "text/html" } });
		const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
		// The slow sign-in is answered only after the page's next navigation has reached the server: it is in flight until then.
		const evil = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				switch (new URL(req.url).pathname) {
					// A sign-in redirect chain: own address → team → provider.
					case "/chain":
						return redirect("/team");
					case "/team":
						return redirect("/idp");
					case "/idp":
						return page("idp", "idp");
					// A page that navigates itself, to a sign-in that does not answer; its next navigation is the page's own too
					// (location = '/evil'), but run when WebKit reports that this one started rather than on a timer: a timer is a
					// race under load, and can come before this request reaches the server, which records the opposite order.
					case "/script":
						return page("script", "<script>location = '/team-slow';</script>");
					case "/team-slow":
						await evil.promise;
						return page("team", "team");
					// The Mac's own address in the middle of a chain: own → team → own authorisation → another site.
					case "/leg":
						return redirect("/team2");
					case "/team2":
						return redirect("/own");
					case "/own":
						return redirect("/evil");
					case "/evil":
						evil.resolve();
						return page("evil", "evil");
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const out = JSON.parse(await run(["order", String(server.port)])) as Record<
				string,
				{ events: string[]; replayed: string[]; timedOut?: boolean }
			>;
			// A run whose web view never reached its last commit did not record an order at all: say so, rather than reading the
			// shorter list as the order WebKit gave.
			for (const name of ["chain", "script", "leg"])
				expect(out[name].timedOut, `${name} reached its last commit`).toBe(undefined);
			// One start for the whole redirect chain, and each hop is decided and then reported as a redirect.
			expect(out.chain.events).toEqual([
				"decide:/chain",
				"start",
				"decide:/team",
				"redirect",
				"decide:/idp",
				"redirect",
				"commit:/idp",
			]);
			expect(out.chain.replayed).toEqual([
				"decide own → allow",
				"start → go",
				"decide team → signIn:myteam",
				"redirect",
				"decide idp → signInStep",
				"redirect",
				"commit idp → signingIn pin=-",
			]);
			// A page's own navigations: each is decided and then starts. The slow one is cancelled by the next (a failure, -999),
			// which finds the chain closed: it is cancelled before it starts.
			const script = out.script.events;
			for (const [i, event] of [
				"decide:/script",
				"start",
				"commit:/script",
				"decide:/team-slow",
				"start",
				"fail:-999",
				"decide:/evil",
			].entries()) {
				expect(script[i], `script event ${i}`).toBe(event);
			}
			expect(out.script.replayed.slice(-4)).toEqual([
				"decide team → signIn:myteam",
				"start → go",
				"fail",
				"decide evil → cancel",
			]);
			// The own address in the middle of a chain: the redirect behind it is decided after the own address's, and the
			// navigator cancels it (the chain ended there), so that the page it would have loaded is never shown.
			expect(out.leg.events).toEqual([
				"decide:/leg",
				"start",
				"decide:/team2",
				"redirect",
				"decide:/own",
				"redirect",
				"decide:/evil",
				"redirect",
				"commit:/evil",
			]);
			expect(out.leg.replayed.slice(-3)).toEqual(["decide ownAuth → allow", "redirect", "decide evil → cancel"]);
			expect(out.leg.replayed.some((line) => line.startsWith("commit"))).toBe(false);
		} finally {
			server.stop(true);
		}
	},
	// Three runs of the harness, each with a 45 s bound of its own (the harness says `timedOut` when it reaches it, and a
	// healthy run of the whole mode takes about half a second): a test timeout below their sum would kill a run before it
	// could report why.
	200_000,
);

test.skipIf(!mac)(
	"only the Mac's own page, in its main frame, once signed in, may use the bridges and ask for a pop-out",
	() => {
		// Pop-out: https, the Mac's host on the default port, the front page with `popout`.
		expect(report.popOut).toEqual([true, true, true, true, false, false, false, false, false, false]);
		expect(report.popOutNil).toBe(false);
		expect(report.bridge).toEqual([true, true, true, false, false, false, false, false, false, false]);
	},
);

test.skipIf(!mac)("the title and the bar always say whose window it is, whatever the page calls itself", () => {
	const [plain, zh, none, blank, controls, spaces, long, same] = report.titles;
	expect(plain).toBe("Mac A (remote) — Fix login bug");
	expect(zh).toBe("Mac A（远程） — Fix login bug");
	expect(none).toBe("Mac A (remote)");
	expect(blank).toBe("Mac A (remote)");
	// A right-to-left override, a NUL and line breaks are not carried into the title.
	expect(controls).toBe("Mac A (remote) — ab c d");
	expect(spaces).toBe("Mac A (remote) — many spaces");
	expect(long.endsWith("…")).toBe(true);
	// At most 120 characters of the page's title follow the prefix.
	expect(long.slice("Mac A (remote) — ".length)).toHaveLength(120);
	// A page that names itself like the window gets the prefix too: it cannot take it away.
	expect(same).toBe("Mac A (remote) — Mac A (remote)");
	expect(report.strips.connected).toEqual([
		"REMOTE · Mac A · omp.example.com · Connected",
		"远程 · Mac A · omp.example.com · 已连接",
	]);
	expect(report.strips.connecting[0]).toBe("REMOTE · Mac A · omp.example.com · Connecting…");
	// While signing in the bar names the host that has the page.
	expect(report.strips.signingIn[0]).toBe(
		"REMOTE · Mac A · omp.example.com · Signing in at myteam.cloudflareaccess.com",
	);
	expect(report.strips.signingIn[1]).toContain("myteam.cloudflareaccess.com");
	expect(report.strips.refused[0]).toEndWith("Sign-in refused");
	expect(report.strips.offline[0]).toEndWith("Can't reach this Mac");
	expect(report.strips.mismatch[0]).toEndWith("Different sign-in team");
	expect(report.strips.unexpected[0]).toBe("REMOTE · Mac A · omp.example.com · Stopped an unexpected page");
	expect(report.problems).toEqual([
		"offline",
		"hostNotFound",
		"timedOut",
		"secure",
		"other:the reason",
		"nil",
		"nil",
		"nil",
		"refused:401",
		"refused:403",
		"http:404",
		"http:502",
	]);
});

test.skipIf(!mac)("each Mac has a hue of its own that none of the others' is likely to share, and none is red", () => {
	const h = report.hues;
	expect(h.degrees).toHaveLength(8);
	// Red is the colour of a warning: nothing within 30 degrees of it, either side.
	for (const degrees of h.degrees) expect(degrees >= 30 && degrees <= 330).toBe(true);
	expect(new Set(h.degrees).size).toBe(8);
	expect(h.fixedTwice).toEqual([h.fixed, h.fixed]);
	// Random ids reach every hue, and none is starved (2000 draws: each about 250).
	expect(h.seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	expect(h.min).toBeGreaterThan(150);
	expect(h.max).toBeLessThan(350);
});

test.skipIf(!mac)(
	"the page for a Mac that did not answer escapes everything it shows, and has the window's own retry link",
	() => {
		const page = report.errorPage;
		expect(page).not.toContain("<b>");
		expect(page).not.toContain("<script>alert");
		expect(page).toContain("&lt;b&gt;&quot;Mac&quot;&lt;/b&gt; &amp; co");
		expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(page).toContain('href="ompw-retry:"');
		expect(page).toContain("Can't reach omp.example.com");
		expect(page).toContain('lang="en"');
		expect(report.errorPageZh).toContain('lang="zh-CN"');
		expect(report.errorPageZh).toContain("不让你进入");
		expect(report.errorPageZh).toContain("403");
	},
);

test.skipIf(!mac)(
	"every sentence is worded in English and in Simplified Chinese, and the Chinese says 对话, never 会话",
	() => {
		const cjk = /[\u3400-\u9fff]/;
		const names = Object.keys(report.words);
		expect(names.length).toBeGreaterThan(60);
		for (const name of names) {
			const [en, zh] = report.words[name];
			expect(en.length, name).toBeGreaterThan(0);
			expect(zh.length, name).toBeGreaterThan(0);
			expect(cjk.test(en), `${name} (en)`).toBe(false);
			// The two are not the same text, except the one word that is the same in both: the menu's "Macs".
			if (name !== "menuTitle") {
				expect(cjk.test(zh), `${name} (zh)`).toBe(true);
				expect(zh, name).not.toBe(en);
			}
			expect(zh, name).not.toContain("会话");
			expect(en, name).not.toContain("undefined");
			expect(zh, name).not.toContain("undefined");
		}
		// Every problem the sheets can say is worded.
		for (const key of [
			"problem:name:empty",
			"problem:name:tooLong",
			"problem:name:characters",
			"problem:full",
			"problem:hostTaken:Mac A",
		]) {
			expect(report.words[key], key).toBeDefined();
		}
		expect(Object.keys(report.words).filter((k) => k.startsWith("problem:address:"))).toHaveLength(11);
		expect(Object.keys(report.words).filter((k) => k.startsWith("probe:"))).toHaveLength(11);
		// What names a Mac, a host or a team says it, in both languages.
		for (const found of Object.values(report.wordsMention)) expect(found).toEqual([true, true]);
		expect(report.words["status:refused"][0]).toBe("Sign-in refused");
		// The language is the page's saved one, else the Mac's first.
		expect(report.language).toEqual([true, true, true, true]);
		// The sentences of the list that the server owns: it is down, a request is under way, a sign-out takes the Macs of a
		// team with it, a forgotten Mac's sign-in could not be deleted.
		expect(report.words.serverDown).toEqual([
			"The app's server is not running, so the list of Macs cannot be changed now. Try again in a moment.",
			"这个应用的服务器没有运行，所以现在无法修改 Mac 列表。请稍后再试。",
		]);
		expect(report.words.working).toEqual(["Working…", "正在处理…"]);
		expect(report.words.signedOutShared[0]).toBe(
			"Signed out of “Mac A”. It shares its sign-in with “Mac B” (the same Cloudflare team), so that Mac is signed out too. Its windows were closed.",
		);
		expect(report.words.signedOutSharedMany[0]).toBe(
			"Signed out of “Mac A”. It shares its sign-in with “Mac B”, “Mac C” (the same Cloudflare team), so those Macs are signed out too. Their windows were closed.",
		);
		expect(report.words.signedOutSharedMany[1]).toBe(
			"已退出“Mac A”的登录。它与“Mac B”、“Mac C”属于同一个 Cloudflare 团队、共用这一次登录，所以它们也已退出，窗口都已关闭。",
		);
		expect(report.words.forgotButSignInKept[0]).toContain("removed from the list");
	},
);

test.skipIf(!mac)(
	"what the Mac's file transfer sends is saved, never shown: an answer that says attachment is one",
	() => {
		// attachment (with and without a name, in any case and spacing), then inline, a name that is the word, a longer word, no
		// header, an answer that is not HTTP, and none.
		expect(report.attachment).toEqual([true, true, true, false, false, false, false, false, false]);
	},
);

test.skipIf(!mac)(
	"the blocker refuses this Mac's loopback, its network, private names, reserved ranges, and every http and ws request",
	() => {
		expect(report.ruleCount).toBeGreaterThan(50);
		expect(report.ruleActions).toEqual(["block"]);
		// Every address that must be refused matches a rule (over https and wss too, with the dot that ends a name, single labels,
		// private suffixes, 192.0.0/24, 198.18/15, multicast, reserved), and none of the addresses that must be reached does.
		expect(report.blocked).toEqual([]);
		expect(report.notBlocked).toEqual([]);
		// The same address rules decide what may be handed to another app, without the scheme rules: a clicked link to
		// `http://example.com/` is the browser's, one to this Mac or its network is nobody's.
		expect(report.externalNotBlocked).toEqual([]);
		expect(report.externalBlocked).toEqual([]);
	},
);

test.skipIf(!windowServer)("WebKit accepts the blocker", () => {
	expect(report.compiles).toEqual({ ok: true, error: "none" });
});

/** The vectors the harness tries, in the order of the ports it is given (`vectorNames` in the harness). */
const vectorNames = [
	"fetchLoopback",
	"fetchLocalhost",
	"fetchLocalhostDot",
	"fetchDecimal",
	"fetchHex",
	"fetchShort",
	"fetchSubLocalhost",
	"xhr",
	"wss",
	"worker",
	"eventSource",
	"beacon",
	"img",
	"iframe",
	"httpFetch",
	"wsPlain",
];

test.skipIf(!windowServer)(
	"a page cannot reach this Mac in any spelling and by any means (fetch, XHR, WebSocket, a worker, EventSource, a beacon, an image, a frame), from an http page or about:blank",
	async () => {
		// What counts is connections, per vector: nothing answers, so a request that is let through can only connect.
		for (const page of [[], ["blank"]]) {
			const control = listenForConnections(vectorNames.length);
			try {
				// Without the blocker every vector connects: a vector that cannot reach the listener would prove nothing.
				await run(["vectors", "0", control.ports.join(","), ...page]);
				for (const [i, name] of vectorNames.entries()) {
					expect(control.counts[i], `${name} without the blocker (${page[0] ?? "http page"})`).toBeGreaterThan(0);
				}
			} finally {
				control.stop();
			}
			const blocked = listenForConnections(vectorNames.length);
			try {
				const out = JSON.parse(await run(["vectors", "1", blocked.ports.join(","), ...page])) as {
					results: Record<string, string>;
				};
				// The page ran every vector (a failure to run one would be a pass for the wrong reason)…
				for (const name of vectorNames) expect(out.results[name], name).toBeDefined();
				// …and nothing of it connected.
				expect(blocked.counts, `with the blocker (${page[0] ?? "http page"})`).toEqual(vectorNames.map(() => 0));
			} finally {
				blocked.stop();
			}
		}
	},
	180_000,
);

test.skipIf(!windowServer)(
	"the app's own remote window, its pop-out and menu, made as the app makes them and never shown, label, lay out and guard themselves",
	async () => {
		const own = listenForConnections(vectorNames.length);
		const popOut = listenForConnections(vectorNames.length);
		try {
			const scratch = mkdtempSync(join(dir, "window-"));
			const w = JSON.parse(await run(["window", scratch, own.ports.join(","), popOut.ports.join(",")])) as Record<
				string,
				unknown
			>;
			// The Macs menu: the list, a tick for none yet, the Mac's address as its tooltip; nothing to manage before there is a Mac.
			expect(w.menuTitle).toBe("Macs");
			expect(w.menuEmpty).toEqual([
				{ title: "No other Macs yet", enabled: false, on: false, tip: "" },
				{ separator: true },
				{ title: "Add Mac…", enabled: true, on: false, tip: "" },
				{ title: "Manage Macs…", enabled: false, on: false, tip: "" },
			]);
			expect(w.menuOne).toEqual([
				{ title: "Mac A", enabled: true, on: false, tip: "omp.invalid" },
				{ separator: true },
				{ title: "Add Mac…", enabled: true, on: false, tip: "" },
				{ title: "Manage Macs…", enabled: true, on: false, tip: "" },
			]);
			// The list is the file the server wrote: a Mac the list does not have is not opened, and no window is made for it.
			expect(w.openUnknown).toBe(false);
			expect(w.noSessionForUnknown).toBe(true);
			// A real window that closes without closing the app, with full screen, never put on the screen.
			expect(w.started).toBe(true);
			expect(w.closable).toBe(true);
			expect(w.delegateIsWindow).toBe(true);
			expect(w.fullScreenPrimary).toBe(true);
			expect(w.everVisible).toBe(false);
			// From its first moment the title says whose it is; the Mac never answers (a host that cannot exist), and the window says so
			// in its own page, with the Mac's name still in front.
			expect(w.titleAtStart).toBe("Mac A (remote)");
			expect(w.failed).toBe(true);
			expect(w.titleAfterFailure).toBe("Mac A (remote) — Can't reach omp.invalid");
			expect(w.strip).toBe(
				"Remote Mac Mac A, omp.invalid: Can't reach this Mac. Everything in this window happens on that Mac.",
			);
			// The bar is above the page and as wide as the window; the page has the rest.
			expect(w.contentIsRemote).toBe(true);
			expect(w.layout).toEqual({ content: [0, 0, 1280, 840], strip: [0, 814, 1280, 26], web: [0, 0, 1280, 814] });
			// A page that renames itself, or tries tricks with its title, cannot take the Mac's name away.
			expect(w.titleAfterRename).toBe("Mac A (remote) — Totally the local Mac");
			expect(w.titleAfterTricks).toBe("Mac A (remote) — evil title");
			// The words and the name follow the language and a rename.
			expect(w.titleZh).toBe("Mac A（远程） — evil title");
			expect(w.stripZh).toBe("远程 Mac Mac A，omp.invalid：连不上这台 Mac。这个窗口里的一切都发生在那台 Mac 上。");
			expect(w.titleRenamed).toBe("Mac Z (remote) — evil title");
			expect(w.stripRenamed).toContain("Remote Mac Mac Z, omp.invalid");
			// A page that is not the Mac's own signed-in page is not answered by the bridges.
			expect(w.themeRefused).toBe(true);

			// No window is narrower than the bar needs, the pop-out included.
			expect(w.minWidth).toBe(640);
			expect(w.windowMinSize).toEqual([640, 480]);
			expect(w.popOutMinWidth).toBe(640);
			// Neither the Mac's own window nor a pop-out zooms its page (tests/unit/macos-no-zoom.test.ts).
			expect(w.allowsMagnification).toEqual([false, false]);
			// The bar names the host that has the page: all of a short one, the end of a long one, never cut off at its end.
			const strips = w.stripWidths as Record<
				string,
				{
					tag: string;
					who: string;
					whoHidden: boolean;
					status: string;
					statusFits: boolean;
					whoFrame: number[];
					statusFrame: number[];
				}
			>;
			for (const width of [1280, 700, 640, 520, 420]) {
				const short = strips[`short/${width}`];
				expect(short.tag, `short/${width}`).toBe("REMOTE");
				expect(short.status, `short/${width}`).toBe("· Signing in at login.example-idp.com");
				expect(short.statusFits, `short/${width}`).toBe(true);
				const long = strips[`long/${width}`];
				// The last 39 characters of a 100-character host, after an ellipsis: it ends as it ends.
				expect(long.status, `long/${width}`).toBe(`· Signing in at …${"x".repeat(26)}.evil.example`);
				expect(long.status, `long/${width}`).not.toContain("accounts.google.com");
			}
			// At and above the least width, the host is shown whole (nothing cut) and who still fits beside it; below it who gives way
			// first, and then the state may be cut, in its middle, but keeps what there is.
			for (const width of [1280, 700, 640]) {
				for (const kind of ["short", "long"]) {
					const s = strips[`${kind}/${width}`];
					expect(s.statusFits, `${kind}/${width}`).toBe(true);
					expect(s.whoHidden, `${kind}/${width}`).toBe(false);
					expect(s.who, `${kind}/${width}`).toBe("· Mac A · omp.example.com");
				}
			}
			expect(strips["short/420"].whoHidden).toBe(true);
			expect(strips["long/520"].whoHidden).toBe(true);
			expect(strips["long/420"].statusFits).toBe(false);
			expect(strips["long/420"].statusFrame[2]).toBeGreaterThan(200);

			// What the window's own configuration blocks never connects: the window's page and its pop-out's.
			const tried = w.pageTried as Record<string, string>;
			const popTried = w.popOutTried as Record<string, string>;
			for (const name of vectorNames) {
				expect(tried[name], `window ${name}`).toBeDefined();
				expect(popTried[name], `pop-out ${name}`).toBeDefined();
			}
			expect(own.counts).toEqual(vectorNames.map(() => 0));
			expect(popOut.counts).toEqual(vectorNames.map(() => 0));
			// Service workers do not exist in this web view (so there is no worker of that kind to carry a request past the blocker).
			expect(tried.serviceWorker).toBe("undefined");

			// A pop-out, and choosing the Mac when only it is left: the Mac's own window comes back, in the same session.
			expect(w.popOutOpened).toBe(true);
			expect(w.popOutTitle).toBe("Mac Z (remote)");
			expect(w.afterMainClosed).toEqual(["popout"]);
			expect(w.afterReopen).toEqual(["popout", "main"]);
			expect(w.reopenedNeverShown).toBe(true);
			// Disconnect ends the session.
			expect(w.windowsAfterDisconnect).toBe(0);
			// The Macs of one Cloudflare team are given one data store (the team's, by its identifier), any other Mac its own, and
			// the local window's default store is left alone.
			const s = w.stores as {
				asked: string[];
				expected: string[];
				sessionStores: number;
				sameTeamSameStore: boolean;
				otherTeamAnotherStore: boolean;
				noTeamOwnStores: boolean;
				noneIsTheDefault: boolean;
				mainConfigurationUntouched: boolean;
				windowsAfterDisconnect: number[];
			};
			expect(s.sessionStores).toBe(5);
			expect(s.asked).toEqual(s.expected);
			expect(s.asked.slice(0, 3)).toEqual([teamStoreId("myteam"), teamStoreId("myteam"), teamStoreId("otherteam")]);
			expect(s.sameTeamSameStore).toBe(true);
			expect(s.otherTeamAnotherStore).toBe(true);
			expect(s.noTeamOwnStores).toBe(true);
			expect(s.noneIsTheDefault).toBe(true);
			expect(s.mainConfigurationUntouched).toBe(true);
			expect(s.windowsAfterDisconnect).toEqual([0, 0, 0, 0, 0]);
			// Forgetting a Mac whose team's store stays takes its own cookies out of it, by host (a real store): its sign-in goes, and
			// its sibling's, the parent domain's and the team's Access sign-in (another site's) stay.
			const o = w.originData as { before: string[]; finished: boolean; after: string[] };
			expect(o.before).toEqual(["a-dot", "a-host", "access", "b-host", "parent"]);
			expect(o.finished).toBe(true);
			expect(o.after).toEqual(["access", "b-host", "parent"]);
		} finally {
			own.stop();
			popOut.stop();
		}
	},
	180_000,
);

// ------------------------------------------------------------------ notices of another Mac (#656)

test.skipIf(!mac)(
	"another Mac's stream is signed in with the window's own cookies, and only those: Access's is required, nothing past its end or for another site is sent",
	async () => {
		const out = JSON.parse(await run(["notify"])) as {
			signIn: Record<string, string[] | string>;
			delays: number[];
			request: { url: string; cookie: string; token: string; handlesCookies: boolean; timeout: number };
		};
		const both = ["CF_Authorization", "ompw_token"];
		expect(out.signIn).toEqual({
			both,
			// Another cookie of the store is not sent, nor a cookie of another site.
			others: both,
			// Without Cloudflare Access's cookie the request would go to Access's sign-in: no request is made.
			noAccess: "nil",
			// The server's own token missing is the server's to refuse (401): Access's alone still signs a request in.
			onlyAccess: ["CF_Authorization"],
			expired: "nil",
			live: both,
			wholeDomain: both,
			otherSite: "nil",
			otherPath: "nil",
			noCookies: "nil",
		});
		// A Mac that is off is not asked every few seconds: doubling, up to five minutes.
		expect(out.delays).toEqual([2, 4, 8, 256, 300, 300]);
		// What the request carries is what the window's sign-in left, on the path that is not the local-only one; the system adds no cookie of its own.
		const url = new URL(out.request.url);
		expect(url.origin + url.pathname).toBe("https://mac.example.com/api/notify/events");
		expect(url.searchParams.get("epoch")).toBe("e1");
		expect(url.searchParams.get("since")).toBe("7");
		expect(out.request.cookie).toBe("CF_Authorization=x; ompw_token=y");
		expect(out.request.token).toBe("nil");
		expect(out.request.handlesCookies).toBe(false);
		expect(out.request.timeout).toBe(45);
	},
);
