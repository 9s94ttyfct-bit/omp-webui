import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrefsError, UiPrefs } from "../../server/prefs.ts";
import {
	DEVICE_PREF_KEYS,
	MAX_PREF_LENGTH,
	PREF,
	PREF_KEYS,
	PREFS_ELEMENT_ID,
	PREFS_SYNC_KEY,
	type PrefKey,
	type PrefsSnapshot,
	pageSnapshot,
	parseSyncMarker,
	reconcile,
	type StoreSnapshot,
	syncMarker,
} from "../../shared/prefs.ts";
import { runPrepaint } from "../support/prepaint.ts";

/**
 * Preferences that follow the person across ports: the server's store, the rule that brings an origin's localStorage and
 * the store together, and the script in index.html that applies the store before first paint (it cannot import that
 * rule, so a table of cases holds the two to the same answers).
 */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-prefs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the server's store", () => {
	test("keeps what it is given across a restart, with the same identity", () => {
		const first = new UiPrefs(dir);
		const before = first.snapshot();
		expect(before.rev).toBe(0);
		expect(Object.values(before.values).every((v) => v === null)).toBe(true);
		first.apply({ [PREF.theme]: "light", [PREF.sidebarWidth]: "412" });

		const second = new UiPrefs(dir).snapshot();
		expect(second.id).toBe(before.id);
		expect(second.rev).toBe(1);
		expect(second.values[PREF.theme]).toBe("light");
		expect(second.values[PREF.sidebarWidth]).toBe("412");
		expect(second.values[PREF.palette]).toBeNull();
	});

	test("null forgets a key; a change that alters nothing leaves the revision alone", () => {
		const prefs = new UiPrefs(dir);
		expect(prefs.apply({ [PREF.palette]: "terminal" }).rev).toBe(1);
		expect(prefs.apply({ [PREF.palette]: "terminal" }).rev).toBe(1);
		expect(prefs.apply({ [PREF.lang]: null }).rev).toBe(1);
		const after = prefs.apply({ [PREF.palette]: null });
		expect(after.rev).toBe(2);
		expect(after.values[PREF.palette]).toBeNull();
		expect(new UiPrefs(dir).snapshot()).toEqual(after);
	});

	test("refuses a value the app never writes for its key, and takes the ones it does", () => {
		const prefs = new UiPrefs(dir);
		const good = prefs.apply({ [PREF.theme]: "light" });
		const bad: Record<string, string>[] = [
			{ [PREF.theme]: "blue" },
			{ [PREF.theme]: "" },
			{ [PREF.palette]: "neon" },
			{ [PREF.lang]: "fr" },
			{ [PREF.sidebarWidth]: "wide" },
			{ [PREF.panelWidth]: "-4" },
			{ [PREF.panelWidth]: "0" },
			{ [PREF.panelWidth]: "400.5" },
			{ [PREF.panelPanes]: "wide" },
			{ [PREF.panelPanes]: '{"top":"info","bottom":"info"}' },
			{ [PREF.panelPanes]: '{"top":"info","bottom":"jobs","split":2}' },
			{ [PREF.sidebarWidth]: "123456" },
			{ [PREF.notify]: "yes" },
			{ [PREF.appUpdateCheck]: "sometimes" },
			{ [PREF.quitAction]: "sometimes" },
			{ [PREF.quitAction]: "" },
			{ [PREF.quitAction]: "Quit" },
			{ [PREF.toolTimer]: "sometimes" },
			{ [PREF.toolTimer]: "" },
			{ [PREF.toolTimer]: "ALL" },
			{ [PREF.compactWhere]: "now" },
			{ [PREF.compactWhere]: "" },
			{ [PREF.compactWhere]: "Step" },
			{ [PREF.usageDays]: "{}" },
			{ [PREF.star]: "[1]" },
			{ [PREF.dismissed]: "not json" },
			{ [PREF.animations]: "yes" },
			{ [PREF.animations]: "" },
			{ [PREF.animationIntensity]: "wild" },
			{ [PREF.animationIntensity]: "Normal" },
		];
		for (const changes of bad) expect(() => prefs.apply(changes), JSON.stringify(changes)).toThrow(PrefsError);
		expect(prefs.snapshot()).toEqual(good);
		const fine = prefs.apply({
			[PREF.theme]: "system",
			[PREF.palette]: "hermes",
			[PREF.lang]: "zh-CN",
			[PREF.sidebarWidth]: "412",
			[PREF.panelPanes]: '{"top":"info","bottom":"jobs","collapsed":"bottom","split":0.4}',
			[PREF.keepThinking]: "off",
			[PREF.appUpdateCheck]: "off",
			[PREF.quitAction]: "background",
			[PREF.toolTimer]: "shell",
			[PREF.compactWhere]: "step",
			[PREF.usageDays]: '["2026-10-18"]',
			[PREF.star]: '{"never":true}',
			[PREF.dismissed]: "{}",
			[PREF.animations]: "on",
			[PREF.animationIntensity]: "lively",
			[PREF.cwd]: "anything at all",
		});
		expect(fine.values[PREF.theme]).toBe("system");
		expect(fine.values[PREF.cwd]).toBe("anything at all");
	});

	test("refuses a bad change whole: nothing of it is applied", () => {
		const prefs = new UiPrefs(dir);
		const good = prefs.apply({ [PREF.theme]: "dark" });
		const bad: unknown[] = [
			{ [PREF.theme]: "light", "ompw.nope": "x" },
			{ [PREF.theme]: "light", [PREF.cwd]: 3 },
			{ [PREF.theme]: "light", [PREF.cwd]: "x".repeat(MAX_PREF_LENGTH + 1) },
			{ "ompw.chunkReloadAt": "1" },
			{ [PREFS_SYNC_KEY]: "a:1" },
			null,
			"theme",
			["a"],
		];
		for (const changes of bad) expect(() => prefs.apply(changes), JSON.stringify(changes)).toThrow(PrefsError);
		expect(prefs.snapshot()).toEqual(good);
	});

	test("a store that cannot be read, or holds junk, starts over under a new identity", () => {
		const id = new UiPrefs(dir).snapshot().id;
		for (const junk of ["", "{", "[]", "null", '{"id":"","rev":0,"values":{}}', '{"id":"x","rev":-1,"values":{}}']) {
			writeFileSync(join(dir, "ui-prefs.json"), junk);
			const s = new UiPrefs(dir).snapshot();
			expect(s.id, junk).not.toBe(id);
			expect(s.rev).toBe(0);
		}
	});

	test("what it loads is checked: unknown keys, non-strings and oversized values are dropped", () => {
		writeFileSync(
			join(dir, "ui-prefs.json"),
			JSON.stringify({
				id: "x",
				rev: 4,
				values: {
					[PREF.theme]: "light",
					[PREF.cwd]: 5,
					"ompw.nope": "y",
					[PREF.star]: "z".repeat(MAX_PREF_LENGTH + 1),
				},
			}),
		);
		const s = new UiPrefs(dir).snapshot();
		expect(s.rev).toBe(4);
		expect(s.values[PREF.theme]).toBe("light");
		expect(s.values[PREF.cwd]).toBeNull();
		expect(s.values[PREF.star]).toBeNull();
		expect(Object.keys(s.values).sort()).toEqual([...PREF_KEYS].sort());
	});

	test("a store from before the check is cleaned as it is read: a theme nobody offers does not show", () => {
		writeFileSync(
			join(dir, "ui-prefs.json"),
			JSON.stringify({
				id: "x",
				rev: 2,
				values: {
					[PREF.theme]: "blue",
					[PREF.palette]: "omp",
					[PREF.lang]: "klingon",
					[PREF.sidebarWidth]: "12px",
					[PREF.panelWidth]: "500",
				},
			}),
		);
		const prefs = new UiPrefs(dir);
		const s = prefs.snapshot();
		expect(s.rev).toBe(2);
		expect([s.values[PREF.theme], s.values[PREF.lang], s.values[PREF.sidebarWidth]]).toEqual([null, null, null]);
		expect([s.values[PREF.palette], s.values[PREF.panelWidth]]).toEqual(["omp", "500"]);
		expect(prefs.inject("<script>", true)).not.toContain("blue");
	});

	test("two servers on one data dir do not overwrite each other: a change is merged into what the file holds, and the revision only goes up", () => {
		const first = new UiPrefs(dir);
		const second = new UiPrefs(dir);
		expect(second.snapshot().id).toBe(first.snapshot().id);

		expect(first.apply({ [PREF.palette]: "terminal" }).rev).toBe(1);
		// `second` loaded before that change and never heard of it, yet it is what it reports now.
		expect(second.snapshot().values[PREF.palette]).toBe("terminal");
		const merged = second.apply({ [PREF.theme]: "light" });
		expect(merged.rev).toBe(2);
		expect(merged.values[PREF.palette]).toBe("terminal");
		expect(merged.values[PREF.theme]).toBe("light");

		// ...and the first, which wrote last but one, keeps both and goes on from 2.
		const next = first.apply({ [PREF.lang]: "zh-CN" });
		expect(next.rev).toBe(3);
		expect([next.values[PREF.palette], next.values[PREF.theme], next.values[PREF.lang]]).toEqual([
			"terminal",
			"light",
			"zh-CN",
		]);
		expect(second.snapshot()).toEqual(next);
		expect(new UiPrefs(dir).snapshot()).toEqual(next);
	});

	test("a change made through a stale instance that alters nothing once merged leaves the revision alone", () => {
		const first = new UiPrefs(dir);
		const second = new UiPrefs(dir);
		first.apply({ [PREF.palette]: "terminal" });
		expect(second.apply({ [PREF.palette]: "terminal" }).rev).toBe(1);
	});

	test("a data dir whose store was replaced is followed: the new identity, wholesale", () => {
		const first = new UiPrefs(dir);
		first.apply({ [PREF.palette]: "terminal" });
		writeFileSync(
			join(dir, "ui-prefs.json"),
			JSON.stringify({ id: "other", rev: 0, values: { [PREF.theme]: "light" } }),
		);
		const s = first.snapshot();
		expect([s.id, s.rev, s.values[PREF.theme], s.values[PREF.palette]]).toEqual(["other", 0, "light", null]);
	});

	test("is written whole: no half file is left beside it", () => {
		const prefs = new UiPrefs(dir);
		prefs.apply({ [PREF.theme]: "dark" });
		expect(JSON.parse(readFileSync(join(dir, "ui-prefs.json"), "utf8")).values[PREF.theme]).toBe("dark");
		expect(readdirSync(dir)).toEqual(["ui-prefs.json"]);
	});

	test("goes into the page ahead of its first script, and no value can break out of it", () => {
		const prefs = new UiPrefs(dir);
		const hostile = `</script><script>alert(1)</script><!-- $& $1 "quotes" \u2028`;
		prefs.apply({ [PREF.cwd]: hostile });
		const html = prefs.inject(
			"<html><head><script>prepaint()</script></head><body><script src=a.js></script></body></html>",
			true,
		);
		const open = `<script type="application/json" id="${PREFS_ELEMENT_ID}">`;
		expect(html.indexOf(open)).toBeGreaterThan(0);
		expect(html.indexOf(open)).toBeLessThan(html.indexOf("prepaint()"));
		// Exactly one data block and the page's own two scripts: the value opened no element.
		expect(html.match(/<script/g)).toHaveLength(3);
		expect(html.match(/<\/script>/g)).toHaveLength(3);
		const text = html.slice(html.indexOf(open) + open.length, html.indexOf("</script>", html.indexOf(open)));
		expect(JSON.parse(text)).toEqual(prefs.snapshot());
		expect((JSON.parse(text) as PrefsSnapshot).values[PREF.cwd]).toBe(hostile);
	});

	test("a page with no script is left as it is", () => {
		expect(new UiPrefs(dir).inject("<html><body>hi</body></html>", true)).toBe("<html><body>hi</body></html>");
	});

	test("a page that is not on this computer is given no device keys, in the page as anywhere else", () => {
		const prefs = new UiPrefs(dir);
		const full = prefs.apply({ [PREF.theme]: "light", [PREF.lang]: "zh-CN", [PREF.autoTitle]: "off" });
		const away = pageSnapshot(full, false);
		expect([away.id, away.rev]).toEqual([full.id, full.rev]);
		expect(Object.keys(away.values).sort()).toEqual(PREF_KEYS.filter((k) => !DEVICE_PREF_KEYS.includes(k)).sort());
		expect(away.values[PREF.autoTitle]).toBe("off");
		expect(pageSnapshot(full, true)).toEqual(full);

		const open = `<script type="application/json" id="${PREFS_ELEMENT_ID}">`;
		const carried = (html: string) =>
			JSON.parse(html.slice(html.indexOf(open) + open.length, html.indexOf("</script>", html.indexOf(open))));
		expect(carried(prefs.inject("<script>", false))).toEqual(away);
		expect(carried(prefs.inject("<script>", true))).toEqual(full);
	});

	test("with the look and layout following the person (ompw.devicePrefs off) every page is given every key", () => {
		const prefs = new UiPrefs(dir);
		const full = prefs.apply({ [PREF.theme]: "light", [PREF.devicePrefs]: "off" });
		expect(pageSnapshot(full, false)).toEqual(full);
		// Back on: the device keys stop reaching a page elsewhere again.
		const again = prefs.apply({ [PREF.devicePrefs]: "on" });
		expect(pageSnapshot(again, false).values[PREF.theme]).toBeUndefined();
	});
});

