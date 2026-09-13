import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gigachatAuth } from "./auth.js";
import { GIGACHAT_MODELS } from "./models.js";
import { streamSimpleGigaChat } from "./stream.js";

export type { GigaChatStreamOptions } from "./stream.js";
export { streamSimpleGigaChat };

export const gigachatProvider = createProvider({
	id: "gigachat",
	name: "GigaChat",
	auth: gigachatAuth,
	models: GIGACHAT_MODELS,
	api: { stream: streamSimpleGigaChat, streamSimple: streamSimpleGigaChat },
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider(gigachatProvider);
}
