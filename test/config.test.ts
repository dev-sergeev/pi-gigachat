import type { Agent } from "node:https";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { GIGACHAT_DEFAULT_BASE_URL } from "../src/models.js";
import {
	createGigaChatHttpsAgent,
	resetTlsDisabledWarningForTests,
	resolveVerifySslCertificates,
} from "../src/shared.js";
import {
	createClientConfig,
	type GigaChatAuth,
	resolveBaseUrl,
	resolveGigaChatTimeoutSeconds,
} from "../src/stream.js";
import {
	clearGigaChatEnv,
	makeModel,
	restoreTestEnv,
	snapshotTestEnv,
} from "./helpers.js";

const originalEnv = snapshotTestEnv();
const accessAuth: GigaChatAuth = {
	kind: "accessToken",
	accessToken: "opaque-access-token-without-dots",
};

beforeEach(() => {
	clearGigaChatEnv();
	process.env.GIGACHAT_VERIFY_SSL_CERTS = "true";
	resetTlsDisabledWarningForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreTestEnv(originalEnv);
	resetTlsDisabledWarningForTests();
});

describe("base URL resolution", () => {
	it("uses the new API default and normalizes trailing slashes", () => {
		expect(resolveBaseUrl(makeModel({ baseUrl: "" }))).toBe(
			GIGACHAT_DEFAULT_BASE_URL,
		);
		expect(
			resolveBaseUrl(makeModel({ baseUrl: "https://model.example/v1///" })),
		).toBe("https://model.example/v1");
	});

	it("applies options, env, model, default priority", () => {
		process.env.GIGACHAT_BASE_URL = "https://env.example/v1/";
		const model = makeModel({ baseUrl: "https://model.example/v1/" });

		expect(resolveBaseUrl(model)).toBe("https://env.example/v1");
		expect(
			resolveBaseUrl(model, { baseUrl: "https://option.example/v1///" }),
		).toBe("https://option.example/v1");
	});
});

describe("transport timeout", () => {
	it("converts the standard Pi timeout from milliseconds to SDK seconds", () => {
		expect(resolveGigaChatTimeoutSeconds({ timeoutMs: 300_000 })).toBe(300);
		expect(
			createClientConfig(makeModel(), accessAuth, { timeoutMs: 300_000 })
				.timeout,
		).toBe(300);
	});

	it("lets GigaChat-specific configuration override the generic Pi timeout", () => {
		process.env.GIGACHAT_TIMEOUT = "120";

		expect(resolveGigaChatTimeoutSeconds({ timeoutMs: 300_000 })).toBe(120);
		expect(
			resolveGigaChatTimeoutSeconds({
				timeoutMs: 300_000,
				env: { GIGACHAT_TIMEOUT: "180" },
			}),
		).toBe(180);
		expect(
			resolveGigaChatTimeoutSeconds({
				timeoutSeconds: 240,
				timeoutMs: 300_000,
				env: { GIGACHAT_TIMEOUT: "180" },
			}),
		).toBe(240);
	});

	it("accepts zero as an explicit request to disable the SDK timeout", () => {
		process.env.GIGACHAT_TIMEOUT = "0";

		expect(resolveGigaChatTimeoutSeconds({ timeoutMs: 300_000 })).toBe(0);
	});

	it.each([
		"not-a-number",
		"-1",
		"2147483.648",
	])("rejects invalid GIGACHAT_TIMEOUT=%s", (value) => {
		process.env.GIGACHAT_TIMEOUT = value;

		expect(() => resolveGigaChatTimeoutSeconds()).toThrow(
			"Invalid GIGACHAT_TIMEOUT value",
		);
	});
});

describe("scoped TLS configuration", () => {
	it("disables certificate verification by default without changing the global setting", () => {
		delete process.env.GIGACHAT_VERIFY_SSL_CERTS;
		const globalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const config = createClientConfig(makeModel(), accessAuth);
		const agent = config.httpsAgent as Agent;

		expect(agent.options.rejectUnauthorized).toBe(false);
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(globalTlsSetting);
		expect(stderr).toHaveBeenCalledWith(
			"[pi-gigachat] TLS certificate verification is disabled\n",
		);
	});

	it("enables certificate verification for supported true values", () => {
		for (const value of ["true", "1", "yes", "on", " TRUE "]) {
			expect(resolveVerifySslCertificates(value)).toBe(true);
		}

		const agent = createGigaChatHttpsAgent("true");
		expect(agent.options.rejectUnauthorized).toBe(true);
	});

	it("accepts supported false values and warns only once", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		for (const value of [undefined, "", "false", "0", "no", "off"]) {
			expect(resolveVerifySslCertificates(value)).toBe(false);
			createGigaChatHttpsAgent(value);
		}

		expect(stderr).toHaveBeenCalledTimes(1);
	});

	it("rejects an invalid value eagerly during extension startup", () => {
		process.env.GIGACHAT_VERIFY_SSL_CERTS = "sometimes";
		const registerProvider = vi.fn();

		expect(() =>
			extension({ registerProvider } as unknown as ExtensionAPI),
		).toThrow(
			"Invalid GIGACHAT_VERIFY_SSL_CERTS value. Use true/false, 1/0, yes/no, or on/off.",
		);
		expect(registerProvider).not.toHaveBeenCalled();
	});
});
