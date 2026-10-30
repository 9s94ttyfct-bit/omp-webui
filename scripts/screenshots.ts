/**
 * Screenshots for the README and docs/TECHNICAL*.md (`bun run screenshots`, or `npm run screenshots`) → docs/screenshots/*.png.
 *
 * The real UI (the build in dist/web, served by the real server) against throwaway omp-webui servers on
 * made-up conversations, in both themes and both languages. Nothing calls a model and nothing comes from your
 * machine's omp: each server gets an isolated HOME and omp agent directory and no Anthropic login
 * (tests/support/server.ts, `login: false`), the conversations below are written into it as session files, and the
 * provider quota the header pill shows is `QUOTA` below, answered by the page's `/api/usage` route, not by `omp usage`.
 *
 * The images are written to a temporary directory and replace docs/screenshots/ only when every shot has been taken:
 * a run that fails (no browser, a selector that no longer exists) leaves the committed images as they were.
 *
 * Run it again after a UI change and commit the new images. Needs Chrome (or PLAYWRIGHT_CHANNEL=chromium
 * after `npx playwright install chromium`). OMPW_SHOT_PORT (default 7881) is the first of two free ports.
 *
 * Which shot shows what is the SHOTS table below; adding one is one more row.
 */
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { FIXTURE_BUCKET } from "../tests/support/fixtures.ts";
import { startTestServer, type TestServer } from "../tests/support/server.ts";
import { onShutdown } from "./lib/shutdown.ts";

const root = join(import.meta.dirname, "..");
const outDir = join(root, "docs", "screenshots");
/** Where a run writes until it has finished; see the header. */
const stageDir = mkdtempSync(join(tmpdir(), "ompw-shots-"));
/** The browser and the server being started or running: a signal can arrive before either is ready. */
let launching: Promise<Browser> | null = null;
let starting: Promise<TestServer> | null = null;
/** What ends the run, whether it finishes, fails or is stopped by a signal (a `finally` does not run on one). */
const cleanup = onShutdown(async () => {
	await (await launching?.catch(() => null))?.close().catch(() => {});
	await (await starting?.catch(() => null))?.stop();
	rmSync(stageDir, { recursive: true, force: true });
});
const firstPort = Number(process.env.OMPW_SHOT_PORT ?? 7881);

type Lang = "en" | "zh-CN";
type Theme = "dark" | "light";

// ───────────────────────────── made-up conversations ─────────────────────────────

