import type { Model } from "@earendil-works/pi-ai";

export const GIGACHAT_API = "gigachat-extension-api";
export const GIGACHAT_DEFAULT_BASE_URL = "https://api.giga.chat/v1";

export const GIGACHAT_MODELS: Model<typeof GIGACHAT_API>[] = [
	["GigaChat-2", "GigaChat 2 Lite"],
	["GigaChat-2-Pro", "GigaChat 2 Pro"],
	["GigaChat-2-Max", "GigaChat 2 Max"],
	["GigaChat-3-Ultra", "GigaChat 3 Ultra"],
].map(([id, name]) => ({
	id,
	name,
	api: GIGACHAT_API,
	provider: "gigachat",
	baseUrl: GIGACHAT_DEFAULT_BASE_URL,
	reasoning: false,
	input: ["text"],
	// Unknown USD prices; tariffs vary by account. Zero is not a free-tier claim.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}));
