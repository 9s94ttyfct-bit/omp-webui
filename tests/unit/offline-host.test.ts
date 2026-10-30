import { expect, test } from "bun:test";
import { classifyHost, classifyUrl, type HostClass } from "../../shared/offline.ts";

/**
 * Where an offline backend's address leads. Settings warns about the ones that leave the machine and its network
 * (prompts and file contents would be sent there), and the link-local ones, where cloud metadata services answer,
 * are refused outright.
 */

const cases: Record<HostClass, string[]> = {
	loopback: [
		"localhost",
		"LOCALHOST",
		"studio.localhost",
		"127.0.0.1",
		"127.1.2.3",
		"0.0.0.0",
		"[::1]",
		"[::]",
		"[::ffff:127.0.0.1]",
	],
	private: [
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.5",
		// Carrier-grade NAT: where Tailscale and other overlays take their addresses from.
		"100.64.0.1",
		"100.127.255.255",
		"[fc00::1]",
		"[fd12:3456:789a::1]",
		"[::ffff:192.168.1.5]",
		"[::ffff:10.1.2.3]",
	],
	local: [
		"studio.local",
		"Studio.LOCAL",
		"studio.local.",
		"nas.lan",
		"router.home.arpa",
		"mac-studio",
		"studio",
		"constructor",
		"__proto__",
	],
	public: [
		"example.com",
		"api.openai.com",
		"localhost.example.com",
		"studio.local.example.com",
		"8.8.8.8",
		"11.0.0.1",
		"172.15.255.255",
		"172.32.0.1",
		"192.167.1.1",
		"192.169.1.1",
		"100.63.255.255",
		"100.128.0.1",
		"[2001:4860:4860::8888]",
		"[::ffff:8.8.8.8]",
		"[64:ff9b::808:808]",
		// Not an address this can read: not one that is known to stay home.
		"[not:an:address]",
	],
	"link-local": [
		"169.254.169.254",
		"169.254.0.1",
		"169.254.255.255",
		"[fe80::1]",
		"[febf::1]",
		"[fd00:ec2::254]",
		"[::ffff:169.254.169.254]",
		"[::ffff:a9fe:a9fe]",
		"[64:ff9b::a9fe:a9fe]",
		"metadata.google.internal",
		"METADATA.GOOGLE.INTERNAL.",
		"metadata.goog",
		// Alibaba Cloud and Oracle Cloud have theirs outside the link-local range.
		"100.100.100.200",
		"192.0.0.192",
	],
};

for (const [expected, hosts] of Object.entries(cases))
	test(`${expected}: ${hosts.slice(0, 3).join(", ")}…`, () => {
		for (const host of hosts) expect([host, classifyHost(host)]).toEqual([host, expected]);
	});

test("an address is classified by its host: numeric forms URL normalizes, a port, a path and credentials do not matter", () => {
	expect(classifyUrl("http://2852039166/v1")).toBe("link-local");
	expect(classifyUrl("http://0xa9.0xfe.0xa9.0xfe/v1")).toBe("link-local");
	expect(classifyUrl("http://2130706433:8000/v1")).toBe("loopback");
	expect(classifyUrl("http://[::ffff:169.254.169.254]/v1")).toBe("link-local");
	expect(classifyUrl("http://me:pw@192.168.1.2:11434/v1?k=1")).toBe("private");
	expect(classifyUrl("https://example.com:8443/openai")).toBe("public");
	expect(classifyUrl("http://127.0.0.1.example.com/v1")).toBe("public");
	expect(classifyUrl("not a url")).toBeNull();
});