const HOUR = 3_600_000;
const MINUTE = 60_000;

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Writes one conversation as an omp session file; each entry follows the one before unless `parent` says otherwise. */
class Convo {
	readonly entries: Record<string, unknown>[] = [];
	#at: number;
	#n = 0;
	constructor(
		readonly tag: string,
		readonly title: string,
		readonly cwd: string,
		/** When the conversation started, as milliseconds before now. */
		ageMs: number,
	) {
		this.#at = Date.now() - ageMs;
	}
	get lastId(): string | null {
		return (this.entries.at(-1)?.id as string | undefined) ?? null;
	}
	#id(): string {
		return `${this.tag}${String(++this.#n).padStart(4, "0")}`;
	}
	#tick(ms: number): string {
		this.#at += ms;
		return new Date(this.#at).toISOString();
	}
	user(text: string, parent: string | null | undefined = undefined): string {
		const id = this.#id();
		const timestamp = this.#tick(40_000);
		this.entries.push({
			type: "message",
			id,
			parentId: parent === undefined ? this.lastId : parent,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text }],
				attribution: "user",
				timestamp: Date.parse(timestamp),
			},
		});
		return id;
	}
	assistant(content: unknown[], u: Usage, took = 14_000): string {
		const id = this.#id();
		const timestamp = this.#tick(took);
		this.entries.push({
			type: "message",
			id,
			parentId: this.lastId,
			timestamp,
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-5",
				usage: {
					input: u.input,
					output: u.output,
					cacheRead: u.cacheRead,
					cacheWrite: u.cacheWrite,
					totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
				},
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			},
		});
		return id;
	}
	/** A tool call with its result, as two entries. */
	tool(
		name: string,
		args: Record<string, unknown>,
		result: string,
		u: Usage,
		details: unknown = {},
		lead?: string,
	): void {
		const callId = `toolu_${this.tag}_${this.#n + 1}`;
		const content: unknown[] = lead ? [{ type: "text", text: lead }] : [];
		content.push({ type: "toolCall", id: callId, name, arguments: args });
		this.assistant(content, u, 5_000);
		const id = this.#id();
		const timestamp = this.#tick(3_000);
		this.entries.push({
			type: "message",
			id,
			parentId: this.lastId,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: [{ type: "text", text: result }],
				details,
				isError: false,
				timestamp: Date.parse(timestamp),
			},
		});
	}
	/** Written to `<agentDir>/sessions/…`; the file's modification time orders the sidebar. */
	write(agentDir: string, endedAgoMs: number): string {
		const dir = join(agentDir, "sessions", `-${this.cwd.replace(/^\//, "").replace(/\//g, "-")}`);
		mkdirSync(dir, { recursive: true });
		const stamp = new Date(Date.now() - endedAgoMs).toISOString();
		const file = join(dir, `${stamp.replace(/[:.]/g, "-")}_01b00000-0000-7000-8000-${this.tag.padEnd(12, "0")}.jsonl`);
		const header = {
			type: "session",
			version: 3,
			id: `01b00000-0000-7000-8000-${this.tag.padEnd(12, "0")}`,
			timestamp: stamp,
			cwd: this.cwd,
		};
		// omp's fixed-width title slot: one JSON line padded to exactly 256 bytes including the newline.
		const slot = { type: "title", v: 1, title: this.title, source: "user", updatedAt: stamp, pad: "" };
		slot.pad = " ".repeat(255 - Buffer.byteLength(JSON.stringify(slot)));
		const body = [header, ...this.entries].map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(file, `${JSON.stringify(slot)}\n${body}\n`);
		const at = (Date.now() - endedAgoMs) / 1000;
		utimesSync(file, at, at);
		return file;
	}
}

const u = (input: number, output: number, cacheRead: number, cost: number): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	cost,
});

const diff = (lines: string[]) => lines.join("\n");

interface Text {
	title: string;
	branchTitle: string;
	prompt: string;
	read: string;
	readResult: string;
	thinking: string;
	editNote: string;
	editResult: string;
	bashResult: string;
	summary: string;
	otherTitles: [string, string, string, string, string];
	editedPrompt: string;
	branchReply: string;
	agentsTitle: string;
	agentsPrompt: string;
	agentAssignments: [string, string];
	agentsFinal: string;
}

