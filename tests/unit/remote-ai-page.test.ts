import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DEFAULT_REMOTE_CONFIG, type RemoteSnapshot } from "../../shared/remote.ts";
import { NO_REMOTE_AI } from "../../shared/remote-ai.ts";
import { showLang } from "../../web/src/i18n/index.ts";
import { onLoginNotice, setRemoteSnapshot, useRemote } from "../../web/src/lib/remote.ts";
import { startingPrompt } from "../../web/src/lib/remote-ai.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The page's half of "Set up with AI" that needs no server: the starting prompt (in the language of the page, with
 * where the set-up stands, never a secret) and the notice that offers the Cloudflare sign-in link when the agent, not
 * the card, started the login.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const LOGIN_URL = "https://dash.cloudflare.com/argotunnel?callback=ompw-test";

function snapshot(over: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
	return {
		config: { ...DEFAULT_REMOTE_CONFIG },
		status: { state: "off" },
		installed: false,
		loggedIn: false,
		url: "",
		ai: NO_REMOTE_AI,
		...over,
	};
}

test("the starting prompt says the goal and where things stand, in English", async () => {
	await showLang("en");
	const prompt = startingPrompt(snapshot());
	expect(prompt).toContain("remote_access_guide");
	expect(prompt).toContain("remote_access_status");
	expect(prompt).toContain("Never ask me for a Cloudflare password or an API token");
	expect(prompt).toContain("- cloudflared installed: no; Cloudflare login done: no");
	expect(prompt).toContain("- hostname: not set; team: not set; AUD: not set; allowed e-mail addresses: not set");
	expect(prompt).toContain("- tunnel: Off");
});

test("the starting prompt follows the language of the page, and the state it is given", async () => {
	await showLang("zh-CN");
	const config = {
		...DEFAULT_REMOTE_CONFIG,
		hostname: "omp.example.com",
		team: "my-team",
		aud: "c".repeat(64),
		emails: ["me@example.com", "jdoe@example.com"],
	};
	const prompt = startingPrompt(snapshot({ config, installed: true, loggedIn: true, status: { state: "connected" } }));
	expect(prompt).toContain("请帮我给这个应用");
	expect(prompt).toContain("- cloudflared 已安装：是；Cloudflare 已登录：是");
	expect(prompt).toContain("- 主机名：omp.example.com；团队名：my-team；AUD：已设置；允许的邮箱地址：2");
	expect(prompt).toContain("- 隧道：已连接");
	// Where it stands, and not what the values are: no AUD, no address of anybody's.
	expect(prompt).not.toContain("c".repeat(64));
	expect(prompt).not.toContain("jdoe@example.com");
	await showLang("en");
});

beforeEach(() => {
	useRemote.setState({ snapshot: null, loginUrl: null, busy: null, error: null, check: null });
});

test("a Cloudflare login that waits for the browser is offered once, when the page did not start it", () => {
	const told: string[] = [];
	onLoginNotice((url) => told.push(url));
	setRemoteSnapshot(snapshot());
	expect(told).toEqual([]);

	setRemoteSnapshot(snapshot({ loginUrl: LOGIN_URL }));
	expect(told).toEqual([LOGIN_URL]);
	expect(useRemote.getState().loginUrl).toBe(LOGIN_URL);
	// The card asks again while it waits: the same link is no news.
	setRemoteSnapshot(snapshot({ loginUrl: LOGIN_URL }));
	expect(told).toEqual([LOGIN_URL]);
	// Another login has another link.
	setRemoteSnapshot(snapshot({ loginUrl: `${LOGIN_URL}-2` }));
	expect(told).toEqual([LOGIN_URL, `${LOGIN_URL}-2`]);
});

test("a login the card itself started is not announced: its own click opens the link", () => {
	const told: string[] = [];
	onLoginNotice((url) => told.push(url));
	useRemote.setState({ busy: "login" });
	setRemoteSnapshot(snapshot({ loginUrl: LOGIN_URL }));
	expect(told).toEqual([]);
	expect(useRemote.getState().loginUrl).toBe(LOGIN_URL);
});
