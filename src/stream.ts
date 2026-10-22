import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
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
import type { MtlsMaterials } from "./connection-types.js";
import { environment, headers, object, request, serial } from "./http.js";
import {
	convertFunctions,
	convertMessages,
	STATE_SIGNATURE_PREFIX,
} from "./messages.js";

const DEFAULT_SYSTEM_PROMPT =
	"Call at most one tool per assistant message. Do not make multiple or parallel tool calls. Wait for the tool result before calling another tool.";

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

export type GigaChatStreamOptions = Omit<SimpleStreamOptions, "reasoning"> & {
	mtls?: MtlsMaterials;
	reasoning?: ModelThinkingLevel;
	stream?: boolean;
	extraBody?: Record<string, unknown>;
	topP?: number;
	responseFormat?:
		| { type: "text" }
		| {
				type: "json_schema";
				schema: Record<string, unknown>;
				strict?: boolean;
		  };
	profanityCheck?: boolean;
	repetitionPenalty?: number;
	functionCall?: "auto" | "none" | { name: string };
};

function payload(
	model: Model<Api>,
	context: TranscriptContext,
	options: GigaChatStreamOptions,
): Record<string, unknown> {
	const env = environment(options);
	const mode = env.GIGACHAT_STREAM ?? "false";
	if (mode !== "true" && mode !== "false")
		throw new Error("GIGACHAT_STREAM must be true or false");
	const additionalSystemPrompt =
		env.GIGACHAT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;
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
	// Pi represents its off selection by omitting options.reasoning.
	const thinkingLevel = clampThinkingLevel(model, options.reasoning ?? "off");
	const tools = getCurrentTools(context.messages);
	return {
		model: model.id,
		messages: convertMessages(model, context, additionalSystemPrompt),
		max_tokens: Math.floor(Math.min(maxTokens, model.maxTokens)),
		function_call:
			options.toolChoice ??
			options.functionCall ??
			(tools.length ? "auto" : "none"),
		...(tools.length ? { functions: convertFunctions(tools) } : {}),
		temperature: options.temperature,
		top_p: options.topP,
		response_format: options.responseFormat,
		profanity_check: options.profanityCheck,
		repetition_penalty: options.repetitionPenalty,
		...(model.reasoning
			? {
					reasoning_effort:
						model.thinkingLevelMap?.[thinkingLevel] ?? thinkingLevel,
				}
			: {}),
		...model.samplingParams,
		...options.samplingParams,
		...extra,
		...options.extraBody,
		stream: options.stream ?? mode === "true",
	};
}

