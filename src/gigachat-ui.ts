import { randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { baseUrl } from "./auth.js";
import type {
	Connection,
	ConnectionCredential,
	ConnectionModel,
} from "./connection-types.js";
import {
	CONNECTION_PROVIDER_PREFIX,
	ConnectionStore,
	createConnectionProvider,
	prepareConnectionCredential,
} from "./connections.js";
import { describeDiscoveryError, discoverModels } from "./discovery.js";
import type { FormField } from "./gigachat-dialogs.js";
import { chooseModels, runProgress, showForm } from "./gigachat-dialogs.js";
import {
	GIGACHAT_CONNECTION_DEFAULTS,
	GIGACHAT_DEFAULT_BASE_URL,
} from "./models.js";
import { importMtlsMaterials } from "./mtls.js";

const AUTH_LABELS: Record<Connection["authorization"]["type"], string> = {
	token: "Токен",
	credentials: "Авторизационный ключ",
	mtls: "Сертификаты (mTLS)",
};
const scopes = ["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"];
const authModes = Object.keys(
	AUTH_LABELS,
) as Connection["authorization"]["type"][];
const defaultTokenUrl = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";

class FormError extends Error {}

export async function registerGigaChatCommand(pi: ExtensionAPI): Promise<void> {
	const store = new ConnectionStore();
	const registered = new Map<string, string>();
	let records: ConnectionCredential[] = [];
	let initialError: unknown;
	let busy = false;
	let unavailableSelection: string | undefined;
	let unavailableModelChangeId: string | undefined;

	function latestModelChange(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "model_change") return entry;
		}
		return undefined;
	}

	function refreshSelectionGuard(ctx: ExtensionContext): void {
		if (!unavailableSelection) return;
		const entry = latestModelChange(ctx);
		// Pi records explicit same-model selection but emits no model_select event.
		if (
			entry &&
			entry.id !== unavailableModelChangeId &&
			entry.provider === ctx.model?.provider &&
			entry.modelId === ctx.model.id &&
			ctx.modelRegistry.find(entry.provider, entry.modelId)
		)
			unavailableSelection = undefined;
	}

	async function synchronize(ctx?: ExtensionContext): Promise<void> {
		records = await store.list();
		const ids = new Set(records.map((record) => record.gigachatConnection.id));
		for (const id of registered.keys()) {
			if (!ids.has(id)) {
				pi.unregisterProvider(id);
				registered.delete(id);
			}
		}
		for (const record of records) {
			const connection = record.gigachatConnection;
			if (registered.get(connection.id) === connection.revision) continue;
			pi.registerProvider(createConnectionProvider(connection, store));
			registered.set(connection.id, connection.revision);
		}
		if (ctx) await ctx.modelRegistry.refresh({ allowNetwork: false });
	}

	try {
		await synchronize();
	} catch (error) {
		initialError = error;
	}
	pi.on("model_select", () => {
		unavailableSelection = undefined;
	});
	pi.on("input", (_event, ctx) => {
		refreshSelectionGuard(ctx);
		if (!unavailableSelection) return;
		ctx.ui.notify(unavailableSelection, "error");
		return { action: "handled" };
	});
	pi.on("session_before_compact", (_event, ctx) => {
		refreshSelectionGuard(ctx);
		if (!unavailableSelection) return;
		ctx.ui.notify(unavailableSelection, "error");
		return { cancel: true };
	});
	pi.on("session_before_tree", (event, ctx) => {
		refreshSelectionGuard(ctx);
		if (!unavailableSelection || !event.preparation.userWantsSummary) return;
		ctx.ui.notify(unavailableSelection, "error");
		return { cancel: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		unavailableSelection = undefined;
		if (initialError) {
			ctx.ui.notify(describeDiscoveryError(initialError), "error");
			unavailableSelection = describeDiscoveryError(initialError);
			return;
		}
		await synchronize(ctx);
		// Factory registrations are flushed after SDK initial-model resolution.
		// Restore a saved connection identity without discovery or paid probes.
		if (process.argv.some((arg) => /^(--model|--provider)(=|$)/.test(arg)))
			return;
		let reference: { provider: string; id: string } | undefined;
		let thinking: Parameters<ExtensionAPI["setThinkingLevel"]>[0] | undefined;
		const branch = ctx.sessionManager.getBranch();
		const hasHistory = branch.some(
			(entry) =>
				entry.type === "message" ||
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				entry.type === "custom_message",
		);
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (!reference && entry.type === "model_change")
				reference = { provider: entry.provider, id: entry.modelId };
			else if (
				!reference &&
				entry.type === "message" &&
				entry.message.role === "assistant"
			)
				reference = {
					provider: entry.message.provider,
					id: entry.message.model,
				};
			if (!thinking && entry.type === "thinking_level_change") {
				const level = entry.thinkingLevel;
				if (
					level === "off" ||
					level === "minimal" ||
					level === "low" ||
					level === "medium" ||
					level === "high" ||
					level === "xhigh" ||
					level === "max"
				)
					thinking = level;
			}
			if (reference && thinking) break;
		}
		if (!hasHistory) {
			const settings = SettingsManager.create(ctx.cwd);
			const provider = settings.getDefaultProvider();
			const id = settings.getDefaultModel();
			if (provider?.startsWith(CONNECTION_PROVIDER_PREFIX) && id)
				reference = { provider, id };
		}
		if (!reference?.provider.startsWith(CONNECTION_PROVIDER_PREFIX)) return;
		const model = ctx.modelRegistry.find(reference.provider, reference.id);
		if (!model) {
			unavailableSelection =
				"Сохранённая модель подключения недоступна. Выберите другую через /model или откройте /gigachat. Запросы к другому серверу заблокированы.";
			unavailableModelChangeId = latestModelChange(ctx)?.id;
			ctx.ui.notify(unavailableSelection, "error");
			return;
		}
		if (
			ctx.model?.provider === reference.provider &&
			ctx.model.id === reference.id
		)
			return;
		if (!(await pi.setModel(model))) {
			unavailableSelection =
				"Не удалось восстановить авторизацию выбранного подключения. Откройте /gigachat или выберите другую модель через /model.";
			unavailableModelChangeId = latestModelChange(ctx)?.id;
			ctx.ui.notify(unavailableSelection, "error");
		} else if (thinking) pi.setThinkingLevel(thinking);
	});

	async function promptAuth(
		ctx: ExtensionContext,
		prompt: AuthPrompt,
		signal: AbortSignal,
	): Promise<string> {
		if (prompt.type === "select") {
			const labels = prompt.options.map((option) => option.label);
			const chosen = await ctx.ui.select(prompt.message, labels, {
				signal: prompt.signal ?? signal,
			});
			const option = prompt.options.find((item) => item.label === chosen);
			if (!option) throw new DOMException("Cancelled", "AbortError");
			return option.id;
		}
		const values = await showForm(
			ctx,
			prompt.message,
			[
				{
					id: "value",
					label: prompt.message,
					placeholder: prompt.placeholder,
					secret: prompt.type === "secret",
				},
			],
			[],
			prompt.signal ?? signal,
		);
		if (!values) throw new DOMException("Cancelled", "AbortError");
		return values.value;
	}

	async function persist(
		ctx: ExtensionCommandContext,
		credential: ConnectionCredential,
		previousId?: string,
	): Promise<boolean> {
		const connection = credential.gigachatConnection;
		const result = await runProgress(
			ctx,
			"Сохранение подключения",
			async (signal) => {
				if (
					(ctx.model?.provider === connection.id ||
						ctx.model?.provider === previousId) &&
					!ctx.isIdle()
				) {
					ctx.abort();
					await ctx.waitForIdle();
				}
				signal.throwIfAborted();
				const interaction: AuthInteraction = {
					signal,
					prompt: (prompt) => promptAuth(ctx, prompt, signal),
					notify: () =>
						ctx.ui.setStatus("gigachat", "Сохранение авторизации GigaChat"),
				};
				try {
					await store.save(credential, interaction, previousId);
				} finally {
					await synchronize(ctx);
					ctx.ui.setStatus("gigachat", undefined);
				}
				const current = ctx.model;
				if (
					previousId &&
					previousId !== connection.id &&
					current?.provider === previousId
				) {
					unavailableSelection =
						"Подключение переименовано. Выберите модель нового подключения через /model. Ссылки в прежних сессиях и настройках не изменены.";
					unavailableModelChangeId = latestModelChange(ctx)?.id;
					ctx.ui.notify(unavailableSelection, "warning");
				}
				if (
					current?.provider === connection.id &&
					connection.models.some((model) => model.id === current.id)
				) {
					const refreshed = ctx.modelRegistry.find(connection.id, current.id);
					if (refreshed) await pi.setModel(refreshed);
				}
			},
		);
		if (!result) return false;
		if ("error" in result) {
			ctx.ui.notify(describeDiscoveryError(result.error), "error");
			return false;
		}
		ctx.ui.notify(
			`Подключение «${connection.name}» сохранено. Модели: ${connection.models.map((model) => model.id).join(", ")}. Выберите модель через /model.`,
			"info",
		);
		return true;
	}

	async function verifyAndChoose(
		ctx: ExtensionCommandContext,
		draft: Connection,
		secret: string,
		previous?: ConnectionCredential,
	): Promise<ConnectionCredential | undefined> {
		const checked = await runProgress(
			ctx,
			"Проверка подключения GigaChat",
			async (signal, update) => {
				update(
					draft.authorization.type === "credentials"
						? "Получение временного токена…"
						: "Получение каталога моделей…",
				);
				const credential = await prepareConnectionCredential(
					draft,
					secret,
					signal,
					previous,
				);
				const token =
					credential.type === "oauth"
						? credential.access
						: (credential.env?.GIGACHAT_ACCESS_TOKEN ?? "");
				const probes = await discoverModels(draft.baseUrl, token, {
					signal,
					mtls:
						draft.authorization.type === "mtls"
							? draft.authorization.materials
							: undefined,
					progress: (completed, total, probe) =>
						update(
							`Проверка моделей: ${completed}/${total}${probe ? ` · ${probe.model.id}: ${probe.status === "available" ? "доступна" : probe.reason}` : ""}`,
						),
				});
				return { credential, probes };
			},
		);
		if (!checked) return undefined;
		if ("error" in checked) throw checked.error;
		if (checked.value.probes.length === 0)
			throw new FormError("Сервер не вернул модели. Подключение не сохранено.");
		if (!checked.value.probes.some((probe) => probe.status === "available")) {
			await chooseModels(ctx, checked.value.probes);
			throw new FormError(
				"Нет успешно проверенных моделей. Подключение не сохранено.",
			);
		}
		const models = await chooseModels(
			ctx,
			checked.value.probes,
			previous?.gigachatConnection.models,
		);
		if (!models) return undefined;
		checked.value.credential.gigachatConnection.models = models;
		return checked.value.credential;
	}

	async function configure(
		ctx: ExtensionCommandContext,
		mode: Connection["authorization"]["type"],
		previous?: ConnectionCredential,
	): Promise<void> {
		const old = previous?.gigachatConnection;
		const oldSecret =
			previous?.type === "oauth"
				? previous.refresh
				: (previous?.env?.GIGACHAT_ACCESS_TOKEN ?? "");
		let values: Record<string, string> = {
			name: old?.name ?? "",
			url: old?.baseUrl ?? "",
			tokenUrl:
				old?.authorization.type === "credentials"
					? old.authorization.tokenUrl
					: "",
			scope:
				old?.authorization.type === "credentials"
					? old.authorization.scope
					: scopes[0],
			secret: "",
			caPath: "",
			certPath: "",
			keyPath: "",
			passphrase: "",
		};
		for (;;) {
			const fields: FormField[] = [
				{
					id: "name",
					label: "Название подключения",
					value: values.name,
					placeholder: "LDBR",
				},
				{
					id: "url",
					label: "API URL (корень, без /models и /chat/completions)",
					value: values.url,
					placeholder: GIGACHAT_DEFAULT_BASE_URL,
				},
			];
			if (mode === "credentials")
				fields.push({
					id: "tokenUrl",
					label: "URL получения временных токенов",
					value: values.tokenUrl,
					placeholder: defaultTokenUrl,
				});
			if (mode === "mtls") {
				const retained = old?.authorization.type === "mtls";
				for (const [id, label] of [
					["caPath", "Путь к PEM CA"],
					["certPath", "Путь к PEM сертификату клиента"],
					["keyPath", "Путь к PEM приватному ключу"],
				])
					fields.push({
						id,
						label,
						value: values[id],
						placeholder: retained
							? "Все три пути пусты — сохранить импортированный набор"
							: "Обязательный путь к файлу",
					});
				fields.push({
					id: "passphrase",
					label: "Пароль PEM ключа (необязательно, скрытый ввод)",
					secret: true,
				});
			} else
				fields.push({
					id: "secret",
					label:
						mode === "token"
							? "Токен доступа (скрытый ввод)"
							: "Авторизационный ключ (скрытый ввод)",
					value: values.secret,
					secret: true,
					placeholder:
						old?.authorization.type === mode
							? "Пусто — сохранить текущий секрет"
							: undefined,
				});
			const entered = await showForm(
				ctx,
				`${previous ? "Изменить" : "Добавить"} подключение · ${AUTH_LABELS[mode]}`,
				fields,
				mode === "credentials"
					? [
							{
								id: "scope",
								label: "Scope",
								value: values.scope,
								choices: scopes,
							},
						]
					: [],
			);
			if (!entered) return;
			values = { ...values, ...entered };
			try {
				const name = stripVTControlCharacters(values.name)
					.replace(/[\p{Cc}\p{Cf}]/gu, " ")
					.trim();
				if (!name) throw new FormError("Укажите название подключения.");
				const renamed = !old || name !== old.name;
				if (renamed && !/^[A-Za-z0-9_-]+$/.test(values.name))
					throw new FormError(
						"Название должно содержать только латинские буквы, цифры, дефис и подчёркивание.",
					);
				const id = renamed ? `${CONNECTION_PROVIDER_PREFIX}${name}` : old.id;
				if (id !== old?.id && ctx.modelRegistry.getProvider(id))
					throw new FormError(
						`Идентификатор провайдера «${id}» уже занят. Выберите другое название подключения.`,
					);
				await store.assertAvailable(id, old?.id);
				const url = baseUrl(values.url.trim() || GIGACHAT_DEFAULT_BASE_URL);
				if (mode === "mtls" && new URL(url).protocol !== "https:")
					throw new FormError("Для mTLS API URL должен использовать HTTPS.");
				const tokenUrl =
					mode === "credentials"
						? values.tokenUrl.trim() ||
							(url === GIGACHAT_DEFAULT_BASE_URL ? defaultTokenUrl : "")
						: "";
				if (mode === "credentials" && !tokenUrl)
					throw new FormError(
						"Для нестандартного сервера укажите URL получения токенов.",
					);
				let authorization: Connection["authorization"] = { type: "token" };
				if (mode === "credentials") {
					const endpoint = new URL(tokenUrl);
					if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
						throw new FormError(
							"URL получения токенов должен использовать HTTP или HTTPS.",
						);
					authorization = {
						type: "credentials",
						tokenUrl: endpoint.href,
						scope: values.scope,
					};
				}
				if (mode === "mtls") {
					const paths = {
						caPath: values.caPath.trim(),
						certPath: values.certPath.trim(),
						keyPath: values.keyPath.trim(),
					};
					const count = Object.values(paths).filter(Boolean).length;
					if (count !== 0 && count !== 3)
						throw new FormError(
							"Для импорта укажите все три пути: CA, сертификат и ключ.",
						);
					if (count === 0) {
						if (old?.authorization.type !== "mtls")
							throw new FormError(
								"Укажите пути к CA, сертификату и приватному ключу.",
							);
						if (values.passphrase)
							throw new FormError(
								"Пароль используется только при импорте: укажите все три пути.",
							);
						authorization = old.authorization;
					} else {
						if (
							!(await ctx.ui.confirm(
								"Импорт приватного ключа mTLS",
								"Приватный ключ будет расшифрован и сохранён в plaintext (открытом виде) в auth.json. Его защита зависит от файловых прав auth.json. Пароль не сохраняется. Исходные PEM файлы после сохранения не нужны. Продолжить?",
							))
						)
							return;
						const imported = await runProgress(
							ctx,
							"Импорт сертификатов mTLS",
							async (signal) => {
								try {
									return await importMtlsMaterials(
										{
											...paths,
											passphrase: values.passphrase || undefined,
										},
										signal,
									);
								} finally {
									values.passphrase = "";
									entered.passphrase = "";
								}
							},
						);
						if (!imported) return;
						if ("error" in imported) throw imported.error;
						authorization = { type: "mtls", materials: imported.value };
					}
				}
				const draft: Connection = {
					id,
					revision: randomBytes(12).toString("hex"),
					name,
					baseUrl: url,
					authorization,
					models: old?.models ?? [],
				};
				const sameAuthorization =
					old?.authorization.type === authorization.type &&
					(authorization.type === "token" ||
						(authorization.type === "mtls"
							? old.authorization.type === "mtls" &&
								old.authorization.materials === authorization.materials
							: old.authorization.type === "credentials" &&
								old.authorization.tokenUrl === authorization.tokenUrl &&
								old.authorization.scope === authorization.scope));
				const changedEndpointOrSecret =
					!old ||
					old.baseUrl !== draft.baseUrl ||
					!sameAuthorization ||
					Boolean(values.secret.trim());
				let credential: ConnectionCredential | undefined;
				if (previous && !changedEndpointOrSecret && !renamed)
					credential = { ...previous, gigachatConnection: draft };
				else {
					const secret =
						values.secret.trim() ||
						(old?.authorization.type === mode ? oldSecret : "");
					if (mode !== "mtls" && !secret)
						throw new FormError(
							"Введите секрет выбранного способа авторизации.",
						);
					credential = await verifyAndChoose(
						ctx,
						draft,
						mode === "mtls" ? "" : secret,
						previous,
					);
				}
				if (!credential) return;
				if (await persist(ctx, credential, old?.id)) {
					values.secret = "";
					return;
				}
			} catch (error) {
				ctx.ui.notify(
					error instanceof FormError
						? error.message
						: describeDiscoveryError(error),
					"error",
				);
			} finally {
				values.passphrase = "";
				entered.passphrase = "";
			}
		}
	}

	async function editModelParameters(
		ctx: ExtensionCommandContext,
		record: ConnectionCredential,
	): Promise<void> {
		const connection = record.gigachatConnection;
		const labels = connection.models.map(
			(model) => `${model.id} — ${model.name}`,
		);
		const selected = await ctx.ui.select("Параметры модели", labels);
		const index = labels.indexOf(selected ?? "");
		if (index < 0) return;
		const model = connection.models[index];
		let values = {
			context: String(model.contextWindow),
			output: String(model.maxTokens),
			temperature:
				model.temperature === undefined ? "" : String(model.temperature),
			reasoning: model.reasoning ? "Поддерживается" : "Не поддерживается",
		};
		for (;;) {
			const entered = await showForm(ctx, `Параметры · ${model.id}`, [
				{ id: "context", label: "Лимит контекста", value: values.context },
				{ id: "output", label: "Лимит ответа", value: values.output },
				{
					id: "temperature",
					label: "Температура (пусто — по умолчанию)",
					value: values.temperature,
				},
				{
					id: "reasoning",
					label: "Reasoning",
					value: values.reasoning,
					choices: ["Поддерживается", "Не поддерживается"],
				},
			]);
			if (!entered) return;
			values = {
				context: entered.context,
				output: entered.output,
				temperature: entered.temperature,
				reasoning: entered.reasoning,
			};
			const contextWindow = Number(values.context);
			const maxTokens = Number(values.output);
			if (
				!Number.isSafeInteger(contextWindow) ||
				contextWindow < 1 ||
				!Number.isSafeInteger(maxTokens) ||
				maxTokens < 1
			) {
				ctx.ui.notify(
					"Лимиты должны быть положительными целыми числами.",
					"error",
				);
				continue;
			}
			const temperature =
				values.temperature.trim() === ""
					? undefined
					: Number(values.temperature);
			if (
				temperature !== undefined &&
				(!Number.isFinite(temperature) || temperature < 0)
			) {
				ctx.ui.notify(
					"Температура должна быть конечным числом не меньше 0.",
					"error",
				);
				continue;
			}
			const reasoning = values.reasoning === "Поддерживается";
			const edited: ConnectionModel = {
				...model,
				contextWindow,
				maxTokens,
				temperature,
				reasoning,
				thinkingLevelMap: reasoning
					? (model.thinkingLevelMap ??
						GIGACHAT_CONNECTION_DEFAULTS.thinkingLevelMap)
					: undefined,
			};
			const models = connection.models.slice();
			models[index] = edited;
			const credential = {
				...record,
				gigachatConnection: {
					...connection,
					revision: randomBytes(12).toString("hex"),
					models,
				},
			};
			if (await persist(ctx, credential, connection.id)) return;
		}
	}

	async function manage(ctx: ExtensionCommandContext): Promise<void> {
		const counts = new Map<string, number>();
		const labels: string[] = [];
		for (const record of records) {
			const connection = record.gigachatConnection;
			const label = `${connection.name} · ${connection.baseUrl}`;
			labels.push(label);
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		for (let index = 0; index < labels.length; index++) {
			if (counts.get(labels[index]) !== 1)
				labels[index] +=
					` · #${records[index].gigachatConnection.id.slice(CONNECTION_PROVIDER_PREFIX.length)}`;
		}
		const selected = await ctx.ui.select("Подключения GigaChat", labels);
		const record = records[labels.indexOf(selected ?? "")];
		if (!record) return;
		const connection = record.gigachatConnection;
		const action = await ctx.ui.select(
			`«${connection.name}» · ${connection.models.length} моделей`,
			[
				"Изменить подключение",
				"Обновить каталог и выбор моделей",
				"Параметры моделей",
				"Удалить подключение",
			],
		);
		if (action === "Изменить подключение") {
			const modes = [
				connection.authorization.type,
				...authModes.filter((mode) => mode !== connection.authorization.type),
			];
			const selected = await ctx.ui.select(
				"Авторизация",
				modes.map((mode) => AUTH_LABELS[mode]),
			);
			const mode = modes.find((mode) => AUTH_LABELS[mode] === selected);
			if (mode) await configure(ctx, mode, record);
		} else if (action === "Параметры моделей")
			await editModelParameters(ctx, record);
		else if (action === "Обновить каталог и выбор моделей") {
			try {
				const draft = {
					...connection,
					revision: randomBytes(12).toString("hex"),
				};
				const secret =
					record.type === "oauth"
						? record.refresh
						: (record.env?.GIGACHAT_ACCESS_TOKEN ?? "");
				const credential = await verifyAndChoose(ctx, draft, secret, record);
				if (credential) await persist(ctx, credential, connection.id);
			} catch (error) {
				ctx.ui.notify(
					error instanceof FormError
						? error.message
						: describeDiscoveryError(error),
					"error",
				);
			}
		} else if (action === "Удалить подключение") {
			if (
				!(await ctx.ui.confirm(
					"Удалить подключение?",
					`«${connection.name}»: будут удалены секрет и все ${connection.models.length} модели. Активная операция этого подключения будет прервана. Другой сервер автоматически не выбирается.`,
				))
			)
				return;
			const result = await runProgress(
				ctx,
				"Удаление подключения",
				async (signal) => {
					if (ctx.model?.provider === connection.id && !ctx.isIdle()) {
						ctx.abort();
						await ctx.waitForIdle();
					}
					signal.throwIfAborted();
					try {
						await store.remove(connection.id, signal);
					} finally {
						await synchronize(ctx);
					}
				},
			);
			if (result && "error" in result)
				ctx.ui.notify(describeDiscoveryError(result.error), "error");
			else if (result)
				ctx.ui.notify(
					`Подключение «${connection.name}» удалено. Если его модель была выбрана, выберите или добавьте другую через /model или /gigachat.`,
					"info",
				);
		}
	}

	pi.registerCommand("gigachat", {
		description:
			"Добавить сервер GigaChat, выбрать модели и управлять подключениями",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"Мастер /gigachat доступен в интерактивном терминале Pi.",
					"warning",
				);
				return;
			}
			if (busy) {
				ctx.ui.notify("Мастер GigaChat уже открыт.", "warning");
				return;
			}
			busy = true;
			try {
				await synchronize(ctx);
				const options = [
					AUTH_LABELS.token,
					AUTH_LABELS.credentials,
					AUTH_LABELS.mtls,
					...(records.length ? ["Управление подключениями"] : []),
				];
				const choice = await ctx.ui.select(
					"GigaChat · способ авторизации",
					options,
				);
				if (choice === "Управление подключениями") await manage(ctx);
				else {
					const mode = authModes.find((mode) => AUTH_LABELS[mode] === choice);
					if (mode) await configure(ctx, mode);
				}
			} catch (error) {
				ctx.ui.notify(describeDiscoveryError(error), "error");
			} finally {
				busy = false;
			}
		},
	});
}
