import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	applySchema,
	insertDerived,
	insertEpisodic,
	insertWorking,
	type SeedEpisodic,
	type SeedWorking,
} from "./mnemopi-seed.ts";

/**
 * Mnemopi databases for the specs that run under Node, in the agent directory of a test's own server (`<agent>/memories/
 * mnemopi/mnemopi.db`, and `…/banks/<bank>/mnemopi.db` for a project's), made with `node:sqlite` (the unit and contract
 * tests use `bun:sqlite`: `mnemopi-store.ts`). The shared bank is `default`, as omp names it with no `mnemopi.bank` set.
 */

export const SHARED_BANK = "default";

export interface BankSeed {
	working?: SeedWorking[];
	episodic?: SeedEpisodic[];
	/** Working memories that also have the rows omp derives from them (facts, edges…), which deleting one takes away. */
	derivedFor?: string[];
}

/** Where `bank`'s database is under an agent directory. */
export function bankPath(agentDir: string, bank: string): string {
	const shared = join(agentDir, "memories", "mnemopi", "mnemopi.db");
	return bank === SHARED_BANK ? shared : join(dirname(shared), "banks", bank, "mnemopi.db");
}

/** Create `bank`'s database under `agentDir` and put `seed` in it; returns the path. */
export function seedBank(agentDir: string, bank: string, seed: BankSeed = {}): string {
	const path = bankPath(agentDir, bank);
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	try {
		applySchema(db);
		for (const w of seed.working ?? []) insertWorking(db, bank, w);
		for (const e of seed.episodic ?? []) insertEpisodic(db, bank, e);
		for (const id of seed.derivedFor ?? []) insertDerived(db, id);
	} finally {
		db.close();
	}
	return path;
}

/** Read a bank's memory text by id (what omp would recall), or null when it is not there. */
export function storedContent(agentDir: string, bank: string, id: string): string | null {
	const db = new DatabaseSync(bankPath(agentDir, bank), { readOnly: true });
	try {
		const row = db.prepare("SELECT content FROM working_memory WHERE id = ?").get(id) as
			| { content: string }
			| undefined;
		return row?.content ?? null;
	} finally {
		db.close();
	}
}
