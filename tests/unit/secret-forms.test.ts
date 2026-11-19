import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../server/migrate/secrets.ts";
import { looksLikeSecret } from "../../shared/memory.ts";
import { blankSecretForms } from "../../shared/secret-forms.ts";
import { sanitize } from "../../web/src/lib/feedback.ts";

/**
 * Three places look for secrets in text (an export made without credentials, a public bug report, the Memory page's
 * warning) and used to disagree on common forms: a database URL with a password, a `--password` argument and an
 * `aws_secret_access_key =` line stayed in an AGENTS.md that the export called clean (#338). One table, all three.
 */

const FORMS: Record<string, { text: string; secret: string }> = {
	"a database URL with a password": {
		text: "- Staging DB: postgres://app:Pg4ssw0rdX@db.example.com:5432/app",
		secret: "Pg4ssw0rdX",
	},
	"a --password argument": { text: "- mysql --password S3cr3tPass99 -h db.example.com", secret: "S3cr3tPass99" },
	"an AWS secret key line": {
		text: "- AWS: aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
		secret: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
	},
	"pwd=": { text: "connect with pwd=hunter2 and retry", secret: "hunter2" },
	"a password written in prose": { text: "the staging password is correcthorse7", secret: "correcthorse7" },
	"a Bearer header": { text: "curl -H 'Authorization: Bearer abcdef0123456789xyz'", secret: "abcdef0123456789xyz" },
	"a GitHub token": { text: "token ghp_0123456789abcdefghijABCDEFGHIJ", secret: "ghp_0123456789abcdefghijABCDEFGHIJ" },
};

describe("the same secrets, in every place that looks for them", () => {
	for (const [name, { text, secret }] of Object.entries(FORMS)) {
		test(name, () => {
			expect(looksLikeSecret(text), "the Memory page warns").toBe(true);
			expect(sanitize(text), "a bug report loses it").not.toContain(secret);
			const redaction = redactSecrets(`# Notes\n\n${text}\n`, "text");
			expect(redaction.count, "an export blanks it").toBeGreaterThan(0);
			expect(redaction.text).not.toContain(secret);
			expect(redaction.text).toContain("# Notes");
			expect(redaction.clean).toBe(true);
		});
	}
});

test("what a person wrote around a secret stays, and ordinary prose is not taken for one", () => {
	const prose = [
		"# Project notes",
		"Pass `--token` to the tool; the primary_key = id and the token: abc are settings.",
		"Set password = ${DB_PASSWORD} in the environment, or <your-password>.",
		"The password is required and the pass was green. Run `compass --port 8080`, `cd $PWD`, `pwd=/home/me`.",
	].join("\n");
	expect(blankSecretForms(prose).count).toBe(0);
	expect(redactSecrets(prose, "text").text).toBe(prose);
	const kept = blankSecretForms("db: postgres://app:Pg4ssw0rdX@db.example.com/app, then restart");
	expect(kept.text).toBe("db: postgres://app:@db.example.com/app, then restart");
});
