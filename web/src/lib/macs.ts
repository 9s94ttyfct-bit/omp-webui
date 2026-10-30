import { isRecord } from "@shared/guards.ts";
import { type AddressProblem, type MacProblem, macUrl, type NameProblem, type SavedMac } from "@shared/macs.ts";
import { create } from "zustand";
import type { MessageKey } from "../i18n/index.ts";

/**
 * The sidebar's machine switcher (#628): which Mac a choice opens and how, what is known of each, and adding one.
 *
 * **Opening a Mac.** In the macOS app the page asks the shell (`ompwMacs`, `{ type: "open", id }`): the shell looks the id up in
 * its own list and opens that Mac's labelled window, which is the only way a remote page is shown there (a remote page never
 * runs inside the local one). The page never names an address to the shell. Anywhere else (a browser, a phone, the app on
 * macOS 13, which has no remote windows) the Mac's own address is opened in a new tab.
 */

interface Bridge {
	postMessage(message: unknown): Promise<unknown>;
}

const bridge = (): Bridge | undefined =>
	typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwMacs;

/** The page runs in the macOS app and the app has a window for other Macs (macOS 14 or later). */
export const hasMacBridge = (): boolean => typeof bridge()?.postMessage === "function";

/**
 * Ask the shell for `message`: whether it did it (`{ ok: true }`), or null when this page has no shell to ask (the caller then
 * does what a browser does). A shell that fails to answer, or answers anything but `{ ok: true }`, did not.
 */
function askShell(message: Record<string, unknown>): Promise<boolean> | null {
	const shell = bridge();
	if (typeof shell?.postMessage !== "function") return null;
	return shell.postMessage(message).then(
		(answer) => isRecord(answer) && answer.ok === true,
		() => false,
	);
}

/** Open the Mac's window in the app: true when the shell did; null when there is no shell. */
export const openMacInApp = (mac: SavedMac): Promise<boolean> | null => askShell({ type: "open", id: mac.id });

/** Show the app's own sheet for adding a Mac (it looks at the address first): true when the shell did; null when there is no shell. */
export const addMacInApp = (): Promise<boolean> | null => askShell({ type: "add" });

/**
 * Open the Mac's own page in a new tab. Called straight from the click that chose it: a window opened after something awaited is
 * a popup a browser blocks. `noopener` leaves the Mac's page no way back to this one.
 */
export function openMacInTab(mac: SavedMac): void {
	window.open(macUrl(mac.host), "_blank", "noopener,noreferrer");
}

// ------------------------------------------------------------------ what is known of a Mac

/** What a saved Mac is doing, as a stream from that Mac would say it. */
export type MacLive = "running" | "attention" | "unreachable" | "unknown";

interface MacLiveStore {
	states: Record<string, MacLive>;
}

/**
 * The seam for the live state of the other Macs (#627's per-Mac event stream). Nothing feeds it yet, so every Mac is `unknown`
 * and the switcher shows only what is known without asking the other Mac: when the app last opened it. The stream will call
 * `setMacLive(mac.id, …)` as it hears a Mac's `lives` and `unreachable`, and the row's dots and words follow, since they are
 * already drawn from this store (`MACS_DOT`, `MACS_STATE`).
 */
export const useMacLive = create<MacLiveStore>(() => ({ states: {} }));

export function setMacLive(id: string, state: MacLive): void {
	useMacLive.setState((s) => (s.states[id] === state ? s : { states: { ...s.states, [id]: state } }));
}

/** A Mac that was saved and is no more: its state goes with it. */
export function forgetMacLive(id: string): void {
	useMacLive.setState((s) => {
		if (!(id in s.states)) return s;
		const { [id]: _gone, ...rest } = s.states;
		return { states: rest };
	});
}

/** The colour of each state's dot (the app's own tones). A Mac whose state is not known has a neutral one. */
export const MACS_DOT: Record<MacLive, string> = {
	running: "bg-success",
	attention: "bg-warning",
	unreachable: "bg-danger",
	unknown: "bg-faint",
};

/** What each state is called, for the dot's tooltip and the screen reader. */
export const MACS_STATE: Record<MacLive, MessageKey> = {
	running: "macs.stateRunning",
	attention: "macs.stateAttention",
	unreachable: "macs.stateUnreachable",
	unknown: "macs.stateUnknown",
};

// ------------------------------------------------------------------ adding one

/** The server refused to change the list: its words, and which rule it was when it was one of the list's. */
export class MacsError extends Error {
	constructor(
		message: string,
		readonly problem: MacProblem | null,
	) {
		super(message);
	}
}

/** The rule of the list a refusal says it was, when it says one the page knows. */
function problemOf(value: unknown): MacProblem | null {
	if (!isRecord(value)) return null;
	if (value.kind === "full") return { kind: "full" };
	if (value.kind === "host-taken")
		return typeof value.name === "string" ? { kind: "host-taken", name: value.name } : null;
	if (value.kind === "name" && isNameProblem(value.code))
		return { kind: "name", code: value.code, ...(typeof value.taken === "string" ? { taken: value.taken } : {}) };
	if (value.kind === "address" && isAddressProblem(value.code)) return { kind: "address", code: value.code };
	return null;
}

/** `POST /api/macs`: add a Mac to the list (the server rechecks everything; only this computer may). */
export async function addSavedMac(input: { name: string; address: string }): Promise<void> {
	const res = await fetch("/api/macs", {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(input),
	});
	if (res.ok) return;
	const body: unknown = await res.json().catch(() => null);
	const said = isRecord(body) && typeof body.error === "string" ? body.error : res.statusText;
	throw new MacsError(said, isRecord(body) ? problemOf(body.problem) : null);
}

/** The key (and the numbers or names it says) of a problem's words in the page's language. */
export function macProblemWords(
	problem: MacProblem,
	limits: { macs: number; name: number },
): {
	key: MessageKey;
	vars?: Record<string, string | number>;
} {
	switch (problem.kind) {
		case "full":
			return { key: "macs.problemFull", vars: { n: limits.macs } };
		case "host-taken":
			return { key: "macs.problemHostTaken", vars: { name: problem.name } };
		case "name":
			if (problem.code === "empty") return { key: "macs.problemNameEmpty" };
			if (problem.code === "too-long") return { key: "macs.problemNameTooLong", vars: { n: limits.name } };
			if (problem.code === "characters") return { key: "macs.problemNameCharacters" };
			return { key: "macs.problemNameTaken", vars: { name: problem.taken ?? "" } };
		case "address":
			return { key: ADDRESS_KEYS[problem.code] };
	}
}

const NAME_CODES: readonly NameProblem[] = ["empty", "too-long", "characters", "taken"];
const isNameProblem = (code: unknown): code is NameProblem => NAME_CODES.some((c) => c === code);
const isAddressProblem = (code: unknown): code is AddressProblem =>
	typeof code === "string" && Object.hasOwn(ADDRESS_KEYS, code);

const ADDRESS_KEYS: Record<AddressProblem, MessageKey> = {
	empty: "macs.addressEmpty",
	"not-https": "macs.addressNotHttps",
	"user-info": "macs.addressUserInfo",
	port: "macs.addressPort",
	path: "macs.addressPath",
	"ip-address": "macs.addressIpAddress",
	"trailing-dot": "macs.addressTrailingDot",
	"not-ascii": "macs.addressNotAscii",
	"local-name": "macs.addressLocalName",
	"access-domain": "macs.addressAccessDomain",
	"not-domain-name": "macs.addressNotDomainName",
};
