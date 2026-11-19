import { isRecord } from "../../shared/guards.ts";

/**
 * What omp puts in a progress frame that nothing here reads. omp 18.22's `bash` tool adds an execution trace of the script
 * to the details of every `tool_execution_update` (`partialResult.details.trace`: every shell node run so far), and each
 * update repeats the whole trace, so the bytes sent grow with the square of the script's length: a loop of 1,000 lines was
 * 195 MB to every page watching, for 9 KB of output (#337). The saved result keeps the trace; the frames that tell a
 * page how the call is going do not carry it.
 */

/** Drop the trace from a progress frame. True when there was one. */
export function dropTrace(frame: Record<string, unknown>): boolean {
	if (frame.type !== "tool_execution_update") return false;
	const partial = frame.partialResult;
	const details = isRecord(partial) ? partial.details : undefined;
	if (!isRecord(details) || !("trace" in details)) return false;
	delete details.trace;
	return true;
}

const UPDATE = Buffer.from('"tool_execution_update"');
const TRACE = Buffer.from('"trace"');

/**
 * Lines omp wrote (whole ones, as `wholeLines` gives them) with the trace taken out of the progress frames among them,
 * before the relay keeps them for a server that is not there yet: the backlog is bounded, and an omp that fills it is
 * made to wait. Lines that carry no trace are passed on as they are, without being read.
 */
export function trimLines(lines: Buffer[]): Buffer[] {
	const all = lines.length === 1 ? (lines[0] as Buffer) : Buffer.concat(lines);
	if (!all.includes(UPDATE) || !all.includes(TRACE)) return lines;
	const out: Buffer[] = [];
	let from = 0;
	while (from < all.length) {
		const nl = all.indexOf(0x0a, from);
		const end = nl < 0 ? all.length : nl + 1;
		const line = all.subarray(from, end);
		from = end;
		if (!line.includes(UPDATE) || !line.includes(TRACE)) {
			out.push(line);
			continue;
		}
		let frame: unknown;
		try {
			frame = JSON.parse(line.toString("utf8"));
		} catch {
			out.push(line);
			continue;
		}
		if (isRecord(frame) && dropTrace(frame)) out.push(Buffer.from(`${JSON.stringify(frame)}\n`));
		else out.push(line);
	}
	return out;
}
