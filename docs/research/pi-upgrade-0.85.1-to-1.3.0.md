# Pi 0.85.1 → 1.3.0: контракт провайдера и последствия для pi-gigachat

Дата исследования: **21 октября 2026 года**. Исследовано рабочее дерево `@dev-sergeev/pi-gigachat`: при создании изолированного снимка manifest показывал **0.6.4**, к завершению исследования — **0.6.5**. Целевая версия — именно **Pi 1.3.0**, а не плавающий `latest`.

> Последующий этап: миграция реализована в `pi-gigachat` **0.7.1** для Pi **1.3.0**; актуальные изменения описаны в [README](../../README.md#release-071). Ниже сохранён исторический отчёт об исходном снимке до переноса, а не описание текущей совместимости.

**Вывод:** механизм добавления native-провайдера не заменён: `createProvider({...})` → `pi.registerProvider(provider)` остаётся подходящим для GigaChat. Основной разрыв — **входной контекст стриминга с 0.86.0**. Дополнительно нужны корректные JSON-типы аргументов инструментов, согласование встроенных helper-функций с 1.3.0, hooks наблюдения и обновление ограничений версии. Простое обновление зависимостей или снятие version guard не обеспечивает совместимость.

Это исследование, **не выполненная миграция**. Исходный код, manifest, lockfile, существующие тесты и сборка проекта автором исследования не изменялись. Добавлена только эта заметка. Проверки выполнялись на копиях в `/tmp`, с синтетическими credentials, без запросов к GigaChat и без пользовательского `auth.json`.

## 1. Источники и границы доказательств

Использованы исходники двух тегов и опубликованные npm-пакеты:

- [`v0.85.1`](https://github.com/earendil-works/pi/tree/v0.85.1), commit `d981de1229ef899957bbe968bc8dcda02a21f477`.
- [`v1.3.0`](https://github.com/earendil-works/pi/tree/v1.3.0), commit `71023aec1546d6d677a65669c5665c0927ce0dd0`.
- Опубликованные [`pi-ai@1.3.0`](https://registry.npmjs.org/@earendil-works/pi-ai/1.3.0), [`pi-coding-agent@1.3.0`](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.3.0), [`pi-tui@1.3.0`](https://registry.npmjs.org/@earendil-works/pi-tui/1.3.0), установленные отдельно от проекта.
- [Changelog Pi AI](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md), [Coding Agent](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md), [руководство custom provider](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md).

Локальный снимок включает `src/`, `package.json`, `tsconfig.json` и сгенерированный **корневой `extension.ts`**. Во время исследования вне действий автора entrypoint изменился с `extension.js` на `extension.ts`, затем версия manifest — на 0.6.5; итоговые runtime-проверки выполнены с копией `extension.ts` и уже существовавшим version guard. Это **не аудит опубликованного npm pi-gigachat 0.6.4**: его tarball не исследовался. Текущий [README](../../README.md#L25-L35) относит guard и `.ts` entrypoint к 0.6.5, а опубликованный 0.6.4 описывает как не имеющий runtime guard. Выводы о срабатывании guard относятся к проверенному рабочему коду, не задним числом к опубликованному 0.6.4. Старую заметку [до 1.0.1](pi-upgrade-0.85.1-to-1.0.1.md) нельзя механически применять: там другой снимок кода, состав зависимостей и имя entrypoint.

Ниже «подтверждено» означает чтение первичного исходника и/или указанный запуск. Рекомендации будущего переноса не означают, что предложенный перенос уже проверен целиком.

## 2. Какие релизы существенны

| Версия | Изменение | Значение для pi-gigachat |
| --- | --- | --- |
| 0.86.0 | Provider-facing `Context` заменён на нормализованный `TranscriptContext`; system/tool state находится в сообщениях; JSON-совместимые `ToolCall.arguments` и `ToolResultMessage.details`; metadata времени жизни prompt cache | Обязательна адаптация контекста и JSON-типов. Cache warming — не обязательная возможность |
| 0.86.1 | Meta Muse, исправления провайдеров и запуска | Новый API регистрации GigaChat не вводится |
| 0.87.0 | `SessionManager` — канонический источник контекста; `context_edit`, `context_with_system`, новые actionable boundaries; `finishTurn` вместо `shouldStopAfterTurn` | Адаптер должен потреблять переданный контекст, не восстанавливать его самостоятельно из UI-истории. Перечисленные agent hooks текущий пакет не реализует |
| 0.87.1 | Каталоги моделей и исправления compaction/image input | Отдельной формы регистрации GigaChat не требует |
| 0.99.0 | MCP, codemode, tool search, virtual models; единый `Provider` для chat/image/classifier; `onProviderStreamEvent` | Следить за динамическими инструментами и наблюдением событий. Chat-only provider допустим без новых операций |
| 0.99.2 | Лёгкий entrypoint `pi-ai/models`; исправлена стартовая доступность extension native-provider со stored credential | Важно для сохранённого default model; прежний workaround восстановления нужно пересмотреть, а не безусловно удалять |
| 1.0.0 | Fullscreen TUI по умолчанию; доступ к image generation из codemode | Нужна визуальная проверка мастера `/gigachat`; генерация изображений не обязательна |
| 1.0.1 | Убрана публикация `npm-shrinkwrap.json`; новые tool renderers; изменения Anthropic inline tools | Контроль реально установленного набора Pi-пакетов и схем инструментов; новый renderer провайдеру не нужен |
| 1.0.2 | `samplingParamsByThinkingLevel` для OpenAI-compatible adapters | Не становится автоматической возможностью custom GigaChat stream |
| 1.0.3 | OAuth refresh, уже начатый до отмены запроса, завершается и сохраняет ротированный token; переименован Azure provider | Семантика отмены OAuth существенна; переименование Azure не означает переименования GigaChat |
| 1.0.4 | Уточнения tool loadout, MCP и codemode, исправления остановки | Проверять фактические текущие declarations, а не фиксированный список встроенных функций |
| 1.1.0 | Stream обязан возвращать `AssistantMessageEventStream`; автоматический `durationMs`; `aborted` в `agent_settled` | Текущий factory потока уже подходит; собственный таймер не нужен |
| 1.2.0 | `RefreshModelsContext.baseUrl`; `before_agent_start` — union user/custom и новая семантика busy; удалены source-only experimental stack и chord dependency | Новый refresh URL полезен при будущем native discovery; текущие используемые lifecycle hooks не требуют перехода на `before_agent_start` |
| 1.3.0 | Чужие thinking blocks удаляются вместо превращения в текст; строгая финализация аргументов инструментов через `argumentsError`; Pi-зависимости закреплены точно; исправлено восстановление активных инструментов и выбор неоднозначного model ID; удалены assistant frames | Нельзя оставлять старый встроенный `transformMessages`. Проверить malformed arguments, несколько подключений с одинаковым Model ID и resume |

Фактическая последовательность changelog: **0.87.1 → 0.99.0**, а не все промежуточные числовые версии. Даты и изменения: [Pi AI changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L3-L279), [Coding Agent changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L3-L565). Таблица выделяет последствия для интеграции, а не перечисляет все новые модели и исправления интерфейса Pi.

## 3. Как теперь добавлять провайдера — и что не изменилось

### 3.1. Native Provider остаётся основным вариантом

**Уже в 0.85.1** существовали обе формы:

```ts
pi.registerProvider(createProvider({ id, auth, models, api }));
pi.registerProvider(providerId, legacyConfig);
```

В 1.3.0 обе формы сохранены. Полный `Provider` рекомендован, когда интеграция владеет авторизацией, discovery, фильтрацией или streaming. `pi-gigachat` уже находится на этой стороне API: [`gigachatProvider`](../../src/index.ts#L9), [`createConnectionProvider`](../../src/connections.ts#L294). Переписывать его в legacy `ProviderConfig` ради обновления не требуется.

Источники: [0.85.1 quick reference](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/custom-provider.md#L31-L91), [1.3.0 register a provider](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L19-L70).

Для native `createProvider` по-прежнему задаются `id`, `auth`, `models` и реализация операции. Для обычного chat-провайдера подходит существующее `api: { stream, streamSimple }`. В 1.3.0 `api` формально optional только потому, что допускаются image-only/classifier-only providers: **как минимум одна реальная реализация** среди `api`, `images`, `classifiers` всё равно обязательна. Пустая карта операций не является рабочим провайдером. Источник: [`CreateProviderOptions` и `createProvider`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L1002-L1059).

### 3.2. Момент регистрации, повторная регистрация, удаление

- Pi ожидает async extension factory. Провайдеры, нужные при выборе стартовой модели, нужно регистрировать в factory, а не впервые в `session_start`. Это было правилом уже в 0.85.1.
- Регистрация после загрузки применяется к активному runtime; текущий `synchronize()` может обновлять подключения и выбранные модели без перезапуска.
- Native registration заменяет provider под тем же ID. Legacy re-registration имеет отдельную merge-семантику: определённые значения заменяют прежние, `undefined` не очищает их. Эти два контракта нельзя смешивать.
- `unregisterProvider(id)` убирает extension registration и восстанавливает базовый provider, если такой был. Это **не logout** и не обещание удалить credential.
- Provider ID — ключ авторизации и часть идентичности модели. Наличие API upsert не отменяет проверки конфликта ID на уровне приложения.

Источники: [регистрация в factory](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L19-L70), [`ModelRuntime.registerNativeProvider/registerProvider/unregisterProvider`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/model-runtime.ts#L891-L957), [`CredentialStore`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/auth/types.ts#L36-L94).

Локальное соответствие: [`synchronize`](../../src/gigachat-ui.ts#L71) уже загружает сохранённые подключения во время factory, затем обновляет их в lifecycle. Сохранять правило **одно подключение сервера → один provider**; одинаковые Model ID разных подключений не объединять. Это доменный контракт [ADR](../adr/0001-server-connection-identity.md), а не ограничение, которое новый Pi отменил.

До binding Pi держит native и legacy registrations в отдельных очередях; legacy flush выполняется раньше native. Поэтому при смешении форм нельзя обещать общий порядок «последний по времени вызов побеждает». Queued registration failure оформляется как extension error, а после binding вызов идёт непосредственно в runtime. Это сохранённая особенность, не новый способ добавления провайдера. Источник: [`ExtensionRunner` queues и binding](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/runner.ts#L470-L545).

### 3.3. `models.json` и переопределения

Здесь различаются **два контракта**. `models.json.providers[id].models` делает chat-only **upsert** поверх базового каталога: добавляет новые модели или заменяет совпавшие chat Model ID, сохраняя прочие модели и операции. Это не allowlist. А явный `models` в **legacy extension `ProviderConfig`** заменяет каталог регистрации; с 0.99.0 replacement охватывает сразу все операции. Legacy endpoint/header override без `models` сохраняет каталог. Источники: [`applyModelsJson` против `applyExtension`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/provider-composer.ts#L300-L350), [уточнение «in the legacy form»](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L25-L33).

Для GigaChat это не основание разрешать перенаправление сохранённого подключения: [`createConnectionProvider`](../../src/connections.ts#L385) намеренно фиксирует endpoint и выбранный Model ID. При переносе проверить совместную работу `models.json`, model headers и защиты подключения; не менять эту политику молча. Источники: [custom provider composition](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L25-L68), [`ModelRuntime.composeProvider`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/model-runtime.ts#L298-L323).

## 4. Главная несовместимость: TranscriptContext

### 4.1. Два уровня контекста

| Уровень | 0.85.1 | 1.3.0 |
| --- | --- | --- |
| Публичный `Models.streamSimple/completeSimple` | `Context` с `systemPrompt`, `tools`, `messages` | По-прежнему принимает `Context` как удобный публичный ввод |
| `Provider.stream/streamSimple`, API implementation | `Context` | Нормализованный `TranscriptContext`: только `messages` с system/tool declarations внутри |
| System/tool updates внутри истории | Не новый provider-facing контракт | `role: "system"`, `sections`, `toolsAdded`, `toolsRemoved` |

`Models` вызывает `normalizeContext()` до передачи управления провайдеру. То, что пример библиотеки продолжает вызывать `completeSimple(model, { systemPrompt, tools, messages })`, **не означает**, что stream-провайдер получает эти поля.

Источники: [breaking change 0.86.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L238-L247), [`Context`/`TranscriptContext`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L765-L788), [`Models.streamSimple`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L907-L921).

### 4.2. Почему текущий адаптер падает

[`streamSimpleGigaChat`](../../src/stream.ts#L115) принимает старый `Context`. [`payload`](../../src/stream.ts#L60) читает `context.tools`, [`convertMessages`](../../src/messages.ts#L20) — `context.systemPrompt`. Конвертер обрабатывает user/assistant, а остальные сообщения считает tool result. Новое системное сообщение со строковым `content` попадает в этот fallback и вызывает `.filter()` у строки.

**Воспроизведено на текущем сгенерированном entrypoint и Pi AI 1.3.0:**

```text
stopReason: error
errorMessage: message.content.filter is not a function
fetchCalls: 0
```

Это не ошибка сервера, OAuth или TLS: отправка запроса ещё не началась. Если входной transcript случайно не содержит system messages, падения может не быть; это не доказывает поддержку промпта и инструментов.

Тонкость TypeScript: `Context.systemPrompt/tools` optional, поэтому структурная совместимость не гарантирует обнаружение этой ошибки компилятором. На полном снимке `src/` компилятор сообщил JSON-ошибку, но **не сообщил отдельную ошибку типа контекста**. Нужен поведенческий smoke, не только `tsc`.

### 4.3. Что требуется от будущего адаптера

Для сохранения нынешней схемы GigaChat с одним ведущим system message нужна свёртка актуального состояния transcript:

1. `getCurrentSystemPrompt(messages)` — получить базовый текст, дополнительные инструкции и итоговые именованные секции.
2. `getCurrentTools(messages)` — применить удаления, добавления и переопределения инструментов по имени.
3. Исключить `role: "system"` из обычной истории перед текущей GigaChat-конвертацией.
4. Дополнительный GigaChat system prompt добавить один раз, без изменения истории Pi.

Либо использовать `collapseSystemMessages(context)`, который строит одно актуальное ведущее system message, и дальше корректно извлечь prompt/tools. Не нужно сворачивать transcript несколько раз или трактовать system/tool deltas как обычный текст пользователя.

**Нельзя:** читать только первый system message; склеивать `content`, игнорируя `sections`; брать только первоначальные tools; приводить тип через `as Context`; пересобирать историю из `sessionManager.getBranch()` вместо полученного контекста. Эти варианты теряют изменения MCP/tool search, named sections, context edits или compaction.

Источник семантики: [`SystemMessage`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L536-L562), [официальные transcript helpers](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/transcript.ts#L25-L120). Выбор свёртки — консервативная рекомендация для существующего адаптера, а не утверждение, что проверена поддержка mid-conversation system messages всеми серверами GigaChat.

Семантика дельт: `content` **добавляет** инструкции; `sections[name]` заменяет секцию, `null` удаляет её; `toolsRemoved` удаляет по имени, `toolsAdded` добавляет/заменяет описание. В smoke старые `rules` заменились на `NEW`, временная секция исчезла, `read` был удалён, остался `write`. Исходная история не изменилась.

`getDeclaredTools()` здесь не заменяет `getCurrentTools()`: первый собирает встречавшиеся объявления, включая больше не активные инструменты. Свёртка применяет итоговое состояние ко всему отправленному запросу — это штатный fallback для API без mid-conversation updates, а не сохранение исторических capability в каждой точке диалога.

Прямой экспорт `streamSimpleGigaChat` также меняет входной контракт: его callers и direct fixtures должны передавать `normalizeContext(rawContext)`. Callers публичного `Models.completeSimple` продолжают передавать обычный `Context`, поскольку там нормализацию делает библиотека. Не нужно повторно нормализовать provider transcript или вводить неявный dual-format shim. Источники: [provider boundary](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L765-L788), [current против declared tools](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/transcript.ts#L169-L176).

## 5. Инструменты и JSON

### 5.1. Обязательный тип `JsonObject`

Начиная с 0.86.0 `ToolCall.arguments` — `JsonObject`, а не произвольный `Record<string, unknown>`. В текущем [`completionConsumer.finish`](../../src/stream.ts#L438) проверка `object(args)` даёт именно `Record<string, unknown>`.

На снимке исходников с Pi 1.3.0 и TypeScript 5.9.3 получено:

```text
src/stream.ts(442,5): TS2322
Type 'Record<string, unknown>' is not assignable to type 'JsonObject'.
```

Нужна корректная граница JSON-разбора/типизации. Общий `object()` нельзя бездумно переименовать в JSON guard: он проверяет также другие объекты и не доказывает рекурсивную JSON-совместимость. `ToolResultMessage.details` также стал JSON-совместимым условным типом, но текущий provider не создаёт собственные `details`, требующие отдельной миграции. Источники: [0.86.0 JSON breaking change](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L240-L243), [`ToolCall`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L436-L448).

### 5.2. Новая финализация malformed arguments в 1.3.0

`parseStreamingJson()` предназначен для частичного отображения во время стриминга. В 1.3.0 добавлен `parseToolCallArguments()`: окончательно неразбираемый JSON не превращается в успешный вызов с частично прочитанными полями. Возвращаются `arguments: {}` и `argumentsError` с исходным текстом; штатный validator отклоняет вызов и показывает ошибку модели.

**Это не новый обязательный blocker текущего GigaChat-кода:** его `finish()` уже использует строгий `JSON.parse`, то есть не завершает malformed prefix как пригодный для исполнения tool call. Но сейчас это ошибка всей генерации, а не оформленная ошибка аргументов отдельного инструмента. Использование нового helper даст более близкое к Pi поведение; менять эту семантику следует осознанно. Нельзя при переносе заменить финальный `JSON.parse` на permissive `parseStreamingJson`.

В новом parser также есть repair некорректных escape-последовательностей. Это не означает, что любой незавершённый JSON становится валидным. Источники: [`parseToolCallArguments/parseStreamingJson`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/json-parse.ts#L86-L149), [проверка `argumentsError`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/validation.ts#L317-L321), [changelog 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L18-L30).

### 5.3. MCP, codemode и tool search

Новый Pi сам реализует эти механизмы; GigaChat-провайдеру не нужен собственный MCP client или JavaScript sandbox. Ему нужны актуальные **декларации инструментов из transcript** и правильный перевод вызов → результат → продолжение. Список функций может меняться в середине сессии и восстанавливаться при resume. Несколько вызовов из истории других провайдеров по-прежнему нужно переводить в допустимую для текущего GigaChat-адаптера последовательность.

Поддержка Pi-инструмента не доказывает, что его новая JSON Schema допустима для конкретного GigaChat-сервера. Отдельная проверка фактических схем, включая codemode/MCP, остаётся необходимой; прежнее [исследование схем pi-subagents](pi-subagents-gigachat-tools.md) не является проверкой всех tools Pi 1.3.0. Источники: [добавление MCP/codemode](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L372-L402), [восстановление tools в 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L23-L29).

## 6. Thinking: новое поведение, которое старая сборка обходит

В 0.85.1 `transformMessages()` превращал readable thinking чужой модели в обычный `text`. В 1.3.0 такие блоки **удаляются**: Pi предотвращает смешивание чужих рассуждений с видимым ответом. Same-model проверяется тройкой `provider + api + model`, а не одним Model ID.

[`src/messages.ts`](../../src/messages.ts#L10) импортирует `pi-ai/api/transform-messages`; build script встраивает deep helper из закреплённой dev-версии. Поэтому обновление только внешнего host API оставляет внутри generated entrypoint **старое поведение 0.85.1**.

Подтверждено на реальном generated entrypoint в изолированной копии:

```text
Вход чужой модели: thinking="PRIVATE_THOUGHT", text="ANSWER"
Старый встроенный converter: assistant.content="PRIVATE_THOUGHTANSWER"
Host transformMessages 1.3.0: [{ type: "text", text: "ANSWER" }]
```

Для будущего переноса нужно согласовать helper с целевой версией и обновить текущие комментарии/проверки, ожидающие foreign thinking как текст. Same-model readable reasoning, redacted/encrypted blocks и GigaChat `functions_state_id` имеют отдельную семантику; удаление foreign thinking не требует удаления всей собственной reasoning-логики пакета.

Следствие для подключений: одинаковый Model ID у `gigachat-A` и `gigachat-B` — **не same model** по этому правилу. Смена подключения/идентичности должна попасть в сценарии handoff. Источники: [transform 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/transform-messages.ts#L92-L116), [transform 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/api/transform-messages.ts#L119-L175), [`scripts/build.mjs`](../../scripts/build.mjs).

Новый helper также знает system messages и сохраняет корректный учёт пары tool call/result при system message между ними. Свёртка system state до старого конвертера решает конкретную форму GigaChat-запроса, но не является причиной навсегда оставлять устаревший shared helper. Источник: [tool accounting 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/api/transform-messages.ts#L179-L250).

## 7. Стриминг, события, диагностика, retries

### 7.1. Контракт результата

В 1.1.0 stream стал обязан возвращать именно `AssistantMessageEventStream`, а не произвольный совместимый по старой структуре подкласс `EventStream`. Текущий `createAssistantMessageEventStream()` уже соответствует этому правилу. В 1.3.0 класс сам выставляет `durationMs` монотонным таймером; текущий provider при использовании host factory получает это автоматически. Подтверждено локальным ответом с `durationRecorded: true`.

Основные инварианты сохранены: pending message → `start` перед content events → сбалансированные text/thinking/tool events → один terminal `done`/`error`; content block обновляется до публикации `partial`. Ошибка setup может завершить поток до `start`; отсутствие auth может бросать синхронно. Отмена — `stopReason: "aborted"`, не успешный пустой ответ. Источники: [custom stream requirements](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L120-L150), [timing stream](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/event-stream.ts#L91-L135).

### 7.2. `onProviderStreamEvent`

С 0.99.0 есть observer **разобранного provider event до нормализации**. Текущий stream реализует `onPayload` и `onResponse`, но не вызывает `onProviderStreamEvent`.

Для parity с Pi 1.3.0 будущая реализация должна `await options.onProviderStreamEvent?.(event, model)` для разобранных событий до изменения assistant output. Для SSE это требует последовательной async-обработки: сейчас [`readSSE`](../../src/stream.ts#L455) вызывает синхронный callback из `eventsource-parser`. Просто добавить незавершённый Promise в `onEvent` нельзя: порядок наблюдения и нормализации нарушится.

Это недостаток наблюдаемости, а не причина основного падения генерации. Hook поддерживается адаптерами явно; наличие поля в options само по себе не включает его. Источники: [`StreamOptions`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L212-L223), [требования hooks](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L139-L146).

### 7.3. Retries, timeout, usage

Новые transient-error patterns Pi не заменяют собственный транспорт GigaChat. В текущем [`http.ts`](../../src/http.ts#L104) строка `out of budget` намеренно останавливает внешнее повторение после исчерпания локального бюджета. В 1.3.0 она всё ещё распознаётся как non-retryable с приоритетом над transient pattern. Это нужно сохранить проверкой интеграции, чтобы не умножить retry budget.

`maxRetries`, `timeoutMs`, provider env, headers и `onResponse` остаются контрактом custom stream. Исправления встроенных SDK-адаптеров, например headers-only timeout у Mistral, **не применяются автоматически** к собственному `request()` GigaChat. Не следует выдавать их за уже полученное исправление транспорта. Источники: [retry classification](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/retry.ts#L7-L28), [classification precedence](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/retry.ts#L248-L262), [`ProviderRequestOptions`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L157-L209).

Usage/cost должны оставаться честным переводом API GigaChat; появление новых операций не требует выдумывать cacheWrite, стоимость или cache lifetime. `promptCache.short/long` можно не задавать: без подтверждённых lifetime metadata не включать cache warming. Источник: [модели и cache lifetime](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L91-L108).

Есть и предсуществующее различие policy: общий `maxRetryDelayMs` был в Pi уже до этого перехода, а текущий `request()` GigaChat использует собственный cap 600000 ms и не принимает это поле. Новое `RetryPolicy.maxAgentDelayMs` ограничивает **внешний agent backoff**, не GigaChat HTTP backoff. Это не новая регрессия 1.3.0 и не основание незаметно менять существующий бюджет повторов. Источники: [`ProviderRequestOptions.maxRetryDelayMs`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L202-L209), [`retryDelayMs`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/retry.ts#L133-L137), [`request`](../../src/http.ts#L143).

Provider-neutral `toolChoice` остался `"auto" | "none"`; named GigaChat вызов — отдельный `functionCall: { name }`, не новое общее значение Pi. Уровни thinking и null-mappings неподдерживаемых уровней также не требуют замены. Для per-thinking sampling, если он будет заявлен для GigaChat, требуется явный merge `model defaults → clamped-level overrides → request params`; встроенные OpenAI-adapters не выполняют его за custom stream. Источники: [`SimpleStreamOptions`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L369-L377), [`simple-options`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/api/simple-options.ts#L23-L42).

## 8. Авторизация и хранилище подключений

### 8.1. Основные native hooks сохранены

Текущая схема `auth.apiKey.login/check/resolve` и `auth.oauth.login/refresh/toAuth` остаётся пригодной. `ModelRuntime.login/logout`, `InMemoryCredentialStore`, `InMemoryModelsStore` используются пакетом по назначению. Не нужен переход обратно на legacy OAuth adapter.

Авторизационный ключ GigaChat и токен доступа — разные сущности; обновление Pi этого не меняет. `check()` нужен для проверки конфигурации/доступности без платной пробной генерации. `resolve()` подготавливает request auth; stored credential определяет provider, и неуспешный OAuth refresh не должен незаметно переключаться на другой ambient аккаунт.

Источники: [`ApiKeyAuth`, `OAuthAuth`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/auth/types.ts#L166-L255), [stored credential precedence](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/auth/resolve.ts#L27-L93), [`createConnectionProvider`](../../src/connections.ts#L319-L383).

### 8.2. Существенное изменение отмены в 1.0.3

Когда OAuth refresh уже начат под lock, Pi 1.3.0 завершает его и сохраняет результат независимо от отмены вызывающего запроса. Caller может быстро получить abort, но начатый refresh идёт с отдельным timeout **15 секунд**. Причина — возможная ротация refresh token: отмена не должна потерять единственный новый credential. Ожидание lock до начала refresh остаётся отменяемым.

В синтетическом smoke с настоящими `createModels`, `InMemoryCredentialStore` и OAuth resolver 1.3.0:

```text
callerCancelled: true
refreshCancelled: false
rotationPersisted: true
metadataPreserved: true
```

Это проверка штатной orchestration на синтетическом provider, **не реального обмена токеном GigaChat** и не межпроцессного file lock.

Источники: [changelog 1.0.3](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L85-L97), [`refreshStoredOAuthCredential`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/auth/resolve.ts#L102-L155). При переносе не возвращать прежнюю модель «abort caller обязательно прерывает уже начатое обновление token».

### 8.3. `auth.json` и metadata подключения

В 1.3.0 credential по-прежнему хранится по provider ID с discriminator `type: "api_key" | "oauth"`. File storage читает/перезаписывает объекты без проекции только на стандартные поля; текущая nested `gigachatConnection` не требует миграции схемы только из-за номера Pi. OAuth refresh адаптера должен продолжать возвращать metadata вместе с новым access token, а не обрезать её.

Основание: [`AuthStorage` read/modify](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/auth-storage.ts#L363-L489), [типы credentials](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/auth/types.ts#L13-L37), [`exchange`](../../src/auth.ts#L78) сохраняет дополнительные поля через spread.

Но прямое владение `auth.json`, lock и атомарной заменой в `ConnectionStore` остаётся чувствительной границей приложения. Нужны отдельные проверки двух процессов, изменения/удаления подключения во время refresh, stale revision и отмены save. Чтение исходника о сохранении metadata не является доказательством всех этих гонок. Рекомендация — сохранять существующий доменный контракт, не создавать новое хранилище лишь ради обновления Pi.

## 9. Каталог, доступность и выбор модели

### 9.1. Chat-only provider не обязан стать multi-modal

С 0.99.0 появились `AnyModel`, image/classifier discriminants и typed accessors. Для chat модель может **не указывать `type`**, как и сейчас. `getModels/getAvailable/getModel` остаются chat-facing; для всех операций есть `getAllModels/getAllAvailable`, для отдельного типа — `getModelsOfType/getModelOfType/getAvailableOfType`.

Поэтому GigaChat не нужно реализовывать image generation, classifier или virtual routing без отдельной задачи. Но утилита, которая в будущем работает со смешанным каталогом, не должна считать каждый `AnyModel` обычной chat-моделью; `Models.stream*` отвергает non-chat input. Источник: [multi-operation changes](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md#L158-L182).

### 9.2. Два разных refresh API

- Native `Provider.refreshModels(context)` не возвращает список; публикует provider-owned state через `context.publish({ update, persist? })`, после чего `getModels()` синхронно отдаёт актуальное состояние.
- Legacy `ProviderConfig.refreshModels` возвращает определения моделей; runtime заменяет ими live-каталог регистрации.
- Helper `createProvider({ fetchModels })` реализует native publication/restoration сам; это не третья форма `pi.registerProvider`.
- В 1.2.0 `RefreshModelsContext.baseUrl` позволяет discovery следовать эффективному endpoint с учётом wrappers/config overrides. Этот endpoint относится к native discovery, не отменяет политику сохранённого подключения.

Источники: [refresh contracts](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/custom-provider.md#L101-L108), [`RefreshModelsContext`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L80-L101), [`createProvider` dynamic overlay](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L1062-L1125).

Сохранённые нюансы refresh: cache восстанавливается отдельной offline-фазой до request-time auth/network; `publish` проверяет generation, поэтому устаревший refresh не должен перезаписать новый каталог. `persist` не задан — хранение не меняется, `persist: null` — запись каталога удаляется. Provider errors могут находиться в возвращённой `errors` map, а отмена — в `aborted`; одного `try/catch` недостаточно, чтобы признать refresh успешным. Источник: [`publication/refresh`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L509-L617).

Текущий пакет намеренно сохраняет **выбранные модели**, а `discoverModels()` делает платные пробные генерации только по действию пользователя. Превращать эту функцию в автоматический startup/network refresh не нужно: это изменит поведение и стоимость, а не исправит несовместимость. Перезапуск и `/reload` должны восстанавливать сохранённый список без probes. Источники: [ADR подключения](../adr/0001-server-connection-identity.md), [`discoverModels`](../../src/discovery.ts#L127-L195).

### 9.3. Startup, resume, одинаковые Model ID

В 0.99.2 исправлена стартовая доступность native extension provider со stored credential. В 1.3.0 `--model` при нескольких совпадающих providers больше не выбирает по порядку каталога: предпочитает имеющий credentials или сообщает неоднозначность; scoped patterns могут включать модели каждого provider с предупреждением.

Следовательно, несколько GigaChat-подключений с одинаковым Model ID требуют явного теста выбора по **provider + model**. Не стоит упрощать идентичность до Model ID после обновления.

[`session_start` текущего пакета](../../src/gigachat-ui.ts#L116-L193) содержит собственное восстановление выбора и блокировку обращения к другому серверу при потере сохранённой модели. **CLI bootstrap и прямой SDK различаются:** service path flush-ит registrations до выбора модели, а прямой `createAgentSession()` выбирает initial model до позднейшего runner binding. Поэтому комментарий о flush после SDK selection не опровергается одним исправлением CLI availability. После переноса проверить оба режима. Не удалять целиком safety guard: исправление стартовой доступности не гарантирует безопасность выбора после удаления/переименования подключения. Источники: [`agent-session-services`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session-services.ts#L151-L195), [`sdk`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/sdk.ts#L191-L260).

Источники: [fix 0.99.2](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L337-L339), [`markProvisionallyConfigured`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/model-runtime.ts#L891-L925), [selection fix 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L23-L29).

Ещё три нюанса для подключения сервера:

- **Case-only names.** Локальные `gigachat-LDBR` и `gigachat-ldbr` — разные identities, но CLI resolver Pi сравнивает provider prefixes/constraints с приведением к нижнему регистру. **[INFERENCE]** Строка `provider/model` не гарантирует ожидаемого различения таких двух подключений, хотя exact registry lookup различает их. Case folding существовал и до 1.3.0; новое разрешение ambiguity его не отменило. Нужна отдельная CLI-проверка, без переименования доменных IDs в рамках этого исследования. Источник: [`splitProviderPrefix` и provider constraint](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/model-resolver.ts#L127-L166).
- **Availability не серверная проверка.** Наличие stored OAuth и handler может означать configured без refresh и проверки expiry; `check()` bearer-подключения также не проверяет генерацию на сервере. Не заменять явные probes результатом `getAvailable()` и не считать provisional snapshot доказательством валидности токена. Источник: [`Models.checkAuth`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/models.ts#L663-L717).
- **Повторный выбор и reload.** Explicit same-model selection записывает `model_change`, но не обязательно эмитит `model_select`; текущий `refreshSelectionGuard` учитывает это намеренно. **[INFERENCE; предсуществующий риск]** `/reload` не следует считать гарантией очистки всех старых provider IDs: runner заменяется, а native runtime maps сохраняются. Удаление подключения другим процессом перед reload нужно проверить отдельно на stale catalog entries; исправность metadata guards не равна чистоте каталога. Источники: [`setModel`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session.ts#L2487-L2528), [`reload`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session.ts#L3690-L3728).

## 10. Расширения, packaging и UI

### 10.1. Host modules и диапазоны версий

И исходная, и целевая версия в этой задаче используют scope **`@earendil-works`**. Миграция из `@mariozechner` здесь не является необходимым шагом.

Официальное правило Pi 1.3.0: импортируемые host packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) — `peerDependencies` с `"*"`, не обычные runtime dependencies и не встроенная в bundle вторая копия host API. Для разработки и воспроизводимого встраивания helpers нужна согласованная целевая dev-версия. `peerDependencies` — metadata для package manager, **не runtime enforcement и не доказательство поддержки всех Pi**: managed npm/git installs Pi отключают автоматическое разрешение/установку peers, а runtime compatibility отдельно обеспечивается guard и проверенным контрактом. Источник: [`getGitDependencyInstallArgs/getNpmInstallArgs`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/package-manager.ts#L1827-L1871).

Рекомендация wildcard peers существовала уже в 0.85.1; это не новое breaking change 1.x. Exact optional peers — более строгая локальная политика. Managed install может подавлять разрешение peers, поэтому успешная установка файлов не доказывает допустимость host; local package installation не переписывает дерево зависимостей checkout. Warning Pi о duplicate host dependencies относится к `dependencies`, а не автоматически к точным peer ranges. Источники: [guidance 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md#L169-L181), [guidance 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md#L76-L92).

Текущие peers/devDependencies закреплены на `0.85.1`, поэтому для перехода их нужно пересмотреть. Pi 1.3.0 сам закрепил внутренние Pi-зависимости на точную release-версию, чтобы не смешивать несовместимые пакеты. Node requirement остался **`>=22.19.0`**; переход проекта на TypeScript 7 не следует автоматически из того, что upstream сменил собственный build compiler.

Источники: [package dependency policy](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md#L76-L92), [`package.json` 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/package.json), [exact dependency fix](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L23-L25), [локальный manifest](../../package.json).

### 10.2. Public imports, deep helpers и generated entrypoint

Загрузчик подставляет host modules для перечисленных virtual specifiers. `pi-ai` root направляется на host `compat` superset, чтобы старые глобальные APIs расширений продолжали работать. Но **не каждый публичный subpath** находится в virtual map: например, `api/transform-messages`, `utils/abort` и новый лёгкий `/models` нельзя автоматически считать host-алиасами.

Текущий build оставляет root imports Pi внешними, а deep helpers встраивает. Поэтому перенос должен согласовать **обе половины**: внешний host 1.3.0 и helper-код, из которого собран `extension.ts`. Механически сделать все deep imports external или заменить root на `/models` — не доказанное решение для native/standalone загрузки.

В текущем manifest `pi.extensions` указывает на **корневой generated `extension.ts`**, не на `src/extension.ts` и не на библиотечный `dist/index.js`. Эти поверхности проверяются отдельно. `src/index.ts` экспортирует библиотечный provider без встроенных моделей; default activation устанавливает `/gigachat` и восстанавливает пользовательские подключения. Обновить только `dist/` недостаточно; обновить только extension entrypoint недостаточно для library consumers.

Источники: [virtual modules](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/virtual-modules.ts#L14-L38), [package warning о compiled ESM](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md#L88-L92), [`scripts/build.mjs`](../../scripts/build.mjs), [`src/index.ts`](../../src/index.ts), [`src/extension.ts`](../../src/extension.ts).

В loader сохранены разные пути для embedded/bundled CLI, TypeScript-source host и unbundled Node host. В новых версиях jiti/virtual-module setup стал lazy, а не универсальным native Node import. `.ts` у текущего generated entrypoint намеренно заставляет применять host-aware transform; менять его обратно на `.js/.mjs` без проверки обоих способов установки нельзя. Static host import и native dynamic `import()` не эквивалентны по выбору физической копии пакета. Источники: [resolution branches](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/loader.ts#L559-L589), [`scripts/build.mjs`](../../scripts/build.mjs#L3-L17).

### 10.3. Version guard

[`src/extension.ts`](../../src/extension.ts#L5-L10) явно бросает ошибку при `VERSION !== "0.85.1"`. В native CLI Pi 1.3.0 это подтверждено до запуска команды/генерации:

```text
Unsupported Pi version 1.3.0: @dev-sergeev/pi-gigachat requires Pi 0.85.1.
```

Это ожидаемая защита текущего пакета, а не баг новой регистрации Pi. Снимать её до адаптации transcript и проверки собранного entrypoint нельзя. Будущий clean cutover можно делать на выбранную целевую версию; поддержка одновременно 0.85.1 и 1.3.0 потребует отдельного решения, а не неявного расширения диапазона.

### 10.4. Lifecycle и TUI

Изменения 0.87.0 затрагивают потребителей `shouldStopAfterTurn`, exhaustive `SessionEntry/ExtensionEvent` switches и прямых записей в `session.agent.state.messages`. В 1.2.0 `before_agent_start` стал union по `messageType` и изменил семантику idle при старте. Текущий GigaChat extension эти способы управления запуском не использует, поэтому переписывать его в новый hook не нужно.

`/gigachat` использует собственные `ctx.ui.custom` формы, progress и выбор моделей. С 1.0.0 default TUI — fullscreen, с 0.99.0 default theme — terminal-derived `system`; в 1.3.0 исправлено закрытие своего overlay через `done()`. Публичные UI-методы пакета не дали дополнительных ошибок в TypeScript probe, но это **не визуальная проверка** маскировки секрета, resize, focus и клавиш. Нужен native smoke в fullscreen и regular TUI перед объявлением поддержки.

Источники: [0.87.0 lifecycle changes](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L475-L505), [1.2.0 event changes](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L59-L64), [1.0.0 fullscreen](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L268-L289), [1.3.0 overlay fix](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md#L45-L47).

### 10.5. Конкретный UI-разрыв 1.2.0: masked cursor

`Input.render()` и `Editor.render()` больше не выдают нарисованный курсор напрямую через reverse-video SGR. Они оборачивают ячейку в zero-width APC markers; `renderFakeCursor()` — публичный helper. TUI разрешает markers в reverse video либо оставляет только hardware cursor при `showHardwareCursor`.

Текущий [`maskedInput`](../../src/gigachat-dialogs.ts#L28-L45) убирает управляющие последовательности исходного Input, маскирует текст, сохраняет `CURSOR_MARKER`, но **сам снова вставляет `\\x1b[7m`**. Render-probe с настоящими Input и resolver 1.3.0 подтвердил: native Input содержит fake-cursor markers; masked output не содержит их и сохраняет reverse video даже при hardware-cursor policy. Синтетический секрет в видимый output не попал.

Это подтверждённое несовпадение cursor semantics, **не доказанная утечка секрета и не visual end-to-end запуск мастера**. В будущей миграции нужно согласовать masked renderer с `renderFakeCursor`, сохранить mask/IME position и проверить cursor в начале, середине, конце, пустое поле, Unicode, narrow width и оба значения `showHardwareCursor`.

Источники: [TUI breaking change 1.2.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/tui/CHANGELOG.md#L5-L17), [markers/helper](https://github.com/earendil-works/pi/blob/v1.3.0/packages/tui/src/tui.ts#L190-L206), [resolver](https://github.com/earendil-works/pi/blob/v1.3.0/packages/tui/src/tui.ts#L1473-L1483).


## 11. Карта будущих изменений по файлам

| Файл/область | Необходимое действие при переносе | Статус |
| --- | --- | --- |
| `src/stream.ts`: `streamSimpleGigaChat`, `payload` | Provider-facing `TranscriptContext`; актуальный prompt/tools; JSON-тип финальных tool arguments | Обязательная совместимость |
| `src/messages.ts`: `convertMessages` | Корректная граница system/non-system, сохранение текущей GigaChat-конвертации и handoff на helper 1.3.0 | Обязательная совместимость |
| `src/stream.ts`: JSON/SSE consumers | Последовательный awaited `onProviderStreamEvent` до нормализации | Parity наблюдаемости |
| `src/stream.ts`: финализация tool call | Рассмотреть `parseToolCallArguments` и `argumentsError`; не запускать malformed prefix | Осознанный выбор семантики, не нынешний blocker |
| `src/extension.ts` | Сменить policy версии только после проверок нового контракта | Обязательный release gate |
| `package.json`, lockfile | Целевые согласованные Pi devDependencies и peer policy; документировать проверенный диапазон | Обязательный release gate |
| `scripts/build.mjs`, generated `extension.ts`, `dist/`, notices | Согласовать bundled helpers с host, пересобрать публикуемые поверхности; проверить native import path | Обязательный release gate |
| `src/connections.ts`, `src/auth.ts` | Сохранить native auth/connection identity; проверить abort/rotation, metadata, stale revision и lock | Контракт в основном сохранён; нужна интеграционная проверка |
| `src/gigachat-ui.ts` | Пересмотреть старый startup workaround; сохранить запрет тихого fallback на другой сервер | Не механическое удаление |
| `src/gigachat-dialogs.ts`, формы UI | Адаптировать masked cursor к APC/renderFakeCursor; проверить hardware cursor, fullscreen/regular, mask, Esc, focus, resize | UI-контракт 1.2+ и проверка поверхности |
| Существующие тесты | Перевести direct stream fixtures на нормализованный контекст; поправить ожидания foreign thinking; покрыть изменения/удаления tools/sections | Нужны поведенческие проверки, не перепривязка старых ожиданий |
| README и install/docs | Целевая версия, оба режима потребления, реальные ограничения и имя entrypoint | Обязательная документация release |

Работы по официальному SDK GigaChat из [ADR о границе протокола](../adr/0001-official-sdk-protocol-boundary.md) — отдельный архитектурный переход. Обновление Pi само по себе не требует одновременно менять транспорт на SDK; смешивание двух переносов затруднит локализацию ошибок. Это рекомендация порядка работ, не отмена ADR.

## 12. Что действительно запускалось

Изолированная установка npm Pi 1.3.0; Node **26.11.0**. Проверки не доказывают поведение на минимальном Node 22.19.0, Bun или standalone binary.

| Проверка | Наблюдённый результат | Что доказывает |
| --- | --- | --- |
| Native `pi --version` | `1.3.0` | Использована нужная версия CLI |
| Native activation точной копии generated `extension.ts`, offline, без сохранения сессии | Ошибка `Unsupported Pi version 1.3.0`; exit 1 | Реальный version guard с host version |
| TypeScript 5.9.3 `--noEmit` на копии всего `src/` с peers 1.3.0 | TS2322, `stream.ts:442`, `Record<string, unknown>` → `JsonObject`; exit 2 | Конкретная типовая несовместимость; не заявление о готовности сборки |
| Текущий stream на старом Context, injected local fetch | `stop`, `local-response`, функция `read`, вызваны payload/response hooks, есть duration | Контрольный старый путь работает с локальным ответом |
| Точный generated entrypoint: экспортированы private helpers только во временной копии; нормализованный контекст | `error`, `message.content.filter is not a function`, HTTP/fetch calls 0 | Ошибка реальной текущей сборки до сети |
| Настоящий `createModels().completeSimple` и диагностический native-provider | Provider видит только `messages`, ведущий system, актуальный prompt и tools | Нормализация происходит и при старом public Context |
| Transcript helpers: replace/delete section, remove/add tool | Prompt `BASE\n\nADDED\n\nNEW`, tools `[write]`, оригинальные roles неизменны | Семантика replay и отсутствие изменения входной истории |
| Generated converter против host transform 1.3.0 на foreign thinking | Старый wire содержит `PRIVATE_THOUGHTANSWER`, новый оставляет `ANSWER` | Реальный риск старого bundled helper |
| Новый final argument parser, оборванный объект | `{ arguments: {}, argumentsError: ... }` | Новая ошибка финальных аргументов, не permissive prefix |
| Synthetic OAuth: abort после начала refresh | Caller abort; refresh не abort; rotated credential и metadata сохранены | Новая orchestration в памяти, без реального OAuth |
| Native `ModelRuntime`: register → offline refresh → unregister | Модель в каталоге и available snapshot; после unregister отсутствует | Базовый native registration lifecycle работает в 1.3.0 |
| Masked-input render probe на Input/resolver 1.3.0 | Native APC markers есть; current mask выдаёт raw inverse video, он остаётся в hardware mode; synthetic secret не выведен | Конкретное несовпадение cursor policy, не визуальная приёмка мастера |

Не запускались: штатный `npm test`/`npm run build`/линтер проекта, реальные OAuth и `/chat/completions` GigaChat, interactive wizard, MCP/codemode workflow, compaction end-to-end, двухпроцессные гонки и готовая миграция. Временные exports/диагностические providers не переносились в репозиторий.

## 13. Приёмка будущей миграции

1. **Установка и загрузка:** опубликованный tarball, managed npm/git install, local package, `/reload`; host API и версия берутся из настоящего Pi, а не случайных local peers. Проверить обе поверхности — extension и библиотеку `createModels()`.
2. **Первый запрос:** native normalized transcript с prompt/tools; text JSON и SSE; один terminal event; нет дубля GigaChat system prompt.
3. **Изменяющийся контекст:** добавить/заменить/удалить named sections и tools; несколько последовательных дельт; `context_with_system`; история не мутируется.
4. **Инструменты:** call → result → continuation; malformed final arguments не исполняются; неполный SSE/finish reason; Unicode и escape boundaries; импортированные parallel calls корректно сериализуются.
5. **Thinking/handoff:** своя модель, другая модель, другое подключение с тем же Model ID, redacted/encrypted blocks; чужие рассуждения не превращаются в видимый текст; GigaChat state signatures не попадают обратно в недопустимые wire-поля.
6. **Auth:** static access token; авторизационный ключ; `/login`/wizard; refresh; abort до lock и после начала refresh; metadata сохраняется; нет silent ambient fallback.
7. **Подключения:** два провайдера с одинаковым Model ID, case-only names `LDBR`/`ldbr` в selector и CLI, update/revision, rename replacement, delete, конфликт чужого ID, два процесса и атомарное сохранение; при исчезновении модели нет запроса к другому серверу.
8. **Сессии:** explicit CLI selection и прямой SDK bootstrap отдельно, saved default, resume/reload после внешнего удаления записи, explicit same-model acknowledgment, compaction и branch summary, восстановление thinking level и активных/deferred tools; без скрытых paid discovery probes.
9. **Наблюдаемость и отказ:** `onPayload` replacement, `onResponse` до body, awaited provider event hook до normalization; abort с partial content; context overflow; quota vs transient failure; retries не умножаются.
10. **Поверхность UI:** `/gigachat` в fullscreen и regular, оба hardware-cursor режима и APC-маска, secret mask, Esc, focus, resize, длинный список моделей и сообщения ошибок без секретов.

**Решение для следующей сессии:** переносить существующий native-provider на выбранную Pi 1.3.0, начиная с transcript boundary и согласованных helpers. Сохранять модель подключения и существующую авторизацию; новые image/classifier/virtual APIs не добавлять без отдельной задачи. Поддержку объявлять только после проверки перечисленных реально затронутых путей.
