import { rmSync } from "node:fs";
import { type ChatTurn, solidPng, writeChatSession } from "../support/chat-session.ts";
import { endOf, expectFollowing, expectStaying, frames, ROUNDING, type Shows, scrollUp } from "../support/follow.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { devices, expect, type Locator, type Page, test, webkit } from "./fixtures.ts";

/**
 * While a reply streams, a reader who is at the end of the conversation keeps its newest line in view through every
 * kind of growth (#586): tokens, thinking that opens and folds, a tool card that opens and folds, code that is coloured
 * late, a picture, a subagent's card, an approval, omp's wait before a retry, a taller composer, the todo strip, toasts,
 * the side panel. Each is streamed to the page and the end is measured after the page has drawn what it caused; once
 * alone, once among tokens that stream on every frame (the way a reply really arrives: the scroll a token caused is
 * still on its way when the next frame of omp lands). A reader who scrolled up is not pulled down by any of it, and the
 * arrow brings them back to following. Measured on a desktop window, an iPad and an iPhone (WebKit). The frames are
 * pushed over the page's socket: no model is called. The same is asked of a subagent's live view in
 * `agent-follow.spec.ts`.
 */

// Every test opens a conversation of its own, on the worker's own server: they spread over the workers rather than run
// one after the other on one, which made this file the floor of a run's wall time (#773).
test.describe.configure({ mode: "parallel" });

const PROFILES = ["desktop", "iPad (gen 11)", "iPhone 15"] as const;
type Profile = (typeof PROFILES)[number];

type Frame = Record<string, unknown>;

interface Rig {
	page: Page;
	tap: SocketTap;
	profile: Profile;
	/** Push a frame to the page as omp's own. */
	frame(f: Frame): void;
}

const history = (n: number): ChatTurn[] =>
	Array.from({ length: n }, (_, i) => ({
		prompt: `Question ${i}: what does item ${i} do?`,
		reply: `Item ${i} does thing ${i}. `.repeat(14),
	}));

interface OpenOptions {
	/** How many turns the conversation has: more than 15 or so make more than one page of messages. */
	turns?: number;
}

let sessions = 0;

/** A conversation with enough history to scroll, open on `profile` with its omp running and following the end. */
async function openRig(
	use: { e2eServer: { url: string }; workerStorageState: string },
	profile: Profile,
	desktop: Page,
	{ turns = 12 }: OpenOptions = {},
): Promise<{ rig: Rig; close: () => Promise<void> }> {
	let page = desktop;
	let close = async () => {};
	if (profile !== "desktop") {
		const { defaultBrowserType: _browser, ...device } = devices[profile];
		// The config's `channel: "chrome"` belongs to Chromium; WebKit launches without one.
		const browser = await webkit.launch({ channel: undefined });
		const context = await browser.newContext({
			...device,
			baseURL: use.e2eServer.url,
			storageState: use.workerStorageState,
			locale: "en-US",
		});
		page = await context.newPage();
		close = () => browser.close();
	}
	const title = `Follow ${profile} ${++sessions}`;
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0x5860 + sessions,
		title,
		turns: history(turns),
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `follow-${sessions}`);
	const rig: Rig = { page, tap, profile, frame: (frame) => tap.push({ t: "frame", liveId, frame }) };
	await expectFollowing(page, "the conversation as it opens", `Question ${turns - 1}`);
	return {
		rig,
		close: async () => {
			rmSync(file, { force: true });
			await close();
		},
	};
}

const call = (id: string, name: string, args: Frame) => ({ type: "toolCall", id, name, arguments: args });
const text = (s: string, extra: Frame[] = []) => ({ content: [{ type: "text", text: s }, ...extra] });
const sentence = (i: number) => `Sentence number ${i} of the reply says something of its own about item ${i}. `;
const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join("\n");

/** The streaming reply: a message that starts empty and gets text a piece at a time, thinking, and tool calls. */
class Reply {
	private started = false;
	private blocks = 1;
	/** The block the text goes to, and the block of the thinking that is going on (-1: none). */
	private textAt = 0;
	private thinkAt = -1;
	/** The sentence the next token says. */
	next = 0;
	constructor(
		private readonly rig: Rig,
		readonly id: string,
	) {}