// ------------------------------------------------------------------ reconcile and index.html

const snap = (values: Partial<Record<PrefKey, string>>, rev = 5): StoreSnapshot => ({
	id: "store-1",
	rev,
	values: Object.fromEntries(PREF_KEYS.map((k) => [k, values[k] ?? null])) as StoreSnapshot["values"],
});
const local = (values: Partial<Record<PrefKey, string>>) =>
	Object.fromEntries(PREF_KEYS.map((k) => [k, values[k] ?? null])) as Record<PrefKey, string | null>;

describe("an origin's copy and the server's store", () => {
	test("an origin that never met this store takes what it lacks and keeps (and sends) what it has", () => {
		const r = reconcile(
			snap({ [PREF.theme]: "light", [PREF.palette]: "omp" }),
			null,
			local({ [PREF.palette]: "terminal", [PREF.cwd]: "/work" }),
		);
		expect(r.adopt).toEqual({ [PREF.theme]: "light" });
		expect(r.upload).toEqual({ [PREF.palette]: "terminal", [PREF.cwd]: "/work" });
	});

	test("an origin of another store counts as one that never met this one", () => {
		const r = reconcile(snap({ [PREF.theme]: "light" }), "store-0:9", local({ [PREF.theme]: "dark" }));
		expect(r).toEqual({ adopt: {}, upload: { [PREF.theme]: "dark" } });
	});

	test("an origin older than the store takes its values, and forgets what it lacks", () => {
		const r = reconcile(
			snap({ [PREF.theme]: "light" }),
			syncMarker({ id: "store-1", rev: 4 }),
			local({ [PREF.theme]: "dark", [PREF.sidebarWidth]: "300" }),
		);
		expect(r).toEqual({ adopt: { [PREF.theme]: "light", [PREF.sidebarWidth]: null }, upload: {} });
	});

	test("a current origin sends its own edits, deletions included; one ahead of the store does the same", () => {
		const edits = local({ [PREF.theme]: "dark", [PREF.cwd]: "/work" });
		const store = snap({ [PREF.theme]: "light", [PREF.palette]: "omp" });
		for (const rev of [5, 9]) {
			const r = reconcile(store, syncMarker({ id: "store-1", rev }), edits);
			expect(r.adopt).toEqual({});
			expect(r.upload).toEqual({ [PREF.theme]: "dark", [PREF.cwd]: "/work", [PREF.palette]: null });
		}
	});

	test("nothing differs: nothing to do", () => {
		const values = { [PREF.theme]: "light" } as const;
		expect(reconcile(snap(values), null, local(values))).toEqual({ adopt: {}, upload: {} });
	});

	test("a page that is not on this computer neither takes nor sends a device key, whatever its marker says", () => {
		const store = snap({
			[PREF.theme]: "dark",
			[PREF.lang]: "en",
			[PREF.sidebarWidth]: "400",
			[PREF.autoTitle]: "off",
		});
		const mine = local({ [PREF.theme]: "light", [PREF.palette]: "hermes", [PREF.cwd]: "/work" });
		const others = (changes: Record<string, string | null>) =>
			Object.fromEntries(Object.entries(changes).filter(([k]) => !DEVICE_PREF_KEYS.includes(k as PrefKey)));
		for (const marker of [null, "other:5", syncMarker({ id: "store-1", rev: 2 }), syncMarker(store)]) {
			const away = reconcile(pageSnapshot(store, false), marker, mine);
			// The other keys are brought together as on this computer.
			const here = reconcile(store, marker, mine);
			expect(away, String(marker)).toEqual({ adopt: others(here.adopt), upload: others(here.upload) });
		}
	});

	test("a marker is read back as written; anything else is no marker", () => {
		expect(parseSyncMarker(syncMarker({ id: "a-b:c", rev: 12 }))).toEqual({ id: "a-b:c", rev: 12 });
		for (const bad of [null, "", "x", ":3", "x:", "x:y", "x:-1", "x:1.5"]) {
			expect(parseSyncMarker(bad)?.id, String(bad)).not.toBe("x");
		}
	});
});

