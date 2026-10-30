import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import {
	checkNewMac,
	describeMacProblem,
	foldMacName,
	isMacId,
	isTeamName,
	MAC_LIMIT,
	type MacAdd,
	type MacAnswer,
	type MacProblem,
	type MacRecord,
	parseMacAddress,
	parseMacName,
	type SavedMac,
	savedMacOf,
} from "../shared/macs.ts";
import { isThisComputer } from "./this-computer.ts";

/**
 * The other Macs this one knows (#628, on #614's list): `<data dir>/remote-macs.json`, the file the macOS app's Macs menu
 * kept before the server did. It is the same file in the same shape (`{ "version": 1, "macs": [ … ] }`), so the Macs a person
 * saved with the app are this list from the first start of this version, with nothing to move; and a server on another data
 * dir (a browser-only install, a test) has a list of its own.
 *
 * The server is the one that writes it, written whole into a file of its own and moved into place, mode 0600; the app asks
 * this server to change it and reads the file. There is no secret in it: a Mac's sign-in is in the app's own web data store
 * for that Mac, and the file only names that store.
 *
 * Read again whenever the file changed (a person may edit it), never trusted past what fits: an entry that does not fit is left
 * out of the list, and the file is kept beside itself as `.damaged` before the next change writes over it.
 */

/** What is wrong with a request to change the list: the whole change is refused. */
export class MacError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly problem: MacProblem | null = null,
	) {
		super(message);
	}
}

const refusal = (problem: MacProblem) => new MacError(describeMacProblem(problem), 400, problem);

/** Dates are kept in whole seconds (`2026-10-23T09:00:00Z`), as the app wrote them. */
const stampOf = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/** A date in the file as it is kept, or null when it is no date. */
function dateOf(value: unknown): string | null {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : stampOf(new Date(ms));
}

/** What a file holds: the entries that fit, and whether anything in it did not. */
interface Loaded {
	macs: MacRecord[];
	damaged: boolean;
}

/** Read the entries of the file's text. An entry that does not fit is left out; so is every one after the tenth. */
export function decodeMacs(text: string): Loaded {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { macs: [], damaged: true };
	}
	if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.macs)) return { macs: [], damaged: true };
	const macs: MacRecord[] = [];
	let damaged = false;
	for (const entry of raw.macs) {
		const record = recordOf(entry, macs);
		if (record === null) damaged = true;
		else {
			// What does not fit in a record that is otherwise good is left out of it, and the file is kept as it was.
			if (record.dropped) damaged = true;
			macs.push(record.mac);
		}
	}
	return { macs, damaged };
}

/** One entry of the file as a record (and whether a field of it had to be left out), or null when it cannot be one. */
function recordOf(entry: unknown, kept: MacRecord[]): { mac: MacRecord; dropped: boolean } | null {
	if (!isRecord(entry) || kept.length >= MAC_LIMIT) return null;
	const { id, storeId, name: rawName, host: rawHost } = entry;
	if (typeof id !== "string" || !isMacId(id) || typeof storeId !== "string" || !isMacId(storeId)) return null;
	if (typeof rawName !== "string" || typeof rawHost !== "string") return null;
	const name = parseMacName(rawName);
	const host = parseMacAddress(rawHost);
	const added = dateOf(entry.added);
	// The host is kept as the address would be read: lower case, no scheme.
	if (!name.ok || !host.ok || host.host !== rawHost || added === null) return null;
	const folded = foldMacName(name.name);
	const clash = kept.some(
		(m) =>
			m.id.toLowerCase() === id.toLowerCase() ||
			m.storeId.toLowerCase() === storeId.toLowerCase() ||
			m.host === host.host ||
			foldMacName(m.name) === folded,
	);
	if (clash) return null;
	let dropped = false;
	let team: string | null = null;
	if (entry.team !== undefined && entry.team !== null) {
		if (typeof entry.team === "string" && isTeamName(entry.team)) team = entry.team;
		else dropped = true;
	}
	let lastConnected: string | null = null;
	if (entry.lastConnected !== undefined && entry.lastConnected !== null) {
		lastConnected = dateOf(entry.lastConnected);
		if (lastConnected === null) dropped = true;
	}
	return { mac: { id, name: name.name, host: host.host, team, storeId, added, lastConnected }, dropped };
}

