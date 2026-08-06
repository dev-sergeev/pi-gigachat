import {
	InMemoryCredentialStore,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { gigachatOAuthProvider } from "../src/oauth.js";
import { PiGigaChatClient } from "../src/shared.js";
import { resolveAuth } from "../src/stream.js";
import {
	clearGigaChatEnv,
	makeModel,
	restoreTestEnv,
	snapshotTestEnv,
} from "./helpers.js";

const originalEnv = snapshotTestEnv();

beforeEach(() => {
	clearGigaChatEnv();
	process.env.GIGACHAT_VERIFY_SSL_CERTS = "true";
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreTestEnv(originalEnv);
});

describe("GIGACHAT_ACCESS_TOKEN regression", () => {
	it("uses an opaque access token ahead of every lower-priority auth source", () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
		process.env.GIGACHAT_CREDENTIALS = "old-stale-credentials";
		process.env.GIGACHAT_USER = "stale-user";
		process.env.GIGACHAT_PASSWORD = "stale-password";
		process.env.GIGACHAT_SCOPE = "irrelevant-invalid-scope";

		expect(resolveAuth({ apiKey: "saved.stale.access" })).toEqual({
			kind: "accessToken",
			accessToken: "opaque-access-token-without-dots",
		});
	});

	it("strips a Bearer prefix and surrounding whitespace", () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "  Bearer opaque-access-token  ";

		expect(resolveAuth()).toEqual({
			kind: "accessToken",
			accessToken: "opaque-access-token",
		});
	});

	it("keeps credentials, saved auth, and password fallbacks in strict order", () => {
		process.env.GIGACHAT_CREDENTIALS = "env-credentials";
		expect(resolveAuth({ apiKey: "saved.access.token" })).toMatchObject({
			kind: "credentials",
			credentials: "env-credentials",
		});

		delete process.env.GIGACHAT_CREDENTIALS;
		process.env.GIGACHAT_USER = "user";
		process.env.GIGACHAT_PASSWORD = "password";
		expect(resolveAuth({ apiKey: "saved.access.token" })).toEqual({
			kind: "accessToken",
			accessToken: "saved.access.token",
		});

		expect(resolveAuth()).toEqual({
			kind: "password",
			user: "user",
			password: "password",
		});
	});

	it("reports a clear error when no authentication source is configured", () => {
		expect(() => resolveAuth()).toThrow(
			"No GigaChat authentication configured. Run /login gigachat or set GIGACHAT_CREDENTIALS, GIGACHAT_ACCESS_TOKEN, or GIGACHAT_USER/GIGACHAT_PASSWORD.",
		);
	});

	it("does not refresh stored Pi OAuth before the stream when env access token exists", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
		const oauthNetwork = vi
			.spyOn(PiGigaChatClient.prototype, "updateTokenQuietly")
			.mockRejectedValue(new Error("OAuth exchange must not run"));
		const stored: OAuthCredential = {
			type: "oauth",
			access: "expired-stored-access",
			refresh: "old-stale-credentials",
			expires: 0,
			authMode: "token",
			authorizationKey: "old-stale-credentials",
			scope: "GIGACHAT_API_PERS",
		};
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("gigachat", async () => stored);
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
		});
		extension({
			registerProvider: (
				name: string,
				config: Parameters<ModelRuntime["registerProvider"]>[1],
			) => runtime.registerProvider(name, config),
		} as unknown as ExtensionAPI);

		const auth = await runtime.getAuth(makeModel());
		expect(auth?.auth.apiKey).toBe("opaque-access-token-without-dots");
		expect(oauthNetwork).not.toHaveBeenCalled();
		expect(await credentials.read("gigachat")).toEqual(stored);
	});

	it("bypasses the legacy refresh callback without persisting the env token", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "opaque-access-token-without-dots";
		const stored = {
			access: "stored-access",
			refresh: "old-stale-credentials",
			expires: 0,
		};

		await expect(gigachatOAuthProvider.refreshToken(stored)).resolves.toBe(
			stored,
		);
		expect(gigachatOAuthProvider.getApiKey(stored)).toBe(
			"opaque-access-token-without-dots",
		);
	});
});
