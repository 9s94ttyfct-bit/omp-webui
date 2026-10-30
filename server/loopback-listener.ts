import { PORT_WINDOW } from "./instance.ts";
import { isLoopbackPeer } from "./this-computer.ts";

/** What `OMP_WEBUI_HOST` may say to listen on every address: the loopback is one of them, and a second listener there would only share it. */
const WILDCARDS = ["0.0.0.0", "::", "[::]"];

/**
 * Whether a server that listens on `host` (`OMP_WEBUI_HOST`) has no page on this computer unless it listens on the
 * loopback as well: `host` is one address of a network (`192.168.1.5`, `fe80::1`) or a name of this computer on one
 * (`mymac.local`). Not when it is the loopback itself (what Bun makes of an empty name too: `localhost`), nor an address
 * that stands for all of them (`0.0.0.0`, `::`). Whether a page that comes in on such a listener is this computer's is
 * still decided by the socket's peer (`isThisComputer`); this only gives the owner a way to connect from it.
 */
export function needsLoopbackListener(host: string): boolean {
	if (host === "" || host === "localhost" || host === "[::1]" || WILDCARDS.includes(host)) return false;
	return !isLoopbackPeer(host);
}

/**
 * The addresses this server answers on besides the loopback, as a gate should treat them (`RiskContext.hosts`): the one
 * `OMP_WEBUI_HOST` names, when it is one address or name a URL could carry (`192.168.1.5`, `mymac.local`, `fe80::1`).
 * None when it is the loopback (`needsLoopbackListener` says so), a wildcard (`0.0.0.0`, `::`), empty, or something no
 * URL writes (a list, a path): then only the loopback spellings reach the server.
 */
export function boundHosts(host: string): string[] {
	if (!needsLoopbackListener(host)) return [];
	const name = host.trim().replace(/^\[|\]$/g, "");
	return name !== "" && !/[\s/\\?#@,]/.test(name) ? [name] : [];
}

/** The ports the loopback listener tries after the one the server got: that one, the next `PORT_WINDOW`, then any free one (`0`). */
export function loopbackCandidates(port: number): number[] {
	const window: number[] = [];
	for (let p = port; p <= port + PORT_WINDOW && p <= 65535; p++) window.push(p);
	return [...window, 0];
}

/** The second listener of a server that is bound to a network address, and the port it got. */
export interface LoopbackListener<S> {
	server: S;
	port: number;
	/** It is not on the port of the other listener (that one was taken on the loopback). */
	moved: boolean;
}

/**
 * Listen on `127.0.0.1` for the owner of a server bound to a network address: on `port`, the one the server got, so
 * that the page here and the page on the network differ in the address only; when another program holds it on the
 * loopback, on the next free one above it (the window a server in app mode falls back through too: see `apiPorts`), and
 * at last on any free one. The server is served already: a loopback listener that cannot be had at all (not a taken port)
 * is said to the log and the server goes on without it. `listen` throws what `Bun.serve` throws (`code: "EADDRINUSE"`).
 */
export function listenOnLoopback<S extends { port?: number }>(
	port: number,
	listen: (hostname: string, port: number) => S,
): LoopbackListener<S> | null {
	for (const p of loopbackCandidates(port)) {
		try {
			const server = listen("127.0.0.1", p);
			const bound = server.port as number;
			return { server, port: bound, moved: bound !== port };
		} catch (e) {
			if ((e as { code?: string }).code === "EADDRINUSE") continue;
			console.warn(
				`omp-webui: could not listen on 127.0.0.1 as well, so there is no page on this computer: ${(e as Error).message}`,
			);
			return null;
		}
	}
	console.warn("omp-webui: could not listen on 127.0.0.1 as well (no free port), so there is no page on this computer");
	return null;
}

/**
 * The macOS app (`OMP_WEBUI_AUTO_PORT=1`) connects to `127.0.0.1` on the port the server reports, so a server it started
 * that is bound to a network address and could not listen there has nothing for the app to open: starting fails, with
 * the reason, instead of reporting a port where nothing answers. A web version (no auto port) goes on without the page
 * on this computer, as the log says.
 */
export function loopbackRequiredByApp(
	cfg: { autoPort: boolean; host: string },
	loopback: LoopbackListener<unknown> | null,
): Error | null {
	if (!cfg.autoPort || loopback !== null || !needsLoopbackListener(cfg.host)) return null;
	return new Error(
		`omp-webui: OMP_WEBUI_HOST is ${cfg.host}, a network address, and the app opens its page at 127.0.0.1, which could not be listened on (see the warning above): unset OMP_WEBUI_HOST, or free a port on 127.0.0.1`,
	);
}
