/**
 * CLI ↔ Web UI parity report (`bun run parity`).
 *
 * Builds the inventory from the installed omp, resolves each item to its UI
 * surface, and statically checks that every surface exists in the web UI
 * source (route components, data-testids). The E2E spec
 * `tests/e2e/parity.spec.ts` then proves each surface in a running browser.
 * Exits non-zero below 100%.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fullInventory } from "../tests/parity/inventory.ts";
import { describeSurface, FLAG_SURFACES, type Surface, surfaceFor } from "../tests/parity/mapping.ts";

const SRC = join(import.meta.dir, "..", "web", "src");
const source = readdirSync(SRC, { recursive: true })
	.map(String)
	.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
	.map((f) => readFileSync(join(SRC, f), "utf8"))
	.join("\n");
const has = (needle: string) => source.includes(needle);

/** Static evidence that the UI implements a surface kind. */
function implemented(s: Surface): boolean {
	switch (s.kind) {
		case "cli-command":
			// CliPage renders one entry per command reported by /api/cli.
			return has('data-testid="cli-command"') && has("data-command={c.name}");
		case "session-option":
			// NewChat's FlagForm renders one control per flag reported by /api/cli.
			return has("data-flag={f.name}") && has("sessionFlags(");
		case "slash-menu":
			// The composer lists every command from RPC get_available_commands.
			return has('data-testid="slash-menu"') && has("get_available_commands");
		case "control":
			return has(`data-testid="${s.testid}"`);
		case "command-line":
			return has('data-testid="cli-line"') && has("pty_open");
	}
}

const inventory = await fullInventory();
const rows = inventory.map((item) => {
	const surface = surfaceFor(item);
	return { item, surface, ok: implemented(surface) };
});
const stale = Object.keys(FLAG_SURFACES).filter((f) => !inventory.some((i) => i.kind === "flag" && i.name === f));

const byKind = new Map<string, { total: number; ok: number }>();
for (const r of rows) {
	const k = byKind.get(r.item.kind) ?? { total: 0, ok: 0 };
	k.total++;
	if (r.ok) k.ok++;
	byKind.set(r.item.kind, k);
}

const verbose = process.argv.includes("--verbose");
for (const r of rows) {
	if (verbose || !r.ok)
		console.log(`${r.ok ? "✓" : "✗"} ${r.item.kind.padEnd(7)} ${r.item.name.padEnd(24)} ${describeSurface(r.surface)}`);
}
for (const [kind, k] of byKind) console.log(`${kind.padEnd(8)} ${k.ok}/${k.total}`);
if (stale.length) console.log(`note: mapping entries for flags omp no longer has: ${stale.join(", ")}`);
const ok = rows.filter((r) => r.ok).length;
const pct = (100 * ok) / rows.length;
console.log(`\nparity: ${ok}/${rows.length} items mapped to implemented UI surfaces (${pct.toFixed(1)}%)`);
process.exit(ok === rows.length ? 0 : 1);