	private event(ev: Frame) {
		this.rig.frame({
			type: "message_update",
			messageId: this.id,
			message: { role: "assistant" },
			assistantMessageEvent: ev,
		});
	}

	text(delta: string) {
		if (!this.started) {
			this.rig.frame({ type: "agent_start" });
			this.rig.frame({
				type: "message_start",
				messageId: this.id,
				message: { role: "assistant", content: [], timestamp: 5 },
			});
			this.event({ type: "text_start", contentIndex: 0 });
			this.started = true;
		}
		this.event({ type: "text_delta", contentIndex: this.textAt, delta });
	}

	/** One more token: the sentence of this number, which the page shows as `Sentence number N `. */
	token(): string {
		const n = this.next++;
		this.text(sentence(n) + (n % 5 === 4 ? "\n\n" : ""));
		return `Sentence number ${n} `;
	}

	/** The model's call of a tool, finished: its card is up, waiting for the tool to start. */
	tool(id: string, name: string, args: Frame) {
		this.text("");
		this.event({ type: "toolcall_end", contentIndex: this.blocks++, toolCall: call(id, name, args) });
	}

	/** Thinking, which is open while it is the last thing the model writes. */
	think(delta: string) {
		this.text("");
		if (this.thinkAt < 0) {
			this.thinkAt = this.blocks++;
			this.event({ type: "thinking_start", contentIndex: this.thinkAt });
		}
		this.event({ type: "thinking_delta", contentIndex: this.thinkAt, delta });
	}

	/** The model is done thinking and answers in a block of its own: what it says from now on goes there. */
	answer() {
		this.event({ type: "thinking_end", contentIndex: this.thinkAt });
		this.thinkAt = -1;
		this.textAt = this.blocks++;
		this.event({ type: "text_start", contentIndex: this.textAt });
	}
}

/** One growth: the frames or the action that make it, and what the page shows once it has happened. */
interface Step {
	label: string;
	push: () => void | Promise<void>;
	shows: Shows;
}

interface Ctx {
	rig: Rig;
	reply: Reply;
	/** Makes ids unique across the runs of one conversation. */
	tag: string;
}

/** The steps of a kind, or null where the profile has no such thing (a phone has no side panel beside the chat). */
type Kind = (ctx: Ctx) => Promise<Step[] | null> | Step[] | null;

const toolCard = (page: Page, command: string) => page.locator('[data-testid="tool-card"]', { hasText: command });
const isOpen = (card: Locator) => card.locator('button[aria-expanded="true"]').first();
const loaded = (img: Locator) => async () => {
	await expect(img.first()).toBeAttached();
	await expect.poll(() => img.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
};

/** The first two steps of a tool that runs, whose `card` is on the page: the model's call of it, and its start. */
function toolSteps({ rig, reply, tag }: Ctx, name: string, args: Frame, card: Locator) {
	const id = `toolu_${tag}`;
	const steps: Step[] = [
		{ label: `the ${name} call`, push: () => reply.tool(id, name, args), shows: card },
		{
			label: `the ${name} starts`,
			push: () => rig.frame({ type: "tool_execution_start", toolCallId: id, toolName: name, args }),
			shows: isOpen(card),
		},
	];
	return { id, card, steps };
}

/** omp's todo list with a task in progress, which puts its strip above the composer. */
function todoList(rig: Rig, tag: string) {
	const phases = [
		{
			name: "Build",
			tasks: [
				{ content: `Write the parser ${tag}`, status: "in_progress" },
				{ content: "Deploy", status: "pending" },
				{ content: "Announce", status: "pending" },
			],
		},
	];
	const strip = rig.page.getByTestId("todo-strip");
	const appears: Step = {
		label: "the todo strip appears above the composer",
		push: () => {
			rig.tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: phases }) }));
			rig.frame({ type: "tool_execution_end", toolCallId: `todo-${tag}`, toolName: "todo", result: {} });
		},
		shows: strip,
	};
	return { strip, appears };
}

