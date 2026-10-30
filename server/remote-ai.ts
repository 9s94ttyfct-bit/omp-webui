import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../shared/guards.ts";
import type { HostToolDefinition } from "../shared/guided-goal.ts";
import type { LiveAttached } from "../shared/protocol.ts";
import {
	missingRemoteSettings,
	parseRemoteConfigPatch,
	RemoteConfigError,
	type RemoteSnapshot,
	withoutLinks,
} from "../shared/remote.ts";
import {
	REMOTE_AI_READ_ONLY,
	REMOTE_AI_SETTINGS,
	REMOTE_AI_TOOL,
	type RemoteAiState,
	type RemoteCheck,
} from "../shared/remote-ai.ts";
import type { HostToolCall, HostToolResult, HostToolServer } from "./omp/host-tools.ts";
import { REMOTE_AI_GUIDE } from "./remote-ai-guide.ts";
import type { RemoteService } from "./remote-routes.ts";
import { TunnelError } from "./remote-tunnel.ts";

/**
 * Let the AI help with the remote access set-up (Settings › Remote access: "Let the AI help with remote access" and "Set
 * up with AI").
 *
 * The agent of a conversation started with "Set up with AI" is given nine tools (`REMOTE_AI_TOOL`). They are served by
 * this server over that conversation's own omp pipe (`Live.serveHostTools`), and each one calls the same `RemoteService`
 * method the card's button does, so the same validation applies and there is no power the card does not offer.
 *
 * What scopes them, with nothing handed to omp to call the server with (no token, nothing that could land in a tool's
 * arguments or results, which are kept in the session file and exported with it):
 *
 *   - the conversation: only a conversation started by `start` holds the tools (`holders`); any other has none, and a
 *     call that reaches this from a conversation that is not one is refused.
 *   - the switch: it is the person's alone (the card, over a route that is local-only). Turned off, every conversation
 *     is refused at once and told the tools are gone; a call is checked against the switch's file, which is the truth.
 *   - the conversation's life: it ends with the process (`ended`); a server that restarts holds no conversation.
 *   - who is looking: a conversation that a page which came in through the tunnel is attached to is refused, since that
 *     page could answer omp's approval prompt itself.
 *
 * The agent cannot reach the switch, `enabled` or `autostart` through them, and no Cloudflare API
 * token is asked for or kept: the dashboard steps stay the person's.
 */

/** What the server must do for this: start a conversation that serves the tools, and know who is on one. */
export interface RemoteAiHooks {
	/** Start a conversation in `cwd` whose host tools `server` answers. */
	open(server: HostToolServer, cwd: string): Promise<LiveAttached>;
	/** Take the tools away from omp in conversation `liveId` (it goes on as an ordinary conversation). */
	withdraw(liveId: string): Promise<void>;
	/** Whether a page that came in through the tunnel is attached to conversation `liveId`. */
	heldRemotely(liveId: string): boolean;
}

/** Where the files of the AI-help conversations are: its folder, and the file the switch is kept in. */
export interface RemoteAiPlaces {
	/** The switch: `{ "enabled": true }`. */
	file: string;
	/** The folder the helper conversation runs in: its own, so that it is not among the person's projects. */
	folder: string;
}

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;

function tool(name: string, label: string, description: string, parameters: Record<string, unknown> = NO_PARAMETERS) {
	// `essential`: in the model's tool list from its first turn; a host tool is otherwise one it has to search for.
	return { name, label, description, parameters, loadMode: "essential" } satisfies HostToolDefinition;
}

