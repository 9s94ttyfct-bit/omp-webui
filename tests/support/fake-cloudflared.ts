import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for `cloudflared` and for the `brew` that installs it, so specs never touch Cloudflare, never install
 * anything and never need the real program (which is not installed on this machine, and must not be). Everything is
 * shell scripts steered by files in a state directory, so it runs under Node (Playwright) and Bun alike.
 *
 * - `tunnel login` prints the URL cloudflared prints and waits until `approveLogin()`, then writes `$HOME/.cloudflared/cert.pem`.
 * - `tunnel create <name>` writes the credentials file and prints the two lines cloudflared prints.
 * - `tunnel route dns <id> <host>` answers like cloudflared does (or refuses: `routeExists`, `fail("route")`).
 * - `tunnel --no-autoupdate --config <file> run <id>` follows a plan (`setPlan`): lines to print on stderr, pauses,
 *   an exit, or for ever. By default it logs four "Registered tunnel connection" lines and stays up.
 * - `brew install cloudflared` puts the fake where `OMP_WEBUI_CLOUDFLARED` points.
 */

/** The id `tunnel create` reports unless a spec chooses another. */
export const FAKE_TUNNEL_ID = "6b1f3d5e-1c2a-4e8b-9d3f-0a1b2c3d4e5f";

/** What the tunnel prints, in cloudflared's own words (timestamps and all). */
export const LOG = {
	starting: "2026-10-21T09:00:00Z INF Starting tunnel tunnelID=6b1f3d5e-1c2a-4e8b-9d3f-0a1b2c3d4e5f",
	registered: (index: number) =>
		`2026-10-21T09:00:0${index}Z INF Registered tunnel connection connIndex=${index} connection=00000000-0000-4000-8000-00000000000${index} event=0 ip=198.41.200.${index} location=sjc0${index} protocol=quic`,
	unregistered: (index: number) =>
		`2026-10-21T09:05:0${index}Z INF Unregistered tunnel connection connIndex=${index} event=0 ip=198.41.200.${index} location=sjc0${index} protocol=quic`,
	error: (what: string) => `2026-10-21T09:00:09Z ERR ${what} connIndex=0 event=0 ip=198.41.200.1`,
};