/** omp's `errorId` of a failure that was a usage limit: the flag 0x80000 and a status bit. */
const USAGE_LIMIT_ERROR_ID = 0x80000 | 0x1000;

const KINDS: Record<string, Kind> = {
	"tokens of a long reply": ({ reply }) =>
		Array.from({ length: 30 }, (_, i) => ({
			label: `token ${i}`,
			push: () => void reply.token(),
			shows: `Sentence number ${i} `,
		})),

	"pieces of a reply that are many lines each": ({ reply }) =>
		Array.from({ length: 8 }, (_, i) => ({
			label: `piece ${i}`,
			push: () => reply.text(`${Array.from({ length: 10 }, () => sentence(reply.next++)).join("")}\n\n`),
			shows: `Sentence number ${i * 10 + 9} `,
		})),

	// The model thinks a line at a time in a block that is open while it is the last thing written, and folds when the answer starts.
	"thinking that grows and folds when the answer starts": ({ rig, reply }) => [
		...Array.from({ length: 14 }, (_, i) => ({
			label: `thinking ${i}`,
			push: () => reply.think(`Thought ${i}: ${sentence(i)}\n`),
			shows: `Thought ${i}: `,
		})),
		{
			label: "the answer starts and the thinking folds",
			push: () => {
				reply.answer();
				reply.text(sentence(0));
			},
			shows: async () =>
				expect(rig.page.getByTestId("thinking").locator('button[aria-expanded="false"]')).toBeAttached(),
		},
	],

	"a long list and a table in pieces": ({ reply, tag }) => {
		const items = (from: number, n: number) =>
			Array.from(
				{ length: n },
				(_, i) => `- item ${tag}-${from + i} with a little text in it, so that the list is long\n`,
			).join("");
		const rows = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => `| row-${tag}-${from + i} | \`code ${from + i}\` | **${from + i}** |\n`).join(
				"",
			);
		return [
			{ label: "the first items", push: () => reply.text(`Items:\n\n${items(0, 20)}`), shows: `item ${tag}-19 ` },
			{ label: "more items", push: () => reply.text(items(20, 30)), shows: `item ${tag}-49 ` },
			{
				label: "the head of a table and its first rows",
				push: () => reply.text(`\nThen a table:\n\n| Name | Code | Count |\n| :--- | --- | ---: |\n${rows(0, 15)}`),
				shows: `row-${tag}-14`,
			},
			{ label: "more rows", push: () => reply.text(rows(15, 25)), shows: `row-${tag}-39` },
		];
	},

	"a tool card that opens, streams its output and folds": (ctx) => {
		const { rig } = ctx;
		const command = `make build ${ctx.tag}`;
		const { id, card, steps } = toolSteps(ctx, "bash", { command }, toolCard(rig.page, command));
		const update = (n: number): Step => ({
			label: `${n} lines of output`,
			push: () =>
				rig.frame({
					type: "tool_execution_update",
					toolCallId: id,
					toolName: "bash",
					partialResult: text(lines(`out${ctx.tag}`, n)),
				}),
			shows: card.getByText(`out${ctx.tag}-${n}`),
		});
		return [
			...steps,
			update(6),
			update(20),
			update(45),
			{
				label: "the tool ends and the card folds",
				push: () =>
					rig.frame({
						type: "tool_execution_end",
						toolCallId: id,
						toolName: "bash",
						isError: false,
						result: text(lines(`out${ctx.tag}`, 45)),
					}),
				shows: card.getByLabel("Done"),
			},
		];
	},

	"code that is coloured late": ({ rig, reply, tag }) =>
		["alpha", "beta"].map((name, i) => ({
			label: `a code block of ${name}`,
			push: () => reply.text(`Here is ${name}:\n\n\`\`\`ts\n${lines(`const ${name}${tag}`, 30 + 10 * i)}\n\`\`\`\n\n`),
			// The block is plain when it arrives and coloured when the worker has answered (see `CodeBlock`).
			shows: async () => {
				await expect(rig.page.getByText(`const ${name}${tag}-${30 + 10 * i}`)).toBeAttached();
				await expect(rig.page.locator("pre.shiki").nth(i)).toBeAttached();
			},
		})),

	"a picture that is fetched late": async ({ rig, reply, tag }) => {
		const hash = tag.repeat(32);
		const gate = Promise.withResolvers<void>();
		await rig.page.route(`**/api/blob/${hash}`, async (route) => {
			await gate.promise;
			await route.fulfill({ body: solidPng(480, 360), contentType: "image/png" });
		});
		const pictures = rig.page.locator(`[data-testid="msg-assistant"] img[src$="${hash}"]`);
		return [
			{
				label: "the picture's place, before it is fetched",
				push: () => reply.text(`Here is the chart:\n\n![chart](/api/blob/${hash})\n\n`),
				shows: pictures,
			},
			{ label: "the picture arrives", push: () => gate.resolve(), shows: loaded(pictures) },
		];
	},

	"a tool's picture": (ctx) => {
		const { rig } = ctx;
		const args = { path: `/tmp/shot-${ctx.tag}.png` };
		const { id, card, steps } = toolSteps(ctx, "read", args, toolCard(rig.page, `shot-${ctx.tag}.png`));
		const png = solidPng(480, 360, [220, 60, 60]).toString("base64");
		return [
			...steps,
			{
				label: "the tool's picture",
				push: () =>
					rig.frame({
						type: "tool_execution_update",
						toolCallId: id,
						toolName: "read",
						partialResult: text("Read image file [image/png]", [{ type: "image", data: png, mimeType: "image/png" }]),
					}),
				shows: loaded(card.getByTestId("tool-image").locator("img")),
			},
		];
	},

	"a subagent's card and the jobs it adds above the composer": (ctx) => {
		const { rig, tag } = ctx;
		const items = ["alpha", "beta", "gamma"].map((name) => ({
			id: `${name}${tag}`,
			description: `Search the ${name} files`,
			assignment: `Look in the ${name} folder for every file that mentions the parser, and report what each does:\n- its name\n- the function that reads it\n- what it returns`,
		}));
		const args = { agent: "explore", context: "The parser lives under src/.", tasks: items };
		const { id, card, steps } = toolSteps(
			ctx,
			"task",
			args,
			rig.page.locator('[data-testid="tool-card"][data-tool="task"]'),
		);
		const lifecycle = (status: string) => {
			for (const [index, item] of items.entries())
				rig.frame({
					type: "subagent_lifecycle",
					payload: {
						id: item.id,
						agent: "explore",
						agentSource: "bundled",
						index,
						status,
						parentToolCallId: id,
						description: item.description,
					},
				});
		};
		return [
			...steps,
			{ label: "the subagents start", push: () => lifecycle("started"), shows: rig.page.getByTestId("jobs-block") },
			{
				label: "the subagents end",
				push: () => lifecycle("completed"),
				shows: async () => expect(rig.page.getByTestId("jobs-block")).toHaveCount(0),
			},
			{
				label: "the task ends and the card folds",
				push: () =>
					rig.frame({
						type: "tool_execution_end",
						toolCallId: id,
						toolName: "task",
						isError: false,
						result: text("Three subagents reported."),
					}),
				shows: card.getByLabel("Done"),
			},
		];
	},

	"an approval that asks for a choice": ({ rig, tag }) => {
		const details = Array.from({ length: 2 }, (_, i) => `  - file-${i}.txt`).join("\n");
		const request = rig.page.getByTestId("ui-request");
		return [
			{
				label: "the approval",
				push: () =>
					rig.frame({
						type: "extension_ui_request",
						id: `ap-${tag}`,
						method: "select",
						title: `Allow tool: read\nFolder: /tmp/project — 2 entries\n${details}`,
						options: ["Approve", "Approve for this session", "Deny"],
					}),
				shows: request,
			},
			{
				label: "the approval is withdrawn",
				push: () => rig.frame({ type: "extension_ui_request", method: "cancel", targetId: `ap-${tag}` }),
				shows: async () => expect(request).toHaveCount(0),
			},
		];
	},

	"the todo strip": ({ rig, tag }) => {
		const { strip, appears } = todoList(rig, tag);
		return [
			appears,
			{
				label: "the strip opens to the whole list",
				push: () => strip.getByRole("button").first().click(),
				shows: rig.page.locator('[data-testid="todo-strip"][data-open="true"]'),
			},
			{
				label: "the list is cleared",
				push: () => {
					rig.tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: [] }) }));
					rig.frame({ type: "todo_auto_clear" });
				},
				shows: async () => expect(strip).toHaveCount(0),
			},
		];
	},

	"a draft that grows the composer": ({ rig, tag }) => {
		const composer = rig.page.getByTestId("composer");
		const draft = (n: number) => Array.from({ length: n }, (_, i) => `draft ${tag} line ${i}`).join("\n");
		return [
			{
				label: "a draft of 9 lines",
				push: () => composer.fill(draft(9)),
				shows: async () => expect(composer).toHaveValue(draft(9)),
			},
			{
				label: "a draft of 14 lines",
				push: () => composer.fill(draft(14)),
				shows: async () => expect(composer).toHaveValue(draft(14)),
			},
			{
				label: "the draft is sent away",
				push: () => composer.fill(""),
				shows: async () => expect(composer).toHaveValue(""),
			},
		];
	},

	"a stack of toasts": ({ rig, tag }) => {
		const toast = (i: number) =>
			rig.frame({
				type: "extension_ui_request",
				id: `toast-${tag}-${i}`,
				method: "notify",
				message: `Command ${i} failed: exit code 1\nstderr: something broke while running the build step number ${i}`,
				notifyType: i % 2 ? "warning" : "error",
			});
		// Two toasts are on the screen at most; the third waits behind them.
		return [0, 1, 2].map((i) => ({
			label: `toast ${i + 1}`,
			push: () => toast(i),
			shows: async () => expect(rig.page.getByTestId("toast")).toHaveCount(Math.min(i + 1, 2)),
		}));
	},

	"omp backing off before it retries a failed turn": ({ rig }) => {
		const wait = rig.page.getByTestId("retry-wait");
		return [
			{
				label: "an ordinary wait, a line above the composer",
				push: () =>
					rig.frame({
						type: "auto_retry_start",
						attempt: 1,
						maxAttempts: 3,
						delayMs: 60_000,
						errorMessage: "429 rate_limit_error",
					}),
				shows: wait,
			},
			{
				label: "a usage limit, a card in its place",
				push: () =>
					rig.frame({
						type: "auto_retry_start",
						attempt: 2,
						maxAttempts: 10,
						delayMs: 90 * 60_000,
						errorMessage: "429 usage limit",
						errorId: USAGE_LIMIT_ERROR_ID,
					}),
				shows: rig.page.locator('[data-testid="retry-wait"][data-kind="usage-limit"]'),
			},
			{
				label: "omp gives up, and a line says how it ended",
				push: () => rig.frame({ type: "auto_retry_end", success: false, attempt: 2, finalError: "Retry cancelled" }),
				shows: async () => expect(rig.page.getByTestId("retry-status")).toContainText("Retry cancelled"),
			},
		];
	},

	"the todo strip moving into the side panel": ({ rig, tag }) => {
		// Beside the chat only where the window is wide: on a tablet or a phone the panel covers the chat instead.
		if (rig.profile !== "desktop") return null;
		const toggle = rig.page.getByTestId("toggle-panel");
		const { strip, appears } = todoList(rig, tag);
		return [
			appears,
			// The panel's Todos tab has the whole list: the strip is not drawn above the composer while it is shown (the
			// panel opens on Agents and Files, so Todos is picked).
			{
				label: "the panel opens on Todos, and the strip moves into it",
				push: async () => {
					await toggle.click();
					await rig.page.getByTestId("pane-tab-todos").click();
				},
				shows: async () => expect(strip).toHaveCount(0),
			},
			{ label: "the panel closes, and the strip is back", push: () => toggle.click(), shows: strip },
		];
	},

	"the window shrinking for the keyboard": async ({ rig }) => {
		const size = rig.page.viewportSize();
		if (!size) throw new Error("the page has no viewport");
		// What a phone's on-screen keyboard leaves of the window, in the browsers that shrink the window for it.
		const keyboard = 291;
		return [
			{
				label: "the keyboard comes up",
				push: () => rig.page.setViewportSize({ width: size.width, height: size.height - keyboard }),
				shows: async () => expect.poll(() => rig.page.evaluate(() => innerHeight)).toBe(size.height - keyboard),
			},
			{
				label: "the keyboard goes away",
				push: () => rig.page.setViewportSize(size),
				shows: async () => expect.poll(() => rig.page.evaluate(() => innerHeight)).toBe(size.height),
			},
		];
	},

	"the device turned on its side": async ({ rig }) => {
		// A desktop window turned on its side is not a thing; a tablet or a phone is.
		if (rig.profile === "desktop") return null;
		const size = rig.page.viewportSize();
		if (!size) throw new Error("the page has no viewport");
		return [
			{
				label: "turned on its side",
				push: () => rig.page.setViewportSize({ width: size.height, height: size.width }),
				shows: async () => expect.poll(() => rig.page.evaluate(() => innerWidth)).toBe(size.height),
			},
			{
				label: "turned back",
				push: () => rig.page.setViewportSize(size),
				shows: async () => expect.poll(() => rig.page.evaluate(() => innerWidth)).toBe(size.width),
			},
		];
	},
};

