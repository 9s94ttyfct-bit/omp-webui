/**
 * MCP servers of the official MCP Registry (registry.modelcontextprotocol.io) as the Plugins page shows them, and how each
 * one can be added to omp's MCP configuration. The server searches the registry and works out the ways to run a server
 * (see `server/omp/mcp-registry.ts`); the page only shows them and asks for the values they need.
 */

/** One value a way of running a server needs from the person: an environment variable, a header, an argument. */
export interface McpInput {
	/** What the page sends its value under (`env:NAME`, `header:Name`, `arg:<n>`, `var:<name>`). */
	key: string;
	kind: "env" | "header" | "arg" | "var";
	/** The variable's, the header's or the argument's name, as the registry gives it. */
	label: string;
	description: string | null;
	required: boolean;
	/** A password, a token: shown as dots, never sent back or written anywhere but the config. */
	secret: boolean;
	/** What it is when left empty. */
	default: string | null;
	/** An example of the form it takes. */
	placeholder: string | null;
	/** The values it may take, when the registry lists them. */
	choices: string[] | null;
}

/** Why a way of running a server cannot be written into omp's config. */
export type McpProblem =
	/** A package of a kind omp-webui cannot run (`nuget`, `cargo`, `mcpb`…): `detail` is its kind. */
	| { code: "registry"; detail: string }
	/** A package from a registry other than npm's or PyPI's public one: `detail` is its address. */
	| { code: "private-registry"; detail: string }
	/** A package that serves HTTP itself: it has to be started by hand, and its address added. */
	| { code: "local-http"; detail: string }
	/** A remote of a transport omp does not speak: `detail` is the transport. */
	| { code: "transport"; detail: string }
	/** A package name, variable or argument this cannot pass on safely. */
	| { code: "invalid"; detail: string };

/** One way of running a server: one of its packages, or one of its remote endpoints. */
export interface McpInstallOption {
	/** `package:<n>` or `remote:<n>`, its place in the registry's entry. */
	id: string;
	/** `npm`, `pypi`, `oci` (docker) or another package kind; `remote` for an endpoint. */
	kind: string;
	/** How omp would run or reach it: `stdio` for a package, `http` or `sse` for a remote. */
	transport: "stdio" | "http" | "sse";
	/** The command line or the address, as it would be written (values still to fill in shown as `{name}`). */
	summary: string;
	inputs: McpInput[];
	/** Why it cannot be added; null: it can. */
	problem: McpProblem | null;
}

/** One server of the registry, its latest version. */
export interface McpServerHit {
	/** The registry's name: reverse-DNS, `io.github.owner/name`. */
	name: string;
	title: string | null;
	description: string | null;
	version: string;
	repository: string | null;
	website: string | null;
	options: McpInstallOption[];
	/** The name omp's config would give it: the last part of the registry's name. */
	configName: string;
	/** The name of a server in omp's config (the user's, or the folder's) that already runs it; null: none. */
	added: string | null;
}

/** `GET /api/plugins/mcp/search`. */
export interface McpSearch {
	servers: McpServerHit[];
	/** Where the next page starts; null: there is none. */
	nextCursor: string | null;
	/** The names already in the user's `mcp.json`: a server cannot be added under one of them. */
	taken: string[];
}

/** `POST /api/plugins/mcp`: which way of which server, under what name, with the values it asked for. */
export interface McpAddRequest {
	server: string;
	version: string;
	option: string;
	name: string;
	values: Record<string, string>;
}

/** What `POST /api/plugins/mcp` answers: the name it was added under and the file it was written to. */
export interface McpAdded {
	name: string;
	file: string;
}
