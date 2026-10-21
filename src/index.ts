import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gigachatAuth } from "./auth.js";
import { streamSimpleGigaChat } from "./stream.js";

export type { GigaChatStreamOptions } from "./stream.js";
export { streamSimpleGigaChat };

export const gigachatProvider = createProvider({
	id: "gigachat",
	name: "GigaChat",
	auth: gigachatAuth,
	models: [],
	api: { stream: streamSimpleGigaChat, streamSimple: streamSimpleGigaChat },
});

export default async function (pi: ExtensionAPI) {
	// Pi host/UI peers may be absent for pi-ai-only consumers; load them only on activation.
	const { default: activate } = await import("./extension.js");
	await activate(pi);
}