/** Every step of a kind pushed alone: after each, the page has drawn what it caused, and the newest line is in view. */
async function oneByOne({ rig }: Ctx, steps: Step[]) {
	for (const step of steps) {
		await step.push();
		await expectFollowing(rig.page, step.label, step.shows);
	}
}

/**
 * Tokens that stream, one on every frame of the page, with the steps among them: a step is pushed right after a frame
 * was drawn in which a token came, so it arrives between two frames, the way omp's own frames do, with the scroll that
 * token caused still on its way. `after` is what is required of the page once the step is drawn.
 */
async function amongTokens({ rig, reply }: Ctx, steps: Step[], after: (step: Step) => Promise<unknown>) {
	const token = async () => {
		const said = reply.token();
		await frames(rig.page, 1);
		return said;
	};
	for (const step of steps) {
		await token();
		await token();
		await step.push();
		await token();
		const last = await token();
		await expect(rig.page.getByTestId("transcript")).toContainText(last);
		await after(step);
	}
}

/** Tokens are the growth themselves: there is nothing to put among them. */
const ARE_TOKENS: Record<string, true> = {
	"tokens of a long reply": true,
	"pieces of a reply that are many lines each": true,
	"a long list and a table in pieces": true,
	"thinking that grows and folds when the answer starts": true,
};

