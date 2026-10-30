import { expect, test } from "bun:test";
import {
	buildIssue,
	diagnosticsText,
	FEEDBACK_FIELDS,
	fullText,
	issueLink,
	missingField,
	sanitize,
	summaryMax,
	TITLE_MAX,
	URL_LIMIT,
} from "../../web/src/lib/feedback.ts";

/** What the Feedback dialog sends to GitHub: nothing secret, nothing personal, and a link that is not too long. */

const HOME = "/Users/jdoe";

test("keys, tokens and bearer credentials are removed", () => {
	const secrets = [
		"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
		"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz",
		"xoxb-1234567890-abcdefghij",
		"AKIAIOSFODNN7EXAMPLE",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ubw",
	];
	for (const secret of secrets) {
		const out = sanitize(`it failed with ${secret} in the log`, HOME);
		expect(out).not.toContain(secret.slice(0, 16));
		expect(out).toContain("[redacted]");
	}
	expect(sanitize("Authorization: Bearer abc123def456ghi789", HOME)).not.toMatch(/abc123/);
	expect(sanitize("curl -H 'Authorization: Bearer abc123def456ghi789' x", HOME)).not.toMatch(/abc123/);
});

test("values of token / key / password settings are removed, whatever the syntax", () => {
	for (const line of [
		"OPENAI_API_KEY=hunter2hunter2",
		"https://x.test/cb?code=1&access_token=hunter2hunter2&x=1",
		'{"apiKey": "hunter2hunter2"}',
		"{'password': 'hunter2hunter2'}",
		"ompw_token=hunter2hunter2",
		"secret: hunter2hunter2",
		"client_secret = hunter2hunter2",
	]) {
		const out = sanitize(line, HOME);
		expect(out).not.toContain("hunter2");
		expect(out).toContain("[redacted]");
	}
	// What follows the secret on the same line survives.
	expect(sanitize("https://x.test/cb?code=1&access_token=hunter2hunter2&x=1")).toContain("&x=1");
});

test("e-mail addresses are removed", () => {
	const out = sanitize("mail me at Jane.Doe+omp@example.co.uk or jane@x.io", HOME);
	expect(out).toBe("mail me at [email] or [email]");
});

test("the home folder becomes ~, this machine's and other people's", () => {
	expect(sanitize("opened /Users/jdoe/work/app/src/a.ts", HOME)).toBe("opened ~/work/app/src/a.ts");
	expect(sanitize("opened /Users/jdoe/work", "/Users/jdoe/")).toBe("opened ~/work");
	expect(sanitize("ENOENT '/home/alice/.omp/agent/x'", undefined)).toBe("ENOENT '~/.omp/agent/x'");
	expect(sanitize("C:\\Users\\Bob\\AppData\\x", undefined)).toBe("~\\AppData\\x");
	expect(sanitize("cwd is /Users/other.name/proj", HOME)).toBe("cwd is ~/proj");
});

test("ordinary text, versions and git hashes are left alone, and cleaning twice changes nothing more", () => {
	const plain = [
		"The author field shows 3 conversations after I click Archive.",
		"omp 18.12.0 · webui 0.9.1 on macOS 15.1 (arm64)",
		"commit 058c3995ab7e1c2d3e4f5a6b7c8d9e0f1a2b3c4d fixed it",
		"see https://github.com/9s94ttyfct-bit/omp-webui/issues/12 and /usr/local/bin/omp",
	];
	for (const text of plain) expect(sanitize(text, HOME)).toBe(text);
	const dirty = "key=abc123456789 mail a@b.co /Users/me/x Bearer abcdefgh12345678";
	const once = sanitize(dirty, HOME);
	expect(sanitize(once, HOME)).toBe(once);
});

