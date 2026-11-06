import { stripVTControlCharacters } from "node:util";
import { createParser } from "eventsource-parser";
import { baseUrl as normalizeBaseUrl } from "./auth.js";
import type {
	ConnectionModel,
	DiscoveryOptions,
	GigaChatProtocol,
	ModelProbe,
} from "./connection-types.js";
import { GigaChatHttpError, object, request } from "./http.js";
import { GIGACHAT_CONNECTION_DEFAULTS } from "./models.js";
import { GigaChatMtlsError } from "./mtls.js";
import { defaultModelsUrl, thinkingLevelMapForProtocol } from "./protocols.js";

class DiscoveryError extends Error {
	constructor(
		readonly code: "INVALID_URL" | "INVALID_RESPONSE" | "INVALID_PROTOCOL",
	) {
		super(
			code === "INVALID_URL"
				? "GigaChat server URL must use http(s)."
				: code === "INVALID_PROTOCOL"
					? "Unknown GigaChat API protocol."
					: "GigaChat returned an invalid response.",
		);
	}
}

function displayName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	// Catalog labels are untrusted terminal text, not markup or escape sequences.
	const safe = stripVTControlCharacters(value)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return safe || fallback;
}

function positiveInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
			return value;
	}
	return undefined;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new DiscoveryError("INVALID_RESPONSE");
		throw error;
	}
}

function catalog(
	value: unknown,
	protocol: GigaChatProtocol,
): ConnectionModel[] {
	if (!object(value) || !Array.isArray(value.data))
		throw new DiscoveryError("INVALID_RESPONSE");
	const seen = new Set<string>();
	const models: ConnectionModel[] = [];
	for (const item of value.data) {
		if (
			!object(item) ||
			typeof item.id !== "string" ||
			!item.id.trim() ||
			/[\p{Cc}\p{Cf}]/u.test(item.id) ||
			seen.has(item.id)
		)
			continue;
		seen.add(item.id);
		// V2 reasoning is opt-in per selected model, never inferred from a catalog.
		const reasoning =
			protocol !== "v2" &&
			(typeof item.reasoning === "boolean"
				? item.reasoning
				: GIGACHAT_CONNECTION_DEFAULTS.reasoning);
		models.push({
			id: item.id,
			name: displayName(item.name, item.id),
			contextWindow:
				positiveInteger(
					item.contextWindow,
					item.context_window,
					item.context_length,
				) ?? GIGACHAT_CONNECTION_DEFAULTS.contextWindow,
			maxTokens:
				positiveInteger(
					item.maxTokens,
					item.max_tokens,
					item.max_output_tokens,
				) ?? GIGACHAT_CONNECTION_DEFAULTS.maxTokens,
			reasoning,
			...(reasoning
				? {
						thinkingLevelMap: thinkingLevelMapForProtocol(protocol),
					}
				: {}),
		});
	}
	if (value.data.length > 0 && models.length === 0)
		throw new DiscoveryError("INVALID_RESPONSE");
	return models;
}

function validateCompletion(value: unknown, protocol: GigaChatProtocol): void {
	if (protocol === "v2") {
		validateV2Completion(value);
		return;
	}
	const choice =
		object(value) && Array.isArray(value.choices)
			? value.choices[0]
			: undefined;
	const message = object(choice) ? choice.message : undefined;
	if (
		!object(choice) ||
		!object(message) ||
		message.role !== "assistant" ||
		(message.content !== null &&
			typeof message.content !== "string" &&
			!(protocol === "openai" && message.content === undefined)) ||
		(message.reasoning_content != null &&
			typeof message.reasoning_content !== "string") ||
		(protocol === "openai" &&
			message.reasoning != null &&
			typeof message.reasoning !== "string")
	)
		throw new DiscoveryError("INVALID_RESPONSE");
	if (protocol === "openai") {
		const calls = message.tool_calls;
		if (
			(calls !== undefined &&
				(!Array.isArray(calls) ||
					!calls.every(
						(call) =>
							object(call) &&
							typeof call.id === "string" &&
							call.id.length > 0 &&
							call.type === "function" &&
							object(call.function) &&
							typeof call.function.name === "string" &&
							call.function.name.length > 0 &&
							typeof call.function.arguments === "string",
					))) ||
			(message.content === undefined && !Array.isArray(calls))
		)
			throw new DiscoveryError("INVALID_RESPONSE");
		if (
			choice.finish_reason === "stop" ||
			choice.finish_reason === "length" ||
			choice.finish_reason === "content_filter" ||
			(choice.finish_reason === "tool_calls" &&
				Array.isArray(calls) &&
				calls.length > 0)
		)
			return;
		throw new DiscoveryError("INVALID_RESPONSE");
	}
	if (choice.finish_reason === "stop" || choice.finish_reason === "length")
		return;
	if (
		choice.finish_reason === "function_call" &&
		object(message.function_call) &&
		typeof message.function_call.name === "string" &&
		message.function_call.name.length > 0 &&
		(typeof message.function_call.arguments === "string" ||
			object(message.function_call.arguments))
	)
		return;
	throw new DiscoveryError("INVALID_RESPONSE");
}

