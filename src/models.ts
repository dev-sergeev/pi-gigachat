import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

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

export const GIGACHAT_CONNECTION_DEFAULTS = {
	contextWindow: 262144,
	maxTokens: 64000,
	reasoning: true,
	thinkingLevelMap,
};