test("a draft becomes a titled, labelled issue with only the fields that were filled in", () => {
	const issue = buildIssue(
		{
			kind: "bug",
			summary: "  Sidebar   loses\nthe selection ",
			fields: { happened: "It broke.", steps: "", actual: "Nothing." },
		},
		null,
		HOME,
	);
	expect(issue.title).toBe("Bug: Sidebar loses the selection");
	expect(issue.labels).toEqual(["bug"]);
	expect(issue.text).toBe("### What happened\n\nIt broke.\n\n### What actually happened\n\nNothing.");
	expect(issue.diagnostics).toBeNull();

	const feature = buildIssue(
		{ kind: "feature", summary: "Export", fields: { problem: "I cannot share.", solution: "A button." } },
		"x: 1",
	);
	expect(feature.labels).toEqual(["enhancement"]);
	expect(feature.title).toBe("Feature: Export");
	expect(feature.text).toContain("### The problem this solves\n\nI cannot share.");
	expect(feature.text).toContain("### What I would like\n\nA button.");
});

test("everything typed is sanitized, the title and the diagnostics included", () => {
	const diagnostics = diagnosticsText({
		webui: "0.9.1",
		omp: "18.12.0",
		os: "macOS 15.1 (arm64)",
		mode: "full",
		browser: "Chrome/141",
		language: "en",
	});
	const issue = buildIssue(
		{
			kind: "bug",
			summary: "crash for jane@example.com",
			fields: { happened: "log: /Users/jdoe/x/y.log token=abcdef123456", steps: "1. open" },
		},
		`${diagnostics}\ncwd: /Users/jdoe/proj`,
		HOME,
	);
	const all = JSON.stringify(issue);
	expect(all).not.toContain("jane@example.com");
	expect(all).not.toContain("/Users/jdoe");
	expect(all).not.toContain("abcdef123456");
	expect(issue.title).toBe("Bug: crash for [email]");
	expect(issue.diagnostics).toContain("web UI: 0.9.1");
	expect(issue.diagnostics).toContain("cwd: ~/proj");
});

test("required fields: the summary and the first guided field", () => {
	expect(missingField({ kind: "bug", summary: "", fields: {} })).toBe("summary");
	expect(missingField({ kind: "bug", summary: "x", fields: { happened: "  " } })).toBe("happened");
	expect(missingField({ kind: "bug", summary: "x", fields: { happened: "y" } })).toBeNull();
	expect(missingField({ kind: "feature", summary: "x", fields: {} })).toBe("problem");
	expect(FEEDBACK_FIELDS.feature.filter((f) => f.required).map((f) => f.key)).toEqual(["problem"]);
});