function validateV2Completion(value: unknown): void {
	if (
		!object(value) ||
		!Array.isArray(value.messages) ||
		value.messages.length === 0
	)
		throw new DiscoveryError("INVALID_RESPONSE");
	let assistant = false;
	let calls = 0;
	for (const message of value.messages) {
		if (
			!object(message) ||
			!["assistant", "reasoning"].includes(String(message.role)) ||
			!Array.isArray(message.content)
		)
			throw new DiscoveryError("INVALID_RESPONSE");
		assistant ||= message.role === "assistant";
		for (const part of message.content) {
			if (!object(part)) throw new DiscoveryError("INVALID_RESPONSE");
			if (typeof part.text === "string") continue;
			const call = part.function_call;
			if (
				message.role !== "assistant" ||
				!object(call) ||
				typeof call.name !== "string" ||
				call.name.length === 0 ||
				!(typeof call.arguments === "string" || object(call.arguments))
			)
				throw new DiscoveryError("INVALID_RESPONSE");
			calls++;
		}
	}
	if (
		!assistant ||
		!(
			value.finish_reason === "stop" ||
			value.finish_reason === "length" ||
			(value.finish_reason === "function_call" && calls > 0)
		)
	)
		throw new DiscoveryError("INVALID_RESPONSE");
}

