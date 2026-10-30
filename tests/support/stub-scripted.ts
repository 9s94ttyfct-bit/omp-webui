import { createServer, type IncomingMessage } from "node:http";

/**
 * A stand-in for a model server whose every answer a test writes: an OpenAI-compatible chat completions endpoint (model
 * list, streamed completions) that says what `script` says — a text, or a call of one tool — and keeps what it was asked.
 * For specs that need a real omp to do something only a model makes it do (start a subagent), with no model behind it.
 * (`stub-omlx.ts` answers every request with one canned text.)
 */

/** One chat request, as the script sees it. */
export interface ScriptedRequest {
	/** The messages of the request, as the JSON text omp sent: system prompts, conversation, tool results. */
	text: string;
	/** The names of the tools the request offers. */
	tools: string[];
	/** How many tool results the conversation holds so far. */
	toolResults: number;
	/** The model the request names (`model` of the chat request). */
	model: string;
}

/**
 * What the stub answers: a text, a call of one tool, or a refusal as a provider says its usage limit is used up: HTTP
 * `status` (402 by default: a billing cap, which omp's transport never retries below the turn retry under test) with a
 * `retry-after-ms` header of `retryAfterMs`, or with `seconds` a standard `retry-after` header of that time in whole
 * seconds, rounded up (what a 429 usually carries).
 */
export type ScriptedTurn =
	| { text: string }
	| { call: { name: string; args: unknown } }
	| { refuse: { retryAfterMs: number; status?: number; message?: string; seconds?: boolean } };

export interface StubScripted {
	/** The provider's `baseUrl`. */
	url: string;
	/** The key it demands as `Authorization: Bearer`. */
	apiKey: string;
	/** The chat requests so far, in order. */
	requests: ScriptedRequest[];
	/** The requests it refused (`refuse`), in order; they are in `requests` too. */
	refused: ScriptedRequest[];
	stop(): Promise<void>;
}

const MODEL = "stub-model";
const API_KEY = "sk-stub-scripted-key-7d2e";

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let raw = "";
		req.on("data", (d) => {
			raw += d;
		});
		req.on("end", () => resolve(raw));
	});

const chunk = (delta: object, finish: string | null = null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-scripted",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

export async function startScriptedStub(
	script: (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>,
): Promise<StubScripted> {
	const requests: ScriptedRequest[] = [];
	const refused: ScriptedRequest[] = [];
	const server = createServer(async (req, res) => {
		const path = (req.url ?? "").split("?")[0];
		if (req.headers.authorization !== `Bearer ${API_KEY}`) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad key" }));
			return;
		}
		if (req.method === "GET" && path === "/v1/models") {
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
			return;
		}
		if (req.method !== "POST" || path !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(await readBody(req));
		const messages: { role?: string }[] = Array.isArray(body.messages) ? body.messages : [];
		const request: ScriptedRequest = {
			text: JSON.stringify(messages),
			tools: Array.isArray(body.tools)
				? body.tools.flatMap((t: { function?: { name?: string } }) => t.function?.name ?? [])
				: [],
			toolResults: messages.filter((m) => m.role === "tool").length,
			model: typeof body.model === "string" ? body.model : "",
		};
		requests.push(request);
		const turn = await script(request);
		if ("refuse" in turn) {
			refused.push(request);
			res
				.writeHead(turn.refuse.status ?? 402, {
					"content-type": "application/json",
					...(turn.refuse.seconds
						? { "retry-after": String(Math.max(0, Math.ceil(turn.refuse.retryAfterMs / 1000))) }
						: { "retry-after-ms": String(Math.max(0, Math.round(turn.refuse.retryAfterMs))) }),
					"x-should-retry": "false",
				})
				.end(
					JSON.stringify({
						error: {
							message: turn.refuse.message ?? "You have reached your usage limit.",
							type: "usage_limit_reached",
							code: "usage_limit_reached",
						},
					}),
				);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ role: "assistant", content: "text" in turn ? "" : null }));
		if ("text" in turn) {
			res.write(chunk({ content: turn.text }));
			res.write(chunk({}, "stop"));
		} else {
			const id = `call_${requests.length}`;
			res.write(
				chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: "" } }] }),
			);
			res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(turn.call.args) } }] }));
			res.write(chunk({}, "tool_calls"));
		}
		res.write(
			`data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("scripted stub has no port");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		apiKey: API_KEY,
		requests,
		refused,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
