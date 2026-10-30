import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Cloudflare Access, locally: RSA keys generated here, tokens signed with them, and a server that publishes the keys the
 * way `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` does. Nothing reaches Cloudflare. Node and Bun.
 */

export const TEAM = "acme";
export const AUD = "0123456789abcdef".repeat(4);
export const HOSTNAME = "omp.example.test";
export const EMAIL = "me@example.test";
export const ISSUER = `https://${TEAM}.cloudflareaccess.com`;

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface AccessKey {
	kid: string;
	privateKey: CryptoKey;
	/** The public half, as the certs endpoint lists it. */
	jwk: JsonWebKey & { kid: string; alg: string };
}

export async function makeKey(kid: string): Promise<AccessKey> {
	const pair = await crypto.subtle.generateKey(
		{ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as AccessKey["jwk"] };
}

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

/** Claims of a valid token at `nowSeconds`, with `over` laid on top (a key set to `undefined` is left out). */
export function claims(nowSeconds: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	const all: Record<string, unknown> = {
		aud: [AUD],
		email: EMAIL,
		exp: nowSeconds + 3600,
		iat: nowSeconds,
		nbf: nowSeconds,
		iss: ISSUER,
		type: "app",
		sub: "user-1",
		...over,
	};
	for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
	return all;
}

/** A token signed with `key` (RS256, its kid), unless `header` says otherwise. */
export async function sign(
	key: AccessKey,
	payload: Record<string, unknown>,
	header: Record<string, unknown> = {},
): Promise<string> {
	const head = b64(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
	const body = b64(JSON.stringify(payload));
	const signature = await crypto.subtle.sign(RSA, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}

/** `token` with its payload replaced by `payload`, signature kept: what someone who cannot sign would send. */
export function withPayload(token: string, payload: Record<string, unknown>): string {
	const [head, , signature] = token.split(".");
	return `${head}.${b64(JSON.stringify(payload))}.${signature}`;
}

export interface Jwks {
	url: string;
	/** How many times the keys were asked for. */
	hits: number;
	/** The keys it publishes now. */
	keys: AccessKey[];
	/** What it answers: `ok` the keys, `error` a 500, `hang` nothing at all. */
	mode: "ok" | "error" | "hang";
	stop(): void;
}

/** The team's certs endpoint, on a loopback port. `node:http`, so it runs under Node (Playwright) and Bun alike. */
export async function startJwks(keys: AccessKey[]): Promise<Jwks> {
	const state: Jwks = {
		url: "",
		hits: 0,
		keys,
		mode: "ok",
		stop: () => {
			server.close();
			server.closeAllConnections();
		},
	};
	const server = createServer((_req, res) => {
		state.hits++;
		// `hang`: nothing is ever said, and the connection is left open until `stop`.
		if (state.mode === "hang") return;
		if (state.mode === "error") {
			res.writeHead(500, { "content-type": "text/plain" }).end("broken");
			return;
		}
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ keys: state.keys.map((k) => k.jwk), public_certs: [] }));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn-cgi/access/certs`;
	return state;
}
