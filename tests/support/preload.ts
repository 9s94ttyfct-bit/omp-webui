import { afterAll } from "bun:test";
import { removeTrackedRelayDirs } from "./relay-dirs.ts";
import { removeTrackedTempDirs } from "./temp-dirs.ts";

/** Preloaded in every Bun worker; each process removes only the relay and temp dirs its own tests tracked. */

afterAll(removeTrackedRelayDirs);
afterAll(removeTrackedTempDirs);