type Run = (ctx: Ctx, steps: Step[], kind: string) => Promise<void>;

const RUNS: Record<string, Run> = {
	"one frame at a time, keeps the newest line in view": oneByOne,
	"among streaming tokens, keeps the newest line in view": (ctx, steps) =>
		amongTokens(ctx, steps, (step) => expectFollowing(ctx.rig.page, step.label, step.shows)),
	"a reader who scrolled up stays where they are": async (ctx, steps, kind) => {
		// Some of the reply is there to be read, and the reader has gone back up from it.
		for (let i = 0; i < 6; i++) ctx.reply.token();
		await expectFollowing(ctx.rig.page, "the reply so far", "Sentence number 5 ");
		const top = await scrollUp(ctx.rig.page, 400);
		if (ARE_TOKENS[kind]) {
			for (const step of steps) {
				await step.push();
				await expectStaying(ctx.rig.page, step.label, step.shows, top);
			}
		} else await amongTokens(ctx, steps, (step) => expectStaying(ctx.rig.page, step.label, step.shows, top));
	},
};

for (const profile of PROFILES) {
	for (const [name, kind] of Object.entries(KINDS)) {
		for (const [how, run] of Object.entries(RUNS)) {
			// Tokens are the growth themselves: there is nothing to put among them.
			if (ARE_TOKENS[name] && how.startsWith("among")) continue;
			// A window that changes shape can leave a reader's place beyond the end it now has: the browser cuts it back.
			if (name === "the device turned on its side" && how.startsWith("a reader")) continue;
			test(`${profile}: ${name}, ${how}`, async ({ page, e2eServer, workerStorageState }) => {
				const { rig, close } = await openRig({ e2eServer, workerStorageState }, profile, page);
				try {
					const ctx = { rig, reply: new Reply(rig, "m-follow"), tag: "a1" };
					const steps = await kind(ctx);
					test.skip(steps === null, `${profile} has no such thing`);
					await run(ctx, steps ?? [], name);
				} finally {
					await close();
				}
			});
		}
	}
}

