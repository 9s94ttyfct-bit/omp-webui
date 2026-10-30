/**
 * Release notes must be bilingual (`bun scripts/check-release-notes.ts vX.Y.Z`; release.yml runs it first).
 *
 * `release-notes/vX.Y.Z.md` has one section per language, each opened by a level-2 heading:
 *
 *   ## English
 *   …notes, with ### headings of their own…
 *   ## 中文
 *   …the same notes in Chinese…
 *
 * Notes written before this rule (up to v0.9.1) are Chinese only and stay as they are; the check applies to
 * later tags and fails if the file is missing or either section is missing, empty, or in the wrong language.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The last release whose notes predate the rule. */
export const LAST_UNILINGUAL = [0, 9, 1];

export function versionOf(tag: string): number[] | null {
	const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isAfter(version: number[], than: number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] !== than[i]) return (version[i] as number) > (than[i] as number);
	}
	return false;
}

/** What is wrong with the notes' text, one sentence per problem; empty when both sections are there. */
export function problemsIn(text: string): string[] {
	const sections = new Map<string, string>();
	let current: string | null = null;
	for (const line of text.split("\n")) {
		const heading = /^## +(.+?) *$/.exec(line);
		if (heading) {
			current = heading[1] as string;
			if (!sections.has(current)) sections.set(current, "");
		} else if (current !== null) {
			sections.set(current, `${sections.get(current)}${line}\n`);
		}
	}
	const problems: string[] = [];
	const english = sections.get("English");
	const chinese = sections.get("中文");
	if (english === undefined) problems.push("no `## English` section");
	else if (!english.trim()) problems.push("the `## English` section is empty");
	else if (/[\u4e00-\u9fff]/.test(english)) problems.push("the `## English` section contains Chinese text");
	if (chinese === undefined) problems.push("no `## 中文` section");
	else if (!chinese.trim()) problems.push("the `## 中文` section is empty");
	else if (!/[\u4e00-\u9fff]/.test(chinese)) problems.push("the `## 中文` section has no Chinese text");
	return problems;
}

if (import.meta.main) {
	const tag = process.argv[2] ?? "";
	const version = versionOf(tag);
	if (!version) {
		console.error(`usage: bun scripts/check-release-notes.ts vX.Y.Z (got "${tag}")`);
		process.exit(2);
	}
	if (!isAfter(version, LAST_UNILINGUAL)) {
		console.log(`${tag} predates bilingual release notes: not checked.`);
		process.exit(0);
	}
	const file = join(import.meta.dirname, "..", "release-notes", `${tag}.md`);
	if (!existsSync(file)) {
		console.error(`release-notes/${tag}.md is missing: write it with a "## English" and a "## 中文" section.`);
		process.exit(1);
	}
	const problems = problemsIn(readFileSync(file, "utf8"));
	if (problems.length > 0) {
		console.error(`release-notes/${tag}.md: ${problems.join("; ")}.`);
		process.exit(1);
	}
	console.log(`release-notes/${tag}.md has an English and a Chinese section.`);
}
