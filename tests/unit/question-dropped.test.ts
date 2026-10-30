import { expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import type { QuestionDropNote } from "../../shared/unattended.ts";
import { withInfo } from "../../web/src/store/live.ts";

/**
 * A question unattended mode could not keep (#650): it is the process's own state (`LiveInfo.questionDropped`), like the
 * sleep a turn was cut by, so every page that is told the process shows it — one that attached later, and one that was not
 * listening when it happened. The store needs no code of its own for it: `withInfo` takes the whole info as the server has it.
 */

const info = (extra: Partial<LiveInfo> = {}): LiveInfo => ({
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "s",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
	...extra,
});

const note = (why: QuestionDropNote["why"], question = "Which db?"): QuestionDropNote => ({
	why,
	question,
	at: 1_700_000_000_000,
});

test("the info the server sends carries it, for a page that attached after the question was lost", () => {
	const live = { info: info(), resumedAt: 0 } as Parameters<typeof withInfo>[0];
	const next = withInfo(live, info({ questionDropped: note("full") }));
	expect(next.info.questionDropped).toEqual(note("full"));
});

test("a page told the process again with no drop shows none: the server took it away when a question was kept", () => {
	const live = { info: info({ questionDropped: note("unwritable") }), resumedAt: 0 } as Parameters<typeof withInfo>[0];
	expect(withInfo(live, info()).info.questionDropped).toBeUndefined();
});
