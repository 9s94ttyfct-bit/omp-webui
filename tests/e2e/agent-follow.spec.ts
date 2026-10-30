import { solidPng } from "../support/chat-session.ts";
import {
	AGENT,
	endOf,
	expectFollowing,
	expectStaying,
	frames,
	ROUNDING,
	type Shows,
	scrollUp,
} from "../support/follow.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { devices, expect, type Locator, type Page, test, webkit } from "./fixtures.ts";

/**
 * The live view of a subagent (the Agents tab) follows its end the way the conversation does (#586): a reader who is at
 * the end stays there through every kind of growth of what the subagent writes (tokens, thinking, a tool that runs, a
 * message that is saved with a tool call, code coloured late, a picture), and a reader who scrolled up is left where
 * they are. Measured on a desktop window, and on an iPad and an iPhone (WebKit) for what changes size most on them.
 * The frames are pushed over the page's socket as omp's own and `get_subagent_messages` is answered by the spec: no
 * model is called.
 */

// Every test opens a conversation of its own, on the worker's own server: they spread over the workers rather than run
// one after the other on one (#773).
test.describe.configure({ mode: "parallel" });

const PROFILES = ["desktop", "iPad (gen 11)", "iPhone 15"] as const;
type Profile = (typeof PROFILES)[number];

type Frame = Record<string, unknown>;

const AGENT_ID = "Scout";
const at = (n: number) => 1_800_000_000_000 + n;
const text = (t: string) => [{ type: "text", text: t }];
const assistant = (content: unknown[], timestamp: number) => ({
	role: "assistant",
	content,
	provider: "anthropic",
	model: "claude-haiku-5-5",
	timestamp,
});
const entry = (id: string, message: Frame) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-07T01:00:00.000Z",
	message,
});
const sentence = (i: number) => `Sentence number ${i} of the report says something of its own about item ${i}. `;
const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join("\n");
/** Each record takes 100 bytes of the pretend transcript file, so offsets are easy to read. */
const BYTES = 100;

let sessions = 0;

interface Probe {
	page: Page;
	records: unknown[];
	/** Push a frame of the subagent to the page as omp's own. */
	frame(ev: Frame): void;
	/** The messages the subagent has written and omp has saved, before the next one is read. */
	save(...more: unknown[]): void;
}

/** A conversation whose running subagent has a transcript of 25 messages, and its live view open in the panel. */
async function open(
	use: { e2eServer: { url: string }; workerStorageState: string },
	profile: Profile,
	desktop: Page,
): Promise<{ probe: Probe; close: () => Promise<void> }> {
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
	const n = 0x5a00 + ++sessions;
	const title = `Agent follow ${n.toString(16)}`;
	sessionWithSubagents(n, title, {});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `agent-follow-${n}`);
	const records: unknown[] = [
		entry("u1", { role: "user", content: text("Find the config files"), attribution: "user", timestamp: at(1) }),
		...Array.from({ length: 25 }, (_, i) =>
			entry(
				`bulk${i}`,
				assistant(text(`Paragraph ${i}. ${"The quick brown fox jumps over the lazy dog. ".repeat(8)}`), at(2 + i)),
			),
		),
	];
	tap.answer("get_subagent_messages", (c) => {
		const from = Math.min(Number(c.fromByte ?? 0), records.length * BYTES);
		return {
			ok: true,
			data: {
				sessionFile: "/virtual/Scout.jsonl",
				fromByte: from,
				nextByte: records.length * BYTES,
				reset: false,
				// A transcript is a chain: each record's parent is the one before it.
				entries: records
					.map((r, i) => ({ ...(r as Frame), parentId: i ? (records[i - 1] as Frame).id : null }))
					.slice(from / BYTES),
				messages: [],
			},
		};
	});
	const send = (f: Frame) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	send({
		type: "subagent_lifecycle",
		payload: {
			id: AGENT_ID,
			agent: "explore",
			agentSource: "bundled",
			index: 0,
			status: "started",
			description: "Find config files",
			parentToolCallId: "call_scout",
		},
	});
	await page.getByTestId("toggle-panel").click();
	await page.getByTestId("subagent-item").first().click();
	const probe: Probe = {
		page,
		records,
		frame: (ev) => send({ type: "subagent_event", payload: { id: AGENT_ID, event: ev } }),
		save: (...more) => void records.push(...more),
	};
	await expect(page.getByTestId("subagent-scroll")).toBeVisible();
	await expectFollowing(page, "the live view as it opens", "Paragraph 24", AGENT);
	return { probe, close };
}

