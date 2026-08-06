import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { GIGACHAT_DEFAULT_BASE_URL, GIGACHAT_MODELS } from "../src/models.js";
import { buildChatPayload, createClientConfig } from "../src/stream.js";
import {
	clearGigaChatEnv,
	EMPTY_CONTEXT,
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

describe("provider and model registration", () => {
	it("registers exact GigaChat first with the fork defaults", () => {
		let providerName: string | undefined;
		let providerConfig: ProviderConfig | undefined;
		extension({
			registerProvider: (name: string, config: ProviderConfig) => {
				providerName = name;
				providerConfig = config;
			},
		} as unknown as ExtensionAPI);

		expect(providerName).toBe("gigachat");
		expect(providerConfig?.baseUrl).toBe(GIGACHAT_DEFAULT_BASE_URL);
		expect(providerConfig?.apiKey).toBe("GIGACHAT_ACCESS_TOKEN");
		expect(providerConfig?.models?.[0]).toEqual({
			id: "GigaChat",
			name: "GigaChat",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		expect(GIGACHAT_MODELS.map((model) => model.id)).toEqual([
			"GigaChat",
			"GigaChat-2",
			"GigaChat-2-Pro",
			"GigaChat-2-Max",
		]);
	});

	it("sends the Pi-selected model unchanged in config and payload", () => {
		process.env.GIGACHAT_MODEL = "must-not-override-pi-selection";
		const model = makeModel();
		const payload = buildChatPayload(model, EMPTY_CONTEXT);
		const config = createClientConfig(model, {
			kind: "accessToken",
			accessToken: "opaque-access-token-without-dots",
		});

		expect(payload.model).toBe("GigaChat");
		expect(config.model).toBe("GigaChat");
	});

	it("keeps the model definitions compatible with Pi model metadata", () => {
		const models: Model<Api>[] = GIGACHAT_MODELS.map((definition) => ({
			...definition,
			api: "gigachat-extension-api",
			provider: "gigachat",
			baseUrl: GIGACHAT_DEFAULT_BASE_URL,
		}));

		expect(models.every((model) => model.contextWindow > model.maxTokens)).toBe(
			true,
		);
	});
});

describe("chat payload model defaults", () => {
	it("uses model maxTokens when runtime options omit it", () => {
		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT);

		expect(payload.max_tokens).toBe(8192);
	});

	it("allows runtime maxTokens to override the model default", () => {
		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT, {
			maxTokens: 4096,
		});

		expect(payload.max_tokens).toBe(4096);
	});

	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0.5,
	])("omits invalid maxTokens value %s", (maxTokens) => {
		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT, {
			maxTokens,
		});

		expect(payload.max_tokens).toBeUndefined();
	});
});