/** The tools, as omp is told of them. */
export const REMOTE_AI_DEFINITIONS: readonly HostToolDefinition[] = [
	tool(
		REMOTE_AI_TOOL.guide,
		"Remote access guide",
		"Read the guide for setting up remote access to this app: the steps, what each setting means, where in the Cloudflare dashboard to find the values, and the common errors with their fixes. Read it before you start.",
	),
	tool(
		REMOTE_AI_TOOL.status,
		"Remote access status",
		"Read the remote access state: whether cloudflared is installed, whether the Cloudflare login is done, the saved hostname, team, AUD and e-mail addresses, what is still missing, the tunnel's state, and what the next step is. Reads only; it never returns a secret.",
	),
	tool(
		REMOTE_AI_TOOL.check,
		"Check the public address",
		"Check from outside that the public hostname answers and that Cloudflare Access asks for a sign-in. Changes nothing. Use it after the tunnel is connected.",
	),
	tool(
		REMOTE_AI_TOOL.install,
		"Install cloudflared",
		"Install cloudflared with Homebrew, as the card's Install button does. It can take a few minutes. The person is asked to approve it.",
	),
	tool(
		REMOTE_AI_TOOL.login,
		"Start the Cloudflare login",
		"Start the Cloudflare login (cloudflared tunnel login). The person signs in in their browser, with a link that is shown to them in Settings › Remote access; the link is not returned to you. Tell them where it is. The login is done when the status says so.",
	),
	tool(
		REMOTE_AI_TOOL.save,
		"Save remote access settings",
		"Save remote access settings the person gave you: any of hostname, team, aud and emails. Only the fields you give change. Each value is checked as the card checks it, and a refused value changes nothing. You cannot turn remote access on or change any other setting with this.",
		{
			type: "object",
			properties: {
				hostname: { type: "string", description: "The public hostname, e.g. omp.example.com." },
				team: { type: "string", description: "The Cloudflare team: the first part of <team>.cloudflareaccess.com." },
				aud: { type: "string", description: "The AUD tag of the Access application: 64 hexadecimal characters." },
				emails: {
					type: "array",
					items: { type: "string" },
					description: "The e-mail addresses allowed in. The list replaces the saved one.",
				},
			},
			additionalProperties: false,
		},
	),
	tool(
		REMOTE_AI_TOOL.setup,
		"Set up the tunnel",
		"Create the tunnel (once), point the hostname's DNS record at it and write its configuration, as the card's Set up the tunnel button does. Needs cloudflared, the Cloudflare login and a saved hostname. Safe to run again.",
	),
	tool(
		REMOTE_AI_TOOL.start,
		"Start the tunnel",
		"Start the tunnel. This turns remote access on: the saved e-mail addresses can sign in from outside and use this app. Needs every setting saved and the tunnel set up. Say who will be let in before you call it.",
	),
	tool(REMOTE_AI_TOOL.stop, "Stop the tunnel", "Stop the tunnel. This turns remote access off."),
];

/** What the next step is, in a sentence, for `status`: the first thing that is not yet in place. */
function nextStep(s: RemoteSnapshot): string {
	const { config } = s;
	const missing = missingRemoteSettings(config);
	if (!s.installed) return `Install cloudflared: call ${REMOTE_AI_TOOL.install}.`;
	if (!s.loggedIn)
		return `Log in to Cloudflare: call ${REMOTE_AI_TOOL.login}; the person signs in with the link shown to them in Settings › Remote access.`;
	if (config.hostname === "")
		return "Ask the person which hostname to use (a name in a domain of the logged-in Cloudflare account).";
	if (missing.length > 0)
		return `Walk the person through creating the Access application in the Cloudflare dashboard (see the guide), then ask for: ${missing.join(", ")}, and save them with ${REMOTE_AI_TOOL.save}.`;
	if (!config.tunnelId) return `Set up the tunnel: call ${REMOTE_AI_TOOL.setup}.`;
	if (s.status.state === "connected")
		return `Check the address: call ${REMOTE_AI_TOOL.check}, then ask the person to open ${s.url} on another device and sign in.`;
	if (s.status.state === "starting") return "The tunnel is starting: read the status again in a few seconds.";
	return `Start the tunnel: call ${REMOTE_AI_TOOL.start} (say first who will be let in).`;
}

/**
 * The state as the agent is told it. Never a secret: no tunnel id, no path of the credentials file, no login link (see
 * `RemoteSnapshot.loginUrl`). The AUD is an identifier that every Access token carries, and the person pastes it in.
 */
