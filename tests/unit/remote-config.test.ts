import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteStore, remoteConfigPath } from "../../server/remote-config.ts";
import {
	DEFAULT_REMOTE_CONFIG,
	isRemoteOn,
	missingRemoteSettings,
	parseRemoteConfig,
	parseRemoteConfigPatch,
	RemoteConfigError,
} from "../../shared/remote.ts";

/**
 * The remote access settings: what a page may change, what the file may hold, and that neither can put a value in
 * front of the tunnel (a command line, a configuration file) or the allow-list that is not what it looks like.
 */

const AUD = "a".repeat(64);
const TUNNEL = "6b1f3d5e-1c2a-4e8b-9d3f-0a1b2c3d4e5f";

let dir: string;
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-remote-config-"));
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warned.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

test("a change is normalized: names in lower case, emails once each, blanks dropped", () => {
	expect(
		parseRemoteConfigPatch({
			hostname: "  Omp.Example.COM ",
			team: " My-Team ",
			aud: AUD.toUpperCase(),
			emails: ["Me@Example.COM", " me@example.com ", "", "you@example.com"],
		}),
	).toEqual({
		hostname: "omp.example.com",
		team: "my-team",
		aud: AUD,
		emails: ["me@example.com", "you@example.com"],
	});
});

test("confirming risky commands is off until it is turned on, and a file from before it has no such key", () => {
	expect(DEFAULT_REMOTE_CONFIG.confirmRisky).toBe(false);
	expect(parseRemoteConfigPatch({ confirmRisky: true })).toEqual({ confirmRisky: true });
	expect(parseRemoteConfigPatch({ confirmRisky: false })).toEqual({ confirmRisky: false });
	for (const bad of ["true", 1, null, undefined])
		expect(() => parseRemoteConfigPatch({ confirmRisky: bad }), String(bad)).toThrow(RemoteConfigError);
	// An old remote.json parses, with the switch off; writing it back keeps what it said and adds the key.
	const file = join(dir, "remote.json");
	writeFileSync(file, JSON.stringify({ team: "old", hostname: "omp.example.com", autostart: true }));
	const store = new RemoteStore(file);
	expect(store.read()).toEqual({ ...DEFAULT_REMOTE_CONFIG, team: "old", hostname: "omp.example.com", autostart: true });
	expect(store.read().confirmRisky).toBe(false);
	store.patch({ confirmRisky: true });
	expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ team: "old", autostart: true, confirmRisky: true });
	expect(existsSync(`${file}.damaged`)).toBe(false);
	// A file that holds the key wrongly is not trusted.
	writeFileSync(file, JSON.stringify({ confirmRisky: "yes" }));
	expect(new RemoteStore(file).read()).toEqual(DEFAULT_REMOTE_CONFIG);
});
test("file transfer is on in both directions until it is turned down; a bad value is refused, and a file that holds one wrongly is not trusted", () => {
	expect(DEFAULT_REMOTE_CONFIG.fileTransfer).toBe("full");
	for (const value of ["off", "download", "full"] as const)
		expect(parseRemoteConfigPatch({ fileTransfer: value })).toEqual({ fileTransfer: value });
	for (const bad of ["Full", "upload", "", true, 1, null, undefined])
		expect(() => parseRemoteConfigPatch({ fileTransfer: bad }), String(bad)).toThrow(RemoteConfigError);
	// A remote.json from before the setting has no such key: it parses as the default, and writing it back adds the key.
	const file = join(dir, "remote.json");
	writeFileSync(file, JSON.stringify({ team: "old", hostname: "omp.example.com" }));
	const store = new RemoteStore(file);
	expect(store.read().fileTransfer).toBe("full");
	store.patch({ fileTransfer: "download" });
	expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ team: "old", fileTransfer: "download" });
	expect(new RemoteStore(file).read().fileTransfer).toBe("download");
	expect(parseRemoteConfig({ fileTransfer: "off" }).fileTransfer).toBe("off");
	// Not trusted: all of the file is set aside, as for any other key held wrongly.
	writeFileSync(file, JSON.stringify({ fileTransfer: "sometimes" }));
	expect(new RemoteStore(file).read()).toEqual(DEFAULT_REMOTE_CONFIG);
});

