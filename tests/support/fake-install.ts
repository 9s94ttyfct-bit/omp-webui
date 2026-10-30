import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

/**
 * Stand-ins for everything installing and updating omp touches, so specs never run a real installer or package
 * manager, never reach the real npm registry or build service, and never change the omp of the machine they run
 * on. Everything is shell scripts and a local HTTP server, so it runs under Node (Playwright) and Bun alike.
 *
 * - `writeOmpTemplate`: a launcher that answers `--version` and `omp update` from files in a state directory and
 *   hands every other command to the machine's own omp (so the real RPC protocol, accounts and config work).
 * - `writeFakeBrew`, `writeFakeCurl`: installers that put such a launcher where the real ones would.
 * - `startFakeRegistry`: the npm registry and the build service, serving whatever version a spec says is the latest.
 * - `makeToolbin`: a `PATH` of exactly the programs the scripts need, so the machine's own omp, brew or curl can
 *   never be found by accident.
 */

/** The omp on this machine (what every other spec runs), or null. */
export function realOmp(): string | null {
	try {
		return execFileSync("sh", ["-c", "command -v omp"], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

function script(path: string, body: string): string {
	writeFileSync(path, `#!/bin/sh\n${body}`);
	chmodSync(path, 0o755);
	return path;
}

/** The files that steer a launcher: its `version`, and what `omp update` does. */
export interface OmpState {
	dir: string;
	/** `version` is what `--version` says now. */
	setVersion(v: string): void;
	/** `omp update` moves `version` to this one. */
	setUpdateTo(v: string): void;
	/** `omp update` takes this many seconds. */
	setUpdateSeconds(s: number): void;
	/** `omp update` fails with a message. */
	failUpdates(on: boolean): void;
	/** `omp update` succeeds and changes nothing. */
	noopUpdates(on: boolean): void;
	/** Every `omp update` that ran: one line each, with the `PATH` it ran with. */
	updateCalls(): string[];
}

export function ompState(dir: string, version: string): OmpState {
	mkdirSync(dir, { recursive: true });
	const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
	const flag = (name: string, on: boolean) => (on ? put(name, "1") : writeFileSync(join(dir, name), "", { flag: "w" }));
	put("version", version);
	return {
		dir,
		setVersion: (v) => put("version", v),
		setUpdateTo: (v) => put("update-to", v),
		setUpdateSeconds: (s) => put("update-seconds", String(s)),
		failUpdates: (on) => flag("update-fails", on),
		noopUpdates: (on) => flag("update-noop", on),
		updateCalls() {
			try {
				return readFileSync(join(dir, "update-calls"), "utf8").split("\n").filter(Boolean);
			} catch {
				return [];
			}
		},
	};
}

/** The launcher, as a template file: what the installers copy into place. `state` is an `ompState` directory. */
export function writeOmpTemplate(path: string, state: string, real: string | null): string {
	const handOver = real ? `exec "${real}" "$@"` : `echo "no omp to hand over to" >&2; exit 127`;
	return script(
		path,
		`S="${state}"
case "$1" in
  --version) echo "omp/$(cat "$S/version")"; exit 0 ;;
  update)
    echo "Current version: $(cat "$S/version")"
    echo "update PATH=$PATH" >> "$S/update-calls"
    sleep "$(cat "$S/update-seconds" 2>/dev/null || echo 0)"
    if [ -s "$S/update-fails" ]; then echo "Update failed: the release server is down" >&2; exit 1; fi
    if [ -s "$S/update-noop" ]; then exit 0; fi
    cp "$S/update-to" "$S/version"
    echo "Updated to $(cat "$S/version")"
    exit 0 ;;
esac
${handOver}
`,
	);
}

/**
 * A Homebrew layout whose `bin/omp` is a launcher in a Cellar, as `brew install` leaves it. Returns the path of the
 * link on `PATH` (`<prefix>/bin/omp`), which resolves into `<prefix>/Cellar/omp/<version>/bin/omp`.
 */
export function placeBrewOmp(prefix: string, template: string, version: string): string {
	const cellarBin = join(prefix, "Cellar", "omp", version, "bin");
	mkdirSync(cellarBin, { recursive: true });
	mkdirSync(join(prefix, "bin"), { recursive: true });
	execFileSync("cp", [template, join(cellarBin, "omp")]);
	chmodSync(join(cellarBin, "omp"), 0o755);
	const link = join(prefix, "bin", "omp");
	if (!existsSync(link)) symlinkSync(join("..", "Cellar", "omp", version, "bin", "omp"), link);
	return link;
}

export interface FakeBrewOptions {
	prefix: string;
	template: string;
	version: string;
	/** Every `brew` command line, one per line. */
	log: string;
	/** While this file exists `brew install` fails. */
	failFlag?: string;
	/** How long `brew install` takes before it installs (0.4 by default). */
	seconds?: number;
}

/**
 * `brew install can1357/tap/omp` puts the launcher in a Cellar and links it; anything else just answers. Like the real
 * brew (a Ruby program that raises on a write to a closed pipe), it ends at once when what it prints has nowhere to go.
 */
export function writeFakeBrew(path: string, o: FakeBrewOptions): string {
	const fail = o.failFlag ?? join(o.prefix, ".fail");
	return script(
		path,
		`echo "brew $*" >> "${o.log}"
say() { echo "$@" || exit 141; }
case "$1" in
  --prefix) echo "${o.prefix}"; exit 0 ;;
  install)
    say "==> Fetching can1357/tap/omp"
    sleep ${o.seconds ?? 0.4}
    if [ -e "${fail}" ]; then echo "Error: omp: simulated install failure" >&2; exit 1; fi
    say "==> Installing omp"
    # As long as the fetch: the server reads the job's output every 120 ms, and a page may look for this line while
    # the install still runs.
    sleep ${o.seconds ?? 0.4}
    mkdir -p "${o.prefix}/Cellar/omp/${o.version}/bin" "${o.prefix}/bin"
    cp "${o.template}" "${o.prefix}/Cellar/omp/${o.version}/bin/omp"
    chmod +x "${o.prefix}/Cellar/omp/${o.version}/bin/omp"
    ln -sf "../Cellar/omp/${o.version}/bin/omp" "${o.prefix}/bin/omp"
    say "omp was successfully installed!"
    exit 0 ;;
  *) exit 0 ;;
esac
`,
	);
}

export interface FakeCurlOptions {
	template: string;
	/** Every `curl` command line, one per line. */
	log: string;
	/** While this file exists the "installer" fails after downloading. */
	failFlag?: string;
	/** While this file exists the download itself fails, as curl does when it cannot resolve the host (exit 6). */
	downloadFailFlag?: string;
}

/**
 * `curl -fsSL [-o file] https://omp.sh/install` answers (on stdout, or in `file`) with an installer script that puts
 * the launcher at `$HOME/.local/bin/omp`, as omp's own installer does (and, like it, leaves that directory off `PATH`).
 * With `downloadFailFlag` present it prints curl's own message and exits 6 instead.
 */
export function writeFakeCurl(path: string, o: FakeCurlOptions): string {
	const fail = o.failFlag ?? `${o.template}.fail`;
	const unreachable = o.downloadFailFlag ?? `${o.template}.unreachable`;
	return script(
		path,
		`echo "curl $*" >> "${o.log}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
if [ -e "${unreachable}" ]; then echo "curl: (6) Could not resolve host: omp.sh" >&2; exit 6; fi
installer() {
cat <<'INSTALLER'
#!/bin/sh
echo "Fetching latest release..."
sleep 0.3
echo "Downloading omp-fake..."
if [ -e "${fail}" ]; then echo "Checksum mismatch for omp-fake" >&2; exit 1; fi
mkdir -p "$HOME/.local/bin"
cp "${o.template}" "$HOME/.local/bin/omp"
chmod +x "$HOME/.local/bin/omp"
echo "Installed omp to $HOME/.local/bin/omp"
echo "Add $HOME/.local/bin to your PATH, then run 'omp'"
INSTALLER
}
if [ -n "$out" ]; then installer > "$out"; else installer; fi
`,
	);
}

/** Where each program is on this machine (`command -v`), asked once: a spec makes several toolbins. */
const located = new Map<string, string | null>();
function locate(name: string): string | null {
	if (!located.has(name)) {
		try {
			const found = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
			located.set(name, found.startsWith("/") ? found : null);
		} catch {
			located.set(name, null);
		}
	}
	return located.get(name) ?? null;
}

/**
 * A directory of links to the programs the scripts above use (and `ps`, which the server itself runs); its path
 * is the whole `PATH` of a server under test. A program this machine lacks is left out.
 */
export function makeToolbin(dir: string, extra: string[] = []): string {
	mkdirSync(dir, { recursive: true });
	for (const name of [
		"sh",
		"bun",
		"cat",
		"cp",
		"chmod",
		"mkdir",
		"ln",
		"mv",
		"rm",
		"sleep",
		"dirname",
		"uname",
		"tr",
		"mktemp",
		"ps",
		...extra,
	]) {
		const found = locate(name);
		if (found && !existsSync(join(dir, name))) symlinkSync(found, join(dir, name));
	}
	return dir;
}

export interface FakeRegistry {
	/** The npm registry (`npm_config_registry`) and the build service (`PI_BUILD_URL`): one server. */
	url: string;
	/** Every request path it answered. */
	hits: string[];
	setLatest(v: string): void;
	/** Answer every request with a 503. */
	setDown(down: boolean): void;
	stop(): Promise<void>;
}

/** The two places a latest omp version comes from, answering the same `latest`. */
export async function startFakeRegistry(latest: string): Promise<FakeRegistry> {
	const hits: string[] = [];
	let down = false;
	let current = latest;
	const server: Server = createServer((req, res) => {
		const path = req.url ?? "";
		hits.push(path);
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (down) return send(503, { error: "down" });
		if (path.startsWith("/@oh-my-pi%2fpi-coding-agent/latest")) {
			return send(200, { name: "@oh-my-pi/pi-coding-agent", version: current });
		}
		if (path.startsWith("/api/products/omp/latest/")) {
			const file = "omp-fake";
			return send(200, {
				build: { version: current, channel: "stable" },
				file: { name: file, size: 1, sha256: "0".repeat(64) },
				download: "https://example.invalid/omp",
			});
		}
		send(404, { error: "not found" });
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("the fake registry has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		hits,
		setLatest: (v) => {
			current = v;
		},
		setDown: (d) => {
			down = d;
		},
		stop() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

/** A port the OS reports free, so a server a spec starts cannot collide with another checkout's suite. */
export function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
	});
	return promise;
}

/** Everything one spec's server lives in, under one directory: fakes for the installers, and optionally an installed omp. */
export interface World {
	dir: string;
	toolbin: string;
	/** A Homebrew prefix whose `bin` is on `path`; `brew install` and an installed omp put the launcher there. */
	prefix: string;
	state: OmpState;
	template: string;
	brewLog: string;
	curlLog: string;
	/** The whole `PATH` of a server in this world. */
	path: string;
}

export function makeWorld(
	dir: string,
	o: { version: string; installers?: boolean; installed?: boolean; brewSeconds?: number },
): World {
	mkdirSync(dir, { recursive: true });
	const toolbin = makeToolbin(join(dir, "toolbin"));
	const prefix = join(dir, "prefix");
	const state = ompState(join(dir, "state"), o.version);
	const template = writeOmpTemplate(join(dir, "omp-template"), state.dir, realOmp());
	const brewLog = join(dir, "brew.log");
	const curlLog = join(dir, "curl.log");
	if (o.installers) {
		writeFakeBrew(join(toolbin, "brew"), {
			prefix,
			template,
			version: o.version,
			log: brewLog,
			seconds: o.brewSeconds,
		});
		writeFakeCurl(join(toolbin, "curl"), { template, log: curlLog });
	}
	if (o.installed) placeBrewOmp(prefix, template, o.version);
	return { dir, toolbin, prefix, state, template, brewLog, curlLog, path: `${toolbin}:${join(prefix, "bin")}` };
}