const CLOUDFLARED = `#!/bin/sh
S="@STATE@"
echo "$*" >> "$S/calls"
flag() { [ -s "$S/$1" ]; }
case "$1" in
  --version) echo "cloudflared version 2026.10.0 (built 2026-10-01-0000 UTC)"; exit 0 ;;
esac
[ "$1" = tunnel ] || { echo "unexpected: $*" >&2; exit 2; }
case "$2" in
  login)
    if flag login-fails; then echo "failed to fetch the login URL: connection refused" >&2; exit 1; fi
    if flag login-silent; then while :; do sleep 0.05; done; fi
    printf 'Please open the following URL and log in with your Cloudflare account:\\n\\n%s\\n\\nLeave cloudflared running to download the cert automatically.\\n' "$(cat "$S/login-url" 2>/dev/null || echo 'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Ffake')"
    while [ ! -e "$S/login-approve" ]; do sleep 0.05; done
    if flag login-ends-badly; then echo "error: the callback never came" >&2; exit 1; fi
    mkdir -p "$HOME/.cloudflared"; echo cert > "$HOME/.cloudflared/cert.pem"
    echo "You have successfully logged in."
    exit 0 ;;
  create)
    name="$3"
    if flag hang; then while :; do sleep 0.05; done; fi
    if flag create-exists; then echo "failed to create tunnel: Create Tunnel API error: code 1013: tunnel with name already exists" >&2; exit 1; fi
    if flag create-fails; then echo "failed to create tunnel: API error: unauthorized" >&2; exit 1; fi
    id="$(cat "$S/tunnel-id" 2>/dev/null || echo ${FAKE_TUNNEL_ID})"
    mkdir -p "$HOME/.cloudflared"
    echo '{"AccountTag":"a","TunnelSecret":"c2VjcmV0","TunnelID":"'"$id"'"}' > "$HOME/.cloudflared/$id.json"
    echo "Tunnel credentials written to $HOME/.cloudflared/$id.json. cloudflared chose this file based on where your origin certificate was found. Keep this file secret. To revoke these credentials, delete the tunnel." >&2
    echo "Created tunnel $name with id $id"
    exit 0 ;;
  route)
    if flag hang; then while :; do sleep 0.05; done; fi
    if flag route-exists; then echo "Failed to add route: code: 1003, reason: Failed to create record $5 with err An A, AAAA, or CNAME record with that host already exists." >&2; exit 1; fi
    if flag route-fails; then echo "Failed to add route: code: 1000, reason: zone not found for $5" >&2; exit 1; fi
    echo "2026-10-21T09:00:00Z INF Added CNAME $5 which will route to this tunnel tunnelID=$4" >&2
    exit 0 ;;
  list)
    name=""; prev=""
    for a in "$@"; do [ "$prev" = --name ] && name="$a"; prev="$a"; done
    read -r eid ename < "$S/existing-tunnel" 2>/dev/null || { echo '[]'; exit 0; }
    if [ -z "$name" ] || [ "$name" = "$ename" ]; then echo '[{"id":"'"$eid"'","name":"'"$ename"'","created_at":"2026-10-01T00:00:00Z","deleted_at":"0001-01-01T00:00:00Z","connections":[]}]'; else echo '[]'; fi
    exit 0 ;;
esac
# tunnel --no-autoupdate --config FILE run ID
cfg=""; prev=""
for a in "$@"; do [ "$prev" = --config ] && cfg="$a"; prev="$a"; done
n=$(( $(cat "$S/run-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/run-count"
[ -n "$cfg" ] && cp "$cfg" "$S/run-$n.yml"
echo "run $n pid=$$" >> "$S/run-events"
if flag ignore-term; then trap '' TERM; else trap 'echo "term $n" >> "$S/run-events"; exit 0' TERM INT; fi
plan="$S/run-plan.$n"; [ -f "$plan" ] || plan="$S/run-plan"
while IFS= read -r line; do
  case "$line" in
    "emit "*) echo "\${line#emit }" >&2 ;;
    "sleep "*) sleep "\${line#sleep }" ;;
    "exit "*) echo "exit $n \${line#exit }" >> "$S/run-events"; exit "\${line#exit }" ;;
  esac
done < "$plan"
while :; do sleep 0.05; done
`;

/** `brew install cloudflared` puts the template where the server looks for the program; anything else fails like brew does. */
const BREW = `#!/bin/sh
S="@STATE@"
echo "$*" >> "$S/brew-calls"
if [ "$1 $2" != "install cloudflared" ]; then echo "Error: unexpected: $*" >&2; exit 1; fi
if [ -s "$S/brew-fails" ]; then echo "Error: cloudflared: no available formula" >&2; exit 1; fi
echo "==> Fetching cloudflared"
sleep "$(cat "$S/brew-seconds" 2>/dev/null || echo 0)"
echo "==> Pouring cloudflared--2026.10.0.arm64_sequoia.bottle.tar.gz"
cp "@TEMPLATE@" "@TARGET@"
chmod 755 "@TARGET@"
echo "🍺  /opt/homebrew/Cellar/cloudflared/2026.10.0: 12 files"
`;

export interface FakeCloudflared {
	/** What `OMP_WEBUI_CLOUDFLARED` is set to: the program, once it exists (`brew install` puts it there). */
	bin: string;
	/** What `OMP_WEBUI_BREW` is set to. */
	brew: string;
	/** The `HOME` of whatever runs the program (`cert.pem` and the credentials go below it). */
	home: string;
	/** Every command line the program was run with, one per line. */
	calls(): string[];
	/** Every `brew` command line. */
	brewCalls(): string[];
	/** How many times `tunnel run` started. */
	runs(): number;
	/** The configuration file the nth `tunnel run` was started with (as it was when it started). */
	runConfig(n: number): string;
	/** What the runs did: `run <n> pid=<pid>`, `term <n>` when stopped by a signal, `exit <n> <code>`. */
	events(): string[];
	/** The pid of the nth run. */
	runPid(n: number): number;
	/** What `tunnel run` does: `emit <text>` prints on stderr, `sleep <s>`, `exit <code>`; it stays up when the plan ends. For run `n` only, or all. */
	setPlan(lines: string[], n?: number): void;
	/** Let the waiting `tunnel login` finish. */
	approveLogin(): void;
	setLoginUrl(url: string): void;
	/** Make a step fail: `route-exists` is the DNS record that already exists. */
	fail(
		what:
			| "login"
			| "login-silent"
			| "login-ends-badly"
			| "create"
			| "route"
			| "route-exists"
			| "brew"
			| "hang"
			| "ignore-term",
		on?: boolean,
	): void;
	/** The id `tunnel create` reports. */
	setTunnelId(id: string): void;
	/** The account already has a tunnel of this name: `tunnel create` refuses it, `tunnel list` reports it. */
	existingTunnel(id: string, name: string): void;
	/** `brew install` takes this long. */
	setBrewSeconds(s: number): void;
	hasCert(): boolean;
	hasCredentials(id?: string): boolean;
}

