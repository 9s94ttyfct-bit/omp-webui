import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { designatedRequirementOf, leafOf, refusalOf } from "../../server/update/verify.ts";
import { buildFixtures, disposeFixtures, type Fixtures, NEWER } from "../support/update-fixtures.ts";

/**
 * What a downloaded app must be before it may replace the running one (#571, `refusalOf`): intact, this app, the release it
 * was published as, newer, and signed by the certificate the running app is. The real `codesign` and `plutil` run against
 * apps signed with two throwaway certificates (and one ad hoc), each wrong in exactly one way: never the app's own keychain.
 */

const mac = process.platform === "darwin" && Bun.which("codesign") !== null && Bun.which("security") !== null;
let fixtures: Fixtures;

beforeAll(async () => {
	if (!mac) return;
	fixtures = await buildFixtures(mkdtempSync(join(tmpdir(), "ompw-verify-")), undefined, { dmgs: false });
}, 120_000);
afterAll(() => {
	if (mac) disposeFixtures(fixtures);
});

const installed = pkg.version;
const expecting = (version = NEWER, running = () => fixtures.running) => ({ running: running(), version, installed });
const app = (variant: keyof Fixtures["installers"]) => fixtures.installers[variant]?.app as string;

test.skipIf(!mac)(
	"an app that is intact, ours, the release, newer and signed as the running one is fit to install",
	async () => {
		expect(await refusalOf(app("good"), expecting())).toBeNull();
		// The requirement it passed on is the running app's own: the identifier and the certificate, not a build's hash.
		const running = await designatedRequirementOf(fixtures.running);
		expect(await designatedRequirementOf(app("good"))).toBe(running);
		expect(running).toMatch(/^designated => identifier "dev\.omp\.webui" and certificate leaf = H"[0-9a-f]{40}"$/);
	},
);

test.skipIf(!mac)("an app changed after it was signed is refused: its signature no longer holds", async () => {
	const refusal = await refusalOf(app("tampered"), expecting());
	expect(refusal?.code).toBe("signature");
	expect(String(refusal?.params.detail)).not.toBe("");
});

test.skipIf(!mac)("an app of another bundle identifier is refused, with both identifiers", async () => {
	expect(await refusalOf(app("otherId"), expecting())).toEqual({
		code: "bundleId",
		params: { expected: "dev.omp.webui", found: "com.example.not-omp-webui" },
	});
});

test.skipIf(!mac)(
	"an app whose version is not the release's is refused, and a version that is no version too",
	async () => {
		expect(await refusalOf(app("wrongVersion"), expecting())).toEqual({
			code: "version",
			params: { tag: `v${NEWER}`, found: "9.0.1" },
		});
	},
);

test.skipIf(!mac)(
	"an app that is not newer than the running one is refused: never a downgrade, never the same version",
	async () => {
		// The release is v0.0.5 and says so itself: honest, and older than what runs.
		expect(await refusalOf(app("notNewer"), expecting("0.0.5"))).toEqual({
			code: "notNewer",
			params: { found: "0.0.5", installed },
		});
		// The same version as the running one is not an update either.
		expect(await refusalOf(app("good"), { running: fixtures.running, version: NEWER, installed: NEWER })).toMatchObject(
			{
				code: "notNewer",
			},
		);
	},
);

test.skipIf(!mac)(
	"an app signed by another certificate is refused: macOS would take it for another app and forget its permissions",
	async () => {
		const refusal = await refusalOf(app("otherSigner"), expecting());
		expect(refusal?.code).toBe("requirement");
		const mine = leafOf((await designatedRequirementOf(fixtures.running)) as string);
		const theirs = leafOf((await designatedRequirementOf(app("otherSigner"))) as string);
		expect(mine).not.toBe(theirs);
		expect(refusal?.params).toEqual({ expected: mine as string, found: theirs as string });
	},
);

test.skipIf(!mac)("an app signed ad hoc is refused: its requirement is its own hash", async () => {
	expect(await refusalOf(app("adHoc"), expecting())).toEqual({
		code: "requirement",
		params: {
			expected: leafOf((await designatedRequirementOf(fixtures.running)) as string) as string,
			found: "ad hoc",
		},
	});
});

test.skipIf(!mac)(
	"a running app that is signed ad hoc has nothing to hold a download against: nothing is accepted",
	async () => {
		expect(
			await refusalOf(
				app("good"),
				expecting(NEWER, () => fixtures.runningAdHoc),
			),
		).toEqual({ code: "adHoc", params: {} });
	},
);

test.skipIf(!mac)(
	"the order of the refusals: a broken signature is told before anything else, a wrong identifier before a wrong signer",
	async () => {
		// `otherId` is signed by the right certificate under another identifier; its requirement differs too, but the sentence
		// that helps is the identifier's.
		expect((await refusalOf(app("otherId"), expecting()))?.code).toBe("bundleId");
		expect((await refusalOf(app("tampered"), expecting("0.0.1")))?.code).toBe("signature");
	},
);

test("a requirement names its certificate by the hash after `certificate leaf`, and nothing else does", () => {
	const sha = "441eef68726ace2993cd986cda7b75c18a1c0e9c";
	expect(leafOf(`designated => identifier "dev.omp.webui" and certificate leaf = H"${sha}"`)).toBe(sha);
	expect(leafOf(`designated => identifier "dev.omp.webui" and certificate leaf = H"${sha.toUpperCase()}"`)).toBe(sha);
	expect(leafOf(`designated => cdhash H"${sha}"`)).toBeNull();
	expect(leafOf(`designated => anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"`)).toBeNull();
});
