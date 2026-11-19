import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { post } from "../../web/src/lib/api.ts";
import { httpText } from "../../web/src/lib/http-text.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A failed answer that is not the server's own JSON (Cloudflare's error page while the Mac's server restarts) has an empty
 * status text over HTTP/2 and HTTP/3, so the error the person reads must name the status instead (#244).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

test("the status text is used when there is one, else the status", () => {
	expect(httpText(new Response("", { status: 404, statusText: "Not Found" }))).toBe("Not Found");
	expect(httpText(new Response("", { status: 502, statusText: "" }))).toBe("HTTP 502");
});

test("a request answered by a proxy's error page fails with a message that names the status", async () => {
	const g = globalThis as unknown as { fetch: unknown };
	const real = g.fetch;
	g.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "" });
	try {
		await expect(post("/api/anything", {})).rejects.toThrow("HTTP 502");
	} finally {
		g.fetch = real;
	}
});
