import { expect, test } from "bun:test";
import { childEnv } from "../../server/env.ts";

test("childEnv drops every OMP_WEBUI_* setting and keeps the rest", () => {
	const env = childEnv(
		{},
		{
			OMP_WEBUI_AUTO_PORT: "1",
			OMP_WEBUI_TOKEN: "secret",
			OMP_WEBUI_PARENT_PID: "42",
			OMP_WEBUI_DATA_DIR: "/data",
			OMP_WEBUI_PORT: "7777",
			PATH: "/usr/bin",
			HOME: "/home/x",
			OMPW_E2E_PORT: "1",
		},
	);
	expect(Object.keys(env).sort()).toEqual(["HOME", "OMPW_E2E_PORT", "PATH"]);
	expect(env.PATH).toBe("/usr/bin");
});

test("childEnv adds what the caller asks for, even over what we have", () => {
	const env = childEnv({ TERM: "dumb", NO_COLOR: "1" }, { TERM: "xterm", HOME: "/h", OMP_WEBUI_HOST: "0.0.0.0" });
	expect(env).toEqual({ TERM: "dumb", NO_COLOR: "1", HOME: "/h" });
});

test("childEnv reads the process environment by default", () => {
	process.env.OMP_WEBUI_UNIT_PROBE = "x";
	try {
		expect(childEnv().OMP_WEBUI_UNIT_PROBE).toBeUndefined();
		expect(childEnv().PATH).toBe(process.env.PATH);
	} finally {
		delete process.env.OMP_WEBUI_UNIT_PROBE;
	}
});
