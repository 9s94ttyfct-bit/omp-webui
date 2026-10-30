import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { absoluteBucket, homeBucket } from "../../server/migrate/rewrite.ts";

/**
 * A made-up machine for the migration tests: a home folder with omp's layout in it (conversations, databases, settings,
 * plugins) and this app's data folder. Nothing here is a real person's; the names are invented.
 */

export const SECRETS = {
	apiKey: "sk-test-0123456789abcdefghijklmnop",
	bearer: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
	envToken: "tok_0123456789abcdef",
	oauth: "oauth-refresh-token-0123456789abcdef",
	loginKey: "login-api-key-0123456789abcdef",
	secretsYml: "plain-secret-value-0123456789",
	pem: "-----BEGIN CERTIFICATE-----\nMIIBsecretcertificate0123456789\n-----END CERTIFICATE-----\n",
	tunnel: '{"AccountTag":"acct-0123456789","TunnelSecret":"tunnelsecret0123456789"}',
};

export interface Machine {
	home: string;
	agentDir: string;
	dataDir: string;
	/** A database connection kept open with unflushed changes in its `-wal`: what a running omp is. */
	live: Database[];
	/** Folders conversations were started in with `--session-dir`. */
	sessionDirs: string[];
}

export const TUNNEL_ID = "01234567-89ab-cdef-0123-456789abcdef";

export const SESSION_ID = "0190aaaa-0000-7000-8000-000000000001";
export const FORK_ID = "0190aaaa-0000-7000-8000-000000000002";
export const LEGACY_ID = "0190aaaa-0000-7000-8000-000000000003";
export const TMP_ID = "0190aaaa-0000-7000-8000-000000000004";

function put(path: string, text: string | Uint8Array, mtime?: Date): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	if (mtime) utimesSync(path, mtime, mtime);
}

/** omp's title slot: one JSON line padded to 256 bytes with its newline. */
function titleSlot(title: string): string {
	const slot = { type: "title", v: 1, title, source: "auto", updatedAt: "2026-01-05T10:00:00.000Z", pad: "" };
	slot.pad = " ".repeat(255 - Buffer.byteLength(JSON.stringify(slot)));
	return `${JSON.stringify(slot)}\n`;
}

export interface SessionSeed {
	id: string;
	bucket: string;
	cwd: string;
	title: string;
	extra?: Record<string, unknown>;
	/** More lines after the first reply. */
	turns?: number;
	mtime?: Date;
}

