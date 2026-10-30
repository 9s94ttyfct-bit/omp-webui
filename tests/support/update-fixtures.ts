/**
 * Signed stand-ins for the app and its installers, for the tests of the app's own updates (#571): a "running" app, and disk
 * images that each hold an app that is wrong in one way (or none), signed with real certificates the way the release is:
 * `codesign` against two throwaway keychains (never the one the app is built with), so that the designated requirements
 * differ exactly as an update from another signer's would. Mac only (`codesign`, `hdiutil`, `security`, a C compiler).
 *
 * Run by Bun. Specs that run under Node (Playwright) call it as a program: `bun update-fixtures.ts <dir> [variant…]` prints
 * the manifest as JSON; `bun update-fixtures.ts --dispose <dir>` removes the keychains it made.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { BUNDLE_ID, ensureIdentity, signBundle } from "../../scripts/signing-identity.ts";

/** The version every installer here holds (unless a variant says otherwise): newer than the code under test. */
export const NEWER = "9.0.0";

export const VARIANTS = [
	"good",
	"tampered",
	"otherId",
	"wrongVersion",
	"notNewer",
	"otherSigner",
	"adHoc",
	"noApp",
	"quarantined",
	"garbage",
] as const;
export type Variant = (typeof VARIANTS)[number];

export interface Installer {
	/** The disk image (absent when the fixtures were built without images). */
	dmg: string;
	/** The app that is in it, as a folder of its own (absent for the variants that hold none). */
	app?: string;
	/** The release tag the installer is published under. */
	tag: string;
}

export interface Fixtures {
	dir: string;
	/** The app that "runs": `dev.omp.webui`, signed with identity A. */
	running: string;
	/** The same app signed ad hoc. */
	runningAdHoc: string;
	keychains: string[];
	installers: Partial<Record<Variant, Installer>>;
}

/** A tiny executable, so that a bundle has something to sign; each copy differs by `salt`, so each has its own hash. */
function compile(dir: string): string {
	const source = join(dir, "hello.c");
	const binary = join(dir, "hello");
	writeFileSync(source, "int main(void){return 0;}\n");
	const cc = Bun.spawnSync(["cc", "-o", binary, source], { stderr: "pipe" });
	if (cc.exitCode !== 0) throw new Error(`cc: ${cc.stderr.toString()}`);
	return binary;
}

interface BundleOptions {
	id?: string;
	version?: string;
	salt?: string;
}

