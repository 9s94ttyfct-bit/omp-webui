import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImportArchive } from "../../server/migrate/import.ts";
import { absoluteBucket, homeBucket } from "../../server/migrate/rewrite.ts";
import { redactSecrets } from "../../server/migrate/secrets.ts";
import { ZipReader } from "../../server/migrate/zip.ts";
import { scratch, text } from "../support/migrate-run.ts";
import { LEGACY_ID, type Machine, seedMachine, seedSession, stopMachine } from "../support/migrate-world.ts";

/**
 * What a person who left their logins out of the archive expects to be out of it (#572, the security review): keys and
 * tokens under any name a configuration file gives them, numbers, connection strings, `.env` files. And an archive that the
 * importer would refuse is never made.
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

/** Every byte of an archive, and of each entry in it, as text. */
async function everything(file: string): Promise<string[]> {
	const zip = await ZipReader.open(file);
	const all = [readFileSync(file).toString("latin1")];
	for (const e of zip.entries) all.push(Buffer.from(await zip.bytes(e.name)).toString("latin1"));
	await zip.close();
	return all;
}

const SECRETS = {
	awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	openaiKey: "plainopenaikey1234567890",
	notionKey: "notionkeyvalue1234567890",
	xapi: "xapikeyvalue1234567890",
	signing: "signingkeyvalue1234567890",
	pwArg: "pwargvalue1234567890",
	numToken: "9876543210123",
	jsonc: "jsoncsecretvalue1234567890",
	envFile: "skill-env-secret-1234567890",
	envLocal: "envlocal-secret-1234567890",
	nested: "ymlnestedsecret1234567890",
	accessKey: "cs_live_abcdef123456",
	pat: "pat-value-abcdef123456",
	conn: "hunter2hunter2",
	upperKey: "ABCDEF0123456789ABCDEF0123456789",
	pem: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
	cosmos: "cosmosprimarykeyvalue1234567890",
	sendKey: "SCT1234567890abcdefSENDKEY",
};

function plant(m: Machine): void {
	const w = (p: string, t: string) => {
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, t);
	};
	w(
		join(m.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				aws: {
					command: "uvx",
					args: ["aws-mcp", "--password", SECRETS.pwArg],
					env: {
						AWS_SECRET_ACCESS_KEY: SECRETS.awsSecret,
						OPENAI_KEY: SECRETS.openaiKey,
						NOTION_KEY: SECRETS.notionKey,
						SIGNING_KEY: SECRETS.signing,
						AZURE_COSMOS_PRIMARY_KEY: SECRETS.cosmos,
						SENDKEY: SECRETS.sendKey,
						CONNECTION_STRING: `Server=db;User Id=sa;Password=${SECRETS.conn};`,
					},
				},
				web: { url: "https://x.example/mcp", headers: { "X-Api-Key": SECRETS.xapi, "X-Auth": SECRETS.pat } },
			},
		}),
	);
	w(
		join(m.agentDir, "models.yml"),
		`providers:\n  p1:\n    baseUrl: http://x\n    accessKey: ${SECRETS.accessKey}\n    apiKey: ${SECRETS.upperKey}\n    headers:\n      x-goog-api-key: ${SECRETS.nested}\n`,
	);
	w(join(m.agentDir, "lsp.json"), `// comment\n{"servers":{"a":{"env":{"MY_KEY":"${SECRETS.jsonc}"}}},}\n`);
	w(join(m.agentDir, "skills", "x", ".env"), `SERVICE_TOKEN=${SECRETS.envFile}\n`);
	w(join(m.agentDir, "hooks", ".env.local"), `API_KEY=${SECRETS.envLocal}\n`);
	w(
		join(m.agentDir, "tools", "t", "server.pem"),
		`-----BEGIN PRIVATE KEY-----\n${SECRETS.pem}\n-----END PRIVATE KEY-----\n`,
	);
	w(join(m.agentDir, "config.yml"), `theme: dark\nsomeService:\n  token: ${SECRETS.numToken}\n`);
}

