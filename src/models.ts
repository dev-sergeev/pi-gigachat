import type { GigaChatSamplingParams } from "./generation-params.js";

export interface GigaChatModelDefinition {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	/** Optional provider defaults forwarded as GigaChat request fields. */
	samplingParams?: GigaChatSamplingParams;
}

export const GIGACHAT_DEFAULT_BASE_URL = "https://api.giga.chat/v1";

export const GIGACHAT_MODELS: GigaChatModelDefinition[] = [
	{
		id: "GigaChat",
		name: "GigaChat",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "glm-5.1",
		name: "GLM 5.1 via GigaChat",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 192000,
		maxTokens: 131071,
		samplingParams: { temperature: 0.2 },
	},
	{
		id: "GigaChat-2",
		name: "GigaChat 2 Lite",
		reasoning: false,
		input: ["text"],
		cost: { input: 65, output: 65, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "GigaChat-2-Pro",
		name: "GigaChat 2 Pro",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 500, output: 500, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "GigaChat-2-Max",
		name: "GigaChat 2 Max",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 650, output: 650, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];
