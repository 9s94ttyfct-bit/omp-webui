/**
 * A minimal MCP server on stdio for tests: `bun tests/support/stub-mcp.ts <name>` offers one tool, `<name>_ping`.
 * It lets a test tell which of several configured servers an omp process actually loaded, without a real server.
 */
const name = process.argv[2] ?? "stub";
const tools = [
	{
		name: `${name}_ping`,
		description: `Replies pong (test server ${name}).`,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(line: string): void {
	let request: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	const id = request.id;
	// Notifications carry no id and get no answer.
	if (id === undefined) return;
	switch (request.method) {
		case "initialize":
			send({
				id,
				result: {
					protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name, version: "0.0.0" },
				},
			});
			break;
		case "tools/list":
			send({ id, result: { tools } });
			break;
		case "tools/call":
			send({ id, result: { content: [{ type: "text", text: "pong" }] } });
			break;
		case "ping":
			send({ id, result: {} });
			break;
		default:
			send({ id, error: { code: -32601, message: `Method not found: ${request.method}` } });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (line) handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));
