import type { Api, Context, Model } from "@earendil-works/pi-ai";

export const TEST_ENV_KEYS = [
	"GIGACHAT_ACCESS_TOKEN",
	"GIGACHAT_BASE_URL",
	"GIGACHAT_CREDENTIALS",
	"GIGACHAT_MAX_TOKENS",
	"GIGACHAT_MODEL",
	"GIGACHAT_PASSWORD",
	"GIGACHAT_REPETITION_PENALTY",
	"GIGACHAT_SCOPE",
	"GIGACHAT_TEMPERATURE",
	"GIGACHAT_TOP_P",
	"GIGACHAT_UPDATE_INTERVAL",
	"GIGACHAT_USER",
	"GIGACHAT_VERIFY_SSL_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
] as const;

export type TestEnvKey = (typeof TEST_ENV_KEYS)[number];

export function snapshotTestEnv(): Record<TestEnvKey, string | undefined> {
	return Object.fromEntries(
		TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<TestEnvKey, string | undefined>;
}

export function restoreTestEnv(
	snapshot: Record<TestEnvKey, string | undefined>,
): void {
	for (const key of TEST_ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

export function clearGigaChatEnv(): void {
	for (const key of TEST_ENV_KEYS) {
		if (key.startsWith("GIGACHAT_")) {
			delete process.env[key];
		}
	}
}

export function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "GigaChat",
		name: "GigaChat",
		api: "gigachat-extension-api",
		provider: "gigachat",
		baseUrl: "https://api.giga.chat/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

export const EMPTY_CONTEXT: Context = { messages: [] };
