import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBunLauncher } from "./bun-program.ts";

/**
 * Stand-ins for what the Plugins page's Discover, Skills and MCP tabs reach: omp's `plugin` and `skill` commands
 * (`fake-plugins-omp-bin.ts`, as `OMP_BIN`) and the official MCP Registry (`OMPW_MCP_REGISTRY`), so that their tests need
 * no network and install nothing.
 */

/** An executable that is `fake-plugins-omp-bin.ts`, written into `dir` (usable as `OMP_BIN`). */
export function writeFakePluginsOmp(dir: string): string {
	return writeBunLauncher(dir, "omp", join(dirname(fileURLToPath(import.meta.url)), "fake-plugins-omp-bin.ts"));
}

/** The registry's servers, as `GET /v0/servers` lists them (schema 2025-12-11). */
export const REGISTRY_SERVERS: Record<string, unknown>[] = [
	{
		name: "io.github.example/weather-mcp",
		title: "Weather",
		description: "Forecasts and alerts for any place.",
		version: "1.4.0",
		repository: { url: "https://github.com/example/weather-mcp", source: "github" },
		packages: [
			{
				registryType: "npm",
				registryBaseUrl: "https://registry.npmjs.org",
				identifier: "@example/weather-mcp",
				version: "1.4.0",
				transport: { type: "stdio" },
				environmentVariables: [
					{ name: "WEATHER_API_KEY", description: "Your API key.", isRequired: true, isSecret: true },
					{ name: "WEATHER_UNITS", description: "metric or imperial", default: "metric" },
				],
			},
		],
		remotes: [
			{
				type: "streamable-http",
				url: "https://mcp.example.com/weather",
				headers: [{ name: "Authorization", value: "Bearer {api_key}", isRequired: true, isSecret: true }],
			},
		],
	},
	{
		name: "io.github.example/sqlite-mcp",
		description: "Query a SQLite database.",
		version: "0.2.0",
		packages: [
			{
				registryType: "pypi",
				identifier: "sqlite-mcp",
				version: "0.2.0",
				transport: { type: "stdio" },
				packageArguments: [
					{ type: "named", name: "--read-only" },
					{ type: "positional", valueHint: "database_path", isRequired: true },
				],
			},
		],
	},
	{
		name: "io.github.example/dotnet-mcp",
		description: "Only as a NuGet package.",
		version: "1.0.0",
		packages: [{ registryType: "nuget", identifier: "Example.Mcp", version: "1.0.0", transport: { type: "stdio" } }],
	},
];

export interface StubRegistry {
	url: string;
	/** Every path and query it was asked for. */
	requests: string[];
	stop(): Promise<void>;
}

/** A stand-in for the MCP Registry's `GET /v0/servers` and `GET /v0/servers/<name>/versions/<version>`. */
export async function startStubRegistry(servers: Record<string, unknown>[] = REGISTRY_SERVERS): Promise<StubRegistry> {
	const requests: string[] = [];
	const item = (server: Record<string, unknown>) => ({
		server,
		_meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
	});
	const http: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		requests.push(`${url.pathname}${url.search}`);
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/v0/servers") {
			const q = (url.searchParams.get("search") ?? "").toLowerCase();
			const found = servers.filter((s) => String(s.name).toLowerCase().includes(q));
			return send(200, { servers: found.map(item), metadata: { count: found.length } });
		}
		const one = /^\/v0\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
		const server = one
			? servers.find(
					(s) =>
						s.name === decodeURIComponent(one[1]) && (one[2] === "latest" || s.version === decodeURIComponent(one[2])),
				)
			: undefined;
		if (server) return send(200, item(server));
		send(404, { title: "Not Found", status: 404, detail: "Server not found" });
	});
	const listening = Promise.withResolvers<void>();
	http.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	return {
		url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
		requests,
		stop: () => {
			const closed = Promise.withResolvers<void>();
			http.close(() => closed.resolve());
			http.closeAllConnections();
			return closed.promise;
		},
	};
}