/** The file's text: sorted keys, two spaces, a line break at the end. */
function encodeMacs(macs: MacRecord[]): string {
	const entries = macs.map((m) => ({
		added: m.added,
		host: m.host,
		id: m.id,
		lastConnected: m.lastConnected,
		name: m.name,
		storeId: m.storeId,
		team: m.team,
	}));
	return `${JSON.stringify({ macs: entries, version: 1 }, null, 2)}\n`;
}

/** The list, in `remote-macs.json`. */
export class SavedMacs {
	private known: { stamp: string; loaded: Loaded } | null = null;

	/** `onChange` runs after every change that was written (every open page is told, and asks again). */
	constructor(
		readonly file: string,
		private readonly onChange: () => void = () => {},
	) {}

	/** The Macs as a page sees them. */
	saved(): SavedMac[] {
		return this.load().macs.map(savedMacOf);
	}

	/** The Macs as the file holds them, in the order they were added. */
	records(): MacRecord[] {
		return this.load().macs;
	}

	add(input: MacAdd, now: Date = new Date()): MacRecord {
		const loaded = this.load();
		const checked = checkNewMac(loaded.macs, input);
		if (!checked.ok) throw refusal(checked.problem);
		const mac: MacRecord = {
			id: randomUUID(),
			name: checked.name,
			host: checked.host,
			team: typeof input.team === "string" && isTeamName(input.team) ? input.team : null,
			storeId: randomUUID(),
			added: stampOf(now),
			lastConnected: null,
		};
		this.write(loaded, [...loaded.macs, mac]);
		return mac;
	}

	rename(id: string, name: string): MacRecord {
		return this.update(id, (mac, macs) => ({ ...mac, name: this.nameFor(macs, mac.id, name) }));
	}

	/** Take the Mac out of the list. The app removes its sign-in itself (its data store is its own). */
	remove(id: string): void {
		const loaded = this.load();
		const at = loaded.macs.findIndex((m) => m.id.toLowerCase() === id.toLowerCase());
		if (at < 0) throw new MacError("No such Mac", 404);
		this.write(loaded, loaded.macs.toSpliced(at, 1));
	}

	/** The app had a window of this Mac signed in. */
	connected(id: string, now: Date = new Date()): MacRecord {
		return this.update(id, (mac) => ({ ...mac, lastConnected: stampOf(now) }));
	}

	/** Keep the team this Mac's sign-in belongs to: the first one seen; a later one changes nothing. */
	pin(id: string, team: string): MacRecord {
		return this.update(id, (mac) => (mac.team !== null || !isTeamName(team) ? mac : { ...mac, team }));
	}

	/** Replace the Mac `id` by what `next` makes of it; nothing is written when it comes out the same. */
	private update(id: string, next: (mac: MacRecord, macs: MacRecord[]) => MacRecord): MacRecord {
		const loaded = this.load();
		const at = loaded.macs.findIndex((m) => m.id.toLowerCase() === id.toLowerCase());
		const mac = loaded.macs[at];
		if (!mac) throw new MacError("No such Mac", 404);
		const changed = next(mac, loaded.macs);
		if (JSON.stringify(changed) !== JSON.stringify(mac)) this.write(loaded, loaded.macs.with(at, changed));
		return changed;
	}

	/** The name as it would be kept; the Mac `own` may keep its own. */
	private nameFor(macs: MacRecord[], own: string | null, input: string): string {
		const name = parseMacName(input);
		if (!name.ok) throw refusal({ kind: "name", code: name.problem });
		const folded = foldMacName(name.name);
		const other = macs.find((m) => m.id !== own && foldMacName(m.name) === folded);
		if (other) throw refusal({ kind: "name", code: "taken", taken: other.name });
		return name.name;
	}

	private stamp(): string {
		try {
			const info = statSync(this.file);
			return `${info.mtimeMs}:${info.size}:${info.ino}`;
		} catch {
			return "none";
		}
	}

