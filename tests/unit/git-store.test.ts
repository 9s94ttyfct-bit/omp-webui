import { afterEach, expect, test } from "bun:test";
import type { GitReport, GitStatus } from "../../shared/git.ts";
import { refreshGit, useGit } from "../../web/src/store/git.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const status = (branch: string): GitStatus => ({ branch, detached: false, staged: 0, unstaged: 0, untracked: 0 });
const pull = (n: number) => ({ number: n, url: `https://github.com/o/r/pull/${n}` });

/**
 * Answer `/api/git` by its query string (`pr=1&fresh=1` …): a held answer waits for its gate. Like the server, it takes an
 * ask for the pull request or a fresh look only as a POST (with the header that makes a browser preflight it), and a
 * plain look only as a GET.
 */
function serve(answers: Record<string, () => GitReport | Promise<GitReport>>, asked: string[] = []): string[] {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const query = new URL(String(input), "http://x").search.slice(1).replace(/^cwd=[^&]*&?/, "");
		asked.push(query);
		const starts = query.includes("pr=1") || query.includes("fresh=1");
		const headers = new Headers(init?.headers);
		if (starts !== (init?.method === "POST") || starts !== (headers.get("x-omp-webui") === "1")) {
			return new Response(JSON.stringify({ error: starts ? "POST required" : "unexpected POST" }), { status: 405 });
		}
		const answer = answers[query];
		if (!answer) throw new Error(`unexpected ask: ${query}`);
		return new Response(JSON.stringify(await answer()));
	}) as typeof fetch;
	return asked;
}

const settle = async (done: () => boolean) => {
	for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
	expect(done()).toBe(true);
};

test("a slow answer older than the one on screen does not put the old branch and its pull request back", async () => {
	const cwd = "/repo/out-of-order";
	const gate = Promise.withResolvers<void>();
	serve({
		// The ask made first answers last, from before the branch was switched.
		"pr=1&fresh=1": async () => {
			await gate.promise;
			return { git: status("main"), pr: pull(5) };
		},
		"": () => ({ git: status("other") }),
		"pr=1": () => ({ git: status("other"), pr: pull(9) }),
	});
	const slow = refreshGit(cwd, { pr: true, fresh: true });
	await refreshGit(cwd);
	await settle(() => useGit.getState().byCwd[cwd]?.pr?.number === 9);
	gate.resolve();
	await slow;
	const folder = useGit.getState().byCwd[cwd];
	expect(folder?.git?.branch).toBe("other");
	expect(folder?.pr?.number).toBe(9);
});

test("a branch switched in a terminal asks for the new branch's pull request, and the old one goes at once", async () => {
	const cwd = "/repo/switched";
	let branch = "main";
	const asked = serve({
		"": () => ({ git: status(branch) }),
		"fresh=1": () => ({ git: status(branch) }),
		"pr=1": () => ({ git: status(branch), pr: branch === "main" ? pull(1) : null }),
	});
	await refreshGit(cwd, { pr: true });
	expect(useGit.getState().byCwd[cwd]?.pr?.number).toBe(1);
	// Focus asks for the status only; the answer has another branch.
	branch = "feature";
	const before = asked.length;
	await refreshGit(cwd, { fresh: true });
	expect(useGit.getState().byCwd[cwd]?.git?.branch).toBe("feature");
	expect(useGit.getState().byCwd[cwd]?.pr).toBeNull();
	await settle(() => asked.length > before + 1);
	expect(asked.slice(before)).toEqual(["fresh=1", "pr=1"]);
	// The pull request of the new branch (none) is now known: a later status-only look does not ask again.
	await settle(() => useGit.getState().byCwd[cwd]?.prBranch === "feature");
	await refreshGit(cwd, { fresh: true });
	await Bun.sleep(30);
	expect(asked.slice(before)).toEqual(["fresh=1", "pr=1", "fresh=1"]);
});

test("a status-only look on the same branch keeps its pull request", async () => {
	const cwd = "/repo/same";
	serve({
		"": () => ({ git: status("main") }),
		"pr=1": () => ({ git: status("main"), pr: pull(3) }),
	});
	await refreshGit(cwd, { pr: true });
	await refreshGit(cwd);
	expect(useGit.getState().byCwd[cwd]?.pr?.number).toBe(3);
});