export function describeRemote(s: RemoteSnapshot): string {
	const { config } = s;
	// What the tunnel or cloudflared said is a program's output: no address in it reaches the agent (see `withoutLinks`).
	const said = s.status.message === undefined ? null : withoutLinks(s.status.message);
	return JSON.stringify(
		{
			cloudflared: { installed: s.installed },
			cloudflareLogin: { signedIn: s.loggedIn, waitingForBrowser: s.loginUrl !== undefined },
			settings: { hostname: config.hostname, team: config.team, aud: config.aud, emails: config.emails },
			missingSettings: missingRemoteSettings(config),
			tunnel: { setUp: config.tunnelId !== undefined, state: s.status.state, message: said },
			remoteAccessOn: config.enabled,
			publicUrl: s.url || null,
			next: nextStep(s),
		},
		null,
		2,
	);
}

/** What a check found, as the agent is told it. */
function describeCheck(c: RemoteCheck): string {
	return JSON.stringify({ url: c.url, verdict: c.verdict, httpStatus: c.status ?? null, meaning: c.message }, null, 2);
}

/** The AI help of one `RemoteService`: the switch, the conversations that hold the tools, and the tools themselves. */
export class RemoteAi implements HostToolServer {
	readonly tools = REMOTE_AI_DEFINITIONS;
	readonly readOnly: readonly string[] = REMOTE_AI_READ_ONLY;
	/** The conversations that hold the tools, by live id. */
	private readonly holders = new Set<string>();

	constructor(
		private readonly service: RemoteService,
		private readonly places: RemoteAiPlaces,
		/** Without it no conversation can be started (a server that does not run omp). */
		private readonly hooks: RemoteAiHooks | null,
		/** Tell the open pages that something changed (their card asks the server again). */
		private readonly changed: () => void,
	) {}

	// ------------------------------------------------------------------ the switch

	/**
	 * Whether the person has turned the help on. The file is the truth and is read at every ask, as `RemoteStore`'s is: a
	 * file that cannot be read, or says anything but `true`, is off.
	 */
	enabled(): boolean {
		try {
			const read: unknown = JSON.parse(readFileSync(this.places.file, "utf8"));
			return isRecord(read) && read.enabled === true;
		} catch {
			return false;
		}
	}

	state(): RemoteAiState {
		return { enabled: this.enabled(), conversations: [...this.holders] };
	}

	/**
	 * Turn the help on or off. Off takes every conversation's tools away at once: they are refused from now on (the
	 * switch is read at each call), and omp is told it has none, so that the model stops offering them. The
	 * conversations themselves go on as ordinary ones.
	 */
	async setEnabled(on: boolean): Promise<void> {
		mkdirSync(dirname(this.places.file), { recursive: true, mode: 0o700 });
		// Written whole and moved into place, as the settings are: never half a file.
		const temporary = `${this.places.file}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ enabled: on })}\n`, { mode: 0o600 });
			renameSync(temporary, this.places.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
		if (!on) await this.revokeAll();
		this.changed();
	}

	/** Every conversation loses the tools; one that cannot be reached is refused all the same. */
	private async revokeAll(): Promise<void> {
		const held = [...this.holders];
		this.holders.clear();
		await Promise.all(held.map((liveId) => this.hooks?.withdraw(liveId).catch(() => {})));
	}

	// ------------------------------------------------------------------ the conversation

	/**
	 * "Set up with AI": the help is turned on and a new conversation is started that holds the tools. The page opens it
	 * and sends the starting prompt. One conversation each time; the ones before it keep their tools until they end.
	 */
	async start(): Promise<LiveAttached> {
		if (!this.hooks) throw new TunnelError("This server cannot start a conversation", 501);
		await this.setEnabled(true);
		mkdirSync(this.places.folder, { recursive: true, mode: 0o700 });
		const info = await this.hooks.open(this, this.places.folder);
		// The person may have turned the help off while the conversation was starting: `setEnabled(false)` withdrew the tools
		// of the conversations it knew, and this one was not among them yet. It is given none, and is not a holder.
		if (!this.enabled()) {
			await this.hooks.withdraw(info.liveId).catch(() => {});
			throw new TunnelError(
				"Letting the AI help with remote access was turned off while the conversation started",
				409,
			);
		}
		this.holders.add(info.liveId);
		this.changed();
		return info;
	}

	/** The conversation ended: it holds nothing any more. */
	ended(liveId: string): void {
		if (this.holders.delete(liveId)) this.changed();
	}

