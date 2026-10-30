import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_CONFIG } from "../../shared/remote.ts";
import {
	parseRemoteAccessFile,
	REMOTE_ACCESS_FILE_MAX_BYTES,
	REMOTE_ACCESS_FILE_MAX_EMAILS,
	remoteAccessFileText,
} from "../../shared/remote-transfer.ts";

/**
 * The file Settings › Remote access exports and imports (#628): the team, the AUD tag and the allowed addresses, so that a
 * second Mac behind the same (wildcard) Access application needs only its own hostname. Nothing that opens the tunnel or
 * this Mac is in it, and nothing but those three settings is read back from a file.
 */

const AUD = "0123456789abcdef".repeat(4);
const good = { team: "my-team", aud: AUD, emails: ["me@example.com", "you@example.com"] };

describe("the file made for these settings", () => {
	test("holds the team, the AUD tag and the addresses, with what says what it is, and nothing else", () => {
		const everything = {
			...DEFAULT_REMOTE_CONFIG,
			...good,
			hostname: "omp.example.com",
			enabled: true,
			autostart: true,
			confirmRisky: true,
			tunnelId: "11111111-2222-3333-4444-555555555555",
			tunnelName: "omp-webui",
		};
		const text = remoteAccessFileText(everything);
		expect(JSON.parse(text)).toEqual({ kind: "omp-webui-remote-access", version: 1, ...good });
		for (const secret of [
			"omp.example.com",
			"11111111-2222",
			'omp-webui"',
			"autostart",
			"confirmRisky",
			"enabled",
			"tunnel",
			"token",
			"credential",
		])
			expect(text, secret).not.toContain(secret);
		expect(text.endsWith("}\n")).toBe(true);
	});

	test("reads back as the same settings", () => {
		expect(parseRemoteAccessFile(remoteAccessFileText(good))).toEqual({ ok: true, settings: good });
	});
});

describe("a file read", () => {
	const file = (over: Record<string, unknown> = {}) =>
		JSON.stringify({ kind: "omp-webui-remote-access", version: 1, ...good, ...over });

	test("is checked the way a change of the settings is: the team, the tag and each address", () => {
		expect(
			parseRemoteAccessFile(
				file({ team: " My-Team ", aud: AUD.toUpperCase(), emails: [" Me@Example.COM ", "me@example.com"] }),
			),
		).toEqual({
			ok: true,
			settings: { team: "my-team", aud: AUD, emails: ["me@example.com"] },
		});
		for (const over of [
			{ team: "no spaces here" },
			{ team: 5 },
			{ aud: "abc" },
			{ aud: `${AUD}0` },
			{ emails: ["nope"] },
			{ emails: "me@example.com" },
			{ emails: [5] },
		]) {
			const result = parseRemoteAccessFile(file(over));
			expect(result.ok, JSON.stringify(over)).toBe(false);
			if (!result.ok) expect(result.problem, JSON.stringify(over)).toBe("invalid");
		}
	});

	test("hands on the three settings and nothing else, whatever else the file says", () => {
		const result = parseRemoteAccessFile(
			file({
				hostname: "evil.example.com",
				enabled: true,
				autostart: true,
				confirmRisky: false,
				tunnelId: "11111111-2222-3333-4444-555555555555",
				tunnelName: "evil",
				__proto__: { enabled: true },
				extra: { deep: 1 },
			}),
		);
		expect(result).toEqual({ ok: true, settings: good });
		if (result.ok) expect(Object.keys(result.settings).sort()).toEqual(["aud", "emails", "team"]);
	});

	test("takes a file with only some of them (the rest stay as they are), and refuses one with none", () => {
		expect(
			parseRemoteAccessFile(JSON.stringify({ kind: "omp-webui-remote-access", version: 1, team: "my-team" })),
		).toEqual({
			ok: true,
			settings: { team: "my-team", aud: "", emails: [] },
		});
		for (const over of [{ team: "", aud: "", emails: [] }]) {
			const result = parseRemoteAccessFile(file(over));
			expect(result).toEqual({ ok: false, problem: "empty" });
		}
	});

	test("is refused when it is not this file: not JSON, another kind, another version, too big, too many addresses", () => {
		expect(parseRemoteAccessFile("")).toEqual({ ok: false, problem: "not-json" });
		expect(parseRemoteAccessFile("{")).toEqual({ ok: false, problem: "not-json" });
		for (const text of ["[]", "null", "5", '"x"', file({ kind: "something-else" }), JSON.stringify(good)])
			expect(parseRemoteAccessFile(text), text).toEqual({ ok: false, problem: "not-ours" });
		expect(parseRemoteAccessFile(file({ version: 2 }))).toEqual({ ok: false, problem: "version" });
		expect(parseRemoteAccessFile(file({ team: "a".repeat(REMOTE_ACCESS_FILE_MAX_BYTES) }))).toEqual({
			ok: false,
			problem: "too-large",
		});
		const emails = Array.from({ length: REMOTE_ACCESS_FILE_MAX_EMAILS + 1 }, (_, i) => `u${i}@example.com`);
		expect(parseRemoteAccessFile(file({ emails }))).toEqual({ ok: false, problem: "too-many" });
	});
});
