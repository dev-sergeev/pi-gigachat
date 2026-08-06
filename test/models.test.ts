import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { GIGACHAT_DEFAULT_BASE_URL, GIGACHAT_MODELS } from "../src/models.js";
import {
	buildChatPayload,
	createClientConfig,
	type GigaChatStreamOptions,
} from "../src/stream.js";
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
		const registeredFlags: string[] = [];
		extension({
			registerFlag: (name: string) => registeredFlags.push(name),
			getFlag: () => undefined,
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
			"glm-5.1",
			"GigaChat-2",
			"GigaChat-2-Pro",
			"GigaChat-2-Max",
		]);
		expect(providerConfig?.models?.[1]).toEqual({
			id: "glm-5.1",
			name: "GLM 5.1 via GigaChat",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 192000,
			maxTokens: 131071,
			samplingParams: { temperature: 0.2 },
		});
		expect(registeredFlags).toEqual([
			"gigachat-temperature",
			"gigachat-top-p",
			"gigachat-max-tokens",
			"gigachat-repetition-penalty",
			"gigachat-update-interval",
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
	it("forwards the GLM model id and generation defaults", () => {
		const definition = GIGACHAT_MODELS.find((model) => model.id === "glm-5.1");
		if (!definition) throw new Error("glm-5.1 model was not registered");
		const model: Model<Api> = {
			...definition,
			api: "gigachat-extension-api",
			provider: "gigachat",
			baseUrl: GIGACHAT_DEFAULT_BASE_URL,
		};

		expect(buildChatPayload(model, EMPTY_CONTEXT)).toMatchObject({
			model: "glm-5.1",
			max_tokens: 131071,
			temperature: 0.2,
			stream: true,
		});
	});

	it("forwards model sampling parameters to the GigaChat payload", () => {
		const model = Object.assign(makeModel(), {
			samplingParams: {
				temperature: 0.2,
				repetition_penalty: 1.1,
				update_interval: 0.25,
				response_format: { type: "text" },
			},
		});
		const payload = buildChatPayload(model, EMPTY_CONTEXT);

		expect(payload).toMatchObject({
			temperature: 0.2,
			repetition_penalty: 1.1,
			update_interval: 0.25,
			response_format: { type: "text" },
		});
	});

	it("uses model maxTokens when runtime options omit it", () => {
		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT);

		expect(payload.max_tokens).toBe(8192);
	});

	it("forwards generation parameters from environment variables", () => {
		process.env.GIGACHAT_TEMPERATURE = "0.2";
		process.env.GIGACHAT_MAX_TOKENS = "4096";
		process.env.GIGACHAT_REPETITION_PENALTY = "1.1";
		process.env.GIGACHAT_UPDATE_INTERVAL = "0.25";

		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT);

		expect(payload).toMatchObject({
			temperature: 0.2,
			max_tokens: 4096,
			repetition_penalty: 1.1,
			update_interval: 0.25,
		});
	});

	it("forwards top_p from the environment as a sampling alternative", () => {
		process.env.GIGACHAT_TOP_P = "0.9";

		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT);

		expect(payload.top_p).toBe(0.9);
		expect(payload.temperature).toBeUndefined();
	});

	it("ignores invalid lower-priority configuration when runtime overrides it", () => {
		process.env.GIGACHAT_TEMPERATURE = "stale-invalid-value";

		const payload = buildChatPayload(makeModel(), EMPTY_CONTEXT, {
			temperature: 0.2,
		});

		expect(payload.temperature).toBe(0.2);
	});

	it("applies model, environment, flag, named, and sampling precedence", () => {
		const model = Object.assign(makeModel(), {
			samplingParams: { temperature: 0.2 },
		});
		const flagReader = (name: string) =>
			name === "gigachat-temperature" ? "0.5" : undefined;

		expect(buildChatPayload(model, EMPTY_CONTEXT).temperature).toBe(0.2);

		process.env.GIGACHAT_TEMPERATURE = "0.3";
		expect(buildChatPayload(model, EMPTY_CONTEXT).temperature).toBe(0.3);
		expect(
			buildChatPayload(model, EMPTY_CONTEXT, {
				env: { GIGACHAT_TEMPERATURE: "0.4" },
			}).temperature,
		).toBe(0.4);
		expect(
			buildChatPayload(model, EMPTY_CONTEXT, undefined, flagReader).temperature,
		).toBe(0.5);
		expect(
			buildChatPayload(model, EMPTY_CONTEXT, { temperature: 0.6 }, flagReader)
				.temperature,
		).toBe(0.6);
		expect(
			buildChatPayload(
				model,
				EMPTY_CONTEXT,
				{
					temperature: 0.6,
					samplingParams: { temperature: 0.7 },
				},
				flagReader,
			).temperature,
		).toBe(0.7);
	});

	it("uses topP as an alternative to a lower-priority temperature", () => {
		const model = Object.assign(makeModel(), {
			samplingParams: { temperature: 0.2 },
		});
		const payload = buildChatPayload(model, EMPTY_CONTEXT, { topP: 0.9 });

		expect(payload.top_p).toBe(0.9);
		expect(payload.temperature).toBeUndefined();
	});

	it("rejects temperature and top_p from the same configuration layer", () => {
		process.env.GIGACHAT_TEMPERATURE = "0.2";
		process.env.GIGACHAT_TOP_P = "0.9";

		expect(() => buildChatPayload(makeModel(), EMPTY_CONTEXT)).toThrow(
			"temperature and top_p are alternatives",
		);
	});

	it("supports the current response_format API field", () => {
		const options: GigaChatStreamOptions = {
			responseFormat: {
				type: "json_schema",
				schema: {
					type: "object",
					properties: { result: { type: "string" } },
					required: ["result"],
				},
				strict: true,
			},
		};

		expect(buildChatPayload(makeModel(), EMPTY_CONTEXT, options)).toMatchObject(
			{
				response_format: options.responseFormat,
			},
		);
	});

	it("requires schema.required when strict structured output is enabled", () => {
		const options = {
			responseFormat: {
				type: "json_schema",
				schema: { type: "object", properties: {} },
				strict: true,
			},
		} as GigaChatStreamOptions;

		expect(() => buildChatPayload(makeModel(), EMPTY_CONTEXT, options)).toThrow(
			"schema.required",
		);
	});

	it.each([
		["GIGACHAT_TEMPERATURE", "0", "Expected a finite number greater than 0"],
		["GIGACHAT_TOP_P", "1.1", "Expected a finite number between 0 and 1"],
		["GIGACHAT_MAX_TOKENS", "1.5", "Expected a positive 32-bit integer"],
		[
			"GIGACHAT_REPETITION_PENALTY",
			"0",
			"Expected a finite number greater than 0",
		],
		[
			"GIGACHAT_UPDATE_INTERVAL",
			"-0.1",
			"Expected a non-negative finite number",
		],
	] as const)("rejects invalid %s configuration", (name, value, message) => {
		process.env[name] = value;

		expect(() => buildChatPayload(makeModel(), EMPTY_CONTEXT)).toThrow(message);
	});

	it("rejects unsupported sampling parameters instead of changing request invariants", () => {
		const options = {
			samplingParams: { model: "different-model" },
		} as unknown as GigaChatStreamOptions;

		expect(() => buildChatPayload(makeModel(), EMPTY_CONTEXT, options)).toThrow(
			'Unsupported options.samplingParams parameter "model"',
		);
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
