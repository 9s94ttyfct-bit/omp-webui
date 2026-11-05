import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	BUNDLE_ID,
	designatedRequirementOf,
	ensureIdentity,
	findIdentity,
	isKeychainLocked,
	keychainPassword,
	parseIdentities,
	passwordFileFor,
	requirementFor,
	signBundle,
} from "../../scripts/signing-identity.ts";
import { capabilities } from "../../server/platform/capabilities.ts";
import { expectMode } from "../support/modes.ts";

/**
 * Why updates lose the macOS permissions (#456): an ad-hoc signature's designated requirement is the build's cdhash, which
 * changes with every build, so TCC takes each update for a new app. A signature made with one certificate and a requirement
 * that names it (and the bundle identifier) has the same requirement in every build. These run the real `security` and
 * `codesign` against a keychain of their own (never the one the app is built with), which only a Mac has.
 */

const mac = capabilities.appUpdate && Bun.which("codesign") !== null && Bun.which("security") !== null;
const dir = mkdtempSync(join(tmpdir(), "ompw-signing-"));
// The module makes this keychain on first use; the other is never made, as on a Mac that has no identity yet.
const keychain = join(dir, "test.keychain-db");
const noKeychain = join(dir, "none.keychain-db");

/** A bundle with a compiled executable whose bytes differ per `salt`, so each one has a cdhash of its own. */
let hello: string;
function bundle(name: string, salt: string): string {
	const app = join(dir, name, "omp-webui.app");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	cpSync(hello, join(app, "Contents", "MacOS", "omp-webui"));
	writeFileSync(join(app, "Contents", "Resources.txt"), salt);
	writeFileSync(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>omp-webui</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${salt}</string>
</dict></plist>
`,
	);
	return app;
}

beforeAll(() => {
	if (!mac) return;
	writeFileSync(join(dir, "hello.c"), "int main(void){return 0;}\n");
	hello = join(dir, "hello");
	const cc = Bun.spawnSync(["cc", "-o", hello, join(dir, "hello.c")], { stderr: "pipe" });
	if (cc.exitCode !== 0) throw new Error(`cc: ${cc.stderr.toString()}`);
});

afterAll(() => {
	if (mac) Bun.spawnSync(["security", "delete-keychain", keychain]);
	rmSync(dir, { recursive: true, force: true });
});

test("the identities of one name are read from `security find-identity`, once each, whatever their trust", () => {
	const sha = "441EEF68726ACE2993CD986CDA7B75C18A1C0E9C";
	const listing = `
Policy: Code Signing
  Matching identities
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (ABCDE12345)"
  2) ${sha} "omp-webui local signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (ABCDE12345)"
     1 valid identities found
`;
	expect(parseIdentities(listing)).toEqual([sha.toLowerCase()]);
	// The same identity listed as valid too (a trusted one) is still one identity.
	expect(parseIdentities(`${listing}\n  1) ${sha} "omp-webui local signing"\n`)).toEqual([sha.toLowerCase()]);
	expect(parseIdentities("     0 identities found\n")).toEqual([]);
	// A name that only contains ours is another identity.
	expect(parseIdentities(`  1) ${sha} "omp-webui local signing 2"\n`)).toEqual([]);
});

test("the requirement pins the bundle identifier and the certificate", () => {
	expect(requirementFor("441EEF68726ACE2993CD986CDA7B75C18A1C0E9C")).toBe(
		'designated => identifier "dev.omp.webui" and certificate leaf = H"441eef68726ace2993cd986cda7b75c18a1c0e9c"',
	);
});

test.skipIf(!mac)("two different builds signed with the identity have the same designated requirement", () => {
	expect(findIdentity(keychain)).toBeNull();
	const sha = ensureIdentity(keychain);
	expect(sha).toMatch(/^[0-9a-f]{40}$/);

	const first = bundle("one", "1");
	const second = bundle("two", "2");
	expect(signBundle(first, { keychain }).identity).toBe(sha);
	expect(signBundle(second, { keychain }).identity).toBe(sha);

	const requirement = designatedRequirementOf(first);
	expect(requirement).toBe(requirementFor(sha));
	expect(designatedRequirementOf(second)).toBe(requirement);
	expect(requirement).not.toContain("cdhash");
	for (const app of [first, second]) {
		const verified = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", app], { stderr: "pipe" });
		expect(verified.stderr.toString()).toBe("");
		expect(verified.exitCode).toBe(0);
	}
	// The builds themselves differ: with an ad-hoc signature that is all the requirement would be.
	const cdhash = (app: string) =>
		/CDHash=(\w+)/.exec(Bun.spawnSync(["codesign", "-dvvv", app], { stderr: "pipe" }).stderr.toString())?.[1];
	expect(cdhash(first)).not.toBe(cdhash(second));
});

/** `bundle`, with helper apps in Contents/Frameworks as CEF's are (scripts/app.ts), each with an identifier of its own. */
function bundleWithHelpers(name: string): { app: string; helpers: { path: string; id: string }[] } {
	const app = bundle(name, name);
	const helpers = ["omp-webui Helper", "omp-webui Helper (GPU)"].map((helper, i) => {
		const path = join(app, "Contents", "Frameworks", `${helper}.app`);
		const id = i === 0 ? `${BUNDLE_ID}.helper` : `${BUNDLE_ID}.helper.gpu`;
		mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
		cpSync(hello, join(path, "Contents", "MacOS", helper));
		writeFileSync(
			join(path, "Contents", "Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>${helper}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
		);
		return { path, id };
	});
	return { app, helpers };
}

const signedIdentifier = (path: string) =>
	/^Identifier=(.+)$/m.exec(Bun.spawnSync(["codesign", "-dv", path], { stderr: "pipe" }).stderr.toString())?.[1];

test.skipIf(!mac)("each helper app is signed under its own identifier, and the bundle over them still verifies", () => {
	const sha = ensureIdentity(keychain);
	const { app, helpers } = bundleWithHelpers("helpers");
	expect(signBundle(app, { keychain }).identity).toBe(sha);
	for (const helper of helpers) {
		expect(signedIdentifier(helper.path)).toBe(helper.id);
		expect(designatedRequirementOf(helper.path)).toBe(requirementFor(sha, helper.id));
	}
	expect(designatedRequirementOf(app)).toBe(requirementFor(sha));
	const verified = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", app], { stderr: "pipe" });
	expect(verified.stderr.toString()).toBe("");
	expect(verified.exitCode).toBe(0);

	// Ad hoc too: the helpers keep their own identifiers.
	const adHoc = bundleWithHelpers("helpers-ad-hoc");
	expect(signBundle(adHoc.app, { keychain: noKeychain, warn: () => {} }).identity).toBeNull();
	for (const helper of adHoc.helpers) expect(signedIdentifier(helper.path)).toBe(helper.id);
	expect(Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", adHoc.app]).exitCode).toBe(0);
});

test.skipIf(!mac)("creating the identity again finds the one there instead of making another", () => {
	const sha = ensureIdentity(keychain);
	expect(ensureIdentity(keychain)).toBe(sha);
	expect(
		parseIdentities(Bun.spawnSync(["security", "find-identity", "-p", "codesigning", keychain]).stdout.toString()),
	).toEqual([sha]);
});

test.skipIf(!mac)(
	"a keychain that locked itself since the last build is unlocked, not a failed build or a dialog",
	() => {
		const sha = ensureIdentity(keychain);
		expect(Bun.spawnSync(["security", "lock-keychain", keychain]).exitCode).toBe(0);
		const app = bundle("locked", "4");
		expect(signBundle(app, { keychain }).identity).toBe(sha);
		expect(designatedRequirementOf(app)).toBe(requirementFor(sha));
	},
);

test.skipIf(!mac)("the keychain's password is a random one in a file only the user can read", () => {
	const password = keychainPassword(keychain);
	expect(password.length).toBeGreaterThanOrEqual(32);
	expect(password).not.toContain("omp-webui");
	// The same password every time: the keychain is not re-created under the user.
	expect(keychainPassword(keychain)).toBe(password);
	const file = passwordFileFor(keychain);
	expect(existsSync(file)).toBe(true);
	expectMode(file, 0o600);
	expectMode(dirname(file), 0o700);
	expectMode(keychain, 0o600);
	expect(readFileSync(file, "utf8")).toContain(password);
});

test.skipIf(!mac)("the keychain is locked again right after the build, so nothing of it is left open", () => {
	const sha = ensureIdentity(keychain);
	const app = bundle("locked-after", "5");
	expect(signBundle(app, { keychain }).identity).toBe(sha);
	expect(isKeychainLocked(keychain)).toBe(true);
	// A build that fails leaves it locked as well.
	const broken = bundle("broken", "6");
	rmSync(broken, { recursive: true, force: true });
	expect(() => signBundle(broken, { keychain })).toThrow();
	expect(isKeychainLocked(keychain)).toBe(true);
});

/** A keychain as the first version of this script made it: a fixed password, and the identity in it. */
function keychainWithPassword(name: string, password: string): { path: string; sha: string } {
	const path = join(dir, name);
	expect(Bun.spawnSync(["security", "create-keychain", "-p", password, path]).exitCode).toBe(0);
	Bun.spawnSync(["security", "unlock-keychain", "-p", password, path]);
	const tmp = mkdtempSync(join(tmpdir(), "ompw-legacy-"));
	writeFileSync(
		join(tmp, "openssl.cnf"),
		"[req]\ndistinguished_name = dn\nx509_extensions = v3\nprompt = no\n[dn]\nCN = omp-webui local signing\nO = omp-webui local\n[v3]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\n",
	);
	const openssl = Bun.spawnSync([
		"/usr/bin/openssl",
		...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650"],
		...["-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"), "-config", join(tmp, "openssl.cnf")],
	]);
	expect(openssl.exitCode).toBe(0);
	Bun.spawnSync(["security", "import", join(tmp, "cert.pem"), "-k", path, "-T", "/usr/bin/codesign"]);
	Bun.spawnSync(["security", "import", join(tmp, "key.pem"), "-k", path, "-T", "/usr/bin/codesign"]);
	rmSync(tmp, { recursive: true, force: true });
	// The keychain is still unlocked here: list it directly (as findIdentity does, without a password).
	const [sha] = parseIdentities(
		Bun.spawnSync(["security", "find-identity", "-p", "codesigning", path]).stdout.toString(),
	);
	expect(sha).toMatch(/^[0-9a-f]{40}$/);
	return { path, sha: sha as string };
}

test.skipIf(!mac)("a keychain made with the old fixed password keeps its certificate and gets a random one", () => {
	const { path: legacy, sha: beforeSha } = keychainWithPassword("legacy.keychain-db", "omp-webui local signing");
	// The script takes it over: the same certificate, a password of its own.
	expect(ensureIdentity(legacy)).toBe(beforeSha);
	const password = keychainPassword(legacy);
	expect(password).not.toBe("omp-webui local signing");
	expectMode(passwordFileFor(legacy), 0o600);
	// The old password opens it no more.
	Bun.spawnSync(["security", "lock-keychain", legacy]);
	const old = Bun.spawnSync(["security", "unlock-keychain", "-p", "omp-webui local signing", legacy]);
	expect(old.exitCode).not.toBe(0);
	// And the new one does.
	expect(Bun.spawnSync(["security", "unlock-keychain", "-p", password, legacy]).exitCode).toBe(0);
	Bun.spawnSync(["security", "delete-keychain", legacy]);
});

/**
 * `security` reads its password prompts from /dev/tty when the process has a controlling terminal, and from stdin only
 * when it has none. A test runner has none, a person at Terminal has one: so the calls are run under a pseudo-terminal
 * (`script`), and a call that relies on stdin shows as a hang (no exit code) instead of passing by luck.
 */
async function underTerminal(args: string[], timeoutMs = 25_000): Promise<{ out: string; hung: boolean }> {
	const harness = join(import.meta.dir, "..", "support", "signing-pty.ts");
	const proc = Bun.spawn(["script", "-q", "/dev/null", process.execPath, harness, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	// Killed by the timeout rather than ended on its own: it was waiting for something.
	return { out: out + err, hung: proc.signalCode !== null };
}

test.skipIf(!mac || Bun.which("script") === null)(
	"from a terminal, setup and signing do not wait for a password prompt",
	async () => {
		const kc = join(dir, "tty.keychain-db");
		const made = await underTerminal(["make", kc]);
		expect(made.hung, made.out).toBe(false);
		expect(made.out).toMatch(/ok [0-9a-f]{40}/);
		const signed = await underTerminal(["sign", kc, bundle("tty", "9")]);
		expect(signed.hung, signed.out).toBe(false);
		expect(signed.out).toMatch(/ok [0-9a-f]{40}/);
		expect(isKeychainLocked(kc)).toBe(true);
		Bun.spawnSync(["security", "delete-keychain", kc]);
	},
	60_000,
);

test.skipIf(!mac || Bun.which("script") === null)(
	"from a terminal, a keychain with the old password is migrated and keeps its certificate",
	async () => {
		const { path, sha } = keychainWithPassword("tty-legacy.keychain-db", "omp-webui local signing");
		const migrated = await underTerminal(["migrate", path]);
		expect(migrated.hung, migrated.out).toBe(false);
		expect(existsSync(path)).toBe(true);
		expect(findIdentity(path)).toBe(sha);
		Bun.spawnSync(["security", "delete-keychain", path]);
	},
	60_000,
);

test.skipIf(!mac)(
	"a keychain is never deleted, whether its password is definitely not the old one or the unlock failed otherwise (#162)",
	() => {
		// A `security` that fails the way a timeout or an unknown error does (not exit status 51) when asked to unlock.
		const stubs = mkdtempSync(join(tmpdir(), "ompw-stub-"));
		const real = Bun.which("security") as string;
		writeFileSync(
			join(stubs, "security"),
			`#!/bin/sh\nif [ "$1" = unlock-keychain ]; then echo "security: something else went wrong" >&2; exit 1; fi\nexec ${real} "$@"\n`,
			{ mode: 0o755 },
		);
		const { path } = keychainWithPassword("undecided.keychain-db", "omp-webui local signing");
		const harness = join(import.meta.dir, "..", "support", "signing-pty.ts");
		const migrated = Bun.spawnSync([process.execPath, harness, "migrate", path], {
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		rmSync(stubs, { recursive: true, force: true });
		expect(migrated.exitCode).not.toBe(0);
		expect(migrated.stderr.toString()).toContain("unlock-keychain");
		// Still there, with its identity, and no password file claiming it was secured.
		expect(existsSync(path)).toBe(true);
		expect(findIdentity(path)).not.toBeNull();
		expect(existsSync(passwordFileFor(path))).toBe(false);
		// A password that is definitely wrong (exit status 51) is an error too, and the keychain stays where it is.
		const { path: other, sha } = keychainWithPassword("other.keychain-db", "some other password");
		expect(() => keychainPassword(other)).toThrow(/does not open/);
		expect(existsSync(other)).toBe(true);
		expect(existsSync(passwordFileFor(other))).toBe(false);
		expect(findIdentity(other)).toBe(sha);
		Bun.spawnSync(["security", "delete-keychain", other]);
		Bun.spawnSync(["security", "delete-keychain", path]);
	},
);