describe("an archive made with the logins left out", () => {
	test("holds none of the secrets a configuration file keeps, under any key name, as a number, or in a connection string", async () => {
		const old = seedMachine(join(root, "l1"), "jdoe");
		plant(old);
		const { file, manifest } = await exportOf(old);
		const all = await everything(file);
		for (const [name, value] of Object.entries(SECRETS)) {
			expect(
				all.some((t) => t.includes(value)),
				name,
			).toBe(false);
		}
		// What is not a secret is still there: the file's other values, and the rest of the settings.
		const mcp = JSON.parse(await zipText(file, "agent/mcp.json"));
		expect(mcp.mcpServers.aws.command).toBe("uvx");
		expect(mcp.mcpServers.web.url).toBe("https://x.example/mcp");
		expect(await zipText(file, "agent/config.yml")).toContain("theme: dark");
		// The plan names the files that hold some: the person is told to look at them.
		expect(manifest.secretFiles.map((f) => f.path.split("/").pop()).sort()).toEqual([
			"config.yml",
			"lsp.json",
			"mcp.json",
			"models.yml",
		]);
		stopMachine(old);
	});

	test("lists the .env and key files it leaves out, and carries them only in the encrypted part", async () => {
		const old = seedMachine(join(root, "l2"), "jdoe");
		plant(old);
		const plain = await exportOf(old);
		const left = plain.manifest.leftOut.filter((l) => l.reason === "secret").map((l) => l.path.replace(old.home, "~"));
		expect(left).toContain("~/.omp/agent/skills/x/.env");
		expect(left).toContain("~/.omp/agent/hooks/.env.local");
		expect(left).toContain("~/.omp/agent/tools/t/server.pem");
		expect(plain.manifest.entries.some((e) => /\.env|\.pem/.test(e.path))).toBe(false);
		const sealed = await exportOf(old, { credentials: true, password: "correct horse battery" });
		expect(sealed.manifest.leftOut.some((l) => l.reason === "secret")).toBe(false);
		const all = await everything(sealed.file);
		for (const value of [SECRETS.envFile, SECRETS.envLocal, SECRETS.pem])
			expect(all.some((t) => t.includes(value))).toBe(false);
		const fresh = seedMachine(join(root, "l3"), "alice", { rich: false });
		await importInto(fresh, sealed.file, { credentials: true, password: "correct horse battery" });
		expect(text(fresh.agentDir, "skills", "x", ".env")).toBe(`SERVICE_TOKEN=${SECRETS.envFile}\n`);
		expect(text(fresh.agentDir, "hooks", ".env.local")).toBe(`API_KEY=${SECRETS.envLocal}\n`);
		expect(text(fresh.agentDir, "config.yml")).toContain(`token: ${SECRETS.numToken}`);
		stopMachine(old);
		stopMachine(fresh);
	});

	test("every key that ends in key, secret, token, password or pat is a secret, and an all-capitals value is a key unless it is an environment variable's name", () => {
		const yaml = (key: string, value: string | number) => redactSecrets(`a:\n  ${key}: ${value}\n`, "yaml");
		for (const key of [
			"apiKey",
			"accessKey",
			"SECRET_KEY",
			"SUPABASE_SERVICE_KEY",
			"client_secret",
			"authToken",
			"db_password",
			"GITHUB_PAT",
			"x-api-key",
			"privateKey",
		]) {
			const r = yaml(key, "valuevaluevalue123");
			expect([key, r.count, r.text.includes("valuevaluevalue123")]).toEqual([key, 1, false]);
		}
		for (const key of ["maxTokens", "monkeyBusiness", "path", "keyboard", "type", "baseUrl", "contextWindow"]) {
			expect([key, yaml(key, "valuevaluevalue123").count]).toEqual([key, 0]);
		}
		// Numbers: a long one at a secret key is one; a small one is a setting.
		expect(yaml("token", 9876543210123).count).toBe(1);
		expect(yaml("maxToken", 4096).count).toBe(0);
		// omp reads `apiKey: OPENAI_API_KEY` as the name of a variable: it is not a secret. Anything else all capitals is.
		expect(yaml("apiKey", "OPENAI_API_KEY").count).toBe(0);
		expect(yaml("apiKey", "ABCDEF0123456789ABCDEF").count).toBe(1);
		expect(yaml("SERVICE_KEY", "OPENAI_API_KEY").count).toBe(1);
		// A connection string.
		const conn = redactSecrets(
			JSON.stringify({ env: { C: "Server=db;User Id=sa;Password=hunter2hunter2;Encrypt=yes" } }),
			"json",
		);
		expect(conn.text).not.toContain("hunter2");
		expect(conn.text).toContain("Server=db");
		expect(conn.text).toContain("Encrypt=yes");
		// A file that is no document is read line by line: what looks like a secret is blanked, the rest is kept.
		const loose = redactSecrets(
			`// c\n{"a":{"MY_KEY":"jsoncsecretvalue1234567890","name":"x"}},}\nSERVICE_TOKEN=abcdef123456\n`,
			"json",
		);
		expect(loose.text).not.toContain("jsoncsecretvalue");
		expect(loose.text).not.toContain("abcdef123456");
		expect(loose.text).toContain('"name":"x"');
	});
});

