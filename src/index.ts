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
	// Pi UI peers are absent when this package is used only as a pi-ai library.
	const { registerGigaChatCommand } = await import("./gigachat-ui.js");
	await registerGigaChatCommand(pi);
}