test.skipIf(!mac)("without an identity the bundle is signed ad hoc, and the warning says what that costs", () => {
	const warnings: string[] = [];
	const app = bundle("adhoc", "3");
	expect(signBundle(app, { keychain: noKeychain, warn: (text) => warnings.push(text) }).identity).toBeNull();
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("ad-hoc");
	expect(warnings[0]).toContain("permissions");
	expect(warnings[0]).toContain("scripts/signing-identity.ts");
	expect(designatedRequirementOf(app)).toContain("cdhash");
	const verified = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", app], { stderr: "pipe" });
	expect(verified.exitCode).toBe(0);
});

test.skipIf(!mac)(
	"a keychain that does not open is an error that stops the build and leaves it in place, not 'no identity' (#162)",
	() => {
		const { path, sha } = keychainWithPassword("closed.keychain-db", "a password nobody wrote down");
		Bun.spawnSync(["security", "lock-keychain", path]);
		// Listing it needs no password: its identity is found, and it stays locked.
		expect(findIdentity(path)).toBe(sha);
		expect(isKeychainLocked(path)).toBe(true);
		// What has to open it refuses, before anything is signed, made or deleted.
		expect(() => ensureIdentity(path)).toThrow(/does not open/);
		const app = bundle("closed", "7");
		expect(() => signBundle(app, { keychain: path })).toThrow(/does not open/);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(passwordFileFor(path))).toBe(false);
		expect(findIdentity(path)).toBe(sha);
		Bun.spawnSync(["security", "delete-keychain", path]);
	},
);