/** The message the subagent is writing: it starts empty, and blocks and text are added to it a piece at a time. */
class Writing {
	private started = false;
	content: Frame[] = [];
	constructor(private readonly probe: Probe) {}

	private show() {
		const message = assistant([...this.content], at(500));
		if (!this.started) {
			this.probe.frame({ type: "message_start", message: assistant([], at(500)) });
			this.started = true;
		}
		this.probe.frame({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", partial: message },
		});
	}

	/** The text block the next tokens add to. */
	private said(): Frame {
		const last = this.content.at(-1);
		if (last?.type === "text") return last;
		const block = { type: "text", text: "" };
		this.content.push(block);
		return block;
	}

	text(delta: string) {
		const block = this.said();
		block.text = `${block.text}${delta}`;
		this.show();
	}

	next = 0;
	/** One more token: the sentence of this number, which the page shows as `Sentence number N `. */
	token(): string {
		const n = this.next++;
		this.text(sentence(n) + (n % 5 === 4 ? "\n\n" : ""));
		return `Sentence number ${n} `;
	}

	/** Thinking, which is open while it is the last thing the subagent is writing. */
	think(delta: string) {
		const last = this.content.at(-1);
		if (last?.type === "thinking") last.thinking = `${last.thinking}${delta}`;
		else this.content.push({ type: "thinking", thinking: delta });
		this.show();
	}

	/** The message is finished and saved with what it holds: the page reads it from the transcript. */
	end(id: string) {
		const message = assistant([...this.content], at(500));
		this.probe.save(entry(id, message));
		this.probe.frame({ type: "message_end", message });
		this.started = false;
		this.content = [];
	}
}

interface Step {
	label: string;
	push: () => void | Promise<void>;
	shows: Shows;
}

interface Ctx {
	probe: Probe;
	say: Writing;
	/** Makes ids unique across the runs of one conversation. */
	tag: string;
}

/** The steps of a kind, whose last one may end the message being written (`alone`: then no token can follow it). */
interface Kind {
	steps: (ctx: Ctx) => Step[];
	/** The steps are the growth themselves, or tokens cannot come among them (the message is saved, the subagent is thinking). */
	alone?: boolean;
}