/** A plan for `setPlan`: the lines the program prints on stderr (with their prefix, e.g. from `LOG`). */
export const emit = (...logLines: string[]): string[] => logLines.map((l) => `emit ${l}`);

/** What a tunnel that comes up prints: it starts and registers four connections. */
export const connectedPlan = (): string[] => emit(LOG.starting, ...[0, 1, 2, 3].map(LOG.registered));

/**
 * The fake in `dir`. `installed: false` leaves the program out until the fake `brew install` puts it there; the
 * template it copies is `dir/template/cloudflared`.
 */
export function makeFakeCloudflared(dir: string, o: { installed?: boolean } = {}): FakeCloudflared {
	const state = join(dir, "state");
	const home = join(dir, "home");
	const binDir = join(dir, "bin");
	const template = join(dir, "template", "cloudflared");
	const bin = join(binDir, "cloudflared");
	const brew = join(dir, "brew-bin", "brew");
	for (const d of [state, home, binDir, join(dir, "template"), join(dir, "brew-bin")])
		mkdirSync(d, { recursive: true });
	const script = (path: string, body: string) => {
		writeFileSync(
			path,
			body.replaceAll("@STATE@", state).replaceAll("@TEMPLATE@", template).replaceAll("@TARGET@", bin),
		);
		chmodSync(path, 0o755);
	};
	script(template, CLOUDFLARED);
	if (o.installed !== false) script(bin, CLOUDFLARED);
	script(brew, BREW);
	const put = (name: string, text: string) => writeFileSync(join(state, name), text);
	const lines = (name: string): string[] => {
		try {
			return readFileSync(join(state, name), "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	put("run-plan", `${connectedPlan().join("\n")}\n`);
	const flagFiles = {
		login: "login-fails",
		"login-silent": "login-silent",
		"login-ends-badly": "login-ends-badly",
		create: "create-fails",
		route: "route-fails",
		"route-exists": "route-exists",
		brew: "brew-fails",
		hang: "hang",
		"ignore-term": "ignore-term",
	} as const;
	return {
		bin,
		brew,
		home,
		calls: () => lines("calls"),
		brewCalls: () => lines("brew-calls"),
		runs: () => Number(lines("run-count")[0] ?? 0),
		runConfig: (n) => readFileSync(join(state, `run-${n}.yml`), "utf8"),
		events: () => lines("run-events"),
		runPid(n) {
			const line = lines("run-events").find((l) => l.startsWith(`run ${n} `));
			const pid = /pid=(\d+)/.exec(line ?? "")?.[1];
			if (!pid) throw new Error(`run ${n} has not started`);
			return Number(pid);
		},
		setPlan(plan, n) {
			put(n === undefined ? "run-plan" : `run-plan.${n}`, `${plan.join("\n")}\n`);
		},
		approveLogin: () => put("login-approve", "1"),
		setLoginUrl: (url) => put("login-url", url),
		setTunnelId: (id) => put("tunnel-id", id),
		existingTunnel(id, name) {
			put("existing-tunnel", `${id} ${name}\n`);
			put("create-exists", "1");
		},
		fail(what, on = true) {
			const file = join(state, flagFiles[what]);
			if (on) put(flagFiles[what], "1");
			else rmSync(file, { force: true });
		},
		setBrewSeconds: (s) => put("brew-seconds", String(s)),
		hasCert: () => existsSync(join(home, ".cloudflared", "cert.pem")),
		hasCredentials: (id = FAKE_TUNNEL_ID) => existsSync(join(home, ".cloudflared", `${id}.json`)),
	};
}
