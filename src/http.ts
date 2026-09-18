import type {
	ProviderEnv,
	ProviderHeaders,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { EnvHttpProxyAgent, fetch } from "undici";

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function environment(options?: {
	env?: ProviderEnv;
}): NodeJS.ProcessEnv {
	return { ...process.env, ...options?.env };
}

export function headers(...sources: (ProviderHeaders | undefined)[]): Headers {
	const result = new Headers();
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) result.delete(name);
			else result.set(name, value);
		}
	}
	return result;
}

// GigaChat personal accounts allow one active generation. This also covers the
// two summaries that pi can request concurrently when compacting a split turn.
let queue = Promise.resolve();
export function serial<T>(
	signal: AbortSignal,
	work: () => Promise<T>,
): Promise<T> {
	const pending = queue.then(() => {
		signal.throwIfAborted();
		return work();
	});
	queue = pending.then(
		() => {},
		() => {},
	);
	return raceWithAbortSignal(pending, signal);
}

export class GigaChatHttpError extends Error {
	constructor(
		readonly status: number,
		body: string,
		readonly headers?: Headers,
	) {
		super(
			`GigaChat HTTP ${status}${status === 413 ? " context_length_exceeded" : ""}: ${body}`,
		);
	}
}

const MAX_RETRY_DELAY_MS = 600000;
const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function transient(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof GigaChatHttpError) {
		if (
			/insufficient_quota|quota (?:exceeded|exhausted)|billing/i.test(
				error.message,
			)
		)
			return false;
		return (
			error.status === 408 ||
			error.status === 429 ||
			(error.status >= 500 && error.status < 600)
		);
	}
	if (error.name === "TimeoutError") return true;
	if ("code" in error && NETWORK_CODES.has(String(error.code))) return true;
	if (error.cause !== undefined) return transient(error.cause);
	return error instanceof TypeError && error.message === "fetch failed";
}

function retryFailure(error: unknown, reason: string): Error {
	// Pi 0.85 classifies errors by text. "out of budget" makes exhaustion
	// terminal, so its outer retry loop cannot multiply this request's budget.
	return new Error(
		`GigaChat out of budget for automatic retries: ${reason}. Last error: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}

function serverDelay(error: unknown): number {
	if (!(error instanceof GigaChatHttpError)) return 0;
	const milliseconds = error.headers?.get("retry-after-ms");
	const value = error.headers?.get("retry-after");
	const delay = milliseconds
		? Number(milliseconds)
		: value
			? /^\d+(?:\.\d+)?$/.test(value.trim())
				? Number(value) * 1000
				: Date.parse(value) - Date.now()
			: 0;
	return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

// Use one transport for OAuth, JSON and SSE, including provider-scoped proxies.
export async function request<T>(
	url: string,
	init: RequestInit,
	options: Pick<
		StreamOptions,
		"signal" | "timeoutMs" | "env" | "fetch" | "maxRetries"
	> & {
		canRetry?: () => boolean;
	},
	consume: (response: Response) => Promise<T>,
	observe?: (response: Response) => void | Promise<void>,
): Promise<T> {
	const env = environment(options);
	const timeout =
		options.timeoutMs ?? Number(env.GIGACHAT_TIMEOUT ?? 300) * 1000;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("GigaChat timeout must be positive");
	const maxRetries =
		options.maxRetries ?? Number(env.GIGACHAT_MAX_RETRIES ?? 10);
	const baseDelay = Number(env.GIGACHAT_RETRY_BASE_DELAY_MS ?? 1000);
	if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
		throw new Error("GigaChat maxRetries must be a non-negative safe integer");
	if (
		!Number.isSafeInteger(baseDelay) ||
		baseDelay < 0 ||
		baseDelay > MAX_RETRY_DELAY_MS
	)
		throw new Error(
			"GIGACHAT_RETRY_BASE_DELAY_MS must be an integer from 0 to 600000",
		);
	const signal = options.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const proxy = (name: string) =>
		options.env?.[name.toLowerCase()] ??
		options.env?.[name] ??
		env[name.toLowerCase()] ??
		env[name] ??
		"";
	const dispatcher = new EnvHttpProxyAgent({
		httpProxy: proxy("HTTP_PROXY"),
		httpsProxy: proxy("HTTPS_PROXY"),
		noProxy: proxy("NO_PROXY"),
	});
	try {
		const send = options.fetch ?? (fetch as unknown as typeof globalThis.fetch);
		for (let retries = 0; ; retries++) {
			signal.throwIfAborted();
			const attemptSignal = AbortSignal.any([
				signal,
				AbortSignal.timeout(Math.ceil(timeout)),
			]);
			let response: Response | undefined;
			let observing = false;
			let delay = 0;
			try {
				response = await send(url, {
					...init,
					signal: attemptSignal,
					dispatcher,
				} as RequestInit);
				observing = true;
				await observe?.(response);
				observing = false;
				if (!response.ok)
					throw new GigaChatHttpError(
						response.status,
						await response.text(),
						response.headers,
					);
				return await consume(response);
			} catch (caught) {
				if (signal.aborted) throw signal.reason;
				const error = attemptSignal.aborted ? attemptSignal.reason : caught;
				if (
					maxRetries === 0 ||
					observing ||
					options.canRetry?.() === false ||
					!transient(error)
				) {
					if (
						error instanceof Error &&
						error.message === "fetch failed" &&
						error.cause instanceof Error
					)
						throw new Error(
							`GigaChat connection failed: ${error.cause.message}`,
							{ cause: error },
						);
					throw error;
				}
				if (retries >= maxRetries)
					throw retryFailure(error, `${retries} retries exhausted`);
				delay = Math.max(
					Math.min(baseDelay * 2 ** Math.min(retries, 30), MAX_RETRY_DELAY_MS),
					serverDelay(error),
				);
				if (delay > MAX_RETRY_DELAY_MS)
					throw retryFailure(
						error,
						"server requested a wait longer than 600 seconds",
					);
			} finally {
				// Release each attempt's body before waiting or reusing the connection.
				if (response?.body && !response.body.locked)
					await response.body.cancel().catch(() => {});
			}
			await wait(delay, signal);
		}
	} finally {
		await dispatcher.close();
	}
}
