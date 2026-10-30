/**
 * omp's `config.yml` as a test leaves it plus `block` (top-level YAML keys). omp writes the file without a closing newline,
 * and an `omp config reset` that empties it leaves `{}` (a flow mapping): text appended to either is not YAML omp can read
 * (`thresholdPercent: 80mnemopi:`, `{}mnemopi:`), and omp then sets the file aside, so a spec that ran after one that used
 * `omp config` would see none of its own settings (#649). The block goes after the file's own lines, on a line of its own.
 */
export function withYaml(original: string, block: string): string {
	const own = original.trim();
	const head = own === "" || own === "{}" ? "" : `${original.replace(/\s+$/, "")}\n`;
	const tail = block.replace(/^\n+/, "");
	return `${head}${tail.endsWith("\n") ? tail : `${tail}\n`}`;
}