	// ------------------------------------------------------------------ the tools

	/** Why a call is refused, or null when it may go on. */
	private refusal(liveId: string): string | null {
		if (!this.enabled())
			return "Letting the AI help with remote access is turned off, so these tools are gone. Only the person can turn it on again, in Settings › Remote access. Tell them, and do not try another way.";
		if (!this.holders.has(liveId))
			return 'This conversation was not started with "Set up with AI" in Settings › Remote access, so it has no access to remote access. Tell the person to use that button.';
		if (this.hooks?.heldRemotely(liveId))
			return "A page that came in through the tunnel has been on this conversation, and could have answered omp's approval prompt itself, so these tools are refused. Remote access can be set up from this computer only: do nothing, and tell the person to continue at the Mac (it is lifted by sending a message from this computer).";
		return null;
	}

	async call(call: HostToolCall): Promise<HostToolResult> {
		const refused = this.refusal(call.liveId);
		if (refused !== null) return { text: refused, isError: true };
		if (call.signal.aborted) return { text: "The call was cancelled.", isError: true };
		try {
			return { text: await this.run(call.name, call.args) };
		} catch (e) {
			// What the card would say: the refusal of a value, or of a step, in words that tell what to do.
			if (e instanceof TunnelError || e instanceof RemoteConfigError)
				return { text: withoutLinks(e.message), isError: true };
			console.error(`omp-webui: the remote access tool ${call.name} failed:`, e);
			return { text: "The app could not do that (see its log).", isError: true };
		} finally {
			// Whatever it did, the card follows.
			this.changed();
		}
	}

	private async run(name: string, args: unknown): Promise<string> {
		const done = async (what: string, act: Promise<unknown>) => {
			await act;
			return `${what}\n${describeRemote(this.service.snapshot())}`;
		};
		switch (name) {
			case REMOTE_AI_TOOL.guide:
				return REMOTE_AI_GUIDE;
			case REMOTE_AI_TOOL.status:
				return describeRemote(this.service.snapshot());
			case REMOTE_AI_TOOL.check:
				return describeCheck(await this.service.check());
			case REMOTE_AI_TOOL.install:
				return done("cloudflared is installed.", this.service.install());
			case REMOTE_AI_TOOL.login: {
				// The link is not returned: it is a one-time authorisation, and what the tool returns is kept and exported.
				await this.service.login();
				return `The Cloudflare login has started. The person finishes it in their browser, with the link shown in Settings › Remote access (and as a notice in the app). It is done when the status says cloudflareLogin.signedIn is true; wait for them to say they signed in, then read the status.`;
			}
			case REMOTE_AI_TOOL.save:
				return done("Saved.", this.service.saveConfig(this.settingsOf(args)));
			case REMOTE_AI_TOOL.setup:
				return done("The tunnel is set up.", this.service.setup());
			case REMOTE_AI_TOOL.start:
				return done("The tunnel is starting; remote access is on.", this.service.start());
			case REMOTE_AI_TOOL.stop:
				return done("The tunnel is stopped; remote access is off.", this.service.stop());
			default:
				throw new TunnelError(`There is no tool named ${name} for remote access`, 404);
		}
	}

	/**
	 * What `save` may change: hostname, team, aud and emails, checked by the same code the card's save is. Anything else
	 * is refused before anything is written (`enabled` and the other switches are the person's, not the agent's).
	 */
	private settingsOf(args: unknown) {
		if (!isRecord(args)) throw new RemoteConfigError("Give the settings to save: hostname, team, aud and/or emails.");
		const given = Object.keys(args);
		const foreign = given.filter((k) => !(REMOTE_AI_SETTINGS as readonly string[]).includes(k));
		if (foreign.length > 0)
			throw new RemoteConfigError(
				`${foreign.join(", ")} cannot be changed here: only ${REMOTE_AI_SETTINGS.join(", ")} can be saved. The other settings are the person's own switches in Settings › Remote access.`,
			);
		if (given.length === 0) throw new RemoteConfigError("Give at least one of hostname, team, aud and emails to save.");
		return parseRemoteConfigPatch(args);
	}
}