export function transcript(s: SessionSeed): string {
	const header = {
		type: "session",
		version: 3,
		id: s.id,
		timestamp: "2026-01-05T10:00:00.000Z",
		cwd: s.cwd,
		...s.extra,
	};
	const lines = [header];
	let parent: string | null = null;
	for (let i = 0; i <= (s.turns ?? 1); i++) {
		const id = `m${i}`;
		lines.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: "2026-01-05T10:01:00.000Z",
			message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${s.title} turn ${i}` }] },
		} as never);
		parent = id;
	}
	return `${titleSlot(s.title)}${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

export function seedSession(m: Machine, s: SessionSeed): string {
	const file = join(m.agentDir, "sessions", s.bucket, `2026-01-05T10-00-00-000Z_${s.id}.jsonl`);
	put(file, transcript(s), s.mtime ?? new Date("2026-02-03T04:05:06.000Z"));
	return file;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The memory bank folder omp names for a working directory. */
export function bankName(cwd: string): string {
	return `${cwd.split("/").pop()}-${Bun.hash(cwd).toString(36)}`;
}

/** Lay out a machine under `root` (its home is `<root>/Users/<user>`). */
export function seedMachine(root: string, user: string, options: { rich?: boolean } = {}): Machine {
	const home = join(root, "Users", user);
	const agentDir = join(home, ".omp", "agent");
	const dataDir = join(home, ".omp-webui");
	const m: Machine = { home, agentDir, dataDir, live: [], sessionDirs: [] };
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	if (options.rich === false) return m;

	// Conversations: a project under home, one named the old way (by its whole path), one outside home.
	const proj = join(home, "proj");
	const legacy = join(home, "legacy");
	const outside = join(root, "elsewhere", "tmpproj");
	seedSession(m, {
		id: SESSION_ID,
		bucket: homeBucket(proj, home) as string,
		cwd: proj,
		title: "Alpha session",
		turns: 3,
	});
	seedSession(m, {
		id: FORK_ID,
		bucket: homeBucket(proj, home) as string,
		cwd: proj,
		title: "Alpha fork",
		extra: {
			parentSession: join(
				agentDir,
				"sessions",
				homeBucket(proj, home) as string,
				`2026-01-05T10-00-00-000Z_${SESSION_ID}.jsonl`,
			),
		},
	});
	seedSession(m, { id: LEGACY_ID, bucket: absoluteBucket(legacy), cwd: legacy, title: "Legacy session" });
	seedSession(m, { id: TMP_ID, bucket: absoluteBucket(outside), cwd: outside, title: "Outside session" });
	// Its subagent's transcript and an artifact beside it.
	const nested = join(agentDir, "sessions", homeBucket(proj, home) as string, `2026-01-05T10-00-00-000Z_${SESSION_ID}`);
	put(join(nested, "0-Scout.jsonl"), transcript({ id: "sub-1", bucket: "", cwd: proj, title: "Scout" }));
	put(join(nested, "artifact-1.md"), "# found\nnothing\n");
	const blob = "an image's bytes";
	put(join(agentDir, "blobs", sha(blob)), blob);

	// History: rows that are only in the `-wal` while a connection holds the database open (a running omp).
	const history = new Database(join(agentDir, "history.db"));
	history.exec("PRAGMA journal_mode = WAL");
	history.exec(
		"CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), cwd TEXT, session_id TEXT, use_count INTEGER NOT NULL DEFAULT 1);" +
			"CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id');" +
			"CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt); END;" +
			"CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);" +
			"CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL, recap TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);",
	);
	history.run("INSERT INTO history (prompt, created_at, cwd, session_id, use_count) VALUES (?, 100, ?, ?, 2)", [
		"explain the zebra protocol",
		proj,
		SESSION_ID,
	]);
	history.run("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, 200, ?, ?)", [
		"wombat routing question",
		outside,
		TMP_ID,
	]);
	history.run("INSERT INTO session_titles (session_id, title) VALUES (?, ?)", [SESSION_ID, "Alpha session"]);
	history.run("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, 5)", [
		SESSION_ID,
		proj,
		"recapped zebra",
	]);
	m.live.push(history);

	// Memories: the shared bank, a bank named after a project, one of this app's own scratch banks, one of unknown origin.
	const mem = (path: string, text: string): void => {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.exec("PRAGMA journal_mode = WAL; CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT);");
		db.run("INSERT INTO working_memory VALUES (?, ?)", ["a", text]);
		m.live.push(db);
	};
	mem(join(agentDir, "memories", "mnemopi", "mnemopi.db"), "global memory");
	mem(join(agentDir, "memories", "mnemopi", "banks", bankName(proj), "mnemopi.db"), "project memory");
	mem(join(agentDir, "memories", "mnemopi", "banks", "ompw-context-AbCdEf-3dbuilwio4276", "mnemopi.db"), "scratch");
	mem(join(agentDir, "memories", "mnemopi", "banks", "mystery-1abcdefgh", "mnemopi.db"), "mystery memory");
	// A bank of a folder no conversation was kept for: only the prompt history remembers it was worked in.
	const onlyInHistory = join(home, "histonly");
	mem(join(agentDir, "memories", "mnemopi", "banks", bankName(onlyInHistory), "mnemopi.db"), "history-only memory");
	history.run("INSERT INTO history (prompt, created_at, cwd) VALUES (?, 300, ?)", [
		"a question from another folder",
		onlyInHistory,
	]);

	// Settings: with comments, absolute paths under home and values that are secrets.
	put(
		join(agentDir, "config.yml"),
		`# my settings\ntheme:\n  dark: titanium   # night\nmodelRoles:\n  default: anthropic/model-a\n`,
	);
	put(
		join(agentDir, "models.yml"),
		`providers:\n  local:\n    baseUrl: http://127.0.0.1:8000/v1\n    api: openai-completions\n    apiKey: ${SECRETS.apiKey}\n    auth: none\n  runner:\n    command: ${home}/bin/serve-models\n`,
	);
	put(
		join(agentDir, "mcp.json"),
		`${JSON.stringify(
			{
				mcpServers: {
					github: {
						type: "http",
						url: "https://mcp.example.com/mcp",
						headers: { Authorization: `Bearer ${SECRETS.bearer}` },
					},
					blender: {
						type: "stdio",
						command: `${home}/.local/bin/blender-mcp`,
						env: { PORT: "9877", API_TOKEN: SECRETS.envToken },
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	put(
		join(agentDir, "lsp.json"),
		`${JSON.stringify({ servers: { gopls: { command: `${home}/go/bin/gopls` } } }, null, 2)}\n`,
	);
	put(join(agentDir, "AGENTS.md"), `# Rules\nBe kind to ${home}/notes.\n`);
	put(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nDemo skill.\n");
	put(join(agentDir, "session-pins.json"), JSON.stringify([SESSION_ID]));
	put(join(agentDir, "secrets.yml"), `- type: plain\n  content: ${SECRETS.secretsYml}\n`);
	// Left out: caches and per-machine state.
	put(join(agentDir, "cache", "composer.db"), "cache");
	put(join(agentDir, "models.db"), "models");
	put(join(agentDir, "terminal-sessions", "tty1"), "tty");

	// Logins, and the usage records that stay behind.
	const auth = new Database(join(agentDir, "agent.db"));
	auth.exec(
		"PRAGMA journal_mode = WAL;" +
			"CREATE TABLE schema_version (version INTEGER PRIMARY KEY);" +
			"CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);" +
			"CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);" +
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);" +
			"CREATE TABLE usage_history (id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL);" +
			"CREATE TRIGGER rev_i AFTER INSERT ON auth_credentials BEGIN UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1; END;" +
			"INSERT INTO schema_version VALUES (6); INSERT INTO auth_schema_version VALUES (1, 8); INSERT INTO auth_change_revision VALUES (1, 0);",
	);
	auth.run(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')",
		["anthropic", JSON.stringify({ refresh: SECRETS.oauth })],
	);
	auth.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?)", [
		"ollama-cloud",
		JSON.stringify({ key: SECRETS.loginKey }),
	]);
	auth.run("INSERT INTO usage_history (recorded_at, provider) VALUES (1, 'anthropic')");
	m.live.push(auth);

	// Plugins: the registry names absolute paths, and each installed plugin is linked from `node_modules`.
	const plugins = join(home, ".omp", "plugins");
	const installed = join(plugins, "cache", "plugins", "market___tool___1.0.0");
	put(join(installed, "package.json"), '{"name":"tool"}\n');
	put(
		join(plugins, "installed_plugins.json"),
		`${JSON.stringify({ version: 2, plugins: { "tool@market": [{ scope: "user", installPath: installed, version: "1.0.0" }] } }, null, 2)}\n`,
	);
	put(join(plugins, "omp-plugins.lock.json"), '{"plugins":{"tool":{"version":"1.0.0","enabled":true}}}\n');
	mkdirSync(join(plugins, "node_modules"), { recursive: true });
	symlinkSync(installed, join(plugins, "node_modules", "tool"));
	put(join(plugins, "cache", "marketplaces", "market", "marketplace.json"), "{}");
	put(
		join(home, ".omp", "marketplaces.json"),
		`${JSON.stringify({ version: 1, marketplaces: [{ name: "market", sourceType: "github", catalogPath: join(plugins, "cache", "marketplaces", "market", "marketplace.json") }] }, null, 2)}\n`,
	);
	put(join(home, ".omp", "install-id"), "machine-identity");
	put(join(home, ".omp", "stats.db"), "stats");
	put(join(home, ".omp", "logs", "omp.log"), "log");

	// This app's data.
	const file = (name: string) => join(agentDir, "sessions", homeBucket(proj, home) as string, name);
	put(
		join(dataDir, "ui-prefs.json"),
		JSON.stringify({
			id: "prefs-id-old",
			rev: 3,
			values: { "ompw.theme": "dark", "ompw.lang": "zh-CN", "ompw.cwd": proj },
		}),
	);
	put(join(dataDir, "favorite-models.json"), JSON.stringify(["anthropic/model-a"]));
	put(
		join(dataDir, "archived.json"),
		JSON.stringify([
			file(`2026-01-05T10-00-00-000Z_${FORK_ID}.jsonl`),
			join(agentDir, "sessions", absoluteBucket(legacy), `2026-01-05T10-00-00-000Z_${LEGACY_ID}.jsonl`),
		]),
	);
	put(
		join(dataDir, "approval.json"),
		JSON.stringify({
			default: "ask",
			sessions: { [file(`2026-01-05T10-00-00-000Z_${SESSION_ID}.jsonl`)]: "auto" },
			usageWait: {},
			models: {},
		}),
	);
	put(join(dataDir, "session-roots.json"), JSON.stringify({ roots: [] }));
	put(
		join(dataDir, "remote.json"),
		JSON.stringify({
			enabled: true,
			hostname: "omp.example.com",
			team: "my-team",
			aud: "a".repeat(64),
			emails: ["me@example.com"],
			tunnelId: TUNNEL_ID,
			tunnelName: "omp",
			autostart: true,
		}),
	);
	put(join(dataDir, "index.db"), "index");
	put(join(dataDir, "token"), "access-token");
	// Web Push: the key this server signs with and the subscriptions made against it stay on this computer.
	put(join(dataDir, "push-vapid.json"), '{"v":1,"jwk":{"d":"private"}}');
	put(join(dataDir, "push-devices.json"), '{"v":1,"devices":[]}');
	// The other Macs this one opens (#628): the sign-in stores its `storeId`s name are this computer's.
	put(
		join(dataDir, "remote-macs.json"),
		JSON.stringify({
			version: 1,
			macs: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					name: "Studio Mac",
					host: "studio.example.com",
					team: "my-team",
					storeId: "22222222-2222-4222-8222-222222222222",
					added: "2026-10-01T09:00:00Z",
					lastConnected: null,
				},
			],
		}),
	);
	put(join(home, ".cloudflared", "cert.pem"), SECRETS.pem);
	put(join(home, ".cloudflared", `${TUNNEL_ID}.json`), SECRETS.tunnel);
	return m;
}

