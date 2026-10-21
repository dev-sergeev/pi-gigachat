import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { registerGigaChatCommand } from "./gigachat-ui.js";

export default async function (pi: ExtensionAPI) {
	// A static host import is required: native dynamic imports can resolve local peers.
	if (VERSION !== "0.85.1") {
		throw new Error(
			`Unsupported Pi version ${VERSION || "unknown"}: @dev-sergeev/pi-gigachat requires Pi 0.85.1. Use Pi 0.85.1 or remove this extension.`,
		);
	}
	await registerGigaChatCommand(pi);
}
