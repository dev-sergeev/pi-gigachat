import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	InMemoryCredentialStore,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { PiGigaChatClient } from "../src/shared.js";
import {
	clearGigaChatEnv,
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

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function createRuntime(
	credentials = new InMemoryCredentialStore(),
	flags: Readonly<Record<string, string | boolean | undefined>> = {},
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
	});
	extension({
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerProvider: (
			name: string,
			config: Parameters<ModelRuntime["registerProvider"]>[1],
		) => runtime.registerProvider(name, config),
	} as unknown as ExtensionAPI);
	return runtime;
}

describe("Pi runtime integration", () => {
	it("applies Pi timeoutMs to the SDK transport without adding timeout to the API payload", async () => {
		let payload: Record<string, unknown> | undefined;
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			payload = JSON.parse(body) as Record<string, unknown>;

			await new Promise((resolve) => setTimeout(resolve, 150));
			if (!response.destroyed) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						'data: {"choices":[{"delta":{"content":"OK"},"index":0,"finish_reason":null}],"created":0,"model":"GigaChat","object":"chat.completion.chunk"}',
						'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"created":0,"model":"GigaChat","object":"chat.completion.chunk"}',
						"data: [DONE]",
						"",
					].join("\n\n"),
				);
			}
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
			const runtime = await createRuntime();
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			const result = await runtime.completeSimple(
				model,
				{
					messages: [
						{ role: "user", content: "Return OK", timestamp: Date.now() },
					],
				},
				{ timeoutMs: 25 },
			);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/timeout of 25ms exceeded/i);
			expect(payload).toBeDefined();
			expect(payload).not.toHaveProperty("timeout");
		} finally {
			await close(server);
		}
	});

	it("rejects invalid generation flags before sending a request", async () => {
		const token = "opaque-access-token-without-dots";
		let requestCount = 0;
		const streamRequest = vi.spyOn(PiGigaChatClient.prototype, "streamRobust");
		const oauthExchange = vi.spyOn(
			PiGigaChatClient.prototype,
			"updateTokenQuietly",
		);
		const server = createServer((_request, response) => {
			requestCount += 1;
			response.writeHead(500).end();
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = token;
			const runtime = await createRuntime(new InMemoryCredentialStore(), {
				"gigachat-temperature": "not-a-number",
			});
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			const result = await runtime.completeSimple(model, {
				messages: [
					{ role: "user", content: "Return OK", timestamp: Date.now() },
				],
			});

			expect(requestCount).toBe(0);
			expect(streamRequest).not.toHaveBeenCalled();
			expect(oauthExchange).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("--gigachat-temperature"),
			});
			expect(result.errorMessage).not.toContain(token);
		} finally {
			await close(server);
		}
	});

	it("forwards extension CLI generation flags through the SDK", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			payloads.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					'data: {"choices":[{"delta":{"content":"OK"},"index":0,"finish_reason":null}],"created":0,"model":"GigaChat","object":"chat.completion.chunk"}',
					'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"created":0,"model":"GigaChat","object":"chat.completion.chunk"}',
					"data: [DONE]",
					"",
				].join("\n\n"),
			);
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
			const runtime = await createRuntime(new InMemoryCredentialStore(), {
				"gigachat-temperature": "0.2",
				"gigachat-max-tokens": "4096",
				"gigachat-repetition-penalty": "1.1",
				"gigachat-update-interval": "0.25",
			});
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			await runtime.completeSimple(
				model,
				{
					messages: [
						{ role: "user", content: "Return OK", timestamp: Date.now() },
					],
				},
				{
					samplingParams: { response_format: { type: "text" } },
				} as Parameters<ModelRuntime["completeSimple"]>[2],
			);

			expect(payloads).toEqual([
				expect.objectContaining({
					temperature: 0.2,
					max_tokens: 4096,
					repetition_penalty: 1.1,
					update_interval: 0.25,
					response_format: { type: "text" },
				}),
			]);
		} finally {
			await close(server);
		}
	});

	it("forwards the GLM model id and model generation defaults", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			payloads.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					'data: {"choices":[{"delta":{"content":"OK"},"index":0,"finish_reason":null}],"created":0,"model":"glm-5.1","object":"chat.completion.chunk"}',
					'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"created":0,"model":"glm-5.1","object":"chat.completion.chunk"}',
					"data: [DONE]",
					"",
				].join("\n\n"),
			);
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
			const runtime = await createRuntime();
			const model = runtime.getModel("gigachat", "glm-5.1");
			if (!model) throw new Error("glm-5.1 model was not registered");

			await runtime.completeSimple(model, {
				messages: [
					{ role: "user", content: "Return OK", timestamp: Date.now() },
				],
			});

			expect(payloads).toEqual([
				expect.objectContaining({
					model: "glm-5.1",
					max_tokens: 131071,
					temperature: 0.2,
					stream: true,
				}),
			]);
		} finally {
			await close(server);
		}
	});

	it("streams through Pi and the SDK with the exact access token, URL, and selected model", async () => {
		const requests: Array<{
			method: string | undefined;
			url: string | undefined;
			authorization: string | undefined;
			payload: Record<string, unknown>;
		}> = [];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			requests.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
				payload: JSON.parse(body) as Record<string, unknown>,
			});

			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					'data: {"choices":[{"delta":{"content":"OK"},"index":0,"finish_reason":null}],"created":0,"model":"GigaChat","object":"chat.completion.chunk"}',
					'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"created":0,"model":"GigaChat","object":"chat.completion.chunk","usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
					"data: [DONE]",
					"",
				].join("\n\n"),
			);
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN =
				"Bearer opaque-access-token-without-dots";
			process.env.GIGACHAT_CREDENTIALS = "old-stale-credentials";
			process.env.GIGACHAT_MODEL = "must-not-override-pi-selection";

			const credentials = new InMemoryCredentialStore();
			const stored: OAuthCredential = {
				type: "oauth",
				access: "stored-stale-access",
				refresh: "old-stale-credentials",
				expires: Date.now() + 60 * 60 * 1000,
			};
			await credentials.modify("gigachat", async () => stored);
			const runtime = await createRuntime(credentials);
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			const result = await runtime.completeSimple(model, {
				messages: [
					{ role: "user", content: "Return OK", timestamp: Date.now() },
				],
			});

			expect(requests).toEqual([
				{
					method: "POST",
					url: "/v1/chat/completions",
					authorization: "Bearer opaque-access-token-without-dots",
					payload: expect.objectContaining({
						model: "GigaChat",
						max_tokens: 8192,
						stream: true,
					}),
				},
			]);
			expect(result).toMatchObject({
				model: "GigaChat",
				stopReason: "stop",
				content: [{ type: "text", text: "OK" }],
				usage: { input: 2, output: 1, totalTokens: 3 },
			});
		} finally {
			await close(server);
		}
	});

	it("redacts the active access token from a public Pi stream error", async () => {
		const token = "opaque-access-token-without-dots";
		const stderr = vi.spyOn(process.stderr, "write");
		const stdout = vi.spyOn(process.stdout, "write");
		const consoleError = vi.spyOn(console, "error");
		const consoleInfo = vi.spyOn(console, "info");
		const consoleLog = vi.spyOn(console, "log");
		const consoleWarn = vi.spyOn(console, "warn");
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: invalid-${token}\n\n`);
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = token;
			const runtime = await createRuntime();
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			const result = await runtime.completeSimple(model, {
				messages: [
					{ role: "user", content: "trigger error", timestamp: Date.now() },
				],
			});

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("[REDACTED]");
			expect(result.errorMessage).not.toContain(token);
			const emittedOutput = [
				...stderr.mock.calls.flat(),
				...stdout.mock.calls.flat(),
				...consoleError.mock.calls.flat(),
				...consoleInfo.mock.calls.flat(),
				...consoleLog.mock.calls.flat(),
				...consoleWarn.mock.calls.flat(),
			]
				.map(String)
				.join("\n");
			expect(emittedOutput).not.toContain(token);
		} finally {
			await close(server);
		}
	});

	it("never performs OAuth when expired Pi auth and an API 401 coexist with an env access token", async () => {
		const token = "opaque-access-token-without-dots";
		const requests: Array<{
			url: string | undefined;
			authorization: string | undefined;
		}> = [];
		const server = createServer((request, response) => {
			requests.push({
				url: request.url,
				authorization: request.headers.authorization,
			});
			response.writeHead(401, { "content-type": "application/json" });
			response.end('{"message":"unauthorized"}');
		});

		try {
			process.env.GIGACHAT_BASE_URL = await listen(server);
			process.env.GIGACHAT_ACCESS_TOKEN = token;
			process.env.GIGACHAT_CREDENTIALS = "old-stale-credentials";
			const oauthExchange = vi.spyOn(
				PiGigaChatClient.prototype,
				"updateTokenQuietly",
			);
			const credentials = new InMemoryCredentialStore();
			const stored: OAuthCredential = {
				type: "oauth",
				access: "expired-stored-access",
				refresh: "old-stale-credentials",
				expires: 0,
			};
			await credentials.modify("gigachat", async () => stored);
			const runtime = await createRuntime(credentials);
			const model = runtime.getModel("gigachat", "GigaChat");
			if (!model) throw new Error("GigaChat model was not registered");

			const result = await runtime.completeSimple(model, {
				messages: [
					{ role: "user", content: "trigger 401", timestamp: Date.now() },
				],
			});

			expect(requests).toEqual([
				{
					url: "/v1/chat/completions",
					authorization: `Bearer ${token}`,
				},
			]);
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: "GigaChat authentication failed",
			});
			expect(oauthExchange).not.toHaveBeenCalled();
			expect(await credentials.read("gigachat")).toEqual(stored);
		} finally {
			await close(server);
		}
	});
});