const TEXT: Record<Lang, Text> = {
	en: {
		title: "Rate-limit the search API",
		branchTitle: "Rate limit across servers",
		prompt:
			"/api/search is getting hammered by a few clients. Add a per-IP rate limit of 60 requests per minute, return 429 with a Retry-After header, and cover it with a test.",
		read: "Let me see how routes are registered first.",
		readResult:
			'import { serve } from "bun";\nimport { search } from "./search";\n\nserve({\n  port: 3000,\n  routes: {\n    "/api/search": (req) => search(req),\n  },\n});\n',
		thinking:
			"The routes are a plain object, so the simplest place for the limit is a small wrapper around the handler. A fixed window per IP is enough here: a Map of counters that resets every 60 seconds. I should keep it out of the handler so the test can drive it with a fake clock.",
		editNote: "A fixed window per IP is enough here. I'll put the limiter in its own module and wrap the handler.",
		editResult: "Updated src/server.ts",
		bashResult:
			"bun test v1.3.4\n\nsrc/rate-limit.test.ts:\n✓ allows 60 requests in a minute [0.41ms]\n✓ answers the 61st with 429 and Retry-After [0.12ms]\n✓ starts a new window after 60 seconds [0.09ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [18.00ms]\n",
		summary:
			"`/api/search` now allows **60 requests per minute per IP** and answers the rest with `429 Too Many Requests` and a `Retry-After` header.\n\n- `src/rate-limit.ts`: a fixed-window limiter (`createLimiter({ limit, windowMs, now })`) with an injectable clock\n- `src/server.ts`: the search route is wrapped with it\n- `src/rate-limit.test.ts`: three tests, including the window reset\n\n```ts\nconst limited = withLimit(createLimiter({ limit: 60, windowMs: 60_000 }), search);\n```\n\nThe counters live in memory, so each server process counts on its own. If you run several, say so and I'll move them to Redis.",
		otherTitles: [
			"Why is the CI build slow?",
			"Migrate the settings page to the new form library",
			"Explain the retry logic in the uploader",
			"Draft the changelog for 2.4",
			"Add dark mode to the docs site",
		],
		editedPrompt:
			"Add a per-IP rate limit of 60 requests per minute to /api/search. Use Redis so it works across servers.",
		branchReply: "Redis it is. I'll use a `INCR` + `EXPIRE` pair per IP so the limit holds across processes.",
		agentsTitle: "Audit the dependencies",
		agentsPrompt:
			"Audit our dependencies: which are outdated, which have known vulnerabilities, and which we no longer import?",
		agentAssignments: [
			"Find outdated dependencies and list the safe upgrades",
			"Find dependencies that no source file imports",
		],
		agentsFinal:
			"Three packages are safe to upgrade now, `left-pad` and `moment` are no longer imported and can go, and `jsonwebtoken` needs a major upgrade that I'd do separately.",
	},
	"zh-CN": {
		title: "给搜索接口加上限流",
		branchTitle: "多台服务器共用的限流",
		prompt:
			"/api/search 被少数几个客户端刷得很厉害。请按 IP 限流，每分钟 60 次，超出返回 429 并带上 Retry-After 头，再写一个测试。",
		read: "先看看路由是怎么注册的。",
		readResult:
			'import { serve } from "bun";\nimport { search } from "./search";\n\nserve({\n  port: 3000,\n  routes: {\n    "/api/search": (req) => search(req),\n  },\n});\n',
		thinking:
			"路由就是一个普通对象，最简单的做法是在处理函数外面包一层。这里用按 IP 的固定窗口就够了：一个计数用的 Map，每 60 秒清零。限流逻辑要放在处理函数之外，这样测试可以用假时钟来驱动它。",
		editNote: "按 IP 的固定窗口就够用。我把限流器单独放一个模块，再包住处理函数。",
		editResult: "Updated src/server.ts",
		bashResult:
			"bun test v1.3.4\n\nsrc/rate-limit.test.ts:\n✓ allows 60 requests in a minute [0.41ms]\n✓ answers the 61st with 429 and Retry-After [0.12ms]\n✓ starts a new window after 60 seconds [0.09ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [18.00ms]\n",
		summary:
			"`/api/search` 现在每个 IP **每分钟最多 60 次**，超出的请求返回 `429 Too Many Requests` 并带上 `Retry-After` 头。\n\n- `src/rate-limit.ts`：固定窗口限流器（`createLimiter({ limit, windowMs, now })`），时钟可注入\n- `src/server.ts`：搜索路由已经包上限流\n- `src/rate-limit.test.ts`：三个测试，包括窗口重置\n\n```ts\nconst limited = withLimit(createLimiter({ limit: 60, windowMs: 60_000 }), search);\n```\n\n计数放在内存里，所以每个服务进程各算各的。如果你会运行多个进程，告诉我，我改用 Redis。",
		otherTitles: [
			"为什么 CI 构建这么慢？",
			"把设置页迁移到新的表单库",
			"讲讲上传器的重试逻辑",
			"起草 2.4 版本的更新日志",
			"给文档站加上深色模式",
		],
		editedPrompt: "给 /api/search 加上按 IP 每分钟 60 次的限流，用 Redis 实现，这样多台服务器也能共用。",
		branchReply: "用 Redis。我对每个 IP 用 `INCR` 加 `EXPIRE`，这样多个进程之间限制也一致。",
		agentsTitle: "审查项目依赖",
		agentsPrompt: "审查一下我们的依赖：哪些过期了，哪些有已知漏洞，哪些已经没人引用？",
		agentAssignments: ["找出过期的依赖，列出可以放心升级的", "找出没有任何源文件引用的依赖"],
		agentsFinal:
			"有三个包现在可以放心升级，`left-pad` 和 `moment` 已经没人引用，可以删掉；`jsonwebtoken` 需要大版本升级，建议单独做。",
	},
};

interface Seeded {
	rateLimit: string;
	branches: string;
	agents: string;
}

