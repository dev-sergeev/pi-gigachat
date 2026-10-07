import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
	AuthInteraction,
	Credential,
	Model,
	OAuthCredential,
	Provider,
	ProviderAuth,
} from "@earendil-works/pi-ai";
import { createProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { baseUrl, exchange } from "./auth.js";
import type { Connection, ConnectionCredential } from "./connection-types.js";
import { GigaChatHttpError, object } from "./http.js";
import { GIGACHAT_API } from "./models.js";
import { streamSimpleGigaChat } from "./stream.js";

export const CONNECTION_PROVIDER_PREFIX = "gigachat-server-";

type ConnectionErrorCode =
	| "GIGACHAT_STORAGE_ERROR"
	| "GIGACHAT_STALE_CONNECTION"
	| "GIGACHAT_AUTH_ERROR";

/** Safe to show in the wizard: no raw HTTP, filesystem, or secret-bearing cause. */
export class ConnectionError extends Error {
	constructor(
		readonly code: ConnectionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ConnectionError";
	}
}

function stale(): ConnectionError {
	return new ConnectionError(
		"GIGACHAT_STALE_CONNECTION",
		"GigaChat connection changed or was removed. Open /gigachat to reload it, or restart Pi.",
	);
}

function storageError(): ConnectionError {
	return new ConnectionError(
		"GIGACHAT_STORAGE_ERROR",
		"Cannot read or update GigaChat connections in auth.json. Check the file and its permissions, then try /gigachat again.",
	);
}

function ownedId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith(CONNECTION_PROVIDER_PREFIX) &&
		value.length > CONNECTION_PROVIDER_PREFIX.length &&
		!/\s/.test(value) &&
		!value.includes("\0")
	);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function httpUrl(value: unknown): value is string {
	if (!nonempty(value)) return false;
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

function validConnection(value: unknown): value is Connection {
	if (
		!object(value) ||
		!ownedId(value.id) ||
		!nonempty(value.revision) ||
		!nonempty(value.name) ||
		!httpUrl(value.baseUrl) ||
		!object(value.authorization) ||
		!Array.isArray(value.models)
	)
		return false;
	if (value.authorization.type !== "token") {
		if (
			value.authorization.type !== "credentials" ||
			!httpUrl(value.authorization.tokenUrl) ||
			!nonempty(value.authorization.scope)
		)
			return false;
	}
	const ids = new Set<string>();
	for (const model of value.models) {
		if (
			!object(model) ||
			!nonempty(model.id) ||
			ids.has(model.id) ||
			!nonempty(model.name) ||
			typeof model.reasoning !== "boolean" ||
			!Number.isSafeInteger(model.contextWindow) ||
			Number(model.contextWindow) < 1 ||
			!Number.isSafeInteger(model.maxTokens) ||
			Number(model.maxTokens) < 1
		)
			return false;
		if (
			model.thinkingLevelMap !== undefined &&
			(!object(model.thinkingLevelMap) ||
				!Object.entries(model.thinkingLevelMap).every(
					([level, target]) =>
						[
							"off",
							"minimal",
							"low",
							"medium",
							"high",
							"xhigh",
							"max",
						].includes(level) &&
						(target === null || typeof target === "string"),
				))
		)
			return false;
		ids.add(model.id);
	}
	return true;
}

function validCredential(
	value: unknown,
	id?: string,
): value is ConnectionCredential {
	if (
		!object(value) ||
		!validConnection(value.gigachatConnection) ||
		(id !== undefined && value.gigachatConnection.id !== id)
	)
		return false;
	if (value.gigachatConnection.authorization.type === "token") {
		return (
			value.type === "api_key" &&
			value.key === undefined &&
			object(value.env) &&
			Object.values(value.env).every((entry) => typeof entry === "string") &&
			nonempty(value.env.GIGACHAT_ACCESS_TOKEN)
		);
	}
	return (
		value.type === "oauth" &&
		nonempty(value.access) &&
		nonempty(value.refresh) &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function currentCredential(
	credential: Credential | undefined,
	connection: Connection,
): ConnectionCredential {
	if (
		!validCredential(credential, connection.id) ||
		credential.gigachatConnection.revision !== connection.revision
	)
		throw stale();
	return credential;
}

async function exchangeConnection(
	connection: Connection,
	secret: string,
	signal: AbortSignal,
): Promise<ConnectionCredential & OAuthCredential> {
	if (connection.authorization.type !== "credentials") throw stale();
	try {
		const result = await exchange(
			{
				type: "oauth",
				access: "",
				expires: 0,
				refresh: secret,
				scope: connection.authorization.scope,
				gigachatConnection: connection,
			},
			signal,
			{},
			{ tokenUrl: connection.authorization.tokenUrl, maxRetries: 0 },
		);
		return { ...result, gigachatConnection: connection };
	} catch (error) {
		signal.throwIfAborted();
		throw new ConnectionError(
			"GIGACHAT_AUTH_ERROR",
			error instanceof GigaChatHttpError
				? `GigaChat authorization failed (HTTP ${error.status}). Check the authorization key, token endpoint, and scope in /gigachat.`
				: "GigaChat authorization failed. Check the authorization key, token endpoint, and scope in /gigachat.",
		);
	}
}

export async function prepareConnectionCredential(
	connection: Connection,
	secret: string,
	signal: AbortSignal,
	previous?: ConnectionCredential,
): Promise<ConnectionCredential> {
	signal.throwIfAborted();
	if (!validConnection(connection))
		throw new ConnectionError(
			"GIGACHAT_AUTH_ERROR",
			"Invalid GigaChat connection configuration.",
		);
	const saved = structuredClone(connection);
	const normalized = secret
		.trim()
		.replace(
			saved.authorization.type === "token"
				? /^Bearer(?:\s+|$)/i
				: /^Basic(?:\s+|$)/i,
			"",
		)
		.trim();
	if (!normalized)
		throw new ConnectionError(
			"GIGACHAT_AUTH_ERROR",
			"A GigaChat secret is required.",
		);
	if (saved.authorization.type === "token") {
		// Native key fields interpret !commands/$variables; scoped env values are literal.
		return {
			type: "api_key",
			env: { GIGACHAT_ACCESS_TOKEN: normalized },
			gigachatConnection: saved,
		};
	}
	if (
		validCredential(previous, saved.id) &&
		previous.type === "oauth" &&
		previous.refresh === normalized &&
		previous.expires > Date.now() &&
		previous.gigachatConnection.authorization.type === "credentials" &&
		previous.gigachatConnection.authorization.tokenUrl ===
			saved.authorization.tokenUrl &&
		previous.gigachatConnection.authorization.scope ===
			saved.authorization.scope
	)
		return { ...previous, gigachatConnection: saved };
	return exchangeConnection(saved, normalized, signal);
}

export function createConnectionProvider(
	connection: Connection,
	store: ConnectionStore,
	loginCredential?: ConnectionCredential,
): Provider<typeof GIGACHAT_API> {
	if (!validConnection(connection))
		throw new ConnectionError(
			"GIGACHAT_AUTH_ERROR",
			"Invalid GigaChat connection configuration.",
		);
	const saved = structuredClone(connection);
	const endpoint = baseUrl(saved.baseUrl);
	if (loginCredential) currentCredential(loginCredential, saved);
	const models: Model<typeof GIGACHAT_API>[] = saved.models.map((model) => ({
		...model,
		name: `${model.name} — ${saved.name}`,
		api: GIGACHAT_API,
		provider: saved.id,
		baseUrl: endpoint,
		input: ["text"],
		// Unknown USD prices; zero is not a free-tier claim.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	const selected = new Map(models.map((model) => [model.id, model]));
	const auth: ProviderAuth = {};
	if (saved.authorization.type === "token") {
		auth.apiKey = {
			name: "GigaChat connection access token",
			async login({ signal }) {
				signal.throwIfAborted();
				if (loginCredential?.type !== "api_key")
					throw new ConnectionError(
						"GIGACHAT_AUTH_ERROR",
						"Use /gigachat to enter a GigaChat access token securely.",
					);
				return structuredClone(loginCredential);
			},
			async check({ credential, signal }) {
				signal.throwIfAborted();
				if (!credential) return undefined;
				currentCredential(credential, saved);
				return { type: "api_key", source: saved.name };
			},
			async resolve({ signal }) {
				// Native summaries supply a bare bearer override without our metadata.
				// Read the owning store instead; request env overrides cannot replace its secret.
				const credential = (await store.list(signal)).find(
					(entry) => entry.gigachatConnection.id === saved.id,
				);
				const current = currentCredential(credential, saved);
				if (current.type !== "api_key") throw stale();
				return {
					auth: {
						apiKey: current.env?.GIGACHAT_ACCESS_TOKEN,
						baseUrl: endpoint,
					},
					source: saved.name,
				};
			},
		};
	}
	if (saved.authorization.type === "credentials") {
		auth.oauth = {
			name: "GigaChat connection",
			loginLabel: "Use /gigachat for secure connection setup",
			async login({ signal }) {
				signal.throwIfAborted();
				if (loginCredential?.type !== "oauth")
					throw new ConnectionError(
						"GIGACHAT_AUTH_ERROR",
						"Use /gigachat to enter a GigaChat authorization key securely.",
					);
				return structuredClone(loginCredential);
			},
			async refresh(credential, signal) {
				const current = currentCredential(credential, saved);
				if (current.type !== "oauth") throw stale();
				return exchangeConnection(
					current.gigachatConnection,
					current.refresh,
					signal,
				);
			},
			async toAuth(credential) {
				const current = currentCredential(credential, saved);
				if (current.type !== "oauth") throw stale();
				return { apiKey: current.access, baseUrl: endpoint };
			},
		};
	}
	const stream: typeof streamSimpleGigaChat = (
		model,
		context,
		options = {},
	) => {
		const current = selected.get(model.id);
		if (!current || model.provider !== saved.id) throw stale();
		return streamSimpleGigaChat(current, context, {
			...options,
			// These legacy overrides must not redirect a connection or its selected Model ID.
			env: {
				...options.env,
				GIGACHAT_BASE_URL: endpoint,
				GIGACHAT_EXTRA_BODY: "{}",
			},
		});
	};
	return createProvider({
		id: saved.id,
		name: saved.name,
		baseUrl: endpoint,
		auth,
		models,
		api: { stream, streamSimple: stream },
	});
}

export class ConnectionStore {
	private readonly authPath: string;
	private runtime?: Promise<ModelRuntime>;
	private writes: Promise<void> = Promise.resolve();

	constructor(authPath = join(getAgentDir(), "auth.json")) {
		const expanded =
			authPath === "~"
				? homedir()
				: authPath.startsWith("~/")
					? join(homedir(), authPath.slice(2))
					: authPath;
		this.authPath = resolve(
			expanded.startsWith("file://") ? fileURLToPath(expanded) : expanded,
		);
	}

	async list(signal?: AbortSignal): Promise<ConnectionCredential[]> {
		signal?.throwIfAborted();
		let release: (() => Promise<void>) | undefined;
		let compromised = false;
		try {
			await mkdir(dirname(this.authPath), { recursive: true, mode: 0o700 });
			// Match native FileAuthStorageBackend's lock path, stale window and cancellation.
			const deadline = Date.now() + 30000;
			let retry = 0;
			while (!release) {
				signal?.throwIfAborted();
				try {
					release = await lockfile.lock(this.authPath, {
						realpath: false,
						retries: 0,
						stale: 30000,
						onCompromised: () => {
							compromised = true;
						},
					});
				} catch (error) {
					signal?.throwIfAborted();
					const remaining = deadline - Date.now();
					if (!object(error) || error.code !== "ELOCKED" || remaining <= 0)
						throw error;
					const delay = Math.min(
						Math.round(Math.min(10 * 2 ** retry++, 1000) * (1 + Math.random())),
						remaining,
					);
					await sleep(delay, undefined, { signal });
				}
			}
			signal?.throwIfAborted();
			if (compromised) throw storageError();
			let content: string;
			try {
				content = await readFile(this.authPath, "utf8");
			} catch (error) {
				signal?.throwIfAborted();
				if (compromised) throw storageError();
				if (object(error) && error.code === "ENOENT") return [];
				throw error;
			}
			signal?.throwIfAborted();
			if (compromised) throw storageError();
			const data: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
			if (!object(data)) throw storageError();
			const credentials: ConnectionCredential[] = [];
			for (const [id, credential] of Object.entries(data)) {
				if (!id.startsWith(CONNECTION_PROVIDER_PREFIX)) continue;
				if (!validCredential(credential, id)) throw storageError();
				credentials.push(credential);
			}
			return credentials;
		} catch {
			signal?.throwIfAborted();
			throw storageError();
		} finally {
			await release?.().catch(() => {});
		}
	}

	private nativeRuntime(): Promise<ModelRuntime> {
		this.runtime ??= ModelRuntime.create({
			authPath: this.authPath,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		return this.runtime;
	}

	private write(
		operation: () => Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		const pending = this.writes.then(async () => {
			signal?.throwIfAborted();
			try {
				await operation();
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof ConnectionError) throw error;
				throw storageError();
			}
		});
		this.writes = pending.catch(() => {});
		return signal ? raceWithAbortSignal(pending, signal) : pending;
	}

	async save(
		credential: ConnectionCredential,
		interaction: AuthInteraction,
	): Promise<void> {
		if (!validCredential(credential)) throw storageError();
		const saved = structuredClone(credential);
		return this.write(async () => {
			await this.list(interaction.signal);
			const runtime = await this.nativeRuntime();
			runtime.registerNativeProvider(
				createConnectionProvider(saved.gigachatConnection, this, saved),
			);
			await runtime.login(saved.gigachatConnection.id, saved.type, interaction);
		}, interaction.signal);
	}

	async remove(id: string, signal?: AbortSignal): Promise<void> {
		if (!ownedId(id)) throw storageError();
		return this.write(async () => {
			await this.list(signal);
			await (await this.nativeRuntime()).logout(id, { signal });
		}, signal);
	}
}
