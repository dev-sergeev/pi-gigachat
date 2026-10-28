import { randomUUID } from "node:crypto";
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
import { environment, headers, object, request } from "./http.js";
import { convertMessages, convertTools } from "./openai-messages.js";
import type { GigaChatStreamOptions } from "./stream.js";

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
	const additionalSystemPrompt = env.GIGACHAT_SYSTEM_PROMPT;
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
	const reasoningEffort = model.reasoning
		? (model.thinkingLevelMap?.[thinkingLevel] ?? thinkingLevel)
		: undefined;
	return {
		model: model.id,
		messages: convertMessages(model, context, additionalSystemPrompt),
		max_tokens: Math.floor(Math.min(maxTokens, model.maxTokens)),
		tool_choice:
			typeof choice === "object" && "name" in choice
				? { type: "function", function: { name: choice.name } }
				: choice,
		...(tools.length ? { tools: convertTools(tools) } : {}),
		temperature: options.temperature,
		top_p: options.topP,
		response_format:
			options.responseFormat?.type === "json_schema"
				? {
						type: "json_schema",
						json_schema: {
							name: "response",
							schema: options.responseFormat.schema,
							...(options.responseFormat.strict !== undefined && {
								strict: options.responseFormat.strict,
							}),
						},
					}
				: options.responseFormat,
		reasoning_effort: reasoningEffort,
		...model.samplingParams,
		...options.samplingParams,
		...extra,
		...options.extraBody,
		stream: options.stream ?? mode === "true",
	};
}

// Native pi calls this after resolving provider.auth to an access token.
export function streamSimpleOpenAI(
	model: Model<Api>,
	context: TranscriptContext,
	options: GigaChatStreamOptions = {},
): AssistantMessageEventStream {
	if (!options.apiKey && !options.mtls)
		throw new Error(
			"GigaChat access token or mTLS is required; use /gigachat in Pi",
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
			body = { ...body, stream: streaming };
			// Overrides are caller-owned; fold replayed reasoning into content on copies.
			delete body.reasoning;
			delete body.reasoning_content;
			if (Array.isArray(body.messages)) {
				const messages = body.messages;
				let cleaned = messages;
				for (let i = 0; i < messages.length; i++) {
					const message = messages[i];
					if (
						!object(message) ||
						(!Object.hasOwn(message, "reasoning_content") &&
							!Object.hasOwn(message, "reasoning") &&
							!Object.hasOwn(message, "reasoning_effort"))
					)
						continue;
					if (cleaned === messages) cleaned = messages.slice();
					const copy = { ...message };
					if (copy.role === "assistant") {
						const reasoning = [copy.reasoning_content, copy.reasoning]
							.filter(
								(value): value is string =>
									typeof value === "string" && value.length > 0,
							)
							.join("\n\n");
						if (reasoning) {
							const content = copy.content;
							copy.content = Array.isArray(content)
								? [
										{
											type: "text",
											text: `${reasoning}${content.length ? "\n\n" : ""}`,
										},
										...content,
									]
								: `${reasoning}${typeof content === "string" && content ? `\n\n${content}` : ""}`;
						}
					}
					delete copy.reasoning_content;
					delete copy.reasoning;
					delete copy.reasoning_effort;
					cleaned[i] = copy;
				}
				body.messages = cleaned;
			}
			let observerFailed = false;
			stream.push({ type: "start", partial: output });
			await request(
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
							Authorization: options.mtls ? null : `Bearer ${options.apiKey}`,
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
							signal.throwIfAborted();
							// Pi also retries assistant errors by text. Keep observer failures
							// terminal even when their cause resembles a transport failure.
							observerFailed = true;
							throw new Error(
								`GigaChat out of budget for automatic observer retries (disabled): ${error instanceof Error ? error.message : String(error)}`,
								{ cause: error },
							);
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
	const tools = new Map<number, { tool: ToolCall; argumentsJson: string }>();
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
				const cached = object(chunk.usage.prompt_tokens_details)
					? Number(chunk.usage.prompt_tokens_details.cached_tokens ?? 0)
					: 0;
				usage.input = Number(chunk.usage.prompt_tokens ?? 0) - cached;
				usage.output = Number(chunk.usage.completion_tokens ?? 0);
				usage.cacheRead = cached;
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
			if (message.content != null && typeof message.content !== "string")
				throw new Error("Invalid GigaChat content");
			if (
				message.reasoning_content != null &&
				typeof message.reasoning_content !== "string"
			)
				throw new Error("Invalid GigaChat reasoning_content");
			if (message.reasoning_content)
				addThinking(message.reasoning_content as string);
			if (message.content) addText(message.content as string);
			if (message.tool_calls != null) {
				if (!Array.isArray(message.tool_calls))
					throw new Error("Invalid GigaChat tool_calls");
				for (const [position, call] of message.tool_calls.entries()) {
					if (!object(call)) throw new Error("Invalid GigaChat tool call");
					const index = streaming ? call.index : position;
					if (
						typeof index !== "number" ||
						!Number.isInteger(index) ||
						index < 0
					)
						throw new Error("Invalid GigaChat tool call index");
					let state = tools.get(index);
					if (!state) {
						closeThinking();
						closeText();
						const tool: ToolCall = {
							type: "toolCall",
							id:
								typeof call.id === "string" && call.id
									? call.id
									: `gigachat_${randomUUID()}`,
							name: "",
							arguments: {},
						};
						state = { tool, argumentsJson: "" };
						tools.set(index, state);
						output.content.push(tool);
						stream.push({
							type: "toolcall_start",
							contentIndex: output.content.indexOf(tool),
							partial: output,
						});
					}
					if (typeof call.id === "string" && call.id) state.tool.id = call.id;
					if (call.function != null) {
						if (!object(call.function))
							throw new Error("Invalid GigaChat tool function");
						if (typeof call.function.name === "string")
							state.tool.name += call.function.name;
						if (call.function.arguments !== undefined) {
							if (typeof call.function.arguments !== "string")
								throw new Error("Invalid GigaChat tool arguments");
							const delta = call.function.arguments;
							state.argumentsJson += delta;
							state.tool.arguments = parseStreamingJson<ToolCall["arguments"]>(
								state.argumentsJson,
							);
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(state.tool),
								delta,
								partial: output,
							});
						}
					}
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
					case "tool_calls":
						output.stopReason = "toolUse";
						break;
					case "content_filter":
						output.stopReason = "error";
						break;
					default:
						throw new Error(`GigaChat finish_reason: ${choice.finish_reason}`);
				}
			}
		},
		finish() {
			if (output.stopReason === "pending")
				throw new Error("Incomplete GigaChat response: missing finish_reason");
			if (output.stopReason === "toolUse" && tools.size === 0)
				throw new Error("Invalid GigaChat completion: missing tool_calls");
			closeThinking();
			closeText();
			for (const { tool, argumentsJson } of tools.values()) {
				if (!tool.name) throw new Error("Invalid GigaChat tool call name");
				Object.assign(tool, parseToolCallArguments(argumentsJson));
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
	// Keep only the current reader chunk queued; await observers before reading more.
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