	/** The file as it is now: read again when it changed since it was last read. */
	private load(): Loaded {
		const stamp = this.stamp();
		if (this.known?.stamp === stamp) return this.known.loaded;
		let loaded: Loaded;
		if (stamp === "none") loaded = { macs: [], damaged: false };
		else {
			try {
				loaded = decodeMacs(readFileSync(this.file, "utf8"));
			} catch (e) {
				console.warn(`omp-webui: ${this.file} cannot be read (${(e as Error).message}): no Mac is listed`);
				loaded = { macs: [], damaged: true };
			}
			if (loaded.damaged) console.warn(`omp-webui: ${this.file} is not all usable: the entries that fit are listed`);
		}
		this.known = { stamp, loaded };
		return loaded;
	}

	/** Write the list whole and move it into place; what could not be trusted of the old file is kept beside it. */
	private write(before: Loaded, macs: MacRecord[]): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		if (before.damaged && existsSync(this.file)) {
			try {
				renameSync(this.file, `${this.file}.damaged`);
			} catch (e) {
				console.warn(`omp-webui: could not keep a copy of ${this.file}: ${(e as Error).message}`);
			}
		}
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, encodeMacs(macs), { mode: 0o600 });
			// The mode asked for is cut by the umask; the list is private whatever it is.
			chmodSync(temporary, 0o600);
			renameSync(temporary, this.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
		this.known = { stamp: this.stamp(), loaded: { macs, damaged: false } };
		this.onChange();
	}

	// ------------------------------------------------------------------ the routes

	/**
	 * The answer to `req` when it is one for `/api/macs*`; null when it is not. The routes change the list, so they are for
	 * the person at this computer (`isLocalOnlyRoute` refuses the others before the request gets here, and this asks again,
	 * as `RemoteService.handle` does): a page that came through the tunnel or over a network address reads the list and never
	 * writes it.
	 */
	async handle(req: Request, url: URL, peer: string | undefined): Promise<Response | null> {
		const path = url.pathname;
		if (path !== "/api/macs" && !path.startsWith("/api/macs/")) return null;
		if (!isThisComputer(req, peer)) return fail("The list of Macs is changed on this computer only", 403);
		try {
			return await this.answer(req, path);
		} catch (e) {
			if (e instanceof MacError)
				return json({ error: e.message, ...(e.problem ? { problem: e.problem } : {}) }, e.status);
			throw e;
		}
	}

	private async answer(req: Request, path: string): Promise<Response> {
		if (path === "/api/macs") {
			if (req.method !== "POST") return fail("POST required", 405);
			const body = await bodyOf(req);
			return answer(
				this.add({
					name: typeof body.name === "string" ? body.name : "",
					address: typeof body.address === "string" ? body.address : "",
					team: typeof body.team === "string" ? body.team : null,
				}),
			);
		}
		const [, , , id, action, ...extra] = path.split("/");
		if (!id || !isMacId(id) || extra.length > 0) return fail("Not found", 404);
		if (action === undefined) {
			if (req.method !== "DELETE") return fail("DELETE required", 405);
			this.remove(id);
			return json({ ok: true });
		}
		if (req.method !== "POST") return fail("POST required", 405);
		const body = await bodyOf(req);
		switch (action) {
			case "rename":
				return answer(this.rename(id, typeof body.name === "string" ? body.name : ""));
			case "connected":
				return answer(this.connected(id));
			case "team":
				return answer(this.pin(id, typeof body.team === "string" ? body.team : ""));
			default:
				return fail("Not found", 404);
		}
	}
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);
const answer = (mac: MacRecord) => json({ mac } satisfies MacAnswer);

/** The body of a request as an object; an empty one is `{}`, one that is not an object is refused. */
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (text === "") return {};
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new MacError("The body must be JSON", 400);
	}
	if (!isRecord(body)) throw new MacError("The body must be an object", 400);
	return body;
}

/** Where the list is kept: beside the app's other files, in the data dir. */
export const savedMacsPath = (dataDir: string): string => join(dataDir, "remote-macs.json");
