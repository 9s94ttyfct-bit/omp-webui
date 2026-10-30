import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../server/config.ts";
import { ModeService } from "../../server/offline/index.ts";

/**
 * models.yml is read for every backend, even Ollama and LM Studio, which need no entry in it. When the file cannot be
 * parsed, Settings used to be told that no backend has an address, which it words as "Light needs a provider
 * named omlx" (#444): wrong for a person on Ollama, and the parse error that is the real cause only showed later, as a
 * toast when a chat was started. The state keeps the error with the backend it concerns.
 */

let root: string;
let cfg: Config;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompw-mode-unreadable-"));
	cfg = {
		ompBin: "omp",
		agentDir: join(root, "user"),
		sessionsDir: join(root, "user", "sessions"),
		dataDir: join(root, "data"),
		host: "127.0.0.1",
		port: 0,
		distDir: root,
		autoPort: false,
		parentPid: null,
	};
	mkdirSync(cfg.agentDir, { recursive: true });
	mkdirSync(cfg.dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const modelsYml = (text: string) => writeFileSync(join(cfg.agentDir, "models.yml"), text);

test("a models.yml that cannot be parsed is reported for every backend, with the file and the parse error", () => {
	modelsYml("providers:\n  ollama: {baseUrl: [\n");
	const { backends } = new ModeService(cfg).state();
	for (const backend of ["omlx", "ollama", "lm-studio"] as const) {
		expect(backends[backend].baseUrl).toBeNull();
		expect(backends[backend].error).toMatchObject({
			code: "offlineModelsUnreadable",
			params: { path: join(cfg.agentDir, "models.yml") },
		});
		expect(backends[backend].error?.message).toContain(`${join(cfg.agentDir, "models.yml")} could not be read`);
		expect(backends[backend].error?.message).toContain("YAML Parse error");
	}
});

test("a readable models.yml reports no error: Ollama has its address, oMLX without an entry just has none", () => {
	modelsYml("providers:\n  other:\n    baseUrl: http://127.0.0.1:9/v1\n");
	const { backends } = new ModeService(cfg).state();
	expect(backends.ollama).toEqual({ baseUrl: "http://127.0.0.1:11434/v1", source: "default" });
	expect(backends.omlx).toEqual({ baseUrl: null, source: null });
});

test("the error goes away once the file is fixed", () => {
	const svc = new ModeService(cfg);
	modelsYml("key: [unclosed");
	expect(svc.state().backends.ollama.error?.code).toBe("offlineModelsUnreadable");
	modelsYml("providers:\n  ollama:\n    baseUrl: http://127.0.0.1:1/v1\n");
	expect(svc.state().backends.ollama).toEqual({ baseUrl: "http://127.0.0.1:1/v1", source: "models.yml" });
});
