import { describe, expect, test } from "bun:test";
import {
	type AddressProblem,
	checkNewMac,
	describeMacProblem,
	foldMacName,
	isMacId,
	isTeamName,
	MAC_LIMIT,
	MAC_NAME_LIMIT,
	type MacProblem,
	macUrl,
	type NameProblem,
	parseMacAddress,
	parseMacName,
} from "../../shared/macs.ts";
import { en } from "../../web/src/i18n/macs.ts";
import { zh } from "../../web/src/i18n/zh-CN/macs.ts";
import { macProblemWords } from "../../web/src/lib/macs.ts";
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
 * The rules of the list of Macs (#628) in `shared/macs.ts`: the server checks what a page sends, the page checks what is typed
 * before it asks, and the macOS app's sheet checks it a third time in Swift. The three hold to one table of cases
 * (`tests/support/mac-vectors.ts`: the Swift side runs it in `macos-remote.test.ts`), named the Swift way; this maps those
 * names to the codes of the TypeScript ones.
 */

const ADDRESS_CODES: Record<string, AddressProblem> = {
	empty: "empty",
	notHTTPS: "not-https",
	userInfo: "user-info",
	port: "port",
	path: "path",
	ipAddress: "ip-address",
	trailingDot: "trailing-dot",
	notASCII: "not-ascii",
	localName: "local-name",
	accessDomain: "access-domain",
	notDomainName: "not-domain-name",
};

const NAME_CODES: Record<string, NameProblem> = { empty: "empty", tooLong: "too-long", characters: "characters" };

describe("an address", () => {
	test("every spelling of the same Mac is the same host", () => {
		for (const input of ADDRESS_SAME)
			expect(parseMacAddress(input), JSON.stringify(input)).toEqual({ ok: true, host: "omp.example.com" });
	});

	test("the other addresses that are accepted give the host they are", () => {
		for (const [input, host] of Object.entries(ADDRESS_OK))
			expect(parseMacAddress(input), input).toEqual({ ok: true, host });
	});

	test("each refused address is refused for the reason the table gives, in the TypeScript codes", () => {
		for (const [input, swift] of Object.entries(ADDRESS_REFUSED)) {
			const name = swift.split(":")[0] as string;
			const code = ADDRESS_CODES[name];
			expect(code, `the table names ${name}, which this test does not know`).toBeDefined();
			expect(parseMacAddress(input), JSON.stringify(input)).toEqual({ ok: false, problem: code as AddressProblem });
		}
	});

	test("every code of the table is one a refusal can have, and every code a refusal can have is in the table", () => {
		const seen = new Set(Object.values(ADDRESS_REFUSED).map((swift) => ADDRESS_CODES[swift.split(":")[0] as string]));
		expect([...seen].sort()).toEqual(Object.values(ADDRESS_CODES).sort());
	});
});

describe("a name", () => {
	test("is kept trimmed, and counted in characters, not in bytes", () => {
		for (const [input, name] of Object.entries(NAME_OK))
			expect(parseMacName(input), JSON.stringify(input)).toEqual({ ok: true, name });
		expect(MAC_NAME_LIMIT).toBe(60);
	});

	test("is refused for the reason the table gives", () => {
		for (const [input, swift] of Object.entries(NAME_REFUSED)) {
			expect(parseMacName(input), JSON.stringify(input)).toEqual({
				ok: false,
				problem: NAME_CODES[swift] as NameProblem,
			});
		}
	});

	test("two names that fold to one are one name, on every case the app's Swift fold is held to as well", () => {
		for (const [a, b] of NAME_SAME)
			expect(foldMacName(a), `${JSON.stringify(a)} and ${JSON.stringify(b)}`).toBe(foldMacName(b));
		for (const [a, b] of NAME_DIFFERENT)
			expect(foldMacName(a), `${JSON.stringify(a)} and ${JSON.stringify(b)}`).not.toBe(foldMacName(b));
	});

	test("the list refuses the second of two names that fold to one, whichever way it is spelled", () => {
		for (const [a, b] of NAME_SAME) {
			expect(
				checkNewMac([{ name: a, host: "a.example.com" }], { name: b, address: "b.example.com" }),
				`${a} / ${b}`,
			).toEqual({
				ok: false,
				problem: { kind: "name", code: "taken", taken: a },
			});
		}
	});
});

describe("a change of the list", () => {
	const mac = (name: string, host: string) => ({ name, host });

	test("is checked in the order a person fixes it in: room, name, address, a saved address", () => {
		const full = Array.from({ length: MAC_LIMIT }, (_, i) => mac(`Mac ${i}`, `m${i}.example.com`));
		expect(checkNewMac(full, { name: "", address: "x" })).toEqual({ ok: false, problem: { kind: "full" } });
		const some = [mac("Studio", "studio.example.com")];
		expect(checkNewMac(some, { name: "", address: "localhost" })).toEqual({
			ok: false,
			problem: { kind: "name", code: "empty" },
		});
		expect(checkNewMac(some, { name: "studio", address: "localhost" })).toEqual({
			ok: false,
			problem: { kind: "name", code: "taken", taken: "Studio" },
		});
		expect(checkNewMac(some, { name: "Laptop", address: "localhost" })).toEqual({
			ok: false,
			problem: { kind: "address", code: "local-name" },
		});
		expect(checkNewMac(some, { name: "Laptop", address: "https://Studio.Example.com/" })).toEqual({
			ok: false,
			problem: { kind: "host-taken", name: "Studio" },
		});
		expect(checkNewMac(some, { name: " Laptop ", address: "Laptop.Example.com" })).toEqual({
			ok: true,
			name: "Laptop",
			host: "laptop.example.com",
		});
	});

	test("a team name is what the server's own setting takes, and an id is a UUID in either case", () => {
		expect(isTeamName("my-team")).toBe(true);
		for (const bad of ["", "My Team", "a.b", "x".repeat(64), "Team"]) expect(isTeamName(bad), bad).toBe(false);
		expect(isMacId("11111111-1111-4111-8111-111111111111")).toBe(true);
		expect(isMacId("ABCDEF01-1111-4111-8111-111111111111")).toBe(true);
		expect(isMacId("not-a-uuid")).toBe(false);
		expect(macUrl("omp.example.com")).toBe("https://omp.example.com/");
	});
});

describe("the words of a problem", () => {
	const problems: MacProblem[] = [
		{ kind: "full" },
		{ kind: "host-taken", name: "Studio" },
		{ kind: "name", code: "empty" },
		{ kind: "name", code: "too-long" },
		{ kind: "name", code: "characters" },
		{ kind: "name", code: "taken", taken: "Studio" },
		...Object.values(ADDRESS_CODES).map((code): MacProblem => ({ kind: "address", code })),
	];

	test("the page has words in each language for every problem, with its numbers and names filled in", () => {
		const limits = { macs: MAC_LIMIT, name: MAC_NAME_LIMIT };
		for (const problem of problems) {
			const words = macProblemWords(problem, limits);
			const key = words.key.replace(/^macs\./, "") as keyof typeof en;
			for (const [lang, table] of [
				["en", en],
				["zh-CN", zh],
			] as const) {
				const text = table[key];
				expect(text, `${lang}: ${JSON.stringify(problem)} has no words under ${words.key}`).toBeString();
				const filled = Object.entries(words.vars ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);
				expect(filled, `${lang}: ${words.key} has a placeholder the problem does not fill`).not.toMatch(/\{\w+\}/);
			}
		}
	});

	test("the server's English and the page's English say the same, so the one that has no words of its own is not a stranger", () => {
		const limits = { macs: MAC_LIMIT, name: MAC_NAME_LIMIT };
		for (const problem of problems) {
			const words = macProblemWords(problem, limits);
			const key = words.key.replace(/^macs\./, "") as keyof typeof en;
			const filled = Object.entries(words.vars ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]);
			expect(filled, JSON.stringify(problem)).toBe(describeMacProblem(problem));
		}
	});
});
