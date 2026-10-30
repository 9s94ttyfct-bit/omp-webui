/**
 * What a confirmation of a risky call says on the wire, so that the gate that asks (`server/omp/gate/extension.ts`, which
 * runs inside omp) and the page that shows it (`web/src/components/UIRequests.tsx`) speak of it the same way. It asks
 * with omp's own `select` dialog, so nothing here is new to omp: a title, and the two answers.
 */

/**
 * The two files the server and the gate keep beside a process's settings overlay (`<overlay>…`), which the gate finds from
 * omp's own `--config` argument: the server's word to the gate (armed or not, the protected places), and the gate's own
 * note that it started in this process. Only a process whose gate left that note is covered; omp carries on without an
 * extension it failed to load, and the command line cannot tell.
 */
export const RISK_SUFFIX = ".risk";
export const RISK_LOADED_SUFFIX = ".risk.loaded";

/** Why a call needs the person's word (see `shared/remote-risk.ts` for what each one is). */
export const RISK_KINDS = [
	"privilege",
	"mass_delete",
	"delete_outside",
	"write_outside",
	"protected",
	"secret_read",
	"force_push",
	"discard",
	"remote_exec",
	"shell_out",
	"permissions",
	"launchctl",
	"osascript",
	"tunnel",
	"global_install",
	"system",
	"remote_tool",
	"unreadable",
] as const;

export type RiskKind = (typeof RISK_KINDS)[number];

/** The first words of the title of a confirmation: `Confirm risky call: <tool>`. */
export const RISK_HEAD = "Confirm risky call:";
/** The line after the title that names why: `Why: privilege,delete_outside`. */
export const RISK_WHY = "Why:";
/**
 * The line right after the title that says which setting asks (#785): `Asked by: remote` for "Confirm risky commands from
 * remote pages" (Settings › Remote access), `Asked by: guard` for "Guard dangerous commands" (Settings › Safety, or the
 * conversation's own choice). Before `Why:`, so the call's own text cannot make it.
 */
export const RISK_ASKED_BY = "Asked by:";
export const RISK_ASKERS = ["remote", "guard"] as const;
export type RiskAsker = (typeof RISK_ASKERS)[number];
/**
 * When the person is asked to overrule a reviewer's denial (#747), the two lines between the title and `Why:` that name
 * the reviewer and its reason, each on one line. They come before `Why:`, so the call's own text (after it) cannot make them.
 */
export const RISK_DENIED_BY = "Denied by:";
export const RISK_DENIED_REASON = "Reason:";
/**
 * When no reviewer could be reached and the person is asked instead (#764), the line between the title and `Why:` that
 * says so with what went wrong, on one line. Before `Why:` too, so the call's own text cannot make it.
 */
export const RISK_UNAVAILABLE = "Reviewer unavailable:";
/** The answers, which are the values the dialog resolves to. */
export const RISK_ALLOW = "Allow once";
export const RISK_DENY = "Deny";

/** The most characters of a command or path shown: more is cut, and the confirmation says so. */
export const RISK_DETAIL_MAX = 24_000;

/**
 * How a shell command is shown (`shared/remote-risk.ts`): `Command: <the command>`, after `In: <folder>` when the call names
 * the folder it runs in. The folder comes first and on one line, so the command (which may hold any line) cannot make it;
 * the page shows both labels in its own words (`riskCommand`).
 */
export const RISK_COMMAND = "Command:";
export const RISK_IN = "In:";

/** What a shell command's detail says (see `RISK_COMMAND`), or null when it is some other call's. */
export function riskCommand(detail: string): { command: string; cwd?: string } | null {
	let rest = detail;
	let cwd: string | undefined;
	if (rest.startsWith(`${RISK_IN} `)) {
		const end = rest.indexOf("\n");
		if (end < 0) return null;
		cwd = rest.slice(RISK_IN.length + 1, end);
		rest = rest.slice(end + 1);
	}
	if (!rest.startsWith(`${RISK_COMMAND} `)) return null;
	const command = rest.slice(RISK_COMMAND.length + 1);
	return cwd === undefined ? { command } : { command, cwd };
}

