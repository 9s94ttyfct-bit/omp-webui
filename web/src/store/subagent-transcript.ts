import type { SessionEntry } from "@shared/protocol.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { loadGuardDecisions } from "../lib/guard-decisions.ts";
import {
	appendPage,
	EMPTY_TRANSCRIPT,
	readFailure,
	replaceEntries,
	type Transcript,
	type TranscriptPage,
} from "../lib/subagent-transcript.ts";
import type { AgentRow } from "../lib/subagents.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "./app.ts";

/** A running subagent's transcript is read again this often, besides whenever its frames say something finished. */
const POLL_MS = 2000;
/** After omp failed for a reason that does not concern the subagent, it is asked again this soon. */
const RETRY_MS = 1000;

interface Reader {
	transcript: Transcript;
	/** A read is out; asking again meanwhile makes it repeat once instead of starting another. */
	busy: boolean;
	again: boolean;
	/** Ask omp for the messages (false once it refuses: it does not know the subagent). */
	viaOmp: boolean;
	/** The process `viaOmp` was decided for: another process may know what this one did not. */
	liveId: string | null;
	/** A read to repeat after omp failed in a way that says nothing about the subagent. */
	retry: ReturnType<typeof setTimeout> | null;
	alive: boolean;
}

/**
 * A subagent's whole transcript, kept current while it runs. While the conversation's process is alive omp is asked
 * for the records written since the last read (`get_subagent_messages` from a byte offset); otherwise, or when omp
 * does not know the subagent (it started in an earlier process), the transcript file is read through the server.
 *
 * Reads are triggered by a clock while the subagent runs and by what its frames report (a message ended, a tool
 * finished, its status changed), so a finished message shows up as soon as it is on disk.
 */
export function useSubagentTranscript(
	row: AgentRow,
	liveId: string | null,
	/** False while another view of the same subagent is on screen over this one: it does not read on its own clock then. */
	active = true,
): { entries: SessionEntry[]; error: string | null } {
	const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT);
	const [error, setError] = useState<string | null>(null);
	const reader = useRef<Reader>({
		transcript: EMPTY_TRANSCRIPT,
		busy: false,
		again: false,
		viaOmp: true,
		liveId,
		retry: null,
		alive: true,
	});
	const { id, file, running } = row;

	/** One read; true when omp failed in a way that says nothing about the subagent and should be asked again. */
	const readOnce = useCallback(async (): Promise<boolean> => {
		const r = reader.current;
		if (r.liveId !== liveId) {
			r.liveId = liveId;
			r.viaOmp = true;
		}
		if (liveId && r.viaOmp) {
			try {
				const page = await socket.rpc<TranscriptPage>(liveId, {
					type: "get_subagent_messages",
					subagentId: id,
					fromByte: r.transcript.nextByte,
				});
				if (!r.alive) return false;
				r.transcript = appendPage(r.transcript, page);
				setTranscript(r.transcript);
				setError(null);
				return false;
			} catch (e) {
				if (!r.alive) return false;
				// Not an answer about the subagent: ask omp again soon, without reading the whole file meanwhile.
				if (readFailure(e) === "retry") return true;
				r.viaOmp = false;
			}
		}
		if (!file) return false;
		try {
			const data = await api.session(file);
			if (!r.alive) return false;
			const next = replaceEntries(r.transcript, data.entries);
			if (next !== r.transcript) {
				r.transcript = next;
				setTranscript(next);
			}
			setError(null);
		} catch (e) {
			if (r.alive) setError(e instanceof Error ? e.message : String(e));
		}
		return false;
	}, [id, file, liveId]);

	const read = useCallback(async () => {
		const r = reader.current;
		if (r.busy) {
			r.again = true;
			return;
		}
		r.busy = true;
		let retry = false;
		try {
			do {
				r.again = false;
				retry = await readOnce();
			} while (r.again && r.alive);
		} finally {
			r.busy = false;
		}
		if (retry && r.alive && r.retry === null) {
			r.retry = setTimeout(() => {
				r.retry = null;
				void latest.current();
			}, RETRY_MS);
		}
	}, [readOnce]);
	// The retry asks with whatever the view reads from by then.
	const latest = useRef(read);
	latest.current = read;

	useEffect(() => {
		const r = reader.current;
		r.alive = true;
		return () => {
			r.alive = false;
			if (r.retry !== null) clearTimeout(r.retry);
			r.retry = null;
		};
	}, []);

	useEffect(() => {
		void read();
	}, [read]);

	useEffect(() => {
		if (!running || !active) return;
		const timer = setInterval(() => void read(), POLL_MS);
		return () => clearInterval(timer);
	}, [running, active, read]);

	// "Guard dangerous commands": what it decided about this subagent's calls, asked of the server by the transcript file the
	// decisions name (nothing of the transcript is read for it); the ones that come while the view is open arrive on the socket.
	useEffect(() => {
		loadGuardDecisions(file, useApp.getState().meta?.remote === true);
	}, [file]);

	// What its frames say has just been written: a message ended, a tool finished, or it changed state.
	const tools = row.live?.tools;
	// Which tools are done, not how many: the live state keeps only the latest few, so the count stops growing.
	const finished = tools
		? Object.values(tools)
				.filter((t) => t.done)
				.map((t) => t.toolCallId)
				.join(",")
		: "";
	const marker = `${row.status}|${row.live?.streamEnded ? 1 : 0}|${finished}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `marker` only says that the transcript has moved on.
	useEffect(() => {
		void read();
	}, [marker, read]);

	return { entries: transcript.entries, error };
}
