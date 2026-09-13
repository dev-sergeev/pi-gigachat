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
	) {
		super(
			`GigaChat HTTP ${status}${status === 413 ? " context_length_exceeded" : ""}: ${body}`,
		);
	}
}

// Use one transport for OAuth, JSON and SSE, including provider-scoped proxies.
export async function request<T>(
	url: string,
	init: RequestInit,
	options: Pick<StreamOptions, "signal" | "timeoutMs" | "env" | "fetch">,
	consume: (response: Response) => Promise<T>,
	observe?: (response: Response) => void | Promise<void>,
): Promise<T> {
	const env = environment(options);
	const timeout =
		options.timeoutMs ?? Number(env.GIGACHAT_TIMEOUT ?? 300) * 1000;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("GigaChat timeout must be positive");
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(Math.ceil(timeout)),
	]);
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
	let response: Response | undefined;
	try {
		const send = options.fetch ?? (fetch as unknown as typeof globalThis.fetch);
		response = await send(url, { ...init, signal, dispatcher } as RequestInit);
		await observe?.(response);
		if (!response.ok)
			throw new GigaChatHttpError(response.status, await response.text());
		return await consume(response);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (
			error instanceof Error &&
			error.message === "fetch failed" &&
			error.cause instanceof Error
		)
			throw new Error(`GigaChat connection failed: ${error.cause.message}`, {
				cause: error,
			});
		throw error;
	} finally {
		// Cancel unread/error bodies before releasing connections, including SSE aborts.
		if (response?.body && !response.body.locked)
			await response.body.cancel().catch(() => {});
		await dispatcher.close();
	}
}