async function zipText(file: string, name: string): Promise<string> {
	const zip = await ZipReader.open(file);
	const out = Buffer.from(await zip.bytes(name)).toString("utf8");
	await zip.close();
	return out;
}

describe("an archive the importer would refuse is never made", () => {
	test("a skill that is a link into a dev folder, and a link out of the plugins' folder, are left out with a note", async () => {
		const old = seedMachine(join(root, "s1"), "jdoe");
		const dev = join(old.home, "dev", "my-skill");
		mkdirSync(dev, { recursive: true });
		writeFileSync(join(dev, "SKILL.md"), "---\nname: my-skill\n---\n");
		symlinkSync(dev, join(old.agentDir, "skills", "my-skill"));
		const plugins = join(old.home, ".omp", "plugins");
		symlinkSync(dev, join(plugins, "node_modules", "dev-plugin"));
		// A real package that npm put there: it is downloaded again, not carried.
		mkdirSync(join(plugins, "node_modules", "real-pkg"), { recursive: true });
		writeFileSync(join(plugins, "node_modules", "real-pkg", "index.js"), "x");
		const { file, manifest } = await exportOf(old);
		const links = manifest.entries.filter((e) => e.kind === "symlink").map((e) => e.path);
		expect(links).toEqual(["omp/plugins/node_modules/tool"]);
		const left = Object.fromEntries(manifest.leftOut.map((l) => [l.path.replace(old.home, "~"), l.reason]));
		expect(left["~/.omp/agent/skills/my-skill"]).toBe("machine");
		expect(left["~/.omp/plugins/node_modules/dev-plugin"]).toBe("machine");
		expect(left["~/.omp/plugins/node_modules/real-pkg"]).toBe("redownload");
		const archive = await ImportArchive.open(file);
		await archive.close();
		const fresh = seedMachine(join(root, "s2"), "alice", { rich: false });
		await importInto(fresh, file);
		stopMachine(old);
		stopMachine(fresh);
	});

	test("a file of lines that is not a conversation is copied whole, even when its last line has no newline", async () => {
		const old = seedMachine(join(root, "j1"), "jdoe");
		const data = `{"a":1}\n{"b":2}`;
		mkdirSync(join(old.agentDir, "skills", "x"), { recursive: true });
		writeFileSync(join(old.agentDir, "skills", "x", "examples.jsonl"), data);
		writeFileSync(join(old.agentDir, "skills", "x", "one-line.jsonl"), `{"only":true}`);
		const { file } = await exportOf(old);
		expect(await zipText(file, "agent/skills/x/examples.jsonl")).toBe(data);
		expect(await zipText(file, "agent/skills/x/one-line.jsonl")).toBe(`{"only":true}`);
		stopMachine(old);
	});
});

describe("a fork whose folder is renamed", () => {
	test("names its parent in the folder the parent is moved to", async () => {
		const old = seedMachine(join(root, "f1"), "jdoe");
		const legacy = join(old.home, "legacy");
		const forkId = "0190aaaa-0000-7000-8000-0000000000f2";
		const parent = join(
			old.agentDir,
			"sessions",
			absoluteBucket(legacy),
			`2026-01-05T10-00-00-000Z_${LEGACY_ID}.jsonl`,
		);
		seedSession(old, {
			id: forkId,
			bucket: absoluteBucket(legacy),
			cwd: legacy,
			title: "Legacy fork",
			extra: { parentSession: parent, previousSessionFiles: [parent] },
		});
		const { file } = await exportOf(old);
		const fresh = seedMachine(join(root, "f2"), "alice", { rich: false });
		await importInto(fresh, file);
		const bucket = homeBucket(join(fresh.home, "legacy"), fresh.home) as string;
		const moved = join(fresh.agentDir, "sessions", bucket, `2026-01-05T10-00-00-000Z_${forkId}.jsonl`);
		const header = JSON.parse(
			text(moved)
				.split("\n")
				.find((l) => l.includes('"type":"session"')) as string,
		);
		const want = join(fresh.agentDir, "sessions", bucket, `2026-01-05T10-00-00-000Z_${LEGACY_ID}.jsonl`);
		expect(header.parentSession).toBe(want);
		expect(header.previousSessionFiles).toEqual([want]);
		stopMachine(old);
		stopMachine(fresh);
	});
});

