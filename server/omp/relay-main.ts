import { RELAY_FLAG } from "./relay-protocol.ts";

/**
 * Entry of the omp relay. `server/main.ts` imports this first: the compiled server (the macOS app ships no other
 * program) starts a relay by running itself with `--ompw-relay`, and that run is a relay from here on — it never
 * gets past this module's top-level await, so none of the server starts. From source, the relay is started by
 * running this file.
 *
 * The relay's own code (`relay.ts` and what only it uses) is loaded only in that case: a server that is not a relay
 * (nearly every run of this file) never runs it, and should not hold it in memory (#585).
 */
if (process.argv[2] === RELAY_FLAG) {
	const { runRelay } = await import("./relay.ts");
	await runRelay(process.argv.slice(3));
}
