/**
 * The identity the macOS app is signed with (`bun scripts/signing-identity.ts` makes it once on this Mac).
 *
 * macOS keeps a permission (notifications, screen recording, accessibility) against the app's designated requirement. An
 * ad-hoc signature has none of its own, so its requirement is the build's cdhash, which changes with every build: after an
 * update macOS takes the app for a new one and every grant has to be made again. A self-signed code-signing certificate
 * gives every build the same requirement, the bundle identifier plus that certificate, without an Apple Developer ID.
 *
 * The certificate and its key live in a keychain of their own, `SIGNING_KEYCHAIN`, not in the login keychain: `codesign`
 * asks for a key in the login keychain through a dialog that wants the login password (the key's partition list can only be
 * set with it), which no build can answer. It is not under ~/Library/Keychains either: measured on macOS 27, `codesign`
 * showed the same dialog for a keychain with its own password there, and none for one in /tmp or in Application Support.
 *
 * The threat this leaves, plainly: a key that signs as `dev.omp.webui` is a key that macOS takes for the app, with the
 * Screen Recording, Accessibility and notification grants the user gave it. So the keychain's password is a random one
 * written once to a 0600 file next to it (the directory is 0700, the keychain 0600) and not in this script; the keychain
 * is unlocked only while a build signs and locked again right after, also when the build fails. What that leaves is this:
 * anything that runs as the user, or that reads that file, can unlock the keychain and sign code macOS treats as the app.
 * (`security` is given the password with `-p`, so for the moment of the call it is in the process list too: anything that runs as
 * the user can read the file anyway, so that widens nothing. Piping it does not work from a terminal: `security` reads its
 * prompts from /dev/tty when there is one, and a build run from Terminal would hang.)
 * The alternative — a key nobody but the app can use — needs an Apple Developer ID, or a keychain only the user's password
 * opens, which an unattended build cannot answer.
 *
 * The certificate is not trusted by the system (`add-trusted-cert` asks for the login password too, and nothing here needs
 * it): `codesign` signs with it all the same, and the requirement names the certificate by its hash, which is what TCC compares.
 *
 * With no identity, `signBundle` signs ad hoc and says loudly what that costs; `scripts/lib/release-preflight.ts` refuses a
 * release without one.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The certificate's name, as `security find-identity` lists it. */
export const IDENTITY_NAME = "omp-webui local signing";
/** The bundle identifier the requirement names (Info.plist's CFBundleIdentifier, which scripts/app.ts writes). */
export const BUNDLE_ID = "dev.omp.webui";
/** The keychain file that holds the identity (not under ~/Library/Keychains: see above). */
export const SIGNING_KEYCHAIN = join(
	homedir(),
	"Library",
	"Application Support",
	"omp-webui-signing",
	"signing.keychain-db",
);
/** The file next to the keychain that holds its password. */
export function passwordFileFor(keychain: string): string {
	return `${keychain}.password`;
}

/** The password the keychain of the first version of this script was made with; it is changed to a random one on first use. */
const LEGACY_PASSWORD = "omp-webui local signing";

/**
 * The keychain's password: a random one, written once next to the keychain (0600) and read from there. A password that is
 * in the script (or in a README) is no password at all: anything running as the user could unlock the keychain and sign
 * code that macOS takes for the app, with its Screen Recording and Accessibility grants. What this leaves is: anyone who
 * can run commands as the user, or read that file, can do the same. The keychain is unlocked only while a build signs and
 * locked again right after, so the window in which that is possible is the build's, not the session's.
 */
export function keychainPassword(keychain: string): string {
	const file = passwordFileFor(keychain);
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	const password = randomBytes(32).toString("base64url");
	if (existsSync(keychain)) {
		// A keychain made by the version of this script that used a fixed password: it is given this one instead, so that
		// the certificate stays the same (and with it the app's macOS permissions).
		const old = run(["security", "unlock-keychain", "-p", LEGACY_PASSWORD, keychain]);
		if (old.code === 0) {
			must(["security", "set-keychain-password", "-o", LEGACY_PASSWORD, "-p", password, keychain]);
			lock(keychain);
		} else if (old.code === WRONG_PASSWORD) {
			// Definitely not the old password, so nothing here can open this keychain: it is made anew. The certificate is a
			// new one, and macOS asks for the app's permissions once more.
			run(["security", "delete-keychain", keychain]);
		} else {
			// A timeout, or a failure that says nothing about the password: the keychain may be perfectly good, so it is
			// left alone.
			throw new Error(describe(["security", "unlock-keychain"], old));
		}
	}
	mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 });
	writeFileSync(file, `${password}\n`, { mode: 0o600 });
	chmodSync(dirname(keychain), 0o700);
	chmodSync(file, 0o600);
	return password;
}