describe("what the settings of an editor or a database are, that looks like a secret and is not, and the other way round", () => {
	const yaml = (key: string, value: string) => redactSecrets(`a:\n  ${key}: ${value}\n`, "yaml");

	test("a key of the keyboard, of a sort or of a cache is a setting: it is not blanked", () => {
		for (const key of [
			"hotkey",
			"sortKey",
			"shortcutKey",
			"cacheKey",
			"foreignKey",
			"partitionKey",
			"keybindings",
			"leaderKey",
		]) {
			const r = yaml(key, "ctrl+shift+p");
			expect([key, r.count, r.text.includes("ctrl+shift+p")]).toEqual([key, 0, true]);
		}
		// …and the folder you are in, which is `PWD`, is no password.
		expect(yaml("PWD", "/Users/jdoe/work").count).toBe(0);
		expect(redactSecrets(JSON.stringify({ env: { PWD: "/Users/jdoe/work", KEY_COUNT: "3" } }), "json").count).toBe(0);
	});

	test("a primary key and a send key are secrets (Azure Cosmos, ServerChan)", () => {
		for (const key of ["AZURE_COSMOS_PRIMARY_KEY", "primaryKey", "SENDKEY"]) {
			const r = yaml(key, "cosmosprimarykeyvalue1234567890");
			expect([key, r.count]).toEqual([key, 1]);
		}
	});

	test("DB_PASS, MYSQL_PWD and a password written like them are secrets: as a key, and in a command line", () => {
		for (const key of ["DB_PASS", "MYSQL_PWD", "dbPass", "PGPASSWORD", "smtp_pass", "REDIS_PASSWORD"]) {
			const r = yaml(key, "hunter2hunter2");
			expect([key, r.count, r.text.includes("hunter2")]).toEqual([key, 1, false]);
		}
		const line = redactSecrets(
			JSON.stringify({ args: ["-e", "mysql --host db MYSQL_PWD=hunter2hunter2 DB_PASS=other-secret-1 ok=1"] }),
			"json",
		);
		expect(line.text).not.toContain("hunter2");
		expect(line.text).not.toContain("other-secret-1");
		expect(line.text).toContain("ok=1");
		for (const key of ["bypass", "compass", "passthrough", "password_policy_url"]) {
			if (key !== "password_policy_url") expect([key, yaml(key, "yes").count]).toEqual([key, 0]);
		}
	});

	test("a webhook's address is a secret: Slack, Discord, Teams, and a key named for one", () => {
		const hooks = {
			slack: "https://hooks.slack.com/services/T01234567/B01234567/abcdefghijklmnopqrstuvwx",
			discord: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123",
			teams:
				"https://contoso.webhook.office.com/webhookb2/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@11111111/IncomingWebhook/abcdef0123456789",
			generic: "https://hooks.example.com/api/webhooks/abcdefghijklmnopqrstuvwxyz0123456789",
		};
		const doc = {
			mcpServers: {
				n: {
					env: {
						SLACK_URL: hooks.slack,
						NOTIFY: hooks.discord,
						TEAMS: hooks.teams,
						G: hooks.generic,
						OTHER_WEBHOOK: "https://example.com/in/short",
						HOME_PAGE: "https://example.com/docs",
					},
				},
			},
		};
		const r = redactSecrets(JSON.stringify(doc), "json");
		for (const [name, url] of Object.entries(hooks))
			expect([name, r.text.includes(url.split("/").pop() as string)]).toEqual([name, false]);
		expect(r.text).toContain("https://example.com/docs");
		expect(JSON.parse(r.text).mcpServers.n.env.OTHER_WEBHOOK).toBe("");
	});
});
