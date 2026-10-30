import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { DEFAULT_OFFLINE, type LightModels, type Mode, type ModeState } from "../../shared/offline.ts";
import { loadModelCatalog } from "../../web/src/lib/model-config.ts";
import { useMode } from "../../web/src/lib/offline.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The model lists the page names models from. Two lists exist: omp's own (Full, Light on the person's own models, and the
 * roles and presets edited in Settings) and the models of the local server Light's models can be (`scope=local`). What
 * was loaded is kept for a minute per list, never across servers or addresses: another server's list is not this one's (#441).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const OMP = [{ provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }];
const OLLAMA = [{ provider: "ollama", id: "llama3", name: "llama3" }];

let asked: string[];
let rev = 0;
let fetchSpy: Mock<typeof fetch>;

function modeState(mode: Mode, lightModels: LightModels, ollamaAddress = "http://127.0.0.1:11434/v1"): ModeState {
	return {
		mode,
		lightModels,
		offline: { ...DEFAULT_OFFLINE, backend: "ollama" },
		mcpServers: [],
		mcpOff: [],
		missingMcp: [],
		backends: {
			omlx: { baseUrl: null, source: null },
			ollama: { baseUrl: ollamaAddress, source: "default" },
			"lm-studio": { baseUrl: "http://127.0.0.1:1234/v1", source: "default" },
		},
		boot: "test",
		rev: ++rev,
	};
}

/** Like the server: the local server's list for `scope=local`, omp's own for anything else. */
function server() {
	fetchSpy.mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		asked.push(url);
		return Response.json(url.includes("scope=local") ? OLLAMA : OMP);
	}) as typeof fetch);
}

beforeEach(() => {
	asked = [];
	fetchSpy = spyOn(globalThis, "fetch");
	server();
});
afterEach(() => fetchSpy.mockRestore());

test("omp's own list is asked for without a scope, whatever the mode is; the local server's with scope=local", async () => {
	useMode.setState({ state: modeState("light", "local") });
	expect(await loadModelCatalog("omp")).toEqual(OMP);
	expect(asked).toEqual(["/api/models"]);
	expect(await loadModelCatalog("local")).toEqual(OLLAMA);
	expect(asked).toEqual(["/api/models", "/api/models?scope=local"]);
});

test("omp's list is kept across modes; a local list is not served to another server's address", async () => {
	useMode.setState({ state: modeState("full", "yours") });
	expect(await loadModelCatalog("omp")).toEqual(OMP);
	const before = asked.length;
	// Another mode is no other omp list: kept within the minute.
	useMode.setState({ state: modeState("light", "yours") });
	expect(await loadModelCatalog("omp")).toEqual(OMP);
	useMode.setState({ state: modeState("light", "local") });
	expect(await loadModelCatalog("omp")).toEqual(OMP);
	expect(asked).toHaveLength(before);

	// An address no other test used: the local list is kept per backend and address, for the whole run of the module.
	useMode.setState({ state: modeState("light", "local", "http://127.0.0.1:8001/v1") });
	expect(await loadModelCatalog("local")).toEqual(OLLAMA);
	expect(asked).toHaveLength(before + 1);
	expect(await loadModelCatalog("local")).toEqual(OLLAMA);
	expect(asked).toHaveLength(before + 1);

	// A backend whose address changed is another list; the one before is still there when the address comes back.
	useMode.setState({ state: modeState("light", "local", "http://127.0.0.1:8002/v1") });
	expect(await loadModelCatalog("local")).toEqual(OLLAMA);
	expect(asked).toHaveLength(before + 2);
	expect(asked.at(-1)).toBe("/api/models?scope=local");
	useMode.setState({ state: modeState("light", "local", "http://127.0.0.1:8001/v1") });
	expect(await loadModelCatalog("local")).toEqual(OLLAMA);
	expect(asked).toHaveLength(before + 2);
});