/** What a command that waits for a dialog nobody answers would otherwise hold the build on for ever. */
const TIMEOUT_MS = 120_000;

/** The exit status of `security unlock-keychain` for a password that is wrong (errSecAuthFailed). */
const WRONG_PASSWORD = 51;

/**
 * `security import` reporting that the Security framework's module could not be loaded: `CSSM_ModuleLoad()`. It is how
 * SecurityAgent answers, from time to time, a keychain being made while other suites in the same run are making or signing
 * with theirs (the update fixtures' two certificates, and every other spec's keychain, on a busy machine). Nothing about the
 * keychain or the certificate is wrong: the same import succeeds when it is made again a moment later.
 */
const CSSM_MODULE_LOAD = "CSSM_ModuleLoad";

/** How many times an import that failed that way is made again, and how long to wait before each: a moment is enough. */
const IMPORT_ATTEMPTS = 5;
const IMPORT_BACKOFF_MS = 100;

interface Ran {
	code: number | null;
	out: string;
	err: string;
}

/** Runs `cmd` to its end; a command that outlives the timeout (a dialog nobody answers) has no exit code. */
function run(cmd: string[], timeout = TIMEOUT_MS): Ran {
	const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Why a command failed, for an error message. */
function describe(cmd: string[], r: Ran): string {
	const why =
		r.code === null
			? "it waited for a dialog or a prompt nobody answered: run this from Terminal on the Mac's own desktop"
			: r.err.trim() || `exit ${r.code}`;
	return `${cmd.slice(0, 2).join(" ")} failed: ${why}`;
}

function must(cmd: string[]): string {
	const r = run(cmd);
	if (r.code === 0) return r.out;
	throw new Error(describe(cmd, r));
}

/**
 * `security import`, made again when it failed with `CSSM_ModuleLoad()` (see `CSSM_MODULE_LOAD`). No other failure is
 * retried: a keychain that cannot be opened, a passphrase that is wrong or a malformed file is reported at once.
 */
function mustImport(cmd: string[]): string {
	for (let attempt = 1; ; attempt++) {
		const r = run(cmd);
		if (r.code === 0) return r.out;
		const said = `${r.out}\n${r.err}`;
		if (attempt >= IMPORT_ATTEMPTS || !said.includes(CSSM_MODULE_LOAD)) throw new Error(describe(cmd, r));
		Bun.sleepSync(IMPORT_BACKOFF_MS * attempt);
	}
}

/**
 * The SHA-1 of each identity named `IDENTITY_NAME` in a `security find-identity` listing, lower case, once each: the list
 * repeats an identity under "Valid identities only" when the system trusts it, and the self-signed one is not.
 */
export function parseIdentities(listing: string): string[] {
	const found = new Set<string>();
	for (const line of listing.split("\n")) {
		const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*?)"/.exec(line);
		if (m && m[2] === IDENTITY_NAME) found.add(m[1].toLowerCase());
	}
	return [...found];
}

/** The requirement every build is signed with: this bundle identifier, signed with exactly this certificate. */
export function requirementFor(sha1: string, identifier = BUNDLE_ID): string {
	return `designated => identifier "${identifier}" and certificate leaf = H"${sha1.toLowerCase()}"`;
}

/**
 * The SHA-1 of the identity in `keychain`, or null when the keychain does not exist. Two of that name are an error. The
 * keychain is unlocked for the listing (a locked one lists no identity at all, which would read as "none" and have a
 * second certificate made), with the password it has now: listing never changes it (that is `secureKeychain`'s job).
 */
export function findIdentity(keychain = SIGNING_KEYCHAIN): string | null {
	if (!existsSync(keychain)) return null;
	const file = passwordFileFor(keychain);
	// A keychain that does not open lists no identity, and "none" would sign ad hoc and lose the permissions: say so instead.
	must([
		"security",
		"unlock-keychain",
		"-p",
		existsSync(file) ? readFileSync(file, "utf8").trim() : LEGACY_PASSWORD,
		keychain,
	]);
	let found: string[];
	try {
		found = parseIdentities(must(["security", "find-identity", "-p", "codesigning", keychain]));
	} finally {
		lock(keychain);
	}
	if (found.length > 1) {
		throw new Error(
			`${found.length} identities named "${IDENTITY_NAME}" in ${keychain} (${found.join(", ")}): builds would be signed by whichever is found first and lose the permissions again. Delete the keychain file and run \`bun scripts/signing-identity.ts\` again`,
		);
	}
	return found[0] ?? null;
}

