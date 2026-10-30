import { expect, test } from "bun:test";
import { type Probe, preflight, tokenScopes } from "../../scripts/lib/release-preflight.ts";

/** The checks of scripts/lib/release-preflight.ts over canned answers of the commands they run. */

const ok = { code: 0, out: "", err: "" };

/** Answers by the command's name, and records what was asked. */
function probeOf(answers: Record<string, Partial<typeof ok>>): { probe: Probe; asked: string[] } {
	const asked: string[] = [];
	const probe: Probe = async (cmd) => {
		asked.push(cmd.slice(0, 2).join(" "));
		return { ...ok, ...answers[cmd[0]] };
	};
	return { probe, asked };
}

test("scopes come from the X-OAuth-Scopes header whatever its case, and a token without the header has none to read", () => {
	expect(tokenScopes("HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, repo,  write:packages\netag: x\n")).toEqual([
		"gist",
		"repo",
		"write:packages",
	]);
	expect(tokenScopes("HTTP/2 200\nx-oauth-scopes: \n")).toEqual([]);
	expect(tokenScopes("HTTP/2 200\ncontent-type: application/json\n")).toBeNull();
});

test("only the checks the release needs are run", async () => {
	const none = probeOf({});
	expect(await preflight({ gui: false, publish: false, signing: false }, none.probe)).toEqual([]);
	expect(none.asked).toEqual([]);
	const publishOnly = probeOf({ gh: { out: "x-oauth-scopes: repo" } });
	expect(await preflight({ gui: false, publish: true, signing: false }, publishOnly.probe)).toEqual([]);
	expect(publishOnly.asked).toEqual(["gh api"]);
});

test("a session that is not Aqua is named, and Finder is not tried in it", async () => {
	const { probe, asked } = probeOf({ launchctl: { out: "Background\n" } });
	const problems = await preflight({ gui: true, publish: false, signing: false }, probe);
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain("launchctl managername: Background");
	expect(asked).toEqual(["launchctl managername"]);
});

test("a Finder that refuses scripting is named with the first line of its error", async () => {
	const { probe } = probeOf({
		launchctl: { out: "Aqua\n" },
		osascript: { code: 1, err: "execution error: Not authorized (-1743)\nmore" },
	});
	const problems = await preflight({ gui: true, publish: false, signing: false }, probe);
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain("Finder cannot be scripted (execution error: Not authorized (-1743))");
});

test("publishing needs a signed-in gh with the repo scope, and no npm or package scope; a token that shows no scopes is not refused", async () => {
	const all = probeOf({ npm: { code: 127, err: "spawn npm ENOENT" }, gh: { out: "x-oauth-scopes: gist" } });
	const problems = await preflight({ gui: false, publish: true, signing: false }, all.probe);
	expect(problems).toEqual(["the gh token lacks repo: run `gh auth refresh -s repo`"]);
	expect(all.asked).toEqual(["gh api"]);

	const signedOut = probeOf({ gh: { code: 1, err: "You are not logged into any GitHub hosts" } });
	expect((await preflight({ gui: false, publish: true, signing: false }, signedOut.probe))[0]).toContain(
		"gh is not signed in (You are not logged into any GitHub hosts)",
	);

	const fineGrained = probeOf({ gh: { out: "HTTP/2 200\ncontent-type: json" } });
	expect(await preflight({ gui: false, publish: true, signing: false }, fineGrained.probe)).toEqual([]);
});

const LISTING = (name: string) =>
	`Policy: Code Signing\n  Matching identities\n  1) 441EEF68726ACE2993CD986CDA7B75C18A1C0E9C "${name}" (CSSMERR_TP_NOT_TRUSTED)\n     1 identities found\n`;

test("a release needs the signing identity, which is why an update keeps the app's permissions", async () => {
	const missing = probeOf({ security: { out: LISTING("Apple Development: someone@example.com (ABCDE12345)") } });
	const problems = await preflight({ gui: false, publish: false, signing: true }, missing.probe);
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain('no code-signing identity named "omp-webui local signing"');
	expect(problems[0]).toContain("bun scripts/signing-identity.ts");
	expect(problems[0]).toContain("permissions");

	// A self-signed identity is listed (as not trusted) and counts.
	const present = probeOf({ security: { out: LISTING("omp-webui local signing") } });
	expect(await preflight({ gui: false, publish: false, signing: true }, present.probe)).toEqual([]);

	// Not asked for when the release does not need it, and a keychain that cannot be read is named.
	const none = probeOf({});
	await preflight({ gui: false, publish: false, signing: false }, none.probe);
	expect(none.asked).toEqual([]);
	const broken = probeOf({
		security: { code: 44, err: "security: SecKeychainSearchCopyNext: The specified item could not be found" },
	});
	const unreadable = await preflight({ gui: false, publish: false, signing: true }, broken.probe);
	expect(unreadable[0]).toContain("security find-identity failed (security: SecKeychainSearchCopyNext");
});
