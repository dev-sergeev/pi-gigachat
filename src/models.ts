import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const GIGACHAT_API = "gigachat-extension-api";
export const GIGACHAT_DEFAULT_BASE_URL = "https://api.giga.chat/v1";

const thinkingLevelMap: ThinkingLevelMap = {
	off: "off",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

export const GIGACHAT_MODELS: Model<typeof GIGACHAT_API>[] = [
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "Qwen3.5-397b",
		name: "Qwen 3.5 397B",
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 32768,
	},
].map(
	({
		id,
		name,
		reasoning = false,
		contextWindow = 128000,
		maxTokens = 8192,
	}) => ({
		id,
		name,
		api: GIGACHAT_API,
		provider: "gigachat",
		baseUrl: GIGACHAT_DEFAULT_BASE_URL,
		reasoning,
		...(reasoning ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
		input: ["text"],
		// Unknown USD prices; tariffs vary by account. Zero is not a free-tier claim.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	}),
);