/**
 * Unlock the keychain (a locked one makes `codesign` fail with errSecInternalComponent). The password is passed with `-p`:
 * `security` reads a prompt from /dev/tty when the process has a controlling terminal (a person at Terminal) and from stdin
 * only when it has none, so piping it would hang from Terminal. On the command line any process of the user can read it,
 * which adds nothing to what the same user can do by reading the 0600 password file (see the threat above).
 */
function unlock(keychain: string): void {
	const r = run(["security", "unlock-keychain", "-p", keychainPassword(keychain), keychain]);
	if (r.code === 0) return;
	if (r.code === WRONG_PASSWORD) {
		throw new Error(
			`the password in ${passwordFileFor(keychain)} does not open ${keychain}: the keychain was made by an older version of this script, with a fixed password. Delete both files and run \`bun scripts/signing-identity.ts\` again; the certificate will be a new one, so macOS asks for the app's permissions once more`,
		);
	}
	throw new Error(describe(["security", "unlock-keychain"], r));
}

/** Lock the keychain again, so that nothing of it stays open after the build. */
function lock(keychain: string): void {
	run(["security", "lock-keychain", keychain]);
}

/**
 * Whether the keychain is locked, asked of Security.framework directly (`SecKeychainGetStatus`). Not `security
 * show-keychain-info`: on a locked keychain that asks for the password in SecurityAgent's dialog and waits for it.
 */
export function isKeychainLocked(keychain: string): boolean {
	const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
		SecKeychainOpen: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
		SecKeychainGetStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	try {
		const ref = new BigUint64Array(1);
		const opened = sec.symbols.SecKeychainOpen(Buffer.from(`${keychain}\0`), ptr(ref));
		if (opened !== 0) throw new Error(`SecKeychainOpen ${keychain} failed (${opened})`);
		const status = new Uint32Array(1);
		const read = sec.symbols.SecKeychainGetStatus(Number(ref[0]) as unknown as never, ptr(status));
		if (read !== 0) throw new Error(`SecKeychainGetStatus ${keychain} failed (${read})`);
		// kSecUnlockStateStatus
		return ((status[0] as number) & 1) === 0;
	} finally {
		sec.close();
	}
}

/** Make the keychain, the certificate and its key. Returns the certificate's SHA-1. */
function createIdentity(keychain: string): string {
	mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 });
	if (!existsSync(keychain)) {
		const password = keychainPassword(keychain);
		// -p, not stdin: see `unlock`.
		must(["security", "create-keychain", "-p", password, keychain]);
		// It locks itself after a minute without use, and on sleep: a keychain left open is a keychain anybody can use.
		must(["security", "set-keychain-settings", "-u", "-t", "60", "-l", keychain]);
	}
	chmodSync(dirname(keychain), 0o700);
	chmodSync(keychain, 0o600);
	unlock(keychain);
	const tmp = mkdtempSync(join(tmpdir(), "ompw-identity-"));
	try {
		const config = join(tmp, "openssl.cnf");
		writeFileSync(
			config,
			`[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${IDENTITY_NAME}
O = omp-webui local
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`,
		);
		const key = join(tmp, "key.pem");
		const cert = join(tmp, "cert.pem");
		// 100 years: a certificate that expires would stop the builds, and a new one would have another hash.
		must([
			"/usr/bin/openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"36500",
			"-config",
			config,
		]);
		// -T: codesign may use the key. Not add-trusted-cert: it needs the login password in a dialog. The import is made
		// again when SecurityAgent says its module could not be loaded, which a busy machine says of a sound import.
		mustImport(["security", "import", cert, "-k", keychain, "-T", "/usr/bin/codesign"]);
		mustImport(["security", "import", key, "-k", keychain, "-T", "/usr/bin/codesign"]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		lock(keychain);
	}
	const sha1 = findIdentity(keychain);
	if (sha1 === null) throw new Error(`the certificate was imported into ${keychain} but is not listed as an identity`);
	return sha1;
}

/** The identity's SHA-1, made first if there is none. Run again it finds the same one: its hash is what permissions are kept by. */
export function ensureIdentity(keychain = SIGNING_KEYCHAIN): string {
	const existing = findIdentity(keychain);
	if (existing === null) return createIdentity(keychain);
	// The keychain is there but may still have the fixed password of the first version of this script, or be left open.
	secureKeychain(keychain);
	return existing;
}

