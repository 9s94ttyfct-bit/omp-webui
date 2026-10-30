import * as Tooltip from "@radix-ui/react-tooltip";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import type { SessionEntry } from "../../shared/protocol.ts";
import { buildFamily, type Family } from "../../web/src/lib/family.ts";
import { isVisible } from "../../web/src/lib/messages.ts";
import { withLiveNotices } from "../../web/src/lib/notices.ts";
import { pathTo } from "../../web/src/lib/tree.ts";
import { type AgentTurn, type Segment, segmentTranscript } from "../../web/src/lib/turns.ts";

/**
 * The page's own derivations and drawing for unit specs of how a conversation reads (see `session-entries.ts` for the
 * entries). The web modules read `localStorage` as they load: a spec imports `./browser-globals.ts` before this file.
 */

const FILE = "/x/turn-render.jsonl";

/** What the page derives from a conversation's entries: the family (its saved tool results) and the segments of the branch on screen. */
export function conversationOf(entries: SessionEntry[]): { fam: Family; path: SessionEntry[]; segments: Segment[] } {
	const fam = buildFamily([], FILE, [...entries]);
	const path = pathTo(fam.idx, fam.headOf.get(FILE) ?? null);
	const rows = withLiveNotices(path, [], []).filter(isVisible);
	return { fam, path, segments: segmentTranscript(rows, fam.idx) };
}

/** The last turn of a conversation. */
export function lastTurn(segments: Segment[]): AgentTurn {
	for (let i = segments.length - 1; i >= 0; i--) {
		const s = segments[i];
		if (s.kind === "turn") return s.turn;
	}
	throw new Error("the conversation has no turn");
}

/** An element as the page draws it: its tooltips live in one provider. */
export function draw(element: ReactElement): string {
	return renderToString(createElement(Tooltip.Provider, null, element));
}