// Native pi calls this after resolving provider.auth to an access token.
export function streamSimpleGigaChat(
	model: Model<Api>,
	context: TranscriptContext,
	options: GigaChatStreamOptions = {},
): AssistantMessageEventStream {
	if (!options.apiKey && !options.mtls)
		throw new Error(
			"GigaChat access token is required; use /gigachat in Pi or gigachatProvider with createModels()",
		);
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
			const streaming = body.stream;
			const modified = await options.onPayload?.(body, model);
			if (modified !== undefined) {
				if (!object(modified))
					throw new Error("GigaChat onPayload must return a JSON object");
				body = modified;
			}
			// This switch controls both the wire format and its parser.
			body.stream = streaming;
			// Sanitize the final messages, including payload overrides, without
			// mutating caller-owned history or nested function arguments.
			if (Array.isArray(body.messages)) {
				const messages = body.messages;
				let cleaned = messages;
				for (let i = 0; i < messages.length; i++) {
					const message = messages[i];
					if (object(message) && Object.hasOwn(message, "functions_state_id")) {
						if (cleaned === messages) cleaned = messages.slice();
						const copy = { ...message };
						delete copy.functions_state_id;
						cleaned[i] = copy;
					}
				}
				body.messages = cleaned;
			}
			let recoveryAdded = false;
			let observerFailed = false;
			stream.push({ type: "start", partial: output });
			await serial(signal, () =>
				request(
					// Native auth already applied the saved or ambient endpoint to the
					// model. Only an explicit request override may replace it here.
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
						canRetry: () => !observerFailed && output.content.length === 0,
						recover422: (init) => {
							if (recoveryAdded) return init;
							const recoveredBody = {
								...body,
								messages: [
									...(body.messages as unknown[]),
									{ role: "user", content: DEFAULT_SYSTEM_PROMPT },
								],
							};
							recoveryAdded = true;
							return { ...init, body: JSON.stringify(recoveredBody) };
						},
					},
					async (response) => {
						// A failed attempt may have emitted only metadata, not content.
						output.stopReason = "pending";
						delete output.rawStopReason;
						output.usage = emptyUsage();
						const consume = completionConsumer(output, stream, model);
						const observe = async (chunk: unknown) => {
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
								// Observer failures are not transport failures, even if their
								// error happens to match a transient network error.
								observerFailed = true;
								throw error;
							}
							signal.throwIfAborted();
							consume.add(chunk, Boolean(streaming));
						};
						if (streaming) await readSSE(response, observe);
						else {
							if (
								!response.headers
									.get("content-type")
									?.includes("application/json")
							)
								throw new Error("Expected a GigaChat JSON response");
							await observe(await response.json());
						}
						consume.finish();
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
					`GigaChat finished with reason: ${output.rawStopReason ?? output.stopReason}`,
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

function completionConsumer(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
) {
	let text: TextContent | undefined;
	let thinking: ThinkingContent | undefined;
	let tool: ToolCall | undefined;
	let argumentsJson = "";
	let signature: string | undefined;
	let textClosed = false;
	let thinkingClosed = false;
	const closeThinking = () => {
		if (thinking && !thinkingClosed) {
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(thinking),
				content: thinking.thinking,
				partial: output,
			});
			thinkingClosed = true;
		}
	};
	const closeText = () => {
		if (text && !textClosed) {
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(text),
				content: text.text,
				partial: output,
			});
			textClosed = true;
		}
	};
	const addThinking = (delta: string) => {
		closeText();
		if (!thinking || thinkingClosed) {
			thinking = {
				type: "thinking",
				thinking: "",
				// Pi preserves signed blocks even when they contain only whitespace.
				thinkingSignature: "reasoning_content",
			};
			thinkingClosed = false;
			output.content.push(thinking);
			stream.push({
				type: "thinking_start",
				contentIndex: output.content.indexOf(thinking),
				partial: output,
			});
		}
		thinking.thinking += delta;
		stream.push({
			type: "thinking_delta",
			contentIndex: output.content.indexOf(thinking),
			delta,
			partial: output,
		});
	};
	const addText = (delta: string) => {
		if (tool) throw new Error("GigaChat sent text after a function call");
		closeThinking();
		if (!text || textClosed) {
			text = { type: "text", text: "" };
			textClosed = false;
			output.content.push(text);
			stream.push({
				type: "text_start",
				contentIndex: output.content.indexOf(text),
				partial: output,
			});
		}
		text.text += delta;
		stream.push({
			type: "text_delta",
			contentIndex: output.content.indexOf(text),
			delta,
			partial: output,
		});
	};
	return {
		add(chunk: unknown, streaming: boolean) {
			if (!object(chunk) || !Array.isArray(chunk.choices))
				throw new Error("Invalid GigaChat completion: missing choices");
			if (object(chunk.usage)) {
				const usage = output.usage;
				usage.input = Number(chunk.usage.prompt_tokens ?? 0);
				usage.output = Number(chunk.usage.completion_tokens ?? 0);
				usage.cacheRead = Number(chunk.usage.precached_prompt_tokens ?? 0);
				// GigaChat total_tokens is billable usage; pi needs occupied context.
				usage.totalTokens = usage.input + usage.cacheRead + usage.output;
				calculateCost(model, usage);
			}
			if (streaming && chunk.choices.length === 0 && object(chunk.usage))
				return;
			const choice = chunk.choices[0];
			const message = object(choice)
				? choice[streaming ? "delta" : "message"]
				: undefined;
			if (!object(message))
				throw new Error(
					"Invalid GigaChat completion: missing message or delta",
				);
			if (message.role === "function_in_progress") return;
			if (message.content != null && typeof message.content !== "string")
				throw new Error("Invalid GigaChat content");
			if (
				message.reasoning_content != null &&
				typeof message.reasoning_content !== "string"
			)
				throw new Error("Invalid GigaChat reasoning_content");
			if (typeof message.functions_state_id === "string")
				signature = STATE_SIGNATURE_PREFIX + message.functions_state_id;
			if (message.reasoning_content)
				addThinking(message.reasoning_content as string);
			if (message.content) addText(message.content as string);
			if (message.function_call != null) {
				const call = message.function_call;
				if (!object(call)) throw new Error("Invalid GigaChat function_call");
				if (call.name !== undefined && typeof call.name !== "string")
					throw new Error("Invalid GigaChat function_call name");
				if (!tool) {
					closeThinking();
					closeText();
					tool = {
						type: "toolCall",
						id: `gigachat_${randomUUID()}`,
						name: "",
						arguments: {},
					};
					output.content.push(tool);
					stream.push({
						type: "toolcall_start",
						contentIndex: output.content.indexOf(tool),
						partial: output,
					});
				}
				if (typeof call.name === "string" && tool.name !== call.name)
					tool.name += call.name;
				if (call.arguments !== undefined) {
					// GigaChat returns complete objects or JSON string fragments.
					if (typeof call.arguments !== "string" && !object(call.arguments))
						throw new Error("Invalid GigaChat function arguments");
					const delta =
						typeof call.arguments === "string"
							? call.arguments
							: JSON.stringify(call.arguments);
					argumentsJson =
						typeof call.arguments === "string" ? argumentsJson + delta : delta;
					tool.arguments = parseStreamingJson(argumentsJson);
					stream.push({
						type: "toolcall_delta",
						contentIndex: output.content.indexOf(tool),
						delta,
						partial: output,
					});
				}
			}
			if (choice.finish_reason != null && choice.finish_reason !== "") {
				output.rawStopReason = choice.finish_reason;
				switch (choice.finish_reason) {
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
						throw new Error(`GigaChat finish_reason: ${choice.finish_reason}`);
				}
			}
		},
		finish() {
			if (output.stopReason === "pending")
				throw new Error("Incomplete GigaChat response: missing finish_reason");
			if (output.stopReason === "toolUse" && !tool)
				throw new Error("Invalid GigaChat completion: missing function_call");
			if (signature && !tool && !text) addText("");
			if (text && signature) text.textSignature = signature;
			closeThinking();
			closeText();
			if (tool) {
				if (!tool.name) throw new Error("Invalid GigaChat function_call name");
				Object.assign(tool, parseToolCallArguments(argumentsJson));
				if (signature) tool.thoughtSignature = signature;
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(tool),
					toolCall: tool,
					partial: output,
				});
			}
		},
	};
}

async function readSSE(
	response: Response,
	consume: (chunk: unknown) => Promise<void>,
) {
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw new Error("Expected a GigaChat SSE response");
	let done = false;
	// Only queue events from the current reader chunk. Await normalization
	// before reading again, so a slow observer cannot buffer the response.
	const events: string[] = [];
	const parser = createParser({
		onEvent(event) {
			events.push(event.data);
		},
	});
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	try {
		while (!done) {
			const next = await reader.read();
			if (next.done) break;
			parser.feed(decoder.decode(next.value, { stream: true }));
			for (const event of events) {
				if (event === "[DONE]") {
					done = true;
					break;
				}
				await consume(JSON.parse(event));
			}
			events.length = 0;
		}
		parser.feed(decoder.decode());
		for (const event of events) {
			if (event === "[DONE]") {
				done = true;
				break;
			}
			await consume(JSON.parse(event));
		}
		if (!done)
			throw new Error("Incomplete GigaChat SSE response: missing [DONE]");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
