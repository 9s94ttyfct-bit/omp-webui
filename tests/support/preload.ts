import { afterAll, beforeEach } from "bun:test";
import { removeTrackedRelayDirs } from "./relay-dirs.ts";
import { removeTrackedTempDirs } from "./temp-dirs.ts";
import { serversAlive } from "./test-servers.ts";

/** Preloaded in every Bun worker; each process removes only the relay and temp dirs its own tests tracked. */

afterAll(removeTrackedRelayDirs);
afterAll(removeTrackedTempDirs);
// A test server that exited by itself is started again; the next test waits until it answers (#3, `test-servers.ts`).
beforeEach(serversAlive);
