import { randomUUID } from "node:crypto";
import type {
	ApiKeyCredential,
	AuthContext,
	OAuthCredential,
	ProviderAuth,
	ProviderEnv,
} from "@earendil-works/pi-ai";
import { environment, object, request, serial } from "./http.js";
import { GIGACHAT_DEFAULT_BASE_URL } from "./models.js";

const scopes = ["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"];
const authUrl = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
type Credentials = OAuthCredential & {
	authMode?: string;
	authorizationKey?: string;
	scope?: string;
	baseUrl?: string;
	user?: string;
	password?: string;
};

export function baseUrl(value = GIGACHAT_DEFAULT_BASE_URL): string {
	const url = new URL(value);
	if (!["https:", "http:"].includes(url.protocol))
		throw new Error("GigaChat base URL must use http(s)");
	return url.href.replace(/\/+$/, "");
}

async function exchange(
	stored: Credentials,
	signal: AbortSignal,
	env: ProviderEnv = {},
): Promise<Credentials> {
	const config = environment({ env });
	const passwordAuth = stored.authMode === "basic";
	const scope = stored.scope || scopes[0];
	if (!scopes.includes(scope))
		throw new Error(`Invalid GigaChat scope: use ${scopes.join(", ")}`);
	const authorization = passwordAuth
		? Buffer.from(`${stored.user}:${stored.password}`).toString("base64")
		: (stored.authorizationKey || stored.refresh)
				.replace(/^Basic\s+/i, "")
				.trim();
	if (!authorization || (passwordAuth && (!stored.user || !stored.password)))
		throw new Error("GigaChat login credentials are missing");
	const data = await request(
		passwordAuth
			? `${baseUrl(stored.baseUrl)}/token`
			: config.GIGACHAT_AUTH_URL || authUrl,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				Authorization: `Basic ${authorization}`,
				RqUID: randomUUID(),
				"User-Agent": "pi-gigachat",
			},
			body: passwordAuth ? "" : new URLSearchParams({ scope }).toString(),
		},
		{ signal, env },
		(response) => response.json(),
	);
	if (!object(data)) throw new Error("Invalid GigaChat token response");
	const access = data.access_token ?? data.tok;
	const expiry = Number(data.expires_at ?? data.exp);
	if (
		typeof access !== "string" ||
		!access ||
		!Number.isFinite(expiry) ||
		expiry <= 0
	)
		throw new Error(
			"Invalid GigaChat token response: missing access_token or expires_at",
		);
	return {
		...stored,
		type: "oauth",
		access,
		expires: (expiry > 1e12 ? expiry : expiry * 1000) - 60000,
	};
}

// Environment authorization keys cannot use pi's persisted OAuth store. Cache
// one exchanged token; serialize refresh and never write secrets to process.env.
let cached: { key: string; credential: Credentials } | undefined;
async function configuration(ctx: AuthContext, credential?: ApiKeyCredential) {
	const env: ProviderEnv = { ...credential?.env };
	for (const name of [
		"GIGACHAT_ACCESS_TOKEN",
		"GIGACHAT_CREDENTIALS",
		"GIGACHAT_USER",
		"GIGACHAT_PASSWORD",
		"GIGACHAT_SCOPE",
		"GIGACHAT_BASE_URL",
		"GIGACHAT_AUTH_URL",
		"GIGACHAT_TIMEOUT",
		"GIGACHAT_MAX_RETRIES",
		"GIGACHAT_RETRY_BASE_DELAY_MS",
		"GIGACHAT_STREAM",
		"GIGACHAT_REASONING_IN_CONTENT",
		"GIGACHAT_EXTRA_BODY",
		"GIGACHAT_SYSTEM_PROMPT",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"no_proxy",
	]) {
		const value = env[name] ?? (await ctx.env(name));
		if (value !== undefined) env[name] = value;
	}
	const access = credential?.key || env.GIGACHAT_ACCESS_TOKEN;
	const configured = Boolean(
		access ||
			env.GIGACHAT_CREDENTIALS ||
			(env.GIGACHAT_USER && env.GIGACHAT_PASSWORD),
	);
	return { env, access, configured };
}

