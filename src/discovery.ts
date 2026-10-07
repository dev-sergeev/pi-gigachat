import { stripVTControlCharacters } from "node:util";
import { baseUrl as normalizeBaseUrl } from "./auth.js";
import type {
	ConnectionModel,
	DiscoveryOptions,
	ModelProbe,
} from "./connection-types.js";
import { GigaChatHttpError, object, request, serial } from "./http.js";
import { GIGACHAT_CONNECTION_DEFAULTS } from "./models.js";

class DiscoveryError extends Error {
	constructor(readonly code: "INVALID_URL" | "INVALID_RESPONSE") {
		super(
			code === "INVALID_URL"
				? "GigaChat server URL must use http(s)."
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

function catalog(value: unknown): ConnectionModel[] {
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
		const reasoning =
			typeof item.reasoning === "boolean"
				? item.reasoning
				: GIGACHAT_CONNECTION_DEFAULTS.reasoning;
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
						thinkingLevelMap: {
							...GIGACHAT_CONNECTION_DEFAULTS.thinkingLevelMap,
						},
					}
				: {}),
		});
	}
	if (value.data.length > 0 && models.length === 0)
		throw new DiscoveryError("INVALID_RESPONSE");
	return models;
}

function validateCompletion(value: unknown): void {
	const choice =
		object(value) && Array.isArray(value.choices)
			? value.choices[0]
			: undefined;
	const message = object(choice) ? choice.message : undefined;
	if (
		!object(choice) ||
		!object(message) ||
		message.role !== "assistant" ||
		(message.content !== null && typeof message.content !== "string") ||
		(message.reasoning_content != null &&
			typeof message.reasoning_content !== "string")
	)
		throw new DiscoveryError("INVALID_RESPONSE");
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

/** Enumerate the server catalog, then make exactly one paid probe per exact ID. */
export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	options: DiscoveryOptions,
): Promise<ModelProbe[]> {
	options.signal.throwIfAborted();
	let root: string;
	try {
		root = normalizeBaseUrl(baseUrl);
	} catch {
		throw new DiscoveryError("INVALID_URL");
	}
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
	const transport = { signal: options.signal, maxRetries: 0 };
	const models = await request(
		`${root}/models`,
		{ method: "GET", headers },
		transport,
		async (response) => catalog(await readJson(response)),
	);
	options.signal.throwIfAborted();
	const probes: ModelProbe[] = [];
	options.progress?.(0, models.length);
	for (const model of models) {
		options.signal.throwIfAborted();
		let probe: ModelProbe;
		try {
			await serial(options.signal, () =>
				request(
					`${root}/chat/completions`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							model: model.id,
							messages: [{ role: "user", content: "Hi" }],
							max_tokens: 1,
							stream: false,
						}),
					},
					transport,
					async (response) => validateCompletion(await readJson(response)),
				),
			);
			probe = { model, status: "available" };
		} catch (error) {
			options.signal.throwIfAborted();
			const denied =
				error instanceof GigaChatHttpError &&
				[400, 401, 402, 403, 404, 422].includes(error.status);
			probe = {
				model,
				status: denied ? "unavailable" : "unverified",
				reason: describeDiscoveryError(error),
			};
		}
		options.signal.throwIfAborted();
		probes.push(probe);
		options.progress?.(probes.length, models.length, probe);
	}
	options.signal.throwIfAborted();
	return probes;
}

/** Display only trusted diagnostics: never echo server bodies or parser input. */
export function describeDiscoveryError(error: unknown): string {
	if (error instanceof DiscoveryError) return error.message;
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
							? "rate limited; availability is not verified"
							: status === 408
								? "request timed out; availability is not verified"
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
	if (code === "GIGACHAT_AUTH_ERROR")
		return "GigaChat authorization failed. Check this connection's credentials.";
	if (error instanceof SyntaxError)
		return "GigaChat returned an invalid response.";
	if (error instanceof Error && error.name === "AbortError")
		return "GigaChat discovery cancelled.";
	if (error instanceof Error && error.name === "TimeoutError")
		return "GigaChat request timed out; availability is not verified.";
	if (
		error instanceof TypeError ||
		(typeof code === "string" && /^(?:E|UND_ERR_)/.test(code)) ||
		(error instanceof Error && error.cause !== undefined)
	)
		return "Cannot reach the GigaChat server. Check the network, URL and proxy settings.";
	return "GigaChat discovery failed. Check the connection settings and try again.";
}
