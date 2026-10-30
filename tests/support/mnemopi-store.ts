import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { layoutOf, type MemoryLayout } from "../../server/memory/store.ts";
import { applySchema, insertEpisodic, insertWorking, type SeedEpisodic, type SeedWorking } from "./mnemopi-seed.ts";
import { tempDir } from "./temp-dirs.ts";

export {
	DAY,
	insertDerived,
	insertEpisodic,
	insertWorking,
	type SeedEpisodic,
	type SeedWorking,
} from "./mnemopi-seed.ts";

/**
 * Mnemopi databases for the tests that run under Bun, laid out as omp lays its memories out (`<agent dir>/memories/mnemopi/
 * mnemopi.db` for the shared bank, `…/banks/<bank>/mnemopi.db` for each project's). What goes into them is
 * `mnemopi-seed.ts` (shared with the browser specs, which run under Node). Never inside a real agent directory: every
 * store has a directory of its own in the system's temp folder, which the tests leave where it is.
 */

export function createDb(path: string): Database {
	mkdirSync(join(path, ".."), { recursive: true });
	const db = new Database(path, { create: true });
	applySchema(db);
	return db;
}

export interface MemoryFixture {
	root: string;
	agentDir: string;
	dataDir: string;
	layout: MemoryLayout;
	/** The path of a bank's database (the shared bank's when it is `default`). */
	pathOf(bank: string): string;
	/** Create a bank's database and put `seed` in it; returns the open connection (close it when done). */
	bank(name: string, seed?: { working?: SeedWorking[]; episodic?: SeedEpisodic[] }): Database;
}

/** A store in a temp folder of its own. */
export function memoryFixture(sharedBank = "default"): MemoryFixture {
	const root = tempDir("ompw-mem-");
	const agentDir = join(root, "agent");
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	const layout = layoutOf(agentDir, null, sharedBank === "default" ? null : sharedBank);
	const pathOf = (bank: string) =>
		bank === layout.sharedBank ? layout.sharedDb : join(layout.banksDir, bank, "mnemopi.db");
	return {
		root,
		agentDir,
		dataDir,
		layout,
		pathOf,
		bank(name, seed = {}) {
			const db = createDb(pathOf(name));
			for (const w of seed.working ?? []) insertWorking(db, name, w);
			for (const e of seed.episodic ?? []) insertEpisodic(db, name, e);
			return db;
		},
	};
}
