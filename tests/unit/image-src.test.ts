import { describe, expect, test } from "bun:test";
import { isAllowedImageSrc } from "../../web/src/lib/image-src.ts";

const origin = "http://127.0.0.1:7879";
const hash = "ab".repeat(32);

describe("isAllowedImageSrc: transcript images may only come from this server's blobs or inline data", () => {
	test.each([
		["a stored attachment", `/api/blob/${hash}`],
		["a stored attachment with a cache-busting query", `/api/blob/${hash}?v=1`],
		["a stored attachment by absolute same-origin URL", `${origin}/api/blob/${hash}`],
		["an inline PNG", "data:image/png;base64,iVBORw0KGgo="],
		["an inline image, scheme and type in capitals", "DATA:IMAGE/JPEG;base64,/9j/4AAQ"],
		["an inline SVG (an <img> cannot run script or load anything from it)", "data:image/svg+xml;utf8,<svg/>"],
	])("allows %s", (_what, src) => {
		expect(isAllowedImageSrc(src, origin)).toBe(true);
	});

	test.each([
		["a remote image", "https://attacker.invalid/steal?d=secret"],
		["plain http", "http://attacker.invalid/p.png"],
		["a scheme-relative URL", "//attacker.invalid/p.png"],
		["a scheme-relative URL hiding behind a blob path", `//attacker.invalid/api/blob/${hash}`],
		["backslashes browsers read as slashes", `/\\attacker.invalid/api/blob/${hash}`],
		["a host that only starts like ours", `http://127.0.0.1:7879.attacker.invalid/api/blob/${hash}`],
		["another port on the same host", `http://127.0.0.1:1234/api/blob/${hash}`],
		["credentials in the URL", `http://user:pw@127.0.0.1:7879/api/blob/${hash}`],
		["a path that climbs out of /api/blob/", `/api/blob/../export?file=x`],
		["the same, percent-encoded", `/api/blob/%2e%2e/export?file=x`],
		["a blob id that isn't a sha256", "/api/blob/not-a-hash"],
		["a blob id in capitals (the server only knows lowercase)", `/api/blob/${hash.toUpperCase()}`],
		["a sibling path", `/api/blobs/${hash}`],
		["another same-origin file", "/favicon.png"],
		["another API endpoint", "/api/sessions"],
		["a relative file", "photo.png"],
		["a javascript: URL", "javascript:alert(1)"],
		["inline HTML", "data:text/html,<script>alert(1)</script>"],
		["inline JSON", "data:application/json,{}"],
		["a data URL that merely mentions image/", "data:text/plain,data:image/png"],
		["an object URL", "blob:http://127.0.0.1:7879/5f1c3b9e-0000-4000-8000-000000000000"],
		["a file URL", "file:///etc/passwd"],
		["an empty source", ""],
		["no source", undefined],
	])("refuses %s", (_what, src) => {
		expect(isAllowedImageSrc(src, origin)).toBe(false);
	});
});
