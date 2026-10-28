import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getCurrentTools,
	parseStreamingJson,
	parseToolCallArguments,
} from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { createParser } from "eventsource-parser";
import { baseUrl } from "./auth.js";
import { environment, headers, object, request, serial } from "./http.js";
import type { GigaChatStreamOptions } from "./stream.js";
import {
	convertV2Functions,
	convertV2Messages,
	V2_STATE_SIGNATURE_PREFIX,
} from "./v2-messages.js";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function payload(
	model: Model<Api>,
	context: TranscriptContext,
	options: GigaChatStreamOptions,
): Record<string, unknown> {
	const env = environment(options);
	const mode = env.GIGACHAT_STREAM ?? "false";
	if (mode !== "true" && mode !== "false")
		throw new Error("GIGACHAT_STREAM must be true or false");
	let extra: unknown;
	try {
		extra = JSON.parse(env.GIGACHAT_EXTRA_BODY || "{}");
	} catch {
		throw new Error("GIGACHAT_EXTRA_BODY must be a JSON object");
	}
	if (!object(extra))
		throw new Error("GIGACHAT_EXTRA_BODY must be a JSON object");
	const maxTokens = options.maxTokens ?? model.maxTokens;
	if (!Number.isFinite(maxTokens) || maxTokens < 1)
		throw new Error("GigaChat maxTokens must be positive");
	const tools = getCurrentTools(context.messages);
	const choice =
		options.toolChoice ??
		options.functionCall ??
		(tools.length ? "auto" : "none");
	const thinkingLevel = clampThinkingLevel(model, options.reasoning ?? "off");
	const reasoning = model.reasoning && thinkingLevel !== "off";
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertV2Messages(model, context, env.GIGACHAT_SYSTEM_PROMPT),
		...(tools.length
			? {
					tools: [{ functions: { specifications: convertV2Functions(tools) } }],
				}
			: {}),
		tool_config:
			typeof choice === "string"
				? { mode: choice }
				: { mode: "forced", function_name: choice.name },
		model_options: {
			max_tokens: Math.floor(Math.min(maxTokens, model.maxTokens)),
			temperature: options.temperature,
			top_p: options.topP,
			repetition_penalty: options.repetitionPenalty,
			response_format: options.responseFormat,
			...(tools.length && { parallel_tool_calls: true }),
			...(reasoning && { reasoning: { effort: "medium" } }),
			...model.samplingParams,
			...options.samplingParams,
		},
		...(options.profanityCheck !== undefined && {
			disable_filter: !options.profanityCheck,
		}),
		...extra,
		...options.extraBody,
		stream: options.stream ?? mode === "true",
	};
	if (!reasoning && object(body.model_options)) {
		body.model_options = { ...body.model_options };
		delete (body.model_options as Record<string, unknown>).reasoning;
	}
	return body;
}

