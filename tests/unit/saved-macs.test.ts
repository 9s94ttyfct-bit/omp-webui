import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteSignIns } from "../../server/remote-run/sign-ins.ts";
import { decodeMacs, MacError, SavedMacs } from "../../server/saved-macs.ts";
import { MAC_LIMIT } from "../../shared/macs.ts";
import { expectMode } from "../support/modes.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The list of saved Macs (`server/saved-macs.ts`, #628), without a server: what the file may hold, what is left out of the
 * list when it holds something that does not fit, and that a change is written whole, privately, and keeps what it could not
 * trust. The routes (and who may use them) are `tests/contract/macs.test.ts`.
 */

const dir = tempDir("ompw-saved-macs-");
let n = 0;
/** A list of its own: a file in the scratch directory that nothing else uses. */
const fresh = () => {
	const folder = mkdtempSync(join(dir, `l${n++}-`));
	const changes: number[] = [];
	return {
		folder,
		file: join(folder, "remote-macs.json"),
		changes,
		list: new SavedMacs(join(folder, "remote-macs.json"), () => changes.push(Date.now())),
	};
};

const entry = (over: Record<string, unknown> = {}) => ({
	added: "2026-10-23T09:00:00Z",
	host: "omp.example.com",
	id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D11",
	lastConnected: null,
	name: "Mac A",
	storeId: "A4B2C3D4-0000-4000-8000-0123456789AB",
	team: null,
	...over,
});
const file = (...macs: unknown[]) => JSON.stringify({ version: 1, macs });
// The scratch directories are left where they are: a test never deletes anything.

describe("decodeMacs", () => {
	test("reads what the macOS app wrote (UPPER-case UUIDs, a team, a time) as it is, with nothing left out", () => {
		const read = decodeMacs(file(entry({ team: "myteam", lastConnected: "2026-10-24T18:30:00Z" })));
		expect(read.damaged).toBe(false);
		expect(read.macs).toEqual([entry({ team: "myteam", lastConnected: "2026-10-24T18:30:00Z" })]);
	});

	test("an empty list is a list, and anything that is no list of this version is damage that lists nothing", () => {
		expect(decodeMacs(file())).toEqual({ macs: [], damaged: false });
		for (const text of [
			"",
			"not json",
			"[]",
			"null",
			'{"macs":[]}',
			'{"version":2,"macs":[]}',
			'{"version":1}',
			'{"version":1,"macs":{}}',
		])
			expect(decodeMacs(text), text).toEqual({ macs: [], damaged: true });
	});

	test("leaves out an entry that does not fit, and says the file is not all usable; the others are listed", () => {
		const bad: Record<string, unknown>[] = [
			{ id: "nope" },
			{ storeId: "nope" },
			{ name: "" },
			{ name: "x".repeat(61) },
			{ name: "Mac\u202EA" },
			{ host: "127.0.0.1" },
			{ host: "OMP.EXAMPLE.COM" },
			{ host: "https://omp.example.com" },
			{ host: "omp.example.com:8443" },
			{ added: "yesterday" },
			{ added: 5 },
			{ host: 5 },
		];
		for (const over of bad) {
			const read = decodeMacs(
				file(
					entry(over),
					entry({
						id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D12",
						storeId: "A4B2C3D4-0000-4000-8000-0123456789AC",
						name: "Mac B",
						host: "b.example.com",
					}),
				),
			);
			expect(read.damaged, JSON.stringify(over)).toBe(true);
			expect(
				read.macs.map((m) => m.name),
				JSON.stringify(over),
			).toEqual(["Mac B"]);
		}
		expect(decodeMacs(file(null, 5, "x", [])).damaged).toBe(true);
	});

	test("keeps an entry whose team or time does not fit, without that field, and says so", () => {
		const team = decodeMacs(file(entry({ team: "Not A Team!" })));
		expect(team.damaged).toBe(true);
		expect(team.macs[0]?.team).toBeNull();
		const time = decodeMacs(file(entry({ lastConnected: "sometime" })));
		expect(time.damaged).toBe(true);
		expect(time.macs[0]?.lastConnected).toBeNull();
		// A time with fractions is read, and kept in whole seconds.
		expect(decodeMacs(file(entry({ lastConnected: "2026-10-24T18:30:00.750Z" }))).macs[0]?.lastConnected).toBe(
			"2026-10-24T18:30:00Z",
		);
	});

	test("leaves out a second Mac that repeats an id, a data store, an address or a name (in any case, accents and width)", () => {
		const other = {
			id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D12",
			storeId: "A4B2C3D4-0000-4000-8000-0123456789AC",
			name: "Mac B",
			host: "b.example.com",
		};
		for (const over of [
			{ id: "6f1c1b7e-7b7a-4e0b-9e27-0c7e0a6c1d11" },
			{ storeId: "a4b2c3d4-0000-4000-8000-0123456789ab" },
			{ host: "omp.example.com" },
			{ name: "mac a" },
			{ name: "Mác A" },
			{ name: "Ｍac A" },
		]) {
			const read = decodeMacs(file(entry(), { ...other, ...over }));
			expect(read.damaged, JSON.stringify(over)).toBe(true);
			expect(
				read.macs.map((m) => m.name),
				JSON.stringify(over),
			).toEqual(["Mac A"]);
		}
	});

	test("lists at most ten", () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			entry({
				id: `6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D${String(i).padStart(2, "0")}`,
				storeId: `A4B2C3D4-0000-4000-8000-0123456789${String(i).padStart(2, "0")}`,
				name: `M${i}`,
				host: `m${i}.example.com`,
			}),
		);
		const read = decodeMacs(file(...many));
		expect(read.macs.map((m) => m.name)).toEqual(many.slice(0, MAC_LIMIT).map((m) => m.name));
		expect(read.damaged).toBe(true);
	});
});