/** Writes the conversations of one language into the agent directory; the fixture sessions the server came with are removed. */
function seed(server: TestServer, lang: Lang): Seeded {
	const t = TEXT[lang];
	rmSync(join(server.agentDir, "sessions", FIXTURE_BUCKET), { recursive: true, force: true });

	const rateLimit = new Convo("rl01", t.title, "/Users/dev/acme-api", 95 * MINUTE);
	rateLimit.user(t.prompt);
	rateLimit.tool("read", { path: "src/server.ts" }, t.readResult, u(1_840, 96, 0, 0.0071), {}, t.read);
	rateLimit.assistant(
		[
			{ type: "thinking", thinking: t.thinking },
			{ type: "text", text: t.editNote },
		],
		u(2_104, 311, 1_840, 0.0102),
	);
	rateLimit.tool(
		"edit",
		{
			i: "Wrapping the search route",
			input:
				'[acme-api/src/server.ts#4F2A]\nPUT 3.=8:\n+import { createLimiter, withLimit } from "./rate-limit";\n+\n+const limiter = createLimiter({ limit: 60, windowMs: 60_000 });\n',
		},
		'[acme-api/src/server.ts#4F2A]\n3:import { createLimiter, withLimit } from "./rate-limit";',
		u(2_650, 420, 3_944, 0.0123),
		{
			diff: diff([
				' 1|import { serve } from "bun";',
				' 2|import { search } from "./search";',
				'+3|import { createLimiter, withLimit } from "./rate-limit";',
				"+4|",
				"+5|const limiter = createLimiter({ limit: 60, windowMs: 60_000 });",
				" 6|",
				" 7|serve({",
				" 8|  port: 3000,",
				" 9|  routes: {",
				'-10|    "/api/search": (req) => search(req),',
				'+10|    "/api/search": withLimit(limiter, search),',
				" 11|  },",
				" 12|});",
			]),
			firstChangedLine: 3,
			op: "update",
			path: "/Users/dev/acme-api/src/server.ts",
		},
	);
	rateLimit.tool(
		"bash",
		{ command: "bun test src/rate-limit.test.ts" },
		t.bashResult,
		u(3_020, 118, 6_594, 0.0098),
		{},
		undefined,
	);
	rateLimit.assistant([{ type: "text", text: t.summary }], u(3_410, 402, 9_614, 0.0187), 21_000);
	const rateLimitFile = rateLimit.write(server.agentDir, 90 * MINUTE);

	// Branches: the first prompt, then the same turn edited (omp keeps both as branches of one conversation).
	const branches = new Convo("br01", t.branchTitle, "/Users/dev/acme-api", 3 * HOUR);
	branches.user(t.prompt, null);
	branches.assistant([{ type: "text", text: t.summary }], u(1_300, 210, 0, 0.0094));
	branches.user(t.editedPrompt, null);
	branches.assistant([{ type: "text", text: t.branchReply }], u(1_200, 88, 0, 0.0061));
	const branchesFile = branches.write(server.agentDir, 150 * MINUTE);

	// Subagents: a task call with two transcripts.
	const agents = new Convo("ag01", t.agentsTitle, "/Users/dev/acme-api", 26 * HOUR);
	agents.user(t.agentsPrompt);
	const ids = ["Outdated", "Unused"];
	agents.tool(
		"task",
		{ tasks: ids.map((id, i) => ({ id, assignment: t.agentAssignments[i] })) },
		`${ids.join(", ")}: done`,
		u(2_000, 260, 0, 0.0121),
	);
	agents.assistant([{ type: "text", text: t.agentsFinal }], u(2_900, 190, 2_000, 0.0111));
	const agentsFile = agents.write(server.agentDir, 25 * HOUR);
	const artifacts = agentsFile.replace(/\.jsonl$/, "");
	mkdirSync(artifacts, { recursive: true });
	ids.forEach((id, i) => {
		const sub = new Convo(`sa0${i}`, "", "/Users/dev/acme-api", 26 * HOUR - 4 * MINUTE);
		sub.user(t.agentAssignments[i] ?? "");
		sub.tool(
			"bash",
			{ command: i === 0 ? "bun outdated" : "bunx knip --dependencies" },
			"…",
			u(900 + i * 200, 80, 0, 0.003 + i * 0.001),
		);
		sub.assistant([{ type: "text", text: t.agentsFinal }], u(1_400, 220, 900, 0.0058 + i * 0.002));
		const header = {
			type: "session",
			version: 3,
			id: `01b00000-0000-7000-8000-sa0${i}00000000`,
			timestamp: new Date(Date.now() - 26 * HOUR).toISOString(),
			cwd: "/Users/dev/acme-api",
		};
		writeFileSync(
			join(artifacts, `${id}.jsonl`),
			`${[header, ...sub.entries].map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
	});

	// More conversations for the sidebar: a few days of history.
	const ages = [4 * HOUR, 9 * HOUR, 30 * HOUR, 52 * HOUR, 120 * HOUR];
	const projects = [
		"/Users/dev/acme-api",
		"/Users/dev/acme-web",
		"/Users/dev/acme-web",
		"/Users/dev/acme-api",
		"/Users/dev/docs",
	];
	t.otherTitles.forEach((title, i) => {
		const c = new Convo(`ot0${i}`, title, projects[i] ?? "/Users/dev/acme-api", (ages[i] ?? HOUR) + 5 * MINUTE);
		c.user(title);
		c.assistant([{ type: "text", text: title }], u(1_000, 120, 0, 0.004));
		c.write(server.agentDir, ages[i] ?? HOUR);
	});
	// The server names a conversation by its real path (macOS: /private/var/…).
	return {
		rateLimit: realpathSync(rateLimitFile),
		branches: realpathSync(branchesFile),
		agents: realpathSync(agentsFile),
	};
}

// ───────────────────────────── shots ─────────────────────────────

interface Shot {
	name: string;
	langs: Lang[];
	viewport?: { width: number; height: number };
	/** Navigates to the view and waits until it is ready to be photographed. */
	prepare(page: Page, s: Seeded, lang: Lang): Promise<void>;
}

const open = (file: string) => `/#/s/${encodeURIComponent(file)}`;

const SHOTS: Shot[] = [
	{
		name: "chat",
		langs: ["en", "zh-CN"],
		async prepare(page, s) {
			await page.goto(open(s.rateLimit));
			await page.getByTestId("chat-title").waitFor();
			// The turn's steps are folded behind "Worked for … · N tool calls": open them.
			const summary = page.getByTestId("work-summary");
			await summary.waitFor();
			if ((await summary.getAttribute("aria-expanded")) === "false") await summary.click();
			await page.locator('[data-testid="tool-card"][data-tool="edit"]').first().waitFor();
			await page.locator('[data-testid="tool-card"][data-tool="bash"]').first().waitFor();
			// A conversation opens on its latest messages: show it from the prompt on. The opened steps and the code
			// that is highlighted after them grow the transcript, and a transcript that grows while it is followed goes
			// back to its end: scroll to the top until it stays there for half a second.
			await page.getByTestId("transcript").evaluate(async (el) => {
				const until = Date.now() + 10_000;
				let stillSince = Date.now();
				while (Date.now() < until) {
					if (el.scrollTop !== 0) {
						el.scrollTo(0, 0);
						stillSince = Date.now();
					} else if (Date.now() - stillSince >= 500) return;
					await new Promise((r) => setTimeout(r, 50));
				}
				throw new Error("the transcript does not stay at its top");
			});
		},
	},
	{
		name: "search",
		langs: ["en", "zh-CN"],
		async prepare(page, s) {
			await page.goto(open(s.rateLimit));
			await page.getByTestId("chat-title").waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByTestId("palette-input").fill("Redis");
			await page.getByTestId("search-hit").first().waitFor();
		},
	},
	{
		name: "branches",
		langs: ["en"],
		async prepare(page, s) {
			await page.goto(open(s.branches));
			await page.getByTestId("chat-title").waitFor();
			await page.getByText("Redis").first().waitFor();
		},
	},
	{
		name: "agents",
		langs: ["en"],
		async prepare(page, s) {
			await page.goto(open(s.agents));
			await page.getByTestId("chat-title").waitFor();
			await page.getByTestId("toggle-panel").click();
			await page.getByTestId("right-panel").waitFor();
		},
	},
	{
		name: "settings",
		langs: ["en", "zh-CN"],
		async prepare(page) {
			await page.goto("/#/settings");
			await page.waitForLoadState("networkidle");
		},
	},
	{
		name: "phone",
		langs: ["en"],
		viewport: { width: 390, height: 844 },
		async prepare(page, s) {
			await page.goto(open(s.rateLimit));
			await page.getByTestId("chat-title").waitFor();
		},
	},
];

/** The provider quota every shot shows (what `omp usage --json` would report); made up, like the conversations. */
const QUOTA = [
	{
		provider: "anthropic",
		limits: [
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * HOUR, resetsAt: Date.now() + 3 * 24 * HOUR },
				amount: { remainingFraction: 0.62, unit: "percent" },
				status: "ok",
			},
		],
	},
];

async function context(
	browser: Browser,
	server: TestServer,
	lang: Lang,
	theme: Theme,
	viewport: { width: number; height: number },
): Promise<BrowserContext> {
	const ctx = await browser.newContext({
		baseURL: server.url,
		viewport,
		deviceScaleFactor: 1.5,
		locale: lang,
		colorScheme: theme,
		isMobile: viewport.width < 600,
		hasTouch: viewport.width < 600,
	});
	await ctx.route("**/api/usage**", (route) => route.fulfill({ json: QUOTA }));
	await ctx.addCookies([
		{ name: "ompw_token", value: server.accessToken, url: server.url, httpOnly: true, sameSite: "Strict" },
	]);
	await ctx.addInitScript(
		([l, th]) => {
			localStorage.setItem("ompw.lang", l as string);
			localStorage.setItem("ompw.theme", th as string);
		},
		[lang, theme],
	);
	return ctx;
}

// Playwright would handle the signals itself (close the browser, exit) and race `cleanup`, which does both.
launching = chromium.launch({
	channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
	handleSIGINT: false,
	handleSIGTERM: false,
	handleSIGHUP: false,
});
const languages: Lang[] = ["en", "zh-CN"];
let written = 0;
try {
	const browser = await launching;
	for (const [i, lang] of languages.entries()) {
		starting = startTestServer(firstPort + i, {}, { login: false });
		const server = await starting;
		try {
			const seeded = seed(server, lang);
			for (const shot of SHOTS.filter((x) => x.langs.includes(lang))) {
				for (const theme of ["dark", "light"] as Theme[]) {
					const ctx = await context(browser, server, lang, theme, shot.viewport ?? { width: 1280, height: 800 });
					const page = await ctx.newPage();
					try {
						await shot.prepare(page, seeded, lang);
					} catch (error) {
						mkdirSync(join(root, ".tmp"), { recursive: true });
						const failed = join(root, ".tmp", `screenshot-failed-${shot.name}-${lang}-${theme}.png`);
						await page.screenshot({ path: failed });
						console.error(`${shot.name} (${lang}, ${theme}) failed; what the page showed: ${failed}`);
						throw error;
					}
					// Let streaming-in pieces (highlighting in the worker, fonts, transitions) settle.
					await page.evaluate(() => document.fonts.ready);
					// The version line would make every shot stale at the next release.
					// The scroll-to-bottom arrow floats over the text of a conversation opened from its top.
					await page.addStyleTag({
						content:
							'[data-testid="app-versions"],[aria-label="Scroll to bottom"],[aria-label="滚动到底部"]{visibility:hidden}',
					});
					await page.waitForTimeout(800);
					const file = join(stageDir, `${shot.name}-${lang}-${theme}.png`);
					await page.screenshot({ path: file });
					console.log(`took ${shot.name}-${lang}-${theme}.png`);
					written++;
					await ctx.close();
				}
			}
		} finally {
			await server.stop();
			starting = null;
		}
	}
	// Every shot succeeded (a failure throws above, and the process ends before this): now the images are replaced.
	mkdirSync(outDir, { recursive: true });
	const fresh = readdirSync(stageDir);
	for (const old of readdirSync(outDir))
		if (!fresh.includes(old)) rmSync(join(outDir, old), { recursive: true, force: true });
	for (const name of fresh) copyFileSync(join(stageDir, name), join(outDir, name));
	console.log(`${written} screenshots in docs/screenshots/`);
} finally {
	await cleanup();
}
