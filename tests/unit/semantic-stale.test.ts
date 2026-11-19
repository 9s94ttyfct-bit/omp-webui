import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../server/semantic/assets.ts";
import { removeStale } from "../../server/semantic/install.ts";
import { removeScratch } from "../support/scratch.ts";

/** What an older build, a replaced model or an unpack cut short left in semantic search's folder goes (#210). */

const root = mkdtempSync(join(tmpdir(), "ompw-semstale-"));
afterAll(() => removeScratch(root));

const SERVER = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const model: Asset = { name: "model-new.gguf", urls: [], size: 5, sha256: "" };

function folder(): string {
	const dir = mkdtempSync(join(root, "case-"));
	mkdirSync(join(dir, "runtime-b200"), { recursive: true });
	writeFileSync(join(dir, "runtime-b200", SERVER), "x");
	mkdirSync(join(dir, "model"), { recursive: true });
	writeFileSync(join(dir, "model", model.name), "12345");
	return dir;
}

test("an older build, a cut-short unpack and a replaced model go; the current ones and the rest of the folder stay", () => {
	const dir = folder();
	mkdirSync(join(dir, "runtime-b100"));
	writeFileSync(join(dir, "runtime-b100", SERVER), "old");
	mkdirSync(join(dir, "runtime-b200.unpack-1a2b3c4d"));
	writeFileSync(join(dir, "model", "model-old.gguf"), "old model");
	writeFileSync(join(dir, "index.db"), "the index");
	writeFileSync(join(dir, "on"), "");

	removeStale(dir, model, "b200");

	expect(readdirSync(dir).sort()).toEqual(["index.db", "model", "on", "runtime-b200"]);
	expect(readdirSync(join(dir, "model"))).toEqual([model.name]);
	expect(existsSync(join(dir, "runtime-b200", SERVER))).toBe(true);
});

test("nothing is removed while the current build and model are not all there", () => {
	const dir = folder();
	mkdirSync(join(dir, "runtime-b100"));
	// The new model is cut short (a size that is not the pinned one): the old build may be what still works.
	writeFileSync(join(dir, "model", model.name), "123");
	removeStale(dir, model, "b200");
	expect(existsSync(join(dir, "runtime-b100"))).toBe(true);
});