const loaded = (img: Locator) => async () => {
	await expect(img.first()).toBeAttached();
	await expect.poll(() => img.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
};

const detail = (page: Page) => page.getByTestId("subagent-detail");

const KINDS: Record<string, Kind> = {
	"tokens of a long report": {
		alone: true,
		steps: ({ say }) =>
			Array.from({ length: 30 }, (_, i) => ({
				label: `token ${i}`,
				push: () => void say.token(),
				shows: `Sentence number ${i} `,
			})),
	},

	// The subagent thinks a line at a time in a block that is open while it is the last thing written, and it folds when the answer starts.
	"thinking that grows and folds when the answer starts": {
		alone: true,
		steps: ({ say, probe }) => [
			...Array.from({ length: 14 }, (_, i) => ({
				label: `thinking ${i}`,
				push: () => say.think(`Thought ${i}: ${sentence(i)}\n`),
				shows: `Thought ${i}: `,
			})),
			{
				label: "the answer starts and the thinking folds",
				push: () => say.text("Here is the answer. "),
				shows: async () =>
					expect(detail(probe.page).getByTestId("thinking").locator('button[aria-expanded="false"]')).toBeAttached(),
			},
		],
	},

	"a tool that runs, streams its output and ends": {
		steps: ({ probe, tag }) => {
			const running = detail(probe.page).getByTestId("subagent-running-tool");
			const output = (n: number): Step => ({
				label: `${n} lines of output`,
				push: () =>
					probe.frame({
						type: "tool_execution_update",
						toolCallId: `tc-${tag}`,
						partialResult: { content: text(lines(`out${tag}`, n)) },
					}),
				shows: running.getByText(`out${tag}-${n}`),
			});
			return [
				{
					label: "the tool starts",
					push: () =>
						probe.frame({
							type: "tool_execution_start",
							toolCallId: `tc-${tag}`,
							toolName: "bash",
							args: { command: `make ${tag}` },
							intent: "Build it",
						}),
					shows: running,
				},
				output(6),
				output(20),
				output(40),
				{
					label: "the tool ends",
					push: () =>
						probe.frame({
							type: "tool_execution_end",
							toolCallId: `tc-${tag}`,
							result: { content: text(lines(`out${tag}`, 40)) },
						}),
					shows: async () => expect(running).toHaveCount(0),
				},
			];
		},
	},

	"a message that is saved with a tool call and its result": {
		alone: true,
		steps: ({ probe, say, tag }) => {
			const id = `call-${tag}`;
			return [
				{
					label: "the message is saved, its tool card drawn",
					push: () => {
						say.text(`I will run the build ${tag}.\n\n`);
						say.content.push({ type: "toolCall", id, name: "bash", arguments: { command: `make all ${tag}` } });
						probe.save(
							entry(`r-${tag}`, {
								role: "toolResult",
								toolCallId: id,
								toolName: "bash",
								content: text(lines(`built${tag}`, 40)),
								isError: false,
								timestamp: at(501),
							}),
						);
						say.end(`a-${tag}`);
					},
					shows: probe.page.getByTestId("tool-card").filter({ hasText: `make all ${tag}` }),
				},
				{
					label: "the next message",
					push: () => {
						say.text(`The build ${tag} is done. ${sentence(1)}`);
						say.end(`b-${tag}`);
					},
					shows: `The build ${tag} is done.`,
				},
			];
		},
	},

	"code that is coloured late": {
		steps: ({ probe, say, tag }) =>
			["alpha", "beta"].map((name, i) => ({
				label: `a code block of ${name}`,
				push: () => say.text(`Here is ${name}:\n\n\`\`\`ts\n${lines(`const ${name}${tag}`, 30 + 10 * i)}\n\`\`\`\n\n`),
				// The block is plain when it arrives and coloured when the worker has answered (see `CodeBlock`).
				shows: async () => {
					await expect(probe.page.getByText(`const ${name}${tag}-${30 + 10 * i}`)).toBeAttached();
					await expect(detail(probe.page).locator("pre.shiki").nth(i)).toBeAttached();
				},
			})),
	},

	"a picture that is fetched late": {
		steps: ({ probe, say, tag }) => {
			const hash = tag.repeat(32);
			const gate = Promise.withResolvers<void>();
			const pictures = detail(probe.page).locator(`img[src$="${hash}"]`);
			return [
				{
					label: "the picture's place, before it is fetched",
					push: async () => {
						await probe.page.route(`**/api/blob/${hash}`, async (route) => {
							await gate.promise;
							await route.fulfill({ body: solidPng(480, 360), contentType: "image/png" });
						});
						say.text(`Here is the chart:\n\n![chart](/api/blob/${hash})\n\n`);
					},
					shows: pictures,
				},
				{ label: "the picture arrives", push: () => gate.resolve(), shows: loaded(pictures) },
			];
		},
	},

	"the window shrinking for the keyboard": {
		steps: ({ probe }) => {
			const size = probe.page.viewportSize();
			if (!size) throw new Error("the page has no viewport");
			const keyboard = 291;
			return [
				{
					label: "the keyboard comes up",
					push: () => probe.page.setViewportSize({ width: size.width, height: size.height - keyboard }),
					shows: async () => expect.poll(() => probe.page.evaluate(() => innerHeight)).toBe(size.height - keyboard),
				},
				{
					label: "the keyboard goes away",
					push: () => probe.page.setViewportSize(size),
					shows: async () => expect.poll(() => probe.page.evaluate(() => innerHeight)).toBe(size.height),
				},
			];
		},
	},
};

type Run = (ctx: Ctx, steps: Step[], kind: Kind) => Promise<void>;

/** Tokens that stream, one on every frame of the page, with the steps among them: the way a report really arrives. */
async function amongTokens({ probe, say }: Ctx, steps: Step[], after: (step: Step) => Promise<unknown>) {
	const token = async () => {
		const said = say.token();
		await frames(probe.page, 1);
		return said;
	};
	for (const step of steps) {
		await token();
		await token();
		await step.push();
		await token();
		const last = await token();
		await expect(probe.page.getByTestId(AGENT.testId)).toContainText(last);
		await after(step);
	}
}

const RUNS: Record<string, Run> = {
	"one frame at a time, keeps the newest line in view": async ({ probe }, steps) => {
		for (const step of steps) {
			await step.push();
			await expectFollowing(probe.page, step.label, step.shows, AGENT);
		}
	},
	"among streaming tokens, keeps the newest line in view": (ctx, steps, kind) =>
		kind.alone
			? Promise.resolve()
			: amongTokens(ctx, steps, (step) => expectFollowing(ctx.probe.page, step.label, step.shows, AGENT)),
	"a reader who scrolled up stays where they are": async (ctx, steps, kind) => {
		const { probe, say } = ctx;
		// Some of what the subagent says is there to be read, and the reader has gone back up from it.
		for (let i = 0; i < 6; i++) say.token();
		await expectFollowing(probe.page, "the report so far", "Sentence number 5 ", AGENT);
		const top = await scrollUp(probe.page, 400, AGENT);
		if (kind.alone) {
			for (const step of steps) {
				await step.push();
				await expectStaying(probe.page, step.label, step.shows, top, AGENT);
			}
		} else await amongTokens(ctx, steps, (step) => expectStaying(probe.page, step.label, step.shows, top, AGENT));
	},
};

/** What changes size most on a tablet or a phone: the report itself, a tool, a picture, the keyboard. */
const ON_WEBKIT: Record<string, true> = {
	"tokens of a long report": true,
	"a tool that runs, streams its output and ends": true,
	"a picture that is fetched late": true,
	"the window shrinking for the keyboard": true,
};

for (const profile of PROFILES) {
	for (const [name, kind] of Object.entries(KINDS)) {
		if (profile !== "desktop" && !ON_WEBKIT[name]) continue;
		for (const [how, run] of Object.entries(RUNS)) {
			// Tokens are the growth themselves, and a message that is saved cannot have tokens added to it after.
			if (kind.alone && how.startsWith("among")) continue;
			test(`${profile}: ${name}, ${how}`, async ({ page, e2eServer, workerStorageState }) => {
				const { probe, close } = await open({ e2eServer, workerStorageState }, profile, page);
				try {
					const ctx = { probe, say: new Writing(probe), tag: "a1" };
					await run(ctx, kind.steps(ctx), kind);
				} finally {
					await close();
				}
			});
		}
	}

	test(`${profile}: the arrow brings a reader back to following while the subagent writes`, async ({
		page: desktop,
		e2eServer,
		workerStorageState,
	}) => {
		const { probe, close } = await open({ e2eServer, workerStorageState }, profile, desktop);
		const { page } = probe;
		try {
			const say = new Writing(probe);
			const stream = async (n: number) => {
				let said = "";
				for (let i = 0; i < n; i++) {
					said = say.token();
					await frames(page, 1);
				}
				await expect(page.getByTestId(AGENT.testId)).toContainText(said);
				return said;
			};
			await expectFollowing(page, "the report so far", await stream(6), AGENT);
			const top = await scrollUp(page, 600, AGENT);
			await expectStaying(page, "the reader went up", await stream(4), top, AGENT);
			await page.getByRole("button", { name: "Jump to latest" }).click();
			// The report keeps growing while the view goes to its end.
			await expectFollowing(page, "after the arrow", await stream(20), AGENT);
			expect((await endOf(page, AGENT)).gap).toBeLessThanOrEqual(ROUNDING);
		} finally {
			await close();
		}
	});
}
