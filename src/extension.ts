import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGigaChatCommand } from "./gigachat-ui.js";

export default async function (pi: ExtensionAPI) {
	await registerGigaChatCommand(pi);
}
