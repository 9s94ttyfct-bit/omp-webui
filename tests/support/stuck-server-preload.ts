import { existsSync, writeFileSync } from "node:fs";

/**
 * Preloaded into a test server (BUN_OPTIONS=--preload): it ignores SIGTERM, writes its pid to WEDGE_PIDFILE, and when
 * WEDGE_FLAG exists blocks its event loop for good, like a server stuck in a runaway loop: it answers nothing and no
 * signal handler of its own can run. Only SIGKILL ends it. The server's other processes (relays) are left alone.
 */
if (process.argv[1]?.endsWith("server/main.ts")) {
	process.on("SIGTERM", () => {});
	writeFileSync(process.env.WEDGE_PIDFILE as string, String(process.pid));
	setInterval(() => {
		if (existsSync(process.env.WEDGE_FLAG as string)) for (;;);
	}, 50);
}
