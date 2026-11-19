import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { CONFLICT_LIMITS } from "../../../shared/guidance-conflict.ts";
import type { MemoryItem } from "../../../shared/memory.ts";
import { inside, rootOf } from "../../folder.ts";
import { mayEdit } from "../../folder-write.ts";
import type { ReviewerSource } from "../../guard-reviewer.ts";
import type { TransferEnv } from "../../transfer-core.ts";
import { chooseReviewers } from "../gate/review.ts";
import { GuidanceConflictCheck } from "./conflict-check.ts";
import { contextSources, memorySources } from "./conflict-sources.ts";
import { loadedContextFiles } from "./loaded-context.ts";

/**
 * The guidance conflict check with the server's own parts (`conflict-check.ts` is the check; this is where it reads from):
 *
 * - The model: the guard reviewer's path (`ompReviewer`, one `omp -p` that carries nothing of omp's but the request), chosen
 *   by the gate's rule as the guard's benchmark chooses it (`chooseReviewers`): the reviewer set in the guard's settings,
 *   else omp's `reviewer` role, else its `smol`, `slow` and `default` roles in that order, else the cheapest model signed
 *   in. No agent's model is given, so none is passed over for its family. The first two are tried.
 * - The files: what omp says it gives the agent in that folder (`loaded-context.ts`: a short-lived omp started there, whose
 *   system prompt lists them with their `@` imports expanded, #308), so that omp's settings, its choice of one file per
 *   provider and depth and its opt-in providers are its own. A file the Files tab may write (`mayEdit`, as a page on this
 *   computer) is one a change may be proposed for, by its path in the conversation's folder.
 * - The memories: what the Memory page reads (`MemoryService.forFolder`).
 */

export interface ConflictServerDeps {
	ompBin: string;
	/** omp's agent folder (`~/.omp/agent`): the probe that lists the context files is given a copy of it without its `mcp.json`. */
	agentDir: string;
	/** Every folder an omp-webui keeps its data in, and the places nothing is written (as `TransferEnv` has them). */
	dataDirs: readonly string[];
	protect: readonly string[];
	reviewer: ReviewerSource;
	/** The guard's reviewer setting, as selectors (`reviewerSelectors`); read at each check. */
	configured(): string[];
	/** Whether Settings has the check on. */
	enabled(): boolean;
	memories(cwd: string, limit: number): Promise<MemoryItem[]>;
}

export function serverConflictCheck(deps: ConflictServerDeps): GuidanceConflictCheck {
	const home = homedir();
	const env: TransferEnv = {
		setting: "full",
		owner: true,
		who: "local",
		dataDirs: deps.dataDirs,
		protect: deps.protect,
		home,
	};
	return new GuidanceConflictCheck({
		enabled: deps.enabled,
		async models() {
			const { models, chain } = await deps.reviewer.choice();
			return chooseReviewers({ configured: deps.configured(), chain, agent: undefined }, models).models;
		},
		ask: deps.reviewer.ask,
		async files(cwd) {
			const root = await rootOf(cwd);
			const loaded = await loadedContextFiles(deps.ompBin, cwd, deps.agentDir);
			return contextSources(loaded, cwd, home, async (abs) => {
				// The file's place as the Files tab names it: its folder's real path, inside the conversation's folder.
				const dir = await realpath(dirname(abs)).catch(() => null);
				if (!dir || !inside(root, dir)) return null;
				const rel = relative(root, join(dir, basename(abs)))
					.split(sep)
					.join("/");
				return (await mayEdit(root, rel, env)) ? rel : null;
			});
		},
		async memories(cwd) {
			return memorySources(await deps.memories(cwd, CONFLICT_LIMITS.memories));
		},
	});
}