/**
 * The keychain's own protection: a random password in a 0600 file, a 0700 directory, a 0600 keychain, and a keychain that
 * locks itself. A keychain made by the first version of this script is given the random password here, so that its
 * certificate (and with it the app's macOS permissions) stays the same.
 */
export function secureKeychain(keychain: string): void {
	mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 });
	// Reading the password writes the file (and changes the password of a keychain that still has the old one).
	keychainPassword(keychain);
	chmodSync(dirname(keychain), 0o700);
	chmodSync(keychain, 0o600);
	// It locks itself after a minute without use, and on sleep: a keychain left open is a keychain anybody can use. The
	// settings of a locked keychain can only be changed through SecurityAgent's password dialog, which nobody may be there
	// to answer: unlock it first.
	unlock(keychain);
	try {
		must(["security", "set-keychain-settings", "-u", "-t", "60", "-l", keychain]);
	} finally {
		lock(keychain);
	}
}

export interface SignOptions {
	/** The keychain that holds the identity (a test's own); `SIGNING_KEYCHAIN` otherwise. */
	keychain?: string;
	/** Where the ad-hoc warning goes. */
	warn?: (text: string) => void;
	/** The bundle identifier the signature and its requirement name: a renamed copy's (a test's), the app's own by default. */
	identifier?: string;
}

/**
 * Sign the bundle at `path`: with the identity and the requirement above, or ad hoc (with a warning) when there is no
 * identity. Returns the identity's SHA-1, or null when it was signed ad hoc.
 */
export function signBundle(path: string, options: SignOptions = {}): { identity: string | null } {
	const keychain = options.keychain ?? SIGNING_KEYCHAIN;
	const identifier = options.identifier ?? BUNDLE_ID;
	const sha1 = findIdentity(keychain);
	if (sha1 === null) {
		(options.warn ?? console.warn)(
			`WARNING: no code-signing identity named "${IDENTITY_NAME}": ${path} is signed ad-hoc, so its designated requirement is this build's hash and macOS forgets its permissions (notifications, screen recording, accessibility) at the next update. Run \`bun scripts/signing-identity.ts\` once and build again.`,
		);
		must(["codesign", "--force", "--deep", "--sign", "-", path]);
		return { identity: null };
	}
	// The keychain gets a random password of its own (the first version of this script used a fixed one) and locks itself.
	secureKeychain(keychain);
	unlock(keychain);
	try {
		must([
			"codesign",
			"--force",
			"--deep",
			"--sign",
			sha1,
			"--identifier",
			identifier,
			`--requirements==${requirementFor(sha1, identifier)}`,
			"--keychain",
			keychain,
			path,
		]);
	} finally {
		// Locked again right away, also when the signing failed: an open keychain is a key anyone can use.
		lock(keychain);
	}
	return { identity: sha1 };
}

/** The designated requirement the signature at `path` carries (`codesign -d -r-`). */
export function designatedRequirementOf(path: string): string {
	const r = run(["codesign", "-d", "-r-", path]);
	// An ad-hoc signature's is a comment (`# designated => cdhash H"…"`): codesign made it up, the signer wrote none.
	const line = r.out.split("\n").find((l) => /^(# )?designated =>/.test(l));
	if (!line) throw new Error(`${path} has no designated requirement: ${r.err.trim() || r.out.trim()}`);
	return line.replace(/^# /, "");
}

if (import.meta.main) {
	const existing = findIdentity();
	if (existing !== null) secureKeychain(SIGNING_KEYCHAIN);
	const sha1 = existing ?? createIdentity(SIGNING_KEYCHAIN);
	console.log(`${existing ? "Found" : "Made"} the signing identity "${IDENTITY_NAME}" in ${SIGNING_KEYCHAIN}.`);
	console.log(`SHA-1: ${sha1}`);
	console.log(`Every build is now signed with:\n  ${requirementFor(sha1)}`);
	console.log(
		`\nThe keychain is locked and its password is in ${passwordFileFor(SIGNING_KEYCHAIN)} (0600). Anyone who can run commands as you can sign code that macOS takes for the app, with its Screen Recording and Accessibility grants.`,
	);
	if (!existing) {
		console.log(
			"\nThe first build signed with it has another identity than an ad-hoc one: macOS asks for each permission once more, and from then on updates keep them.",
		);
	}
}