/** `n` tokens, one on every frame of the page; what the last one says. */
async function stream(rig: Rig, reply: Reply, n: number): Promise<string> {
	let said = "";
	for (let i = 0; i < n; i++) {
		said = reply.token();
		await frames(rig.page, 1);
	}
	await expect(rig.page.getByTestId("transcript")).toContainText(said);
	return said;
}

/** The view moves by `dy`: a wheel on a desktop, and a finger on a tablet or a phone (mobile WebKit has no wheel). */
async function scrollBy(rig: Rig, dy: number): Promise<void> {
	const view = rig.page.getByTestId("transcript");
	if (rig.profile !== "desktop") {
		await view.evaluate((el, by) => {
			el.scrollTop += by;
		}, dy);
		return;
	}
	const box = await view.boundingBox();
	if (!box) throw new Error("the transcript is not on the page");
	await rig.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await rig.page.mouse.wheel(0, dy);
}

// A conversation of more than one page of messages (the transcript draws 30 at a time, see `Transcript`).
for (const [name, kind] of Object.entries({
	tokens: KINDS["tokens of a long reply"],
	"a tool card": KINDS["a tool card that opens, streams its output and folds"],
})) {
	for (const [how, run] of Object.entries(RUNS).slice(0, 2)) {
		test(`desktop, a long conversation: ${name}, ${how}`, async ({ page, e2eServer, workerStorageState }) => {
			const { rig, close } = await openRig({ e2eServer, workerStorageState }, "desktop", page, { turns: 45 });
			try {
				const ctx = { rig, reply: new Reply(rig, "m-long"), tag: "d4" };
				await run(ctx, (await kind(ctx)) ?? [], name);
			} finally {
				await close();
			}
		});
	}
}