/** A reviewer's denial the person is asked to overrule: who denied it, and why (blank: it gave no reason). */
export interface RiskDenial {
	model: string;
	reason: string;
}

/** No reviewer could be reached, so the person is asked: what went wrong (blank: nothing was said). */
export interface RiskUnavailable {
	reason: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Who asks about a call: "Confirm risky commands from remote pages", or "Guard dangerous commands" with, when there was
 * one, the reviewer's denial the person may overrule (`denied`) or that no reviewer could be reached (`unavailable`).
 */
export type RiskAsk = { by: "remote" } | { by: "guard"; denied?: RiskDenial; unavailable?: RiskUnavailable };

/**
 * The title of the dialog that asks about one call: the tool, which setting asks, the reviewer's denial when there was one
 * or that no reviewer could be reached, why, then what the call is (the exact command or paths).
 */
export function riskTitle(tool: string, kinds: readonly RiskKind[], detail: string, ask: RiskAsk): string {
	const shown =
		detail.length > RISK_DETAIL_MAX
			? `${detail.slice(0, RISK_DETAIL_MAX)}\n[… ${detail.length - RISK_DETAIL_MAX} more characters are not shown: deny this call]`
			: detail;
	const denied = ask.by === "guard" ? ask.denied : undefined;
	const unavailable = ask.by === "guard" ? ask.unavailable : undefined;
	const denial = denied
		? `${RISK_DENIED_BY} ${oneLine(denied.model)}\n${RISK_DENIED_REASON} ${oneLine(denied.reason)}\n`
		: "";
	const down = unavailable ? `${RISK_UNAVAILABLE} ${oneLine(unavailable.reason)}\n` : "";
	return `${RISK_HEAD} ${tool}\n${RISK_ASKED_BY} ${ask.by}\n${denial}${down}${RISK_WHY} ${kinds.join(",")}\n${shown}`;
}

/**
 * What a title says: the tool, which setting asks (absent: the title does not say), the reviewer's denial it asks to
 * overrule (absent: none), that no reviewer could be reached (absent: one was, or none was asked), why it asks, and what
 * the call is.
 */
export interface RiskTitle {
	tool: string;
	by?: RiskAsker;
	denied?: RiskDenial;
	unavailable?: RiskUnavailable;
	kinds: RiskKind[];
	detail: string;
}

/** What a title says (see `riskTitle`), or null when it is some other dialog's. */
export function parseRiskTitle(title: string | undefined): RiskTitle | null {
	if (title === undefined || !title.startsWith(RISK_HEAD)) return null;
	const [head, ...lines] = title.split("\n");
	let by: RiskAsker | undefined;
	if (lines[0]?.startsWith(RISK_ASKED_BY)) {
		const said = lines[0].slice(RISK_ASKED_BY.length).trim();
		by = RISK_ASKERS.find((a) => a === said);
		lines.splice(0, 1);
	}
	let denied: RiskDenial | undefined;
	if (lines[0]?.startsWith(RISK_DENIED_BY) && lines[1]?.startsWith(RISK_DENIED_REASON)) {
		denied = {
			model: lines[0].slice(RISK_DENIED_BY.length).trim(),
			reason: lines[1].slice(RISK_DENIED_REASON.length).trim(),
		};
		lines.splice(0, 2);
	}
	let unavailable: RiskUnavailable | undefined;
	if (lines[0]?.startsWith(RISK_UNAVAILABLE)) {
		unavailable = { reason: lines[0].slice(RISK_UNAVAILABLE.length).trim() };
		lines.splice(0, 1);
	}
	const [why = "", ...rest] = lines;
	const known: readonly string[] = RISK_KINDS;
	const kinds = (why.startsWith(RISK_WHY) ? why.slice(RISK_WHY.length) : "")
		.split(",")
		.map((k) => k.trim())
		.filter((k): k is RiskKind => known.includes(k));
	return {
		tool: head.slice(RISK_HEAD.length).trim(),
		...(by ? { by } : {}),
		...(denied ? { denied } : {}),
		...(unavailable ? { unavailable } : {}),
		kinds,
		detail: rest.join("\n"),
	};
}
