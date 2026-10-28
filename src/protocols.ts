import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { baseUrl as normalizeBaseUrl } from "./auth.js";
import type { GigaChatProtocol } from "./connection-types.js";
import {
	GIGACHAT_API,
	GIGACHAT_CONNECTION_DEFAULTS,
	GIGACHAT_DEFAULT_BASE_URL,
} from "./models.js";

export const GIGACHAT_PROTOCOLS = {
	v1: {
		label: "GigaChat V1",
		api: GIGACHAT_API,
		baseUrl: GIGACHAT_DEFAULT_BASE_URL,
	},
	v2: {
		label: "GigaChat V2",
		api: "gigachat-v2-extension-api",
		baseUrl: "https://api.giga.chat/v2",
	},
	openai: {
		label: "OpenAI-compatible",
		api: "openai-completions",
		baseUrl: GIGACHAT_DEFAULT_BASE_URL,
	},
} as const satisfies Record<
	GigaChatProtocol,
	{ label: string; api: string; baseUrl: string }
>;

export function defaultModelsUrl(
	baseUrl: string,
	protocol: GigaChatProtocol = "v1",
): string {
	const root = normalizeBaseUrl(baseUrl);
	switch (protocol) {
		case "v1":
			return `${root}/models`;
		case "v2":
			return new URL("/v1/models", root).href;
		case "openai":
			return new URL("/gc/models", root).href;
		default:
			throw new Error("Unknown GigaChat protocol.");
	}
}

export function thinkingLevelMapForProtocol(
	protocol: GigaChatProtocol,
): ThinkingLevelMap {
	return protocol === "v2"
		? {
				off: "off",
				minimal: null,
				low: null,
				medium: "medium",
				high: null,
				xhigh: null,
				max: null,
			}
		: { ...GIGACHAT_CONNECTION_DEFAULTS.thinkingLevelMap };
}
