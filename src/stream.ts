import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	createAssistantMessageEventStream,
	parseStreamingJson,
} from "@earendil-works/pi-ai";
import { createParser } from "eventsource-parser";
import { baseUrl } from "./auth.js";
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

export type GigaChatStreamOptions = SimpleStreamOptions & {
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
	context: Context,
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
	return {
		model: model.id,
		messages: convertMessages(model, context, additionalSystemPrompt),
		max_tokens: Math.floor(Math.min(maxTokens, model.maxTokens)),
		function_call:
			options.toolChoice ??
			options.functionCall ??
			(context.tools?.length ? "auto" : "none"),
		...(context.tools?.length
			? { functions: convertFunctions(context.tools) }
			: {}),
		temperature: options.temperature,
		top_p: options.topP,
		response_format: options.responseFormat,
		profanity_check: options.profanityCheck,
		repetition_penalty: options.repetitionPenalty,
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
	context: Context,
	options: GigaChatStreamOptions = {},
): AssistantMessageEventStream {
	if (!options.apiKey)
		throw new Error(
			"GigaChat access token is required; use gigachatProvider with createModels() or /login gigachat",
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
								Authorization: `Bearer ${options.apiKey}`,
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
					{ ...options, canRetry: () => output.content.length === 0 },
					async (response) => {
						// A failed attempt may have emitted only metadata, not content.
						output.stopReason = "pending";
						delete output.rawStopReason;
						output.usage = emptyUsage();
						const consume = completionConsumer(output, stream, model);
						if (streaming)
							await readSSE(response, (chunk) => consume.add(chunk, true));
						else {
							if (
								!response.headers
									.get("content-type")
									?.includes("application/json")
							)
								throw new Error("Expected a GigaChat JSON response");
							consume.add(await response.json(), false);
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
	let tool: ToolCall | undefined;
	let argumentsJson = "";
	let signature: string | undefined;
	let textClosed = false;
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
	const addText = (delta: string) => {
		if (textClosed) throw new Error("GigaChat sent text after a function call");
		if (!text) {
			text = { type: "text", text: "" };
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
			if (typeof message.functions_state_id === "string")
				signature = STATE_SIGNATURE_PREFIX + message.functions_state_id;
			if (message.content) addText(message.content as string);
			if (message.function_call != null) {
				const call = message.function_call;
				if (!object(call)) throw new Error("Invalid GigaChat function_call");
				if (!tool) {
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
			closeText();
			if (tool) {
				const args: unknown = JSON.parse(argumentsJson || "{}");
				if (!tool.name || !object(args))
					throw new Error("Invalid GigaChat function_call name or arguments");
				tool.arguments = args;
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

async function readSSE(response: Response, consume: (chunk: unknown) => void) {
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw new Error("Expected a GigaChat SSE response");
	let done = false;
	const parser = createParser({
		onEvent(event) {
			if (event.data === "[DONE]") done = true;
			else if (!done) consume(JSON.parse(event.data));
		},
	});
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	try {
		while (!done) {
			const next = await reader.read();
			if (next.done) break;
			parser.feed(decoder.decode(next.value, { stream: true }));
		}
		parser.feed(decoder.decode());
		if (!done)
			throw new Error("Incomplete GigaChat SSE response: missing [DONE]");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
