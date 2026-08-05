import { Readable } from "node:stream";
import type { InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, getErrorMessage, resolveAuth } from "../src/stream.js";
import {
	clearGigaChatEnv,
	makeModel,
	restoreTestEnv,
	snapshotTestEnv,
} from "./helpers.js";

const originalEnv = snapshotTestEnv();

beforeEach(() => {
	clearGigaChatEnv();
	process.env.GIGACHAT_VERIFY_SSL_CERTS = "true";
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreTestEnv(originalEnv);
});

async function consumeStream(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _chunk of stream) {
		// Exhaust the generator so auth retry behavior is observable.
	}
}

function requestPayload(
	config: InternalAxiosRequestConfig,
): Record<string, unknown> {
	if (typeof config.data === "string") {
		return JSON.parse(config.data) as Record<string, unknown>;
	}
	return config.data as Record<string, unknown>;
}

describe("access-token transport regression", () => {
	it("sends an opaque token directly to the API and never falls back to OAuth after 401", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
		process.env.GIGACHAT_CREDENTIALS = "old-stale-credentials";
		process.env.GIGACHAT_BASE_URL = "https://api.giga.chat/v1";
		const auth = resolveAuth({ apiKey: "saved.stale.access" });
		const client = createClient(makeModel(), auth);
		const updateToken = vi
			.spyOn(client, "updateTokenQuietly")
			.mockRejectedValue(new Error("OAuth exchange must not run"));
		const authRequest = vi.fn();
		client._authClient.defaults.adapter = async (config) => {
			authRequest(config);
			throw new Error("ngw.devices.sberbank.ru must not be used");
		};
		let captured: InternalAxiosRequestConfig | undefined;
		client._client.defaults.adapter = async (config) => {
			captured = config;
			return {
				data: { message: "unauthorized" },
				status: 401,
				statusText: "Unauthorized",
				headers: {},
				config,
			};
		};

		await expect(
			consumeStream(
				client.streamRobust({
					model: "GigaChat",
					messages: [{ role: "user", content: "test" }],
					stream: true,
				}),
			),
		).rejects.toThrow("GigaChat authentication failed");

		expect(auth).toEqual({
			kind: "accessToken",
			accessToken: "opaque-access-token-without-dots",
		});
		expect(client._settings.credentials).toBeUndefined();
		expect(client._settings.user).toBeUndefined();
		expect(client._settings.password).toBeUndefined();
		expect(client._settings.authUrl).toBeUndefined();
		expect(updateToken).not.toHaveBeenCalled();
		expect(authRequest).not.toHaveBeenCalled();
		expect(captured).toBeDefined();
		if (!captured) throw new Error("Expected a captured API request");
		expect(client._client.getUri(captured)).toBe(
			"https://api.giga.chat/v1/chat/completions",
		);
		expect(client._client.getUri(captured)).not.toContain(
			"ngw.devices.sberbank.ru",
		);
		expect(captured.headers.get("Authorization")).toBe(
			"Bearer opaque-access-token-without-dots",
		);
		expect(requestPayload(captured).model).toBe("GigaChat");
	});

	it("uses the same scoped HTTPS Agent for regular and streaming requests", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
		const client = createClient(makeModel(), resolveAuth());
		const scopedAgent = client._settings.httpsAgent;
		const captured: InternalAxiosRequestConfig[] = [];
		client._client.defaults.adapter = async (config) => {
			captured.push(config);
			return config.responseType === "stream"
				? {
						data: Readable.from([
							'data: {"choices":[]}\n\n',
							"data: [DONE]\n\n",
						]),
						status: 200,
						statusText: "OK",
						headers: { "content-type": "text/event-stream" },
						config,
					}
				: {
						data: { choices: [] },
						status: 200,
						statusText: "OK",
						headers: { "content-type": "application/json" },
						config,
					};
		};

		await client.chat({
			model: "GigaChat",
			messages: [{ role: "user", content: "test" }],
		});
		await consumeStream(
			client.streamRobust({
				model: "GigaChat",
				messages: [{ role: "user", content: "test" }],
				stream: true,
			}),
		);

		expect(client._client.defaults.httpsAgent).toBe(scopedAgent);
		expect(client._authClient.defaults.httpsAgent).toBe(scopedAgent);
		expect(captured).toHaveLength(2);
		expect(captured.every((config) => config.httpsAgent === scopedAgent)).toBe(
			true,
		);
	});

	it("redacts access tokens from user-facing error text", async () => {
		const token = "opaque-access-token-without-dots";
		const message = await getErrorMessage(
			new Error(`request failed with Bearer ${token}`),
			[token],
		);

		expect(message).toBe("request failed with Bearer [REDACTED]");
		expect(message).not.toContain(token);
	});
});
