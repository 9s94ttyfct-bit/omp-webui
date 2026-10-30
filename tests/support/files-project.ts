import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { solidPng } from "./chat-session.ts";

/**
 * A project folder for the Files tab's specs: code in folders, Markdown, an image, an SVG, a binary file, a large text file, a
 * file with a space in its name, dotfiles and a dependency folder (hidden by default), a git repository with one changed
 * file and one new one, and a link that leads out of the folder. Made-up names throughout.
 *
 *   <root>/
 *     proj/         the conversation's folder
 *     secret.txt    outside it: what the link in `proj` points at
 */

const write = (base: string, rel: string, data: string | Uint8Array) => {
	const path = join(base, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
};

export const APP_TS = `import { greet } from "./lib/greet.ts";

/** Says hello to everyone on the list. */
export function main(names: string[]): string[] {
	return names.map((name) => greet(name));
}

export const VERSION = "1.4.2";
`;

export const README = `# Sample project

A small project for **trying out** the Files tab.

## What is in it

- \`src/\`: the code
- \`docs/\`: notes

\`\`\`ts
const answer = 42;
\`\`\`

See [the guide](docs/guide.md).
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><rect width="96" height="64" rx="8" fill="#3b82f6"/><circle cx="32" cy="32" r="18" fill="#fde68a"/><rect x="56" y="20" width="26" height="24" rx="4" fill="#ffffff"/></svg>`;

function git(cwd: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			stdio: "pipe",
		},
	);
}

/** Make the project under `root` and return its folder. */
export function makeFilesProject(root: string): string {
	const proj = join(root, "proj");
	mkdirSync(proj, { recursive: true });
	writeFileSync(join(root, "secret.txt"), "the secret outside the folder");
	write(proj, "README.md", "# Sample project\n\nFirst version.\n");
	write(proj, "src/app.ts", APP_TS);
	write(proj, "src/lib/greet.ts", 'export const greet = (name: string): string => ["Hello, ", name, "!"].join("");\n');
	write(proj, "src/components/Button.tsx", 'export const Button = () => <button type="button">Go</button>;\n');
	write(proj, "docs/guide.md", "# Guide\n\nRead the code.\n");
	write(proj, "notes with space.txt", "a file with a space in its name\n");
	write(proj, "Dockerfile", 'FROM oven/bun:1\nCOPY . .\nCMD ["bun", "src/app.ts"]\n');
	write(proj, ".gitignore", "build.out/\n*.log\n");
	write(proj, ".env", "TOKEN=not-a-real-token\n");
	write(proj, "node_modules/dep/index.js", "module.exports = 1;\n");
	git(proj, "init", "-q", "-b", "main");
	git(proj, "add", ".");
	git(proj, "commit", "-q", "-m", "first");
	// After the commit: one file changed, one new, one ignored, and the files that are not text or not code.
	write(proj, "README.md", README);
	write(proj, "src/new.ts", "export const fresh = true;\n");
	write(proj, "build.out/bundle.js", "x");
	write(proj, "logo.png", solidPng(160, 100, [59, 130, 246]));
	write(proj, "icon.svg", SVG);
	write(proj, "data.bin", new Uint8Array([0, 1, 2, 3, 0, 255, 254, 0]));
	write(proj, "big.txt", `${"2026-01-09T00:00:00Z INFO request handled in 12ms\n".repeat(26_000)}`);
	symlinkSync(join(root, "secret.txt"), join(proj, "link-out.txt"));
	symlinkSync(join(proj, "src"), join(proj, "link-src"));
	return proj;
}