test("a change names only what it changes, and a page cannot name the tunnel", () => {
	expect(parseRemoteConfigPatch({ autostart: true })).toEqual({ autostart: true });
	expect(parseRemoteConfigPatch({ tunnelId: "--config=/etc/passwd", tunnelName: "x", unknown: 1 })).toEqual({});
});

test("a hostname that is not a name under a zone is refused", () => {
	for (const bad of [
		"localhost",
		"1.2.3.4",
		"a_b.example.com",
		"-a.example.com",
		"a..example.com",
		"a.example.com.",
		`${"x".repeat(64)}.com`,
		"https://a.example.com",
		"a.example.com/x",
		"a b.example.com",
		"omp.example.com:7878",
	])
		expect(() => parseRemoteConfigPatch({ hostname: bad }), bad).toThrow(RemoteConfigError);
	expect(parseRemoteConfigPatch({ hostname: "" })).toEqual({ hostname: "" });
});

test("a team, an AUD and emails that are not what Cloudflare and mail use are refused", () => {
	for (const team of ["yi chen", "a/b", "a.b", "é", "-".repeat(64)])
		expect(() => parseRemoteConfigPatch({ team }), team).toThrow(RemoteConfigError);
	for (const aud of ["abc", "g".repeat(64), "a".repeat(65), 12])
		expect(() => parseRemoteConfigPatch({ aud }), String(aud)).toThrow(RemoteConfigError);
	for (const email of ["me", "me@", "@example.com", "me@example", "a b@example.com", "me@@example.com", 5])
		expect(() => parseRemoteConfigPatch({ emails: [email] }), String(email)).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch({ emails: "me@example.com" })).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch({ enabled: "yes" })).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch(null)).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch([])).toThrow(RemoteConfigError);
});

test("an address is lower-cased as ASCII only: a character that Unicode folds onto another is refused, not folded", () => {
	// The Kelvin sign lower-cases to `k` and the dotted capital I to `i̇`: neither may become an address that looks like another.
	expect(() => parseRemoteConfigPatch({ emails: ["\u212A@example.com"] })).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch({ emails: ["\u0130@example.com"] })).toThrow(RemoteConfigError);
	expect(() => parseRemoteConfigPatch({ hostname: "omp.\u212A.com" })).toThrow(RemoteConfigError);
});

test("remote access is on only when it is enabled and everything the tunnel needs is set", () => {
	const full = {
		...DEFAULT_REMOTE_CONFIG,
		enabled: true,
		hostname: "omp.example.com",
		team: "t",
		aud: AUD,
		emails: ["a@b.co"],
	};
	expect(isRemoteOn(full)).toBe(true);
	expect(isRemoteOn({ ...full, enabled: false })).toBe(false);
	expect(missingRemoteSettings({ ...full, team: "", emails: [] })).toEqual(["team", "emails"]);
	for (const field of ["hostname", "team", "aud"] as const)
		expect(isRemoteOn({ ...full, [field]: "" }), field).toBe(false);
	expect(isRemoteOn({ ...full, emails: [] })).toBe(false);
	expect(isRemoteOn(DEFAULT_REMOTE_CONFIG)).toBe(false);
});

test("the file's tunnel id must be a tunnel id: it ends up in a command line and a configuration file", () => {
	expect(parseRemoteConfig({ tunnelId: TUNNEL, tunnelName: "omp-webui" }).tunnelId).toBe(TUNNEL);
	for (const tunnelId of ["--config=/x", "../../x", `${TUNNEL}\ningress: []`, 5])
		expect(() => parseRemoteConfig({ tunnelId }), String(tunnelId)).toThrow(RemoteConfigError);
	for (const tunnelName of ["-rf", "a b", "x".repeat(64), ""])
		expect(() => parseRemoteConfig({ tunnelName }), tunnelName).toThrow(RemoteConfigError);
});