export const gigachatAuth: ProviderAuth = {
	apiKey: {
		name: "GigaChat access token",
		async login({ prompt, signal }) {
			const key = (
				await prompt({ type: "secret", message: "GigaChat access token" })
			)
				.trim()
				.replace(/^Bearer\s+/i, "");
			signal.throwIfAborted();
			if (!key) throw new Error("GigaChat access token is required");
			return { type: "api_key", key };
		},
		async check({ ctx, credential, signal }) {
			signal.throwIfAborted();
			return (await configuration(ctx, credential)).configured
				? { type: "api_key", source: "GigaChat credentials" }
				: undefined;
		},
		async resolve({ ctx, credential, signal }) {
			const { env, access, configured } = await configuration(ctx, credential);
			if (!configured) return undefined;
			let apiKey = access?.trim().replace(/^Bearer\s+/i, "");
			if (!apiKey) {
				apiKey = await serial(signal, async () => {
					const key = JSON.stringify([
						env.GIGACHAT_CREDENTIALS,
						env.GIGACHAT_USER,
						env.GIGACHAT_PASSWORD,
						env.GIGACHAT_SCOPE,
						env.GIGACHAT_BASE_URL,
						env.GIGACHAT_AUTH_URL,
					]);
					if (cached?.key !== key || cached.credential.expires <= Date.now()) {
						const next = await exchange(
							{
								type: "oauth",
								access: "",
								expires: 0,
								refresh: env.GIGACHAT_CREDENTIALS ?? "",
								authMode: env.GIGACHAT_CREDENTIALS ? "token" : "basic",
								scope: env.GIGACHAT_SCOPE,
								baseUrl: env.GIGACHAT_BASE_URL,
								user: env.GIGACHAT_USER,
								password: env.GIGACHAT_PASSWORD,
							},
							signal,
							env,
						);
						cached = { key, credential: next };
					}
					return cached.credential.access;
				});
			}
			return {
				auth: {
					apiKey,
					...(env.GIGACHAT_BASE_URL
						? { baseUrl: baseUrl(env.GIGACHAT_BASE_URL) }
						: {}),
				},
				// Do not relabel ambient proxy variables as request-scoped overrides.
				env: {
					...Object.fromEntries(
						Object.entries(env).filter(([name]) =>
							name.startsWith("GIGACHAT_"),
						),
					),
					...credential?.env,
				},
			};
		},
	},
	oauth: {
		name: "GigaChat",
		loginLabel:
			"Authorization key or username/password (automatic token renewal)",
		async login({ prompt, signal, notify }) {
			const authMode = await prompt({
				type: "select",
				message: "GigaChat authentication",
				options: [
					{ id: "token", label: "Authorization key" },
					{ id: "basic", label: "Username and password" },
				],
			});
			const url = baseUrl(
				(
					await prompt({
						type: "text",
						message: "GigaChat base URL",
						placeholder: GIGACHAT_DEFAULT_BASE_URL,
					})
				).trim() ||
					process.env.GIGACHAT_BASE_URL ||
					GIGACHAT_DEFAULT_BASE_URL,
			);
			const scope = await prompt({
				type: "select",
				message: "GigaChat scope",
				options: scopes.map((id) => ({ id, label: id })),
			});
			const stored: Credentials = {
				type: "oauth",
				access: "",
				refresh: "",
				expires: 0,
				authMode,
				scope,
				baseUrl: url,
			};
			if (authMode === "basic") {
				stored.user = (
					await prompt({ type: "text", message: "GigaChat username" })
				).trim();
				stored.password = await prompt({
					type: "secret",
					message: "GigaChat password",
				});
			} else {
				stored.refresh = (
					await prompt({
						type: "secret",
						message: "GigaChat authorization key (not access token)",
					})
				)
					.trim()
					.replace(/^Basic\s+/i, "");
			}
			signal.throwIfAborted();
			notify({
				type: "progress",
				message: "Requesting GigaChat access token…",
			});
			return exchange(stored, signal);
		},
		refresh: (credential, signal) => exchange(credential, signal),
		async toAuth(credential: Credentials) {
			return {
				apiKey: credential.access,
				...(credential.baseUrl ? { baseUrl: baseUrl(credential.baseUrl) } : {}),
			};
		},
	},
};