describe("SavedMacs", () => {
	test("has no file until something is saved, and tells nobody that nothing changed", () => {
		const { list, file: path, changes } = fresh();
		expect(list.saved()).toEqual([]);
		expect(existsSync(path)).toBe(false);
		expect(changes).toEqual([]);
	});

	test("writes the list whole into a private file, and again when the file is changed by hand", () => {
		const { list, file: path, changes } = fresh();
		const mac = list.add(
			{ name: "Studio", address: "studio.example.com", team: "myteam" },
			new Date("2026-10-25T08:00:00.900Z"),
		);
		expect(mac.added).toBe("2026-10-25T08:00:00Z");
		expect(mac.team).toBe("myteam");
		expectMode(path, 0o600);
		expect(changes.length).toBe(1);
		// No temporary file is left beside it.
		expect(readdirSync(join(path, "..")).sort()).toEqual(["remote-macs.json"]);
		const text = readFileSync(path, "utf8");
		expect(text.endsWith("}\n")).toBe(true);
		expect(JSON.parse(text)).toEqual({ version: 1, macs: [mac] });

		// Edited by hand, it is read again: the list is the file's, not what the server remembers.
		writeFileSync(path, file(entry({ name: "Edited" })), { mode: 0o600 });
		expect(list.saved().map((m) => m.name)).toEqual(["Edited"]);
	});

	test("a change that changes nothing writes nothing and tells nobody", () => {
		const { list, file: path, changes } = fresh();
		const mac = list.add({ name: "Studio", address: "studio.example.com" });
		const before = readFileSync(path, "utf8");
		const count = changes.length;
		list.rename(mac.id, "Studio");
		list.pin(mac.id, "Not A Team!");
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(changes.length).toBe(count);
		list.pin(mac.id, "myteam");
		list.pin(mac.id, "other");
		expect(list.records()[0]?.team).toBe("myteam");
		expect(changes.length).toBe(count + 1);
	});

	test("the first change to a file that could not all be trusted keeps it beside the new one, once", () => {
		const { list, file: path, folder } = fresh();
		const damaged = file(
			entry(),
			entry({
				host: "127.0.0.1",
				id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D12",
				storeId: "A4B2C3D4-0000-4000-8000-0123456789AC",
				name: "B",
			}),
		);
		writeFileSync(path, damaged, { mode: 0o600 });
		expect(list.saved().map((m) => m.name)).toEqual(["Mac A"]);
		expect(readFileSync(path, "utf8")).toBe(damaged);
		list.add({ name: "Mac C", address: "c.example.com" });
		expect(readFileSync(`${path}.damaged`, "utf8")).toBe(damaged);
		expect(JSON.parse(readFileSync(path, "utf8")).macs.map((m: { name: string }) => m.name)).toEqual([
			"Mac A",
			"Mac C",
		]);
		// What was clean is written over, not kept again.
		list.add({ name: "Mac D", address: "d.example.com" });
		expect(readFileSync(`${path}.damaged`, "utf8")).toBe(damaged);
		expect(readdirSync(folder).sort()).toEqual(["remote-macs.json", "remote-macs.json.damaged"]);
	});

	test("refuses a Mac that is not a Mac, a name or an address that is taken, and an eleventh, as MacError with the rule", () => {
		const { list } = fresh();
		list.add({ name: "Studio", address: "studio.example.com" });
		const problem = (run: () => unknown) => {
			try {
				run();
			} catch (e) {
				if (e instanceof MacError) return { status: e.status, problem: e.problem };
				throw e;
			}
			throw new Error("not refused");
		};
		expect(problem(() => list.add({ name: "STUDIO", address: "x.example.com" }))).toEqual({
			status: 400,
			problem: { kind: "name", code: "taken", taken: "Studio" },
		});
		expect(problem(() => list.add({ name: "Other", address: "studio.example.com" }))).toEqual({
			status: 400,
			problem: { kind: "host-taken", name: "Studio" },
		});
		expect(problem(() => list.add({ name: "Other", address: "10.0.0.1" }))).toEqual({
			status: 400,
			problem: { kind: "address", code: "ip-address" },
		});
		expect(problem(() => list.rename("0f8fad5b-d9cb-469f-a165-70867728950e", "x"))).toEqual({
			status: 404,
			problem: null,
		});
		for (let i = 1; i < MAC_LIMIT; i++) list.add({ name: `M${i}`, address: `m${i}.example.com` });
		expect(problem(() => list.add({ name: "Last", address: "last.example.com" }))).toEqual({
			status: 400,
			problem: { kind: "full" },
		});
		expect(list.saved().length).toBe(MAC_LIMIT);
	});

	test("a name may change case or be the Mac's own again, never another's", () => {
		const { list } = fresh();
		const a = list.add({ name: "Studio", address: "studio.example.com" });
		list.add({ name: "Laptop", address: "laptop.example.com" });
		expect(list.rename(a.id, "STUDIO").name).toBe("STUDIO");
		expect(() => list.rename(a.id, "laptop")).toThrow(MacError);
		expect(list.saved().map((m) => m.name)).toEqual(["STUDIO", "Laptop"]);
	});

	test("what a page is shown holds the address and the last time, not the team or the app's data store", () => {
		const { list } = fresh();
		const mac = list.add({ name: "Studio", address: "studio.example.com", team: "myteam" });
		list.connected(mac.id, new Date("2026-10-25T10:00:00Z"));
		expect(list.saved()).toEqual([
			{ id: mac.id, name: "Studio", host: "studio.example.com", lastConnected: "2026-10-25T10:00:00Z" },
		]);
	});
});

