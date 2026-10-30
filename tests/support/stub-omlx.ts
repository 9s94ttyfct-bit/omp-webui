import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** What the stub saw of one chat request (chat completions, or Responses for a backend omp talks to that way). */
export interface StubChat {
	authorization: string | null;
	/** When the stub received it (epoch ms). */
	at: number;
	body: {
		model?: string;
		tools?: { function?: { name?: string } }[];
		messages?: { role?: string; content?: unknown }[];
	};
}

/**
 * A stand-in for a local model server: an OpenAI-compatible server (model list, streamed chat completions with a
 * canned reply) that records what it is asked. With `ollama` it also speaks what omp asks of Ollama (its own model
 * list and `/api/show`, and the Responses API omp uses there), and without an `apiKey` it asks for none, as Ollama
 * and LM Studio do. No model behind it, so tests of Light on a local server call neither a local nor a cloud model. Runs under
 * Node and Bun.
 */
export interface StubOmlx {
	/** The provider's `baseUrl`. */
	url: string;
	/** The key it demands as `Authorization: Bearer`; empty when it demands none. */
	apiKey: string;
	/** The chat requests so far, in order. */
	chats: StubChat[];
	/** `Authorization` of every request, whatever its path. */
	authorizations: (string | null)[];
	/** `METHOD /path` of every request, in order. */
	requests: string[];
	/** Chat requests refused for the usage limit (`limit`), as `{ at }` in order; they are not in `chats`. */
	refused: { at: number }[];
	/** While in the future, chat requests are refused with a 429 that says when the limit ends (needs the `limit` option). */
	limitUntil: number;
	/** How long an accepted chat completion waits before it answers (a turn that runs for a while); 0: it answers at once. */
	replyDelayMs: number;
	/**
	 * The answer of every chat completion accepted from now on waits until the returned function is called: a turn that
	 * runs for as long as a test needs and no longer (`replyDelayMs` is a number of milliseconds that a busy machine can
	 * overtake between the test's steps).
	 */
	hold(): () => void;
	stop(): Promise<void>;
}

export interface StubOptions {
	models?: string[];
	reply?: string;
	/** The key to demand; null: none. Default: a fixed key. */
	apiKey?: string | null;
	/** Also answer as Ollama does (`/api/tags`, `/api/show`, `/v1/responses`). */
	ollama?: boolean;
	/**
	 * A usage limit in force: every chat request is refused with 429 and a `retry-after-ms` of the time that is left,
	 * until `StubOmlx.limitUntil` has passed (epoch ms; the stub begins with none, a test sets it to start the limit).
	 * `message` is the error text, which names the limit the way providers do. omp's transport retries a 429 whose
	 * reset is under a minute by itself, below the turn retry that waits out a usage limit; `status: 402` (a billing
	 * cap, never retried by the transport) lets a test exercise the turn retry with a short reset. `delayMs` is how long
	 * the stub takes to say so (a provider is a network round trip away; a test that needs the turn's end to come
	 * after what the process did meanwhile sets it).
	 */
	limit?: { message?: string; status?: number; delayMs?: number };
	/**
	 * What the stub answers a chat completion with instead of the canned `reply`: return nothing to keep the canned reply.
	 * A test that needs omp to call a tool (the `task` tool, to see which model a subagent is given) returns tool calls.
	 * Chat completions only; each call is streamed as omp's openai-completions provider reads it.
	 */
	respond?: (chat: StubChat) => StubReply | undefined;
}

/** A scripted answer of the stub: text, or tool calls (their `arguments` are what the model would send). */
export interface StubReply {
	text?: string;
	toolCalls?: { name: string; arguments: Record<string, unknown> }[];
}