test("a fresh install has remote access off", () => {
	const config = new RemoteStore(join(dir, "remote.json")).read();
	expect(config).toEqual(DEFAULT_REMOTE_CONFIG);
	expect(config.enabled).toBe(false);
});

test("a change is kept for the next start, in a file only its owner reads, with nothing left beside it", () => {
	const file = join(dir, "data", "remote.json");
	const store = new RemoteStore(file);
	store.patch({ hostname: "omp.example.com", emails: ["a@b.co"] });
	store.patch({ team: "t" });
	const again = new RemoteStore(file).read();
	expect(again).toEqual({ ...DEFAULT_REMOTE_CONFIG, hostname: "omp.example.com", emails: ["a@b.co"], team: "t" });
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(dir, "data"))).toEqual(["remote.json"]);
});

test("a file edited under a running server is read again, not remembered", () => {
	const file = join(dir, "remote.json");
	const store = new RemoteStore(file);
	store.patch({ team: "one" });
	writeFileSync(file, JSON.stringify({ team: "two" }));
	expect(store.read().team).toBe("two");
});

test("a remote.json from before 'ask for every tool while remote' went away still loads, and the key is dropped at the next write", () => {
	const file = join(dir, "remote.json");
	writeFileSync(file, JSON.stringify({ team: "old", hostname: "omp.example.com", askWhileRemote: true }));
	const store = new RemoteStore(file);
	expect(store.read()).toEqual({ ...DEFAULT_REMOTE_CONFIG, team: "old", hostname: "omp.example.com" });
	expect("askWhileRemote" in store.read()).toBe(false);
	store.patch({ autostart: true });
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
		...DEFAULT_REMOTE_CONFIG,
		team: "old",
		hostname: "omp.example.com",
		autostart: true,
	});
	expect(existsSync(`${file}.damaged`)).toBe(false);
	// A page that still sends the key (an old tab) changes nothing and is not refused.
	expect(parseRemoteConfigPatch({ askWhileRemote: false })).toEqual({});
});

test("a file that cannot be trusted leaves remote access off, and the next change keeps a copy of it", () => {
	const file = join(dir, "remote.json");
	for (const damaged of [
		"{",
		"[]",
		JSON.stringify({ enabled: true, aud: "short", team: "t" }),
		JSON.stringify({ tunnelId: "--x" }),
	]) {
		rmSync(`${file}.damaged`, { force: true });
		writeFileSync(file, damaged);
		const store = new RemoteStore(file);
		expect(isRemoteOn(store.read()), damaged).toBe(false);
		expect(store.read()).toEqual(DEFAULT_REMOTE_CONFIG);
		store.patch({ team: "t" });
		expect(readFileSync(`${file}.damaged`, "utf8"), damaged).toBe(damaged);
		expect(new RemoteStore(file).read().team).toBe("t");
	}
});

test("a change that would make the file untrustworthy is refused before anything is written", () => {
	const file = join(dir, "remote.json");
	const store = new RemoteStore(file);
	expect(() => store.patch({ tunnelId: "not a tunnel" })).toThrow(RemoteConfigError);
	expect(existsSync(file)).toBe(false);
});

test("the file is <data dir>/remote.json unless OMP_WEBUI_REMOTE_CONFIG names another", () => {
	expect(remoteConfigPath("/data", {})).toBe("/data/remote.json");
	expect(remoteConfigPath("/data", { OMP_WEBUI_REMOTE_CONFIG: "/elsewhere/r.json" })).toBe("/elsewhere/r.json");
	expect(remoteConfigPath("/data", { OMP_WEBUI_REMOTE_CONFIG: "" })).toBe("/data/remote.json");
});