describe("a Mac's sign-in", () => {
	const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const exp = Math.floor(Date.now() / 1000) + 3600;
	const JWT = `${b64url({ alg: "RS256" })}.${b64url({ exp })}.c2ln`;

	/** A list with the sign-ins of the server, and the Macs removed from it. */
	const withSignIns = () => {
		const folder = mkdtempSync(join(dir, `s${n++}-`));
		const changes: number[] = [];
		const removed: string[] = [];
		const signIns = new RemoteSignIns();
		const list = new SavedMacs(join(folder, "remote-macs.json"), () => changes.push(Date.now()), {
			signIns,
			removed: (id) => removed.push(id),
		});
		const mac = list.add({ name: "Server1", address: "server1.example.com" });
		changes.length = 0;
		/** A request as `main.ts` hands it over: `owner` and `local` as the request's own authentication says. */
		const send = (method: string, id: string, body: unknown, who: { owner: boolean; local: boolean }) => {
			const url = new URL(`http://127.0.0.1/api/macs/${id}/sign-in`);
			const req = new Request(url, {
				method,
				headers: { "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			return list.handle(req, url, who.owner, who.local) as Promise<Response>;
		};
		return { list, signIns, mac, changes, removed, send };
	};
	const HERE = { owner: true, local: true };

	test("is handed over by this computer's app, kept until it lapses, and listed as a date, never as the token", async () => {
		const { list, mac, changes, send } = withSignIns();
		expect(list.listed()).toEqual([{ ...list.saved()[0], signedInUntil: null }]);
		const res = await send("POST", mac.id.toUpperCase(), { jwt: JWT }, HERE);
		expect(res.status).toBe(200);
		const until = new Date(exp * 1000).toISOString();
		expect(await res.json()).toEqual({ signedInUntil: until });
		expect(list.listed()[0]?.signedInUntil).toBe(until);
		expect(JSON.stringify(list.listed())).not.toContain(JWT);
		expect(readFileSync(list.file, "utf8")).not.toContain(JWT);
		// Every page is told, and reads the list again.
		expect(changes.length).toBe(1);
		const gone = await send("DELETE", mac.id, undefined, HERE);
		expect(gone.status).toBe(204);
		expect(list.listed()[0]?.signedInUntil).toBeNull();
		expect(changes.length).toBe(2);
	});

	test("is refused to every request that is not this computer's own, a page signed in through Access included", async () => {
		const { list, mac, send } = withSignIns();
		// Signed in through Access: the person's own page, but not this computer's app.
		const access = await send("POST", mac.id, { jwt: JWT }, { owner: true, local: false });
		expect(access.status).toBe(403);
		const token = await send("POST", mac.id, { jwt: JWT }, { owner: false, local: false });
		expect(token.status).toBe(403);
		expect((await send("DELETE", mac.id, undefined, { owner: true, local: false })).status).toBe(403);
		expect(list.listed()[0]?.signedInUntil).toBeNull();
	});

	test("a token that is not one, or has lapsed, is refused with 400 and nothing is kept", async () => {
		const { list, mac, changes, send } = withSignIns();
		for (const jwt of ["garbage-value", `${b64url({})}.${b64url({ exp: exp - 7200 })}.c2ln`, 42]) {
			const res = await send("POST", mac.id, { jwt }, HERE);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).not.toContain(String(jwt));
		}
		expect((await send("POST", mac.id, "nope", HERE)).status).toBe(400);
		expect(list.listed()[0]?.signedInUntil).toBeNull();
		expect(changes).toEqual([]);
	});

	test("an id not on the list is 404, a method it does not take 405", async () => {
		const { send, mac } = withSignIns();
		expect((await send("POST", "0f8fad5b-d9cb-469f-a165-70867728950e", { jwt: JWT }, HERE)).status).toBe(404);
		expect((await send("PUT", mac.id, { jwt: JWT }, HERE)).status).toBe(405);
	});

	test("a Mac taken out of the list takes its sign-in with it, and says so", async () => {
		const { list, signIns, mac, removed, send } = withSignIns();
		await send("POST", mac.id, { jwt: JWT }, HERE);
		list.remove(mac.id);
		expect(signIns.get(mac.id)).toBeNull();
		expect(removed).toEqual([mac.id]);
	});
});