export async function startStubOmlx(opts: StubOptions = {}): Promise<StubOmlx> {
	const apiKey = opts.apiKey === undefined ? "sk-stub-omlx-key-4f1c9a" : opts.apiKey;
	const models = opts.models ?? ["stub-model"];
	const reply = opts.reply ?? "STUB-REPLY";
	const chats: StubChat[] = [];
	const authorizations: (string | null)[] = [];
	const requests: string[] = [];
	const refused: { at: number }[] = [];
	const state = { limitUntil: 0, replyDelayMs: 0, gate: null as Promise<void> | null };
	const chunk = (delta: object, finish: string | null = null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-stub",
			object: "chat.completion.chunk",
			created: 1,
			model: models[0],
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	const send = (res: ServerResponse, status: number, body: unknown) =>
		res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
	const readBody = (req: IncomingMessage) =>
		new Promise<string>((resolve) => {
			let raw = "";
			req.on("data", (d) => {
				raw += d;
			});
			req.on("end", () => resolve(raw));
		});
	/** One Responses API turn that says `reply` (what the `openai-responses` provider of omp reads). */
	const responsesStream = (res: ServerResponse, model: string) => {
		const item = { id: "msg_stub", type: "message", role: "assistant", status: "in_progress", content: [] };
		const part = { type: "output_text", text: "", annotations: [] };
		const done = { ...item, status: "completed", content: [{ ...part, text: reply }] };
		const response = (status: string, output: object[]) => ({
			id: "resp_stub",
			object: "response",
			created_at: 1,
			model,
			status,
			output,
		});
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(event("response.created", { sequence_number: 0, response: response("in_progress", []) }));
		res.write(event("response.output_item.added", { sequence_number: 1, output_index: 0, item }));
		res.write(
			event("response.content_part.added", {
				sequence_number: 2,
				item_id: "msg_stub",
				output_index: 0,
				content_index: 0,
				part,
			}),
		);
		res.write(
			event("response.output_text.delta", {
				sequence_number: 3,
				item_id: "msg_stub",
				output_index: 0,
				content_index: 0,
				delta: reply,
			}),
		);
		res.write(
			event("response.output_text.done", {
				sequence_number: 4,
				item_id: "msg_stub",
				output_index: 0,
				content_index: 0,
				text: reply,
			}),
		);
		res.write(
			event("response.content_part.done", {
				sequence_number: 5,
				item_id: "msg_stub",
				output_index: 0,
				content_index: 0,
				part: { ...part, text: reply },
			}),
		);
		res.write(event("response.output_item.done", { sequence_number: 6, output_index: 0, item: done }));
		res.end(
			event("response.completed", {
				sequence_number: 7,
				response: {
					...response("completed", [done]),
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			}),
		);
	};
	const server = createServer(async (req, res) => {
		const authorization = req.headers.authorization ?? null;
		authorizations.push(authorization);
		const path = (req.url ?? "").split("?")[0];
		requests.push(`${req.method} ${path}`);
		if (apiKey !== null && authorization !== `Bearer ${apiKey}`) {
			send(res, 401, { error: "bad key" });
			return;
		}
		if (req.method === "GET" && path === "/v1/models") {
			send(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model" })) });
			return;
		}
		if (opts.ollama && req.method === "GET" && path === "/api/tags") {
			send(res, 200, { models: models.map((name) => ({ name, model: name })) });
			return;
		}
		if (opts.ollama && req.method === "POST" && path === "/api/show") {
			await readBody(req);
			send(res, 200, { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 32768 } });
			return;
		}
		if (opts.limit && req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/responses")) {
			const left = state.limitUntil - Date.now();
			if (left > 0) {
				await readBody(req);
				if (opts.limit.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.limit?.delayMs));
				refused.push({ at: Date.now() });
				res
					.writeHead(opts.limit.status ?? 429, {
						"content-type": "application/json",
						"retry-after-ms": String(left),
						"x-should-retry": "false",
					})
					.end(
						JSON.stringify({
							error: {
								message: opts.limit.message ?? "You have reached your usage limit.",
								type: "usage_limit_reached",
								code: "usage_limit_reached",
							},
						}),
					);
				return;
			}
		}
		if (req.method === "POST" && path === "/v1/chat/completions") {
			const chat: StubChat = { authorization, at: Date.now(), body: JSON.parse(await readBody(req)) };
			chats.push(chat);
			if (state.replyDelayMs > 0) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, state.replyDelayMs);
				await promise;
			}
			if (state.gate) await state.gate;
			const scripted = opts.respond?.(chat);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (scripted?.toolCalls?.length) {
				res.write(chunk({ role: "assistant", content: scripted.text ?? "" }));
				res.write(
					chunk({
						tool_calls: scripted.toolCalls.map((call, index) => ({
							index,
							id: `call_${chats.length}_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						})),
					}),
				);
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "" }));
				res.write(chunk({ content: scripted?.text ?? reply }));
				res.write(chunk({}, "stop"));
			}
			res.write(
				`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: models[0], choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
			return;
		}
		if (opts.ollama && req.method === "POST" && path === "/v1/responses") {
			const body = JSON.parse(await readBody(req));
			const input: { role?: string; content?: unknown }[] = Array.isArray(body.input) ? body.input : [];
			chats.push({
				authorization,
				at: Date.now(),
				body: {
					model: body.model,
					tools: Array.isArray(body.tools)
						? body.tools.map((t: { name?: string }) => ({ function: { name: t.name } }))
						: [],
					messages: [{ role: "system", content: body.instructions ?? "" }, ...input],
				},
			});
			responsesStream(res, String(body.model ?? models[0]));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("stub oMLX has no port");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		apiKey: apiKey ?? "",
		chats,
		authorizations,
		requests,
		refused,
		get limitUntil() {
			return state.limitUntil;
		},
		set limitUntil(at: number) {
			state.limitUntil = at;
		},
		get replyDelayMs() {
			return state.replyDelayMs;
		},
		set replyDelayMs(ms: number) {
			state.replyDelayMs = ms;
		},
		hold() {
			const { promise, resolve } = Promise.withResolvers<void>();
			state.gate = promise;
			return () => {
				if (state.gate === promise) state.gate = null;
				resolve();
			};
		},
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