const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of the report`).join("\n");

test("a short issue opens as written, with title, body and labels in the link", () => {
	const issue = buildIssue({ kind: "bug", summary: "Hi there", fields: { happened: "It broke & burned." } }, "OS: x");
	const link = issueLink(issue);
	expect(link.truncated).toBeNull();
	const url = new URL(link.url);
	expect(`${url.origin}${url.pathname}`).toBe("https://github.com/9s94ttyfct-bit/omp-webui/issues/new");
	expect(url.searchParams.get("title")).toBe("Bug: Hi there");
	expect(url.searchParams.get("labels")).toBe("bug");
	expect(url.searchParams.get("body")).toBe(link.body);
	expect(link.body).toBe("### What happened\n\nIt broke & burned.\n\n### Diagnostics\n\n```\nOS: x\n```");
});

test("too long a link gives up the diagnostics first, saying so", () => {
	const issue = buildIssue({ kind: "bug", summary: "Long", fields: { happened: "short" } }, long(2000));
	const link = issueLink(issue);
	expect(link.url.length).toBeLessThanOrEqual(URL_LIMIT);
	expect(link.truncated).toBe("diagnostics");
	expect(link.body).toContain("### What happened\n\nshort");
	expect(link.body).toContain("line 0 of the report");
	expect(link.body).toContain("Diagnostics were left out or cut");
	expect(link.body).not.toContain("line 1999");
	expect(new URL(link.url).searchParams.get("body")).toBe(link.body);
});

test("when the text itself is too long it is cut last, with a note, and the link still fits", () => {
	const issue = buildIssue({ kind: "bug", summary: "Long", fields: { happened: "é😀".repeat(6000) } }, "OS: x");
	const link = issueLink(issue);
	expect(link.url.length).toBeLessThanOrEqual(URL_LIMIT);
	expect(link.truncated).toBe("text");
	expect(link.body).toContain("### What happened");
	expect(link.body.endsWith("paste it here to replace this cut one._")).toBe(true);
	expect(link.body).not.toContain("### Diagnostics");
	// Cut between characters, never inside a surrogate pair: the link decodes back to the same body.
	expect(new URL(link.url).searchParams.get("body")).toBe(link.body);
	expect(link.body).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("the limit is the caller's to tighten", () => {
	const issue = buildIssue({ kind: "feature", summary: "S", fields: { problem: long(40) } }, null);
	const link = issueLink(issue, 600);
	expect(link.url.length).toBeLessThanOrEqual(600);
	expect(link.truncated).toBe("text");
});

const USER = "jdoe";

/** Each line is what a person might paste; `gone` must not survive, `kept` (what stays useful) must. */
const SANITIZE_TABLE: { name: string; text: string; gone: string[]; kept?: string[] }[] = [
	{ name: "Authorization: Basic", text: "Authorization: Basic dXNlcjpodW50ZXIy", gone: ["dXNlcjpodW50ZXIy", "Basic"] },
	{
		name: "Authorization in a curl header",
		text: "curl -H 'Authorization: Digest realm=x' https://a.test",
		gone: ["Digest", "realm"],
		kept: ["https://a.test"],
	},
	{
		name: "database URL",
		text: "DATABASE_URL=postgres://admin:hunter2@db.local:5432/app",
		gone: ["admin", "hunter2"],
		kept: ["@db.local:5432/app"],
	},
	{
		name: "https userinfo",
		text: "git clone https://user:pw@example.com/r.git",
		gone: ["user:pw"],
		kept: ["@example.com/r.git"],
	},
	{
		name: "a token as the user of a link",
		text: "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b",
		gone: ["ghp_"],
		kept: ["@github.com/a/b"],
	},
	{
		name: "--password flag",
		text: "mytool login --password hunter2 --verbose",
		gone: ["hunter2"],
		kept: ["--verbose"],
	},
	{
		name: "--token flag with a quoted value",
		text: 'mytool --api-key "hunter2 hunter3" run',
		gone: ["hunter2", "hunter3"],
		kept: ["run"],
	},
	{ name: "Cookie header", text: "Cookie: sid=abc123; theme=dark", gone: ["abc123", "theme"] },
	{ name: "Set-Cookie header", text: "Set-Cookie: sid=abc123; Path=/; HttpOnly", gone: ["abc123", "HttpOnly"] },
	{
		name: "signed URL",
		text: "https://a.blob.core.windows.net/c?sv=1&sig=abcDEF123%2Bxyz&se=2",
		gone: ["abcDEF123"],
		kept: ["&se=2"],
	},
	{
		name: "Azure AccountKey",
		text: "AccountName=x;AccountKey=Zm9vYmFy+abc/def==;EndpointSuffix=core",
		gone: ["Zm9vYmFy"],
		kept: ["EndpointSuffix=core"],
	},
	{ name: "Stripe live key", text: "key sk_live_abcdefghijklmnop1234 failed", gone: ["sk_live"] },
	{ name: "Stripe test key", text: "key sk_test_abcdefghijklmnop1234 failed", gone: ["sk_test"] },
	{ name: "AWS temporary key id", text: "id ASIAIOSFODNN7EXAMPLE used", gone: ["ASIAIOSFODNN7EXAMPLE"] },
	{ name: "bare AWS secret with a slash", text: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", gone: ["wJalrXUtnFEMI"] },
	{
		name: "home with a space in the name",
		text: "open /Users/John Smith/Documents/a.txt",
		gone: ["John", "Smith"],
		kept: ["~/Documents/a.txt"],
	},
	{
		name: "a Windows home with a space",
		text: "C:\\Users\\Jane Doe\\AppData\\x",
		gone: ["Jane", "Doe"],
		kept: ["AppData"],
	},
	{
		name: "omp's dash-encoded session folder",
		text: "/x/sessions/--Users-jdoe-omp-webui--/a.jsonl",
		gone: ["jdoe"],
		kept: ["omp-webui--/a.jsonl"],
	},
	{ name: "another person's dash-encoded folder", text: "--home-alice-proj--", gone: ["alice"], kept: ["proj--"] },
	{ name: "a shell prompt", text: "jdoe@MacBook-Pro omp-webui % bun test", gone: [USER], kept: ["bun test"] },
	{ name: "the user name in a log line", text: "owner=Jdoe uid=501", gone: ["Jdoe"], kept: ["uid=501"] },
];

test("credentials, links with logins, cookies, spaced and dash-encoded homes and the user name are removed", () => {
	for (const row of SANITIZE_TABLE) {
		const out = sanitize(row.text, HOME, USER);
		for (const gone of row.gone) expect(out, row.name).not.toContain(gone);
		for (const kept of row.kept ?? []) expect(out, row.name).toContain(kept);
		expect(sanitize(out, HOME, USER), `${row.name}: cleaning twice`).toBe(out);
	}
});

test("short or common user names are not hunted down in ordinary text", () => {
	expect(sanitize("root user: an admin at home", HOME, "root")).toBe("root user: an admin at home");
	expect(sanitize("ab ab ab", HOME, "ab")).toBe("ab ab ab");
	expect(sanitize("the jdoes and jdoe2", HOME, USER)).toBe("the jdoes and jdoe2");
});

/** #302: the shapes #210's table left out, and the ones it checked, each as a person would paste them. */
const SECRET_SHAPES: { name: string; text: string; gone: string[]; kept?: string[] }[] = [
	{
		name: "Google OAuth access token, bare",
		text: "the token endpoint answered ya29.a0AfH6SMBx3kQ9ZpLmN7vRtYwUeIoP2sDfGhJkLzXcVbNm1234 ok",
		gone: ["ya29", "a0AfH6SMB"],
		kept: ["answered", " ok"],
	},
	{
		name: "Google OAuth access token after a key",
		text: "auth: ya29.A0ARrdaM-9xYzLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ_abcdef",
		gone: ["ya29", "A0ARrdaM"],
	},
	{
		name: "Google OAuth refresh token, bare",
		text: "refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ok",
		gone: ["1//0g", "AbCdEfGh"],
		kept: ["refresh", " ok"],
	},
	{
		name: "Slack incoming webhook",
		text: "POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX failed",
		gone: ["T00000000", "B00000000", "XXXXXXXX"],
		kept: ["POST https://hooks.slack.com", " failed"],
	},
	{
		name: "Slack webhook inside JSON",
		text: '{"url": "https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/abcdefghijklmnopqrstuvwx", "n": 1}',
		gone: ["T01ABCDEF", "B02GHIJKL", "abcdefghijkl"],
		kept: ['", "n": 1}'],
	},
	{
		name: "Slack workflow webhook",
		text: "https://hooks.slack.com/workflows/T01ABCDEF/A02GHIJKL/123456789012345678/abcdefghijklmnopqrstuvwx sent",
		gone: ["T01ABCDEF", "123456789012345678"],
		kept: [" sent"],
	},
	{
		name: "curl -u user:pw",
		text: "curl -u admin:hunter2 https://api.test/v1",
		gone: ["admin", "hunter2"],
		kept: ["curl -u", "https://api.test/v1"],
	},
	{
		name: "curl --user user:pw",
		text: "curl --user alice:s3cr3tpass https://api.test/v1",
		gone: ["alice", "s3cr3tpass"],
		kept: ["https://api.test/v1"],
	},
	{
		name: "curl --user=user:pw",
		text: "curl --user=alice:s3cr3tpass -s x",
		gone: ["alice", "s3cr3tpass"],
		kept: ["-s x"],
	},
	{
		name: "curl -uuser:pw",
		text: "curl -uadmin:hunter2 https://api.test/v1",
		gone: ["admin", "hunter2"],
		kept: ["https://api.test/v1"],
	},
	{
		name: "curl -u with a quoted password containing spaces",
		text: "curl -u 'admin:hun ter2' https://api.test/v1",
		gone: ["admin", "hun", "ter2"],
		kept: ["https://api.test/v1"],
	},
	{
		name: "curl --proxy-user",
		text: "curl --proxy-user bob:pw123456 -x http://p:3128 https://a.test",
		gone: ["bob", "pw123456"],
		kept: ["-x http://p:3128", "https://a.test"],
	},
	{
		name: "password: and a spoken passphrase",
		text: "login failed, password: correct horse battery staple, then I retried",
		gone: ["correct", "horse", "battery", "staple"],
		kept: ["login failed,", "then I retried"],
	},
	{
		name: "the password is …",
		text: "the password is hunter2 and it still failed",
		gone: ["hunter2"],
		kept: ["the password is", "and it still failed"],
	},
	{ name: "my passphrase was …", text: "my passphrase was Tr0ub4dor&3.", gone: ["Tr0ub4dor"] },
	{
		name: "a password in brackets keeps the bracket",
		text: "login (password: hunter2) failed",
		gone: ["hunter2"],
		kept: ["login (password: ", ") failed"],
	},
	{
		name: "pwd=",
		text: "mount //srv/share user=bob pwd=hunter2 failed",
		gone: ["hunter2"],
		kept: ["user=bob", "failed"],
	},
	{ name: "pwd: after other settings", text: "user: bob, pwd: hunter2", gone: ["hunter2"], kept: ["user: bob,"] },
	{ name: "PWD= in capitals", text: "PWD=hunter2", gone: ["hunter2"] },
	{ name: "passphrase:", text: "passphrase: hunter2", gone: ["hunter2"] },
	{ name: "passcode =", text: "passcode = 482913", gone: ["482913"] },
	{
		name: "a PEM private key whose body lines have / and +",
		text: "the key follows\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAyZ0XK1Zp0aJHsd8f7sd8f7sdf8sd7f8sd7f8sd7f8sd7f8sd7f8sd7fg\nxQ+ab/cdEFgh12345678901234567890abcdefghijklmnopqrstuvwxyz0123456789AB\nqrst==\n-----END RSA PRIVATE KEY-----\nand then the log goes on",
		gone: ["BEGIN", "MIIEow", "xQ+ab", "qrst==", "END RSA"],
		kept: ["the key follows\n", "\nand then the log goes on"],
	},
	{
		name: "an OpenSSH private key",
		text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----",
		gone: ["b3BlbnNzaC1r", "OPENSSH"],
	},
	{
		name: "a PGP private key block",
		text: "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGJ8x2MBCADH\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----",
		gone: ["lQOYBGJ8x2MBCADH", "PGP"],
	},
	{
		name: "a private key block pasted without its END line",
		text: "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\nAASCBKcwggSjAgEAAoIBAQC7",
		gone: ["MIIEvQ", "AASCBK", "BEGIN"],
		kept: ["before\n"],
	},
	{
		name: "a JWT with an empty signature",
		text: "jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0. x",
		gone: ["eyJhbGci", "eyJzdWIi"],
		kept: ["jwt ", " x"],
	},
	{
		name: "a signed JWT",
		text: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk x",
		gone: ["eyJhbGci", "dBjftJeZ"],
		kept: [" x"],
	},
	{
		name: "GitHub ghp_ token",
		text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected",
		gone: ["ghp_"],
		kept: ["rejected"],
	},
	{
		name: "GitHub gho_ token",
		text: "token gho_abcdefghijklmnopqrstuvwxyz0123456789 rejected",
		gone: ["gho_"],
		kept: ["rejected"],
	},
	{
		name: "GitHub github_pat_ token",
		text: "token github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz0123 rejected",
		gone: ["github_pat_", "11ABCDEFG0"],
		kept: ["rejected"],
	},
	{ name: "AWS access key id", text: "key AKIAIOSFODNN7EXAMPLE used", gone: ["AKIAIOSFODNN7EXAMPLE"], kept: ["used"] },
	{
		name: "AWS secret access key, labelled",
		text: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		gone: ["wJalrXUtnFEMI"],
	},
	{
		name: "AWS secret access key, bare",
		text: "secret wJalrXUtnFEMI+K7MDENGbPxRfiCYEXAMPLEKEY1 here",
		gone: ["wJalrXUtnFEMI"],
		kept: ["here"],
	},
	{
		name: "Authorization: Bearer",
		text: "Authorization: Bearer abc123def456ghi789",
		gone: ["abc123def456"],
	},
	{
		name: "bearer in prose",
		text: "sent bearer abc123def456ghi789 to the server",
		gone: ["abc123def456"],
		kept: ["to the server"],
	},
	{
		name: "URL with user:password@",
		text: "git clone https://alice:hunter2@example.com/r.git",
		gone: ["alice", "hunter2"],
		kept: ["@example.com/r.git"],
	},
	{
		name: "URL with user@",
		text: "git clone ssh://alice@example.com/r.git",
		gone: ["alice"],
		kept: ["@example.com/r.git"],
	},
	{
		name: "e-mail address",
		text: "reach me at jane.doe@example.com please",
		gone: ["jane.doe", "example.com"],
		kept: ["please"],
	},
];

test("Google tokens, Slack webhooks, curl logins, passwords in prose, private keys and the other shapes in the table are removed", () => {
	for (const row of SECRET_SHAPES) {
		const out = sanitize(row.text, HOME, USER);
		for (const gone of row.gone) expect(out, row.name).not.toContain(gone);
		for (const kept of row.kept ?? []) expect(out, row.name).toContain(kept);
		expect(out, `${row.name}: something was put in its place`).toMatch(/\[redacted\]|\[email\]/);
		expect(sanitize(out, HOME, USER), `${row.name}: cleaning twice`).toBe(out);
	}
});

test("ordinary words, commands and commit ids are not mistaken for secrets", () => {
	for (const text of [
		"the password field is empty, the pass was green and Passwords must be 8 characters",
		"Error: the password is required, and the passphrase was not saved; your password is wrong",
		"pwd shows /tmp/x and pass: 12 fail: 0",
		"Sign-in shows 'enter your password' under the email box",
		"commit 058c3995ab7e1c2d3e4f5a6b7c8d9e0f1a2b3c4d and 058c399 (a1b2c3d) fixed it",
		"git rebase -i 058c399~3 && git push -u origin main",
		"docker run -u root alpine; ls -u /tmp; bun test -u",
		"the tokenizer splits words; the secretary read the authentication docs",
		"the ya29 prefix of Google tokens, and 1//2 of the pages",
		"hooks.slack.com is blocked by the proxy, see https://api.slack.com/messaging/webhooks",
		"Merge branch 'fix' of https://github.com/9s94ttyfct-bit/omp-webui into main",
		"-----BEGIN-----  a private key is a file, a key is what the file holds",
		"omp 18.12.0 · webui 0.11.1 on macOS 15.1 (arm64), built 2026-10-19",
	]) {
		expect(sanitize(text, HOME, USER), text).toBe(text);
	}
});

test("the summary limit leaves room for the prefix, so the title is never cut", () => {
	for (const kind of ["bug", "feature"] as const) {
		const issue = buildIssue({ kind, summary: "x".repeat(summaryMax(kind)), fields: {} }, null);
		expect(issue.title.length).toBe(TITLE_MAX);
		expect(issue.title.endsWith("x".repeat(summaryMax(kind)))).toBe(true);
	}
	expect(summaryMax("bug")).toBe(TITLE_MAX - "Bug: ".length);
	expect(summaryMax("feature")).toBe(TITLE_MAX - "Feature: ".length);
	// Whatever else happens to a title it stays whole characters.
	const emoji = buildIssue({ kind: "bug", summary: "😀".repeat(100), fields: {} }, null).title;
	expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("a long Chinese report is cut for the link but copied whole", () => {
	const report = "归档之后列表被重置，滚动位置也丢了。".repeat(120);
	const issue = buildIssue(
		{ kind: "bug", summary: "长报告", fields: { happened: report, steps: "1. 打开" } },
		"OS: macOS",
	);
	const link = issueLink(issue);
	expect(link.truncated).toBe("text");
	expect(link.body.length).toBeLessThan(report.length / 2);
	const full = fullText(issue);
	expect(full).toBe(`${issue.title}\n\n${issue.text}\n\n### Diagnostics\n\n\`\`\`\nOS: macOS\n\`\`\``);
	expect(full).toContain(report);
	expect(full).toContain("### Steps to reproduce\n\n1. 打开");
	// The cut body says the rest is on the clipboard.
	expect(link.body).toContain("copied to your clipboard");
	expect(fullText(buildIssue({ kind: "feature", summary: "S", fields: { problem: "P" } }, null))).toBe(
		"Feature: S\n\n### The problem this solves\n\nP",
	);
});
