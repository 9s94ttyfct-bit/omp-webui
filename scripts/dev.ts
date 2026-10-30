/** Run the API server (with reload) and the Vite dev server together. */
const procs = [
	// The server learns the port of the Vite server that proxies /api to it: the gate of risky commands asks about that API too.
	Bun.spawn(["bun", "--watch", "server/main.ts"], {
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, OMP_WEBUI_DEV_PORT: "5173" },
	}),
	Bun.spawn(["bunx", "vite"], { stdout: "inherit", stderr: "inherit" }),
];
const stop = () => {
	for (const p of procs) p.kill();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