describe("index.html applies the store before first paint", () => {
	// Per key: the server's value and this origin's, one of these pairs each (null: none).
	const PAIRS: [string | null, string | null][] = [
		[null, null],
		[null, "mine"],
		["theirs", null],
		["theirs", "theirs"],
		["theirs", "mine"],
	];
	const MARKERS: [string, string | null][] = [
		["no marker", null],
		["another store", "other:5"],
		["a malformed marker", "store-1:x"],
		["current", "store-1:5"],
		["older", "store-1:2"],
		["ahead", "store-1:9"],
	];

	for (const [name, marker] of MARKERS) {
		for (const onThisComputer of [true, false]) {
			const where = onThisComputer ? "on this computer" : "not on this computer (no device keys in the page)";
			test(`leaves localStorage as \`reconcile\` says to, for an origin with ${name}, ${where}`, () => {
				const values: Partial<Record<PrefKey, string>> = {};
				const mine: Partial<Record<PrefKey, string>> = {};
				PREF_KEYS.forEach((k, i) => {
					const [server, own] = PAIRS[i % PAIRS.length];
					if (server !== null) values[k] = server;
					if (own !== null) mine[k] = own;
				});
				const snapshot = pageSnapshot(snap(values), onThisComputer);
				const stored: Record<string, string> = { ...mine };
				if (marker !== null) stored[PREFS_SYNC_KEY] = marker;

				const expected = new Map(Object.entries(stored));
				for (const [k, v] of Object.entries(reconcile(snapshot, marker, local(mine)).adopt)) {
					if (v === null) expected.delete(k);
					else expected.set(k, v);
				}
				const after = runPrepaint(snapshot, stored).storage;
				expect(after).toEqual(expected);
				if (!onThisComputer) for (const k of DEVICE_PREF_KEYS) expect(after.get(k), k).toBe(stored[k]);
			});
		}
	}

	test("a fresh origin shows the server's theme and palette at once, with nothing but this script run", () => {
		const page = runPrepaint(snap({ [PREF.theme]: "light", [PREF.palette]: "hermes" }), {});
		expect(page.classes.has("dark")).toBe(false);
		expect(page.dataset.palette).toBe("hermes");
		expect(page.storage.get(PREF.lang)).toBeUndefined();
	});

	test("the server's theme follows the OS when it is `system`", () => {
		const snapshot = snap({ [PREF.theme]: "system" });
		expect(runPrepaint(snapshot, {}, true).classes.has("dark")).toBe(true);
		expect(runPrepaint(snapshot, {}, false).classes.has("dark")).toBe(false);
	});

	test("a theme nobody offers paints the default, dark, as the app itself does", () => {
		expect(runPrepaint(null, { [PREF.theme]: "blue" }).classes.has("dark")).toBe(true);
		expect(runPrepaint(snap({ [PREF.theme]: "blue" }), {}).classes.has("dark")).toBe(true);
	});

	test("a page served without a snapshot paints from the origin's own storage, as before", () => {
		const page = runPrepaint(null, { [PREF.theme]: "light", [PREF.palette]: "omp" });
		expect(page.classes.has("dark")).toBe(false);
		expect(page.dataset.palette).toBe("omp");
		const bare = runPrepaint(null, {});
		expect(bare.classes.has("dark")).toBe(true);
		expect(bare.dataset.palette).toBe("claude");
	});

	test("a snapshot that cannot be read does not stop the page from painting", () => {
		const page = runPrepaint("{not json", { [PREF.theme]: "light" });
		expect(page.classes.has("dark")).toBe(false);
	});
});