export function streamSimpleGigaChatV2(
	model: Model<Api>,
	context: TranscriptContext,
	options: GigaChatStreamOptions = {},
): AssistantMessageEventStream {
	if (!options.apiKey && !options.mtls)
		throw new Error("GigaChat access token is required; use /gigachat in Pi");
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "pending",
		timestamp: Date.now(),
		usage: emptyUsage(),
	};
	const signal = options.signal ?? new AbortController().signal;
	(async () => {
		try {
			let body = payload(model, context, options);
			const streaming = Boolean(body.stream);
			const modified = await options.onPayload?.(body, model);
			if (modified !== undefined) {
				if (!object(modified))
					throw new Error("GigaChat onPayload must return a JSON object");
				body = modified;
			}
			body.stream = streaming;
			// The off selection must not turn on server-side reasoning through overrides.
			if (
				(!model.reasoning ||
					!options.reasoning ||
					options.reasoning === "off") &&
				object(body.model_options)
			) {
				body.model_options = { ...body.model_options };
				delete (body.model_options as Record<string, unknown>).reasoning;
			}
			let observerFailed = false;
			stream.push({ type: "start", partial: output });
			await serial(signal, () =>
				request(
					`${baseUrl(options.env?.GIGACHAT_BASE_URL || model.baseUrl)}/chat/completions`,
					{
						method: "POST",
						body: JSON.stringify(body),
						headers: headers(
							{
								"Content-Type": "application/json",
								Accept: streaming ? "text/event-stream" : "application/json",
								...(!options.mtls && {
									Authorization: `Bearer ${options.apiKey}`,
								}),
								"User-Agent": "pi-gigachat",
								"Cache-Control": "no-store",
								...(options.sessionId && options.cacheRetention !== "none"
									? { "X-Session-ID": options.sessionId }
									: {}),
							},
							model.headers,
							options.headers,
						),
					},
					{
						...options,
						retry422: false,
						canRetry: () => !observerFailed && output.content.length === 0,
					},
					async (response) => {
						output.stopReason = "pending";
						delete output.rawStopReason;
						output.usage = emptyUsage();
						const consumer = completionConsumer(output, stream, model);
						const observe = async (chunk: unknown, event?: string) => {
							signal.throwIfAborted();
							try {
								if (options.onProviderStreamEvent)
									await raceWithAbortSignal(
										Promise.resolve().then(() =>
											options.onProviderStreamEvent?.(chunk, model),
										),
										signal,
									);
							} catch (error) {
								observerFailed = true;
								throw error;
							}
							signal.throwIfAborted();
							consumer.add(chunk, event);
						};
						if (streaming) await readSSE(response, observe);
						else {
							if (
								!response.headers
									.get("content-type")
									?.includes("application/json")
							)
								throw new Error("Expected a GigaChat V2 JSON response");
							await observe(await response.json());
						}
						consumer.finish();
					},
					(response) =>
						options.onResponse?.(
							{
								status: response.status,
								headers: Object.fromEntries(response.headers),
							},
							model,
						),
				),
			);
			signal.throwIfAborted();
			if (
				output.stopReason !== "stop" &&
				output.stopReason !== "length" &&
				output.stopReason !== "toolUse"
			)
				throw new Error(
					`GigaChat V2 finished with reason: ${output.rawStopReason ?? output.stopReason}`,
				);
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = signal.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	})();
	return stream;
}

interface ContentState {
	block: TextContent | ThinkingContent | ToolCall;
	index: number;
	argumentsJson: string;
	pendingSurrogate: string;
}

