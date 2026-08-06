import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIGACHAT_DEFAULT_BASE_URL, GIGACHAT_MODELS } from "./models.js";
import { gigachatOAuthProvider } from "./oauth.js";
import { resolveVerifySslCertificates } from "./shared.js";
import { streamSimpleGigaChat } from "./stream.js";

const GIGACHAT_API = "gigachat-extension-api";

export default function (pi: ExtensionAPI) {
	resolveVerifySslCertificates(process.env.GIGACHAT_VERIFY_SSL_CERTS);
	pi.registerProvider("gigachat", {
		baseUrl: GIGACHAT_DEFAULT_BASE_URL,
		// A literal sentinel keeps Pi's pre-stream auth gate open for every
		// supported env mode; resolveAuth replaces or ignores it before the SDK.
		apiKey: "GIGACHAT_ACCESS_TOKEN",
		api: GIGACHAT_API,
		models: GIGACHAT_MODELS,
		oauth: gigachatOAuthProvider,
		streamSimple: streamSimpleGigaChat,
	});
}