/** Close the connections of a machine (a running omp's). */
export function stopMachine(m: Machine): void {
	for (const db of m.live) db.close();
	m.live = [];
}

/** A `--profile`'s agent directory: its own conversations and settings. */
export function seedProfile(m: Machine, name: string): string {
	const agent = join(m.home, ".omp", "profiles", name, "agent");
	const cwd = join(m.home, "work-proj");
	put(
		join(
			agent,
			"sessions",
			homeBucket(cwd, m.home) as string,
			`2026-01-06T10-00-00-000Z_0190aaaa-0000-7000-8000-0000000000p1.jsonl`,
		),
		transcript({ id: "0190aaaa-0000-7000-8000-0000000000p1", bucket: "", cwd, title: "Profile session" }),
	);
	put(join(agent, "config.yml"), `profileSetting: ${m.home}/profile-data\n`);
	return agent;
}

/** A folder given to omp with `--session-dir`: its conversations are files straight in it. */
export function seedSessionDir(m: Machine, name: string): string {
	const dir = join(m.home, name);
	const cwd = join(m.home, "chat-proj");
	put(
		join(dir, `2026-01-07T10-00-00-000Z_0190aaaa-0000-7000-8000-0000000000d1.jsonl`),
		transcript({ id: "0190aaaa-0000-7000-8000-0000000000d1", bucket: "", cwd, title: "Chat session" }),
	);
	m.sessionDirs.push(dir);
	return dir;
}
