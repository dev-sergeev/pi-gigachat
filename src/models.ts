import type { Model } from "@earendil-works/pi-ai";

export const GIGACHAT_API = "gigachat-extension-api";
export const GIGACHAT_DEFAULT_BASE_URL = "https://api.giga.chat/v1";

export const GIGACHAT_MODELS: Model<typeof GIGACHAT_API>[] = [
	{ id: "GigaChat-2", name: "GigaChat 2 Lite" },
	{ id: "GigaChat-2-Pro", name: "GigaChat 2 Pro" },
	{ id: "GigaChat-2-Max", name: "GigaChat 2 Max" },
	{ id: "GigaChat-3-Ultra", name: "GigaChat 3 Ultra" },
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		contextWindow: 200000,
		maxTokens: 64000,
	},
].map(({ id, name, contextWindow = 128000, maxTokens = 8192 }) => ({
	id,
	name,
	api: GIGACHAT_API,
	provider: "gigachat",
	baseUrl: GIGACHAT_DEFAULT_BASE_URL,
	reasoning: false,
	input: ["text"],
	// Unknown USD prices; tariffs vary by account. Zero is not a free-tier claim.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow,
	maxTokens,
}));
