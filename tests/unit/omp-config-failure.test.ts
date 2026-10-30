import { expect, test } from "bun:test";
import { ompFailure } from "../../server/omp/model-config.ts";

/**
 * What the model settings say when an `omp config` command fails. omp is a Bun program: an error it does not catch is
 * printed as an excerpt of its own bundled source, then `error: <message>`, then the stack. The message used to be cut
 * to the first 300 characters of that, which kept only the excerpt (#443).
 */

/** omp 18.12.3's stderr for `omp config list --json` on a config.yml with a YAML syntax error (paths shortened). */
const INVALID_CONFIG = `54042 |     switch (p.kind) {
54043 |       case "missing":
54044 |         return null;
54045 |       case "loaded":
54046 |         return p.settings;
54047 |         throw new Error(\`Settings config is invalid: \${u}\${p.backupPath ? \` (moved to \${p.backupPath})\` : ""}: \${String(p.error)}\`);
                      ^
error: Settings config is invalid: /home/me/.omp/agent/config.yml (moved to /home/me/.omp/agent/config.yml.broken-1792518702942-18713-6302a89a-4f3c-4b06-8fd5-2da47b70a43b): SyntaxError: YAML Parse error: Unexpected token
      at #Re (/$bunfs/root/chunks/cli-9z7szc2v.js:54047:15)
      at #Fe (/$bunfs/root/chunks/cli-9z7szc2v.js:54022:25)
      at async <anonymous> (/$bunfs/root/chunks/cli-9z7szc2v.js:54007:31)
`;

test("an uncaught error of omp is told by its message, not by the source excerpt above it", () => {
	const said = ompFailure(INVALID_CONFIG);
	expect(said).toBe(
		"Settings config is invalid: /home/me/.omp/agent/config.yml (moved to /home/me/.omp/agent/config.yml.broken-1792518702942-18713-6302a89a-4f3c-4b06-8fd5-2da47b70a43b): SyntaxError: YAML Parse error: Unexpected token",
	);
});

test("a message of several lines is kept whole, up to the stack", () => {
	expect(ompFailure("1 | boom()\n      ^\nerror: first line\nsecond line\n\n      at x (file:1:1)\n")).toBe(
		"first line second line",
	);
});

test("output without an `error:` line is cut from the end: the last words are the reason", () => {
	const noisy = `${"warming up\n".repeat(60)}no such key: nope\n`;
	const said = ompFailure(noisy);
	expect(said.length).toBeLessThanOrEqual(300);
	expect(said.endsWith("no such key: nope")).toBe(true);
	expect(ompFailure("  plain failure  \n")).toBe("plain failure");
});