function completionConsumer(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
) {
	const content = new Map<string, ContentState>();
	const tools = new Map<string, ContentState>();
	const states: ContentState[] = [];
	const appendText = (state: ContentState, text: string, snapshot: boolean) => {
		const block = state.block;
		if (block.type === "toolCall")
			throw new Error("Invalid GigaChat V2 text position");
		if (snapshot) {
			const previous =
				(block.type === "text" ? block.text : block.thinking) +
				state.pendingSurrogate;
			if (!text.startsWith(previous))
				throw new Error("Inconsistent GigaChat V2 final text");
			text = text.slice(previous.length);
		}
		let delta = state.pendingSurrogate + text;
		state.pendingSurrogate = "";
		// Keep a split UTF-16 pair together; only replace genuinely unpaired units.
		const last = delta.charCodeAt(delta.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			state.pendingSurrogate = delta.slice(-1);
			delta = delta.slice(0, -1);
		}
		delta = delta.toWellFormed();
		if (!delta) return;
		if (block.type === "text") {
			block.text += delta;
			stream.push({
				type: "text_delta",
				contentIndex: state.index,
				delta,
				partial: output,
			});
		} else {
			block.thinking += delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: state.index,
				delta,
				partial: output,
			});
		}
	};
	const create = (key: string, block: ContentState["block"]) => {
		const state = {
			block,
			index: output.content.length,
			argumentsJson: "",
			pendingSurrogate: "",
		};
		content.set(key, state);
		states.push(state);
		output.content.push(block);
		if (block.type === "text")
			stream.push({
				type: "text_start",
				contentIndex: state.index,
				partial: output,
			});
		else if (block.type === "thinking")
			stream.push({
				type: "thinking_start",
				contentIndex: state.index,
				partial: output,
			});
		else
			stream.push({
				type: "toolcall_start",
				contentIndex: state.index,
				partial: output,
			});
		return state;
	};
	return {
		add(chunk: unknown, event?: string) {
			if (!object(chunk)) throw new Error("Invalid GigaChat V2 completion");
			const snapshot = event !== "response.message.delta";
			if (object(chunk.usage)) {
				const usage = output.usage;
				const details = object(chunk.usage.input_tokens_details)
					? chunk.usage.input_tokens_details
					: {};
				usage.cacheRead = Number(details.cached_tokens ?? 0);
				usage.input = Number(chunk.usage.input_tokens ?? 0) - usage.cacheRead;
				usage.output = Number(chunk.usage.output_tokens ?? 0);
				usage.totalTokens = Number(
					chunk.usage.total_tokens ??
						usage.input + usage.cacheRead + usage.output,
				);
				calculateCost(model, usage);
			}
			if (chunk.messages !== undefined && !Array.isArray(chunk.messages))
				throw new Error("Invalid GigaChat V2 messages");
			if (!Array.isArray(chunk.messages) && event !== "response.message.done")
				throw new Error("Invalid GigaChat V2 completion: missing messages");
			if (Array.isArray(chunk.messages))
				for (const [messageIndex, message] of chunk.messages.entries()) {
					if (!object(message) || !Array.isArray(message.content))
						throw new Error("Invalid GigaChat V2 message");
					if (message.role !== "assistant" && message.role !== "reasoning")
						throw new Error(
							`Unsupported GigaChat V2 response role: ${message.role}`,
						);
					const messageKey = `${message.role}:${typeof message.message_id === "string" ? message.message_id : messageIndex}`;
					const signature =
						typeof message.tool_state_id === "string"
							? V2_STATE_SIGNATURE_PREFIX + message.tool_state_id
							: undefined;
					for (const [partIndex, part] of message.content.entries()) {
						if (!object(part)) throw new Error("Invalid GigaChat V2 content");
						const key = `${messageKey}:${partIndex}`;
						if (part.text !== undefined) {
							if (typeof part.text !== "string")
								throw new Error("Invalid GigaChat V2 text");
							const kind = message.role === "reasoning" ? "thinking" : "text";
							const state =
								content.get(key) ??
								create(
									key,
									kind === "thinking"
										? {
												type: "thinking",
												thinking: "",
												thinkingSignature: "gigachat:v2:reasoning",
											}
										: { type: "text", text: "" },
								);
							if (state.block.type !== kind)
								throw new Error("Inconsistent GigaChat V2 content type");
							appendText(state, part.text, snapshot);
							if (signature && state.block.type === "text")
								state.block.textSignature = signature;
						}
						if (part.function_call !== undefined) {
							if (message.role !== "assistant" || !object(part.function_call))
								throw new Error("Invalid GigaChat V2 function_call");
							const call = part.function_call;
							if (call.id !== undefined && typeof call.id !== "string")
								throw new Error("Invalid GigaChat V2 function_call id");
							const id = typeof call.id === "string" ? call.id : undefined;
							let state = id ? tools.get(id) : content.get(key);
							if (!state) {
								if (!id)
									throw new Error(
										"Invalid GigaChat V2 function_call: missing id",
									);
								state = create(key, {
									type: "toolCall",
									id,
									name: "",
									arguments: {},
								});
								tools.set(id, state);
							}
							const tool = state.block;
							if (tool.type !== "toolCall")
								throw new Error("Inconsistent GigaChat V2 function position");
							if (call.name !== undefined) {
								if (
									typeof call.name !== "string" ||
									(tool.name && tool.name !== call.name)
								)
									throw new Error("Invalid GigaChat V2 function_call name");
								tool.name = call.name;
							}
							if (call.arguments !== undefined) {
								if (
									typeof call.arguments !== "string" &&
									!object(call.arguments)
								)
									throw new Error("Invalid GigaChat V2 function arguments");
								const delta =
									typeof call.arguments === "string"
										? call.arguments
										: JSON.stringify(call.arguments);
								state.argumentsJson =
									typeof call.arguments === "string" && !snapshot
										? state.argumentsJson + delta
										: delta;
								tool.arguments = parseStreamingJson(state.argumentsJson);
								stream.push({
									type: "toolcall_delta",
									contentIndex: state.index,
									delta,
									partial: output,
								});
							}
							if (signature) tool.thoughtSignature = signature;
						}
					}
					// State can arrive after the first content fragment.
					if (signature)
						for (const [key, state] of content) {
							if (!key.startsWith(`${messageKey}:`)) continue;
							if (state.block.type === "text")
								state.block.textSignature = signature;
							else if (state.block.type === "toolCall")
								state.block.thoughtSignature = signature;
						}
				}
			if (chunk.finish_reason != null && chunk.finish_reason !== "") {
				if (typeof chunk.finish_reason !== "string")
					throw new Error("Invalid GigaChat V2 finish_reason");
				output.rawStopReason = chunk.finish_reason;
				switch (chunk.finish_reason) {
					case "stop":
						output.stopReason = "stop";
						break;
					case "length":
						output.stopReason = "length";
						break;
					case "function_call":
						output.stopReason = "toolUse";
						break;
					default:
						throw new Error(
							`GigaChat V2 finish_reason: ${chunk.finish_reason}`,
						);
				}
			}
		},
		finish() {
			if (output.stopReason === "pending")
				throw new Error(
					"Incomplete GigaChat V2 response: missing finish_reason",
				);
			if (output.stopReason === "toolUse" && !tools.size)
				throw new Error(
					"Invalid GigaChat V2 completion: missing function_call",
				);
			for (const state of states) {
				const block = state.block;
				if (block.type === "toolCall") {
					if (!block.name)
						throw new Error("Invalid GigaChat V2 function_call name");
					Object.assign(block, parseToolCallArguments(state.argumentsJson));
					stream.push({
						type: "toolcall_end",
						contentIndex: state.index,
						toolCall: block,
						partial: output,
					});
				} else {
					if (state.pendingSurrogate) {
						state.pendingSurrogate = "";
						appendText(state, "\ufffd", false);
					}
					if (block.type === "text")
						stream.push({
							type: "text_end",
							contentIndex: state.index,
							content: block.text,
							partial: output,
						});
					else
						stream.push({
							type: "thinking_end",
							contentIndex: state.index,
							content: block.thinking,
							partial: output,
						});
				}
			}
		},
	};
}

async function readSSE(
	response: Response,
	consume: (chunk: unknown, event: string) => Promise<void>,
) {
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw new Error("Expected a GigaChat V2 SSE response");
	let done = false;
	const events: { event: string; data: string }[] = [];
	const parser = createParser({
		onEvent(event) {
			events.push({ event: event.event ?? "", data: event.data });
		},
	});
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	const drain = async () => {
		for (const event of events) {
			if (
				event.event !== "response.message.delta" &&
				event.event !== "response.message.done"
			)
				throw new Error(
					`Unsupported GigaChat V2 SSE event: ${event.event || "(unnamed)"}`,
				);
			await consume(JSON.parse(event.data), event.event);
			if (event.event === "response.message.done") {
				done = true;
				break;
			}
		}
		events.length = 0;
	};
	try {
		while (!done) {
			const next = await reader.read();
			if (next.done) break;
			parser.feed(decoder.decode(next.value, { stream: true }));
			await drain();
		}
		if (!done) {
			parser.feed(decoder.decode());
			await drain();
		}
		if (!done)
			throw new Error(
				"Incomplete GigaChat V2 SSE response: missing response.message.done",
			);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