// A fractional pixel ratio (a 125% or 150% scale on a laptop) rounds scroll positions that are whole numbers of CSS pixels.
for (const ratio of [1.25, 1.5]) {
	test.describe(`desktop at a pixel ratio of ${ratio}`, () => {
		test.use({ deviceScaleFactor: ratio });
		for (const [name, how] of [
			["tokens of a long reply", "one frame at a time, keeps the newest line in view"],
			["a tool card that opens, streams its output and folds", "among streaming tokens, keeps the newest line in view"],
			["a draft that grows the composer", "among streaming tokens, keeps the newest line in view"],
		] as const) {
			test(`${name}, ${how}`, async ({ page, e2eServer, workerStorageState }) => {
				const { rig, close } = await openRig({ e2eServer, workerStorageState }, "desktop", page);
				try {
					const ctx = { rig, reply: new Reply(rig, "m-ratio"), tag: "e5" };
					await RUNS[how](ctx, (await KINDS[name](ctx)) ?? [], name);
				} finally {
					await close();
				}
			});
		}
	});
}

for (const profile of PROFILES) {
	const open = (use: { e2eServer: { url: string }; workerStorageState: string }, page: Page, options?: OpenOptions) =>
		openRig(use, profile, page, options);

	test(`${profile}: a reader who wheels up a little leaves the end, and wheeling back down to it resumes following`, async ({
		page: desktop,
		e2eServer,
		workerStorageState,
	}) => {
		const { rig, close } = await open({ e2eServer, workerStorageState }, desktop);
		const { page } = rig;
		try {
			const reply = new Reply(rig, "m-wheel");
			await expectFollowing(page, "the reply so far", await stream(rig, reply, 6));
			const before = (await endOf(page)).top;
			await scrollBy(rig, -30);
			await expect.poll(async () => (await endOf(page)).top).toBeLessThan(before - 20);
			await frames(page);
			const left = await endOf(page);
			expect(left.following, "the reader has left the end").toBe(false);
			expect(left.button, '"Scroll to bottom" is up').toBe(true);
			// The reply goes on under them.
			await stream(rig, reply, 8);
			expect((await endOf(page)).top, "the reader's place").toBe(left.top);

			await scrollBy(rig, 1000);
			await expect.poll(async () => (await endOf(page)).gap).toBeLessThanOrEqual(ROUNDING);
			await expectFollowing(page, "back at the end", await stream(rig, reply, 8));
		} finally {
			await close();
		}
	});

	test(`${profile}: a reader who comes back down to within reach of the end, but not to it, is not pulled the rest of the way`, async ({
		page: desktop,
		e2eServer,
		workerStorageState,
	}) => {
		const { rig, close } = await open({ e2eServer, workerStorageState }, desktop);
		const { page } = rig;
		try {
			const reply = new Reply(rig, "m-near");
			await expectFollowing(page, "the reply so far", await stream(rig, reply, 6));
			await scrollBy(rig, -200);
			await expect.poll(async () => (await endOf(page)).gap).toBeGreaterThan(150);
			await frames(page);
			// Back down, and short of the end by about 60 px: near, not there. The reader is reading the last lines. (How far
			// up that was depends on the window: on a phone the arrow is a strip under the transcript, which takes its room.)
			const up = (await endOf(page)).gap;
			await scrollBy(rig, up - 60);
			await expect.poll(async () => (await endOf(page)).gap).toBeLessThan(80);
			await frames(page);
			const near = await endOf(page);
			expect(near.gap, "short of the end").toBeGreaterThan(ROUNDING);
			expect(near.following, "not following until the end is reached").toBe(false);
			// The reply goes on under them, and the view stays where they put it.
			await stream(rig, reply, 8);
			await expectStaying(page, "short of the end", () => frames(page), near.top);
		} finally {
			await close();
		}
	});

	test(`${profile}: for a reader who asked for less motion the arrow goes to the end at once, not by a glide`, async ({
		page: desktop,
		e2eServer,
		workerStorageState,
	}) => {
		const { rig, close } = await open({ e2eServer, workerStorageState }, desktop);
		const { page } = rig;
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await scrollUp(page, 900);
			expect((await endOf(page)).gap, "the reader went up").toBeGreaterThan(400);
			await page.getByRole("button", { name: "Scroll to bottom" }).click();
			// A glide takes longer than a few frames to cover 900 px.
			await frames(page, 2);
			expect((await endOf(page)).gap, "at the end two frames after the click").toBeLessThanOrEqual(ROUNDING);
		} finally {
			await close();
		}
	});

	test(`${profile}: the arrow brings a reader back to following while the reply streams`, async ({
		page: desktop,
		e2eServer,
		workerStorageState,
	}) => {
		const { rig, close } = await open({ e2eServer, workerStorageState }, desktop);
		const { page } = rig;
		try {
			const reply = new Reply(rig, "m-arrow");
			await expectFollowing(page, "the reply so far", await stream(rig, reply, 6));
			const top = await scrollUp(page, 600);
			await expectStaying(page, "the reader went up", await stream(rig, reply, 4), top);
			await page.getByRole("button", { name: "Scroll to bottom" }).click();
			// The reply keeps growing while the view goes to its end.
			await expectFollowing(page, "after the arrow", await stream(rig, reply, 20));
		} finally {
			await close();
		}
	});
}
