import { stripVTControlCharacters } from "node:util";
import { baseUrl as normalizeBaseUrl } from "./auth.js";
import type {
	ConnectionModel,
	DiscoveryOptions,
	GigaChatProtocol,
	ModelProbe,
} from "./connection-types.js";
import { GigaChatHttpError, object, request, serial } from "./http.js";
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

/** Enumerate the catalog, then check each exact ID with up to three paid probes. */
export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	options: DiscoveryOptions,
): Promise<ModelProbe[]> {
	options.signal.throwIfAborted();
	const protocol = options.protocol === undefined ? "v1" : options.protocol;
	if (protocol !== "v1" && protocol !== "v2" && protocol !== "openai")
		throw new DiscoveryError("INVALID_PROTOCOL");
	let root: string;
	let modelsUrl: string;
	try {
		root = normalizeBaseUrl(baseUrl);
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
	if (
		options.mtls &&
		(new URL(root).protocol !== "https:" ||
			new URL(modelsUrl).protocol !== "https:")
	)
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
	const models = await request(
		modelsUrl,
		{ method: "GET", headers },
		transport,
		async (response) => catalog(await readJson(response), protocol),
	);
	options.signal.throwIfAborted();
	const probeTransport = { ...transport, timeoutMs: 5000 };
	const consumeProbe = async (response: Response) =>
		validateCompletion(await readJson(response), protocol);
	let completed = 0;
	options.progress?.(0, models.length);
	const probeModel = async (model: ConnectionModel): Promise<ModelProbe> => {
		options.signal.throwIfAborted();
		const work = async (): Promise<ModelProbe> => {
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
					stream: false,
				}),
			};
			for (let attempt = 1; ; attempt++) {
				try {
					await request(
						`${root}/chat/completions`,
						init,
						probeTransport,
						consumeProbe,
					);
					return { model, status: "available" };
				} catch (error) {
					options.signal.throwIfAborted();
					if (attempt === 3)
						return {
							model,
							status: "unavailable",
							reason: `GigaChat model unavailable after 3 attempts. ${describeDiscoveryError(error)}`,
						};
				}
			}
		};
		const probe = await (protocol === "openai"
			? work()
			: serial(options.signal, work));
		options.signal.throwIfAborted();
		options.progress?.(++completed, models.length, probe);
		return probe;
	};
	const probes: ModelProbe[] = [];
	if (protocol === "openai")
		probes.push(...(await Promise.all(models.map(probeModel))));
	else for (const model of models) probes.push(await probeModel(model));
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