function makeBundle(binary: string, dest: string, options: BundleOptions = {}): string {
	const app = join(dest, "omp-webui.app");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	cpSync(binary, join(app, "Contents", "MacOS", "omp-webui"));
	writeFileSync(join(app, "Contents", "Resources.txt"), options.salt ?? "");
	writeFileSync(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${options.id ?? BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>omp-webui</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${options.version ?? NEWER}</string>
<key>CFBundleVersion</key><string>${options.version ?? NEWER}</string>
</dict></plist>
`,
	);
	return app;
}

/**
 * The disk images of `images`, all made at once. `hdiutil create -srcfolder` mounts a volume to fill it: about three seconds,
 * five with the compression, however small the folder. Nine of them one after another are three quarters of a minute when
 * the machine is idle and more when it is not, and a hook with a time limit that held them ran out of it (180 s, three
 * suites at once on a busy machine) and Bun killed the `hdiutil` it was waiting for. Made together they take as long as
 * the slowest two. Every image is waited for, and the first failure is the one reported.
 */
async function makeDmgs(images: readonly { content: string; dmg: string }[]): Promise<void> {
	const made = await Promise.allSettled(
		images.map(async ({ content, dmg }) => {
			const child = Bun.spawn(
				[
					"hdiutil",
					"create",
					"-srcfolder",
					content,
					"-volname",
					"omp-webui",
					"-fs",
					"HFS+",
					"-format",
					"UDZO",
					"-ov",
					"-quiet",
					dmg,
				],
				{ stderr: "pipe" },
			);
			const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
			if (code !== 0) throw new Error(`hdiutil create ${dmg}: exit ${code}: ${stderr}`);
		}),
	);
	for (const result of made) if (result.status === "rejected") throw result.reason;
}

export async function buildFixtures(
	dir: string,
	variants: readonly Variant[] = VARIANTS,
	options: { dmgs?: boolean } = {},
): Promise<Fixtures> {
	const keychains: string[] = [];
	try {
		return await makeFixtures(dir, variants, options, keychains);
	} catch (error) {
		// What was made before the failure leaves with the failure: the caller has no `Fixtures` to dispose, and a throwaway
		// keychain that stayed behind would stay in the user's search list for good.
		disposeFixtures({ dir, keychains });
		throw error;
	}
}

async function makeFixtures(
	dir: string,
	variants: readonly Variant[],
	options: { dmgs?: boolean },
	keychains: string[],
): Promise<Fixtures> {
	const dmgs = options.dmgs ?? true;
	mkdirSync(dir, { recursive: true });
	const binary = compile(dir);
	const keychainA = join(dir, "a.keychain-db");
	const keychainB = join(dir, "b.keychain-db");
	keychains.push(keychainA, keychainB);
	ensureIdentity(keychainA);
	ensureIdentity(keychainB);

	const running = makeBundle(binary, join(dir, "running"), { version: pkg.version, salt: "running" });
	signBundle(running, { keychain: keychainA });
	const runningAdHoc = makeBundle(binary, join(dir, "running-adhoc"), { version: pkg.version, salt: "running" });
	signBundle(runningAdHoc, { keychain: join(dir, "none.keychain-db"), warn: () => {} });

	const installers: Fixtures["installers"] = {};
	const images: { content: string; dmg: string }[] = [];
	for (const variant of variants) {
		const content = join(dir, `dmg-${variant}`);
		mkdirSync(content, { recursive: true });
		const dmg = join(dir, `${variant}.dmg`);
		let tag = `v${NEWER}`;
		if (variant === "garbage") {
			writeFileSync(dmg, "this is not a disk image\n".repeat(2000));
			installers[variant] = { dmg, tag };
			continue;
		}
		if (variant === "noApp") {
			writeFileSync(join(content, "README.txt"), "no app in here\n");
			if (dmgs) images.push({ content, dmg });
			installers[variant] = { dmg, tag };
			continue;
		}
		const bundle: BundleOptions = { salt: variant };
		if (variant === "otherId") bundle.id = "com.example.not-omp-webui";
		if (variant === "wrongVersion") bundle.version = "9.0.1";
		if (variant === "notNewer") {
			bundle.version = "0.0.5";
			tag = "v0.0.5";
		}
		const app = makeBundle(binary, content, bundle);
		const identity = variant === "otherSigner" ? keychainB : keychainA;
		if (variant === "adHoc") signBundle(app, { keychain: join(dir, "none.keychain-db"), warn: () => {} });
		else signBundle(app, { keychain: identity, identifier: bundle.id });
		if (variant === "tampered") writeFileSync(join(app, "Contents", "Resources.txt"), "changed after it was signed");
		if (variant === "quarantined") {
			Bun.spawnSync(["xattr", "-w", "com.apple.quarantine", "0081;5f5e1000;Safari;", app]);
			Bun.spawnSync([
				"xattr",
				"-w",
				"com.apple.quarantine",
				"0081;5f5e1000;Safari;",
				join(app, "Contents", "MacOS", "omp-webui"),
			]);
		}
		if (dmgs) images.push({ content, dmg });
		installers[variant] = { dmg, tag, app };
	}
	await makeDmgs(images);
	return { dir, running, runningAdHoc, keychains: [keychainA, keychainB], installers };
}

/**
 * Remove what `buildFixtures` made: the throwaway keychains leave the user's search list with their files. A setup that threw
 * leaves its caller with nothing to pass (`undefined`) or with the part it got to: the cleanup removes what is there and
 * reports nothing, so that a beforeAll that failed is the failure the run shows, not a second one from here.
 */
export function disposeFixtures(f: Pick<Fixtures, "dir" | "keychains"> | undefined | null): void {
	if (!f) return;
	// Without `security` (not a Mac) no keychain was made, and spawning it would throw over the failure being reported.
	if (Bun.which("security") !== null)
		for (const keychain of f.keychains ?? [])
			Bun.spawnSync(["security", "delete-keychain", keychain], { stderr: "ignore" });
	if (f.dir) rmSync(f.dir, { recursive: true, force: true });
}

if (import.meta.main) {
	const [first, second, ...rest] = process.argv.slice(2);
	if (first === "--dispose") {
		const manifest = join(second as string, "manifest.json");
		if (existsSync(manifest)) disposeFixtures(JSON.parse(readFileSync(manifest, "utf8")));
	} else {
		const wanted = [second, ...rest].filter((v): v is Variant => (VARIANTS as readonly string[]).includes(v ?? ""));
		const fixtures = await buildFixtures(first as string, wanted.length > 0 ? wanted : VARIANTS);
		writeFileSync(join(fixtures.dir, "manifest.json"), JSON.stringify(fixtures));
		console.log(JSON.stringify(fixtures));
	}
}