async function readProbeStream(
	response: Response,
	protocol: GigaChatProtocol,
): Promise<void> {
	const invalid = () => new DiscoveryError("INVALID_RESPONSE");
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw invalid();
	let assistant = false;
	let finish: unknown;
	const toolFinish = protocol === "openai" ? "tool_calls" : "function_call";
	const setFinish = (value: unknown) => {
		if (value == null || value === "") return;
		if (
			value !== "stop" &&
			value !== "length" &&
			value !== toolFinish &&
			!(protocol === "openai" && value === "content_filter")
		)
			throw invalid();
		finish = value;
	};
	let done = false;
	// Probes validate fragments without retaining generated text or arguments.
	const calls = new Map<
		string | number,
		{ name: boolean; arguments: boolean; id: boolean; type: boolean }
	>();
	const addCall = (
		key: string | number,
		value: unknown,
		id?: unknown,
		type?: unknown,
	) => {
		if (!object(value)) throw invalid();
		const call = calls.get(key) ?? {
			name: false,
			arguments: false,
			id: false,
			type: false,
		};
		if (value.name !== undefined) {
			if (typeof value.name !== "string") throw invalid();
			call.name ||= value.name.length > 0;
		}
		if (value.arguments !== undefined) {
			if (
				typeof value.arguments !== "string" &&
				!(protocol !== "openai" && object(value.arguments))
			)
				throw invalid();
			call.arguments = true;
		}
		if (id !== undefined) {
			if (typeof id !== "string" || !id) throw invalid();
			call.id = true;
		}
		if (type !== undefined) {
			if (type !== "function") throw invalid();
			call.type = true;
		}
		calls.set(key, call);
	};
	const consume = (data: string, event: string) => {
		if (done) return;
		if (event === "error") throw invalid();
		if (protocol !== "v2" && data === "[DONE]") {
			done = true;
			return;
		}
		const chunk: unknown = JSON.parse(data);
		if (!object(chunk) || chunk.error !== undefined) throw invalid();
		if (protocol === "v2") {
			if (
				event !== "response.message.delta" &&
				event !== "response.message.done"
			)
				throw invalid();
			if (chunk.messages !== undefined && !Array.isArray(chunk.messages))
				throw invalid();
			if (!Array.isArray(chunk.messages) && event !== "response.message.done")
				throw invalid();
			for (const message of Array.isArray(chunk.messages)
				? chunk.messages
				: []) {
				if (
					!object(message) ||
					(message.role !== "assistant" && message.role !== "reasoning") ||
					(!Array.isArray(message.content) &&
						!(
							message.content === undefined &&
							message.role === "assistant" &&
							typeof message.tool_state_id === "string" &&
							message.tool_state_id.length > 0
						))
				)
					throw invalid();
				assistant ||=
					message.role === "assistant" && Array.isArray(message.content);
				for (const part of Array.isArray(message.content)
					? message.content
					: []) {
					if (!object(part)) throw invalid();
					if (part.text !== undefined && typeof part.text !== "string")
						throw invalid();
					if (part.function_call !== undefined) {
						if (
							message.role !== "assistant" ||
							!object(part.function_call) ||
							typeof part.function_call.id !== "string" ||
							!part.function_call.id
						)
							throw invalid();
						addCall(part.function_call.id, part.function_call);
					} else if (typeof part.text !== "string") throw invalid();
				}
			}
			setFinish(chunk.finish_reason);
			done = event === "response.message.done";
			return;
		}
		if (!Array.isArray(chunk.choices)) throw invalid();
		if (chunk.choices.length === 0 && object(chunk.usage)) return;
		const choice = chunk.choices[0];
		if (!object(choice) || !object(choice.delta)) throw invalid();
		const delta = choice.delta;
		if (delta.role !== undefined && delta.role !== "assistant") throw invalid();
		if (
			(delta.content != null && typeof delta.content !== "string") ||
			(delta.reasoning_content != null &&
				typeof delta.reasoning_content !== "string") ||
			(delta.reasoning != null && typeof delta.reasoning !== "string")
		)
			throw invalid();
		assistant ||=
			delta.role === "assistant" ||
			delta.content !== undefined ||
			delta.reasoning_content !== undefined ||
			(protocol === "openai" && delta.reasoning !== undefined);
		if (protocol === "openai" && delta.tool_calls !== undefined) {
			if (!Array.isArray(delta.tool_calls)) throw invalid();
			for (const call of delta.tool_calls) {
				if (
					!object(call) ||
					typeof call.index !== "number" ||
					!Number.isSafeInteger(call.index) ||
					call.index < 0
				)
					throw invalid();
				addCall(call.index, call.function ?? {}, call.id, call.type);
				assistant = true;
			}
		}
		if (protocol === "v1" && delta.function_call !== undefined) {
			addCall(0, delta.function_call);
			assistant = true;
		}
		setFinish(choice.finish_reason);
	};
	const parser = createParser({
		onEvent: (event) => consume(event.data, event.event ?? ""),
		onError: () => {
			throw invalid();
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
		if (!done) parser.feed(decoder.decode());
		for (const call of calls.values()) {
			if (
				!call.name ||
				!call.arguments ||
				(protocol === "openai" && (!call.id || !call.type))
			)
				throw invalid();
		}
		if (
			!done ||
			!assistant ||
			finish === undefined ||
			(finish === toolFinish && calls.size === 0)
		)
			throw invalid();
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

interface ProbeConnection {
	root: string;
	protocol: GigaChatProtocol;
	stream: boolean;
	headers: Headers;
	transport: Pick<DiscoveryOptions, "signal" | "mtls"> & { maxRetries: number };
}

function probeConnection(
	baseUrl: string,
	apiKey: string,
	options: Pick<DiscoveryOptions, "signal" | "protocol" | "mtls" | "stream">,
): ProbeConnection {
	options.signal.throwIfAborted();
	const protocol = options.protocol === undefined ? "v1" : options.protocol;
	if (protocol !== "v1" && protocol !== "v2" && protocol !== "openai")
		throw new DiscoveryError("INVALID_PROTOCOL");
	let root: string;
	try {
		root = normalizeBaseUrl(baseUrl);
	} catch {
		throw new DiscoveryError("INVALID_URL");
	}
	if (options.mtls && new URL(root).protocol !== "https:")
		throw new GigaChatMtlsError(
			"GigaChat certificate authorization requires HTTPS for generation and the model catalog.",
		);
	const headers = new Headers({ "Content-Type": "application/json" });
	if (!options.mtls) headers.set("Authorization", `Bearer ${apiKey}`);
	const transport = {
		signal: options.signal,
		maxRetries: 0,
		mtls: options.mtls,
	};
	return {
		root,
		protocol,
		stream: options.stream ?? false,
		headers,
		transport,
	};
}

async function probeModel(
	connection: ProbeConnection,
	model: ConnectionModel,
	timeouts: readonly number[],
): Promise<ModelProbe> {
	const { root, protocol, stream, headers, transport } = connection;
	const signal = transport.signal;
	signal.throwIfAborted();
	const init = {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: model.id,
			messages: [
				{
					role: "user",
					content: protocol === "v2" ? [{ text: "Hi" }] : "Hi",
				},
			],
			...(protocol === "v2"
				? { model_options: { max_tokens: 1 } }
				: { max_tokens: 1 }),
			stream,
		}),
	};
	const consumeProbe = async (response: Response) =>
		stream
			? readProbeStream(response, protocol)
			: validateCompletion(await readJson(response), protocol);
	let probe: ModelProbe;
	for (let attempt = 0; ; attempt++) {
		try {
			await request(
				`${root}/chat/completions`,
				init,
				{ ...transport, timeoutMs: timeouts[attempt] },
				consumeProbe,
			);
			probe = { model, status: "available" };
			break;
		} catch (error) {
			signal.throwIfAborted();
			if (attempt === timeouts.length - 1) {
				probe = {
					model,
					status: "unavailable",
					reason: `GigaChat model unavailable${timeouts.length > 1 ? ` after ${timeouts.length} attempts` : ""}. ${describeDiscoveryError(error)}`,
				};
				break;
			}
		}
	}
	signal.throwIfAborted();
	return probe;
}

/** One explicit paid probe, including response consumption in its ten-minute deadline. */
export async function retryModel(
	baseUrl: string,
	apiKey: string,
	model: ConnectionModel,
	options: Pick<DiscoveryOptions, "signal" | "protocol" | "mtls" | "stream">,
): Promise<ModelProbe> {
	return probeModel(probeConnection(baseUrl, apiKey, options), model, [600000]);
}

/** Enumerate the catalog, then check each exact ID with up to five paid probes. */
export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	options: DiscoveryOptions,
): Promise<ModelProbe[]> {
	const connection = probeConnection(baseUrl, apiKey, options);
	const { root, protocol, headers, transport } = connection;
	let modelsUrl: string;
	try {
		modelsUrl =
			options.modelsUrl === undefined
				? defaultModelsUrl(root, protocol)
				: options.modelsUrl;
		if (!["http:", "https:"].includes(new URL(modelsUrl).protocol))
			throw new DiscoveryError("INVALID_URL");
	} catch {
		throw new DiscoveryError("INVALID_URL");
	}
	// Reject both URLs before making even the first request with a client certificate.
	if (options.mtls && new URL(modelsUrl).protocol !== "https:")
		throw new GigaChatMtlsError(
			"GigaChat certificate authorization requires HTTPS for generation and the model catalog.",
		);
	const models = await request(
		modelsUrl,
		{ method: "GET", headers },
		transport,
		async (response) => catalog(await readJson(response), protocol),
	);
	options.signal.throwIfAborted();
	const timeouts = [1000, 3000, 9000, 27000, 60000];
	let completed = 0;
	options.progress?.(0, models.length);
	const probes: ModelProbe[] = [];
	let next = 0;
	// Scan probes intentionally bypass the ordinary single-generation queue.
	await Promise.all(
		Array.from({ length: Math.min(5, models.length) }, async () => {
			while (next < models.length) {
				options.signal.throwIfAborted();
				const index = next++;
				const probe = await probeModel(connection, models[index], timeouts);
				probes[index] = probe;
				options.signal.throwIfAborted();
				options.progress?.(++completed, models.length, probe);
			}
		}),
	);
	options.signal.throwIfAborted();
	return probes;
}

/** Display only trusted diagnostics: never echo server bodies or parser input. */
export function describeDiscoveryError(error: unknown): string {
	if (error instanceof DiscoveryError) return error.message;
	if (error instanceof GigaChatMtlsError) return error.message;
	if (error instanceof GigaChatHttpError) {
		const status = error.status;
		const detail =
			status === 401
				? "access token rejected"
				: status === 403
					? "access denied"
					: status === 404
						? "endpoint or model not found"
						: status === 429
							? "rate limited"
							: status === 408
								? "request timed out"
								: status >= 500
									? "server temporarily unavailable"
									: "request rejected";
		return `GigaChat HTTP ${status}: ${detail}.`;
	}
	const code = object(error) ? error.code : undefined;
	if (code === "GIGACHAT_STALE_CONNECTION")
		return "This GigaChat connection changed or was removed. Reopen /gigachat or restart pi.";
	if (code === "GIGACHAT_STORAGE_ERROR")
		return "Cannot read or save GigaChat connections in auth.json. Check file access and retry.";
	if (code === "GIGACHAT_ID_CONFLICT")
		return "Идентификатор провайдера уже занят. Выберите другое название подключения.";
	if (code === "GIGACHAT_AUTH_ERROR")
		return "GigaChat authorization failed. Check this connection's credentials.";
	if (error instanceof SyntaxError)
		return "GigaChat returned an invalid response.";
	if (error instanceof Error && error.name === "AbortError")
		return "GigaChat discovery cancelled.";
	if (error instanceof Error && error.name === "TimeoutError")
		return "GigaChat request timed out.";
	if (
		error instanceof TypeError ||
		(typeof code === "string" && /^(?:E|UND_ERR_)/.test(code)) ||
		(error instanceof Error && error.cause !== undefined)
	)
		return "Cannot reach the GigaChat server. Check the network, URL and proxy settings.";
	return "GigaChat discovery failed. Check the connection settings and try again.";
}
