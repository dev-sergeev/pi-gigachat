# Совместимость pi-gigachat с Pi после 0.85.1

Дата проверки: **3 октября 2026 года**.

Проверяемая версия расширения: **0.4.0**. Исходная версия Pi: **0.85.1**. На момент проверки актуальные опубликованные версии `@earendil-works/pi-coding-agent` и `@earendil-works/pi-ai` — **1.0.1**. Требование Node осталось `>=22.19.0`.

**Рекомендация:** адаптировать расширение под Pi 1.0.1. Главная необходимая правка — новый формат контекста провайдера, введённый в 0.86.0. Одного обновления зависимостей недостаточно.

Это исследование и план миграции, а не выполненная миграция. Код расширения не изменён. Проверены текущие исходники, официальные изменения и опубликованные API; ошибка конвертации воспроизведена в памяти на текущем `extension.js`. Полная сборка, интеграционные тесты и запрос к живому GigaChat не выполнялись.

Источник версии: [опубликованный пакет Pi 1.0.1](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.0.1). Указание актуальной версии относится к дате проверки, а не к моменту последующего чтения заметки.

## Изменения после Pi 0.85.1

| Версия | Дата | Существенные изменения | Влияние на pi-gigachat |
| --- | --- | --- | --- |
| **0.86.0** | 19.09.2026 | Новый `TranscriptContext`; изменения системного промпта и инструментов внутри диалога; JSON-типы аргументов; cache warming | **Требует изменения адаптера контекста и типов аргументов** |
| **0.86.1** | 20.09.2026 | Meta Muse, ускорение повторного запуска, исправления clipboard и ошибок провайдеров | Дополнительных обязательных правок не выявлено |
| **0.87.0** | 21.09.2026 | `SessionManager` стал источником контекста; `context_edit`, `context_with_system`, новые границы событий; `finishTurn` заменил `shouldStopAfterTurn` | Эти API расширение сейчас не использует |
| **0.87.1** | 22.09.2026 | Новые модели; исправления compaction и сообщений с изображениями | Дополнительных обязательных правок не выявлено |
| **0.99.0** | 29.09.2026 | MCP, `codemode`, `tool_search`, virtual models, классификаторы; общий API моделей chat/image/classifier; `onProviderStreamEvent` | Нужна поддержка нового диагностического callback; обычные chat-модели сохраняют совместимость |
| **0.99.1** | 29.09.2026 | GPT-6.1 Sol, исправление входа OpenAI | Прямого влияния нет |
| **0.99.2** | 30.09.2026 | Улучшения MCP; исправлен выбор сохранённой модели extension-провайдера с credentials | Полезное исправление для native provider расширения |
| **1.0.0** | 01.10.2026 | Fullscreen по умолчанию, компактнее промпт codemode, генерация изображений, улучшения OAuth | Дополнительной миграции обычного chat provider не требует |
| **1.0.1** | 03.10.2026 | Настройки MCP на уровне проекта, `registerToolRenderer`, исправления retries и изображений | Дополнительных обязательных правок не выявлено |

Фактический переход версий был `0.87.1 → 0.99.0`.

Источники: [changelog Coding Agent](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/CHANGELOG.md), [changelog Pi AI](https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/CHANGELOG.md).

## Причина несовместимости

В Pi 0.85.1 провайдер получал контекст вида:

```ts
{ systemPrompt, tools, messages }
```

Начиная с 0.86.0 провайдер получает `TranscriptContext`, содержащий только `messages`. Промпт, его секции и изменения инструментов находятся в сообщениях `role: "system"`. Публичный `createModels().streamSimple()` по-прежнему принимает прежний `Context`, но перед вызовом провайдера нормализует его.

Текущий код расширения рассчитан на старый контракт:

- [`src/stream.ts`](../../src/stream.ts), строка 99: читает отсутствующий `context.tools`, поэтому функции не попадут в запрос.
- [`src/messages.ts`](../../src/messages.ts), строка 30: читает отсутствующий `context.systemPrompt`.
- Конвертер сообщений принимает системное сообщение за результат инструмента и вызывает `.filter()` у строкового `content`.

В изолированной проверке функций из текущего `extension.js`, выполненной в памяти без записи файлов, старый контекст проходит, а нормализованный контекст с ведущим системным сообщением вызывает:

```text
TypeError: message.content.filter is not a function
```

Это воспроизведение ошибки конвертера, а не полный запуск расширения внутри новой версии Pi.

Источник контракта: [System Messages в Pi AI](https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/README.md#system-messages).

## Необходимые изменения

### Адаптер контекста провайдера

Минимальная правка — адаптировать контекст на входе `streamSimpleGigaChat`, сохранив существующую конвертацию GigaChat:

```ts
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

function toGigaContext(context: TranscriptContext): Context {
  const transcript = collapseSystemMessages(context);

  return {
    systemPrompt: getCurrentSystemPrompt(transcript.messages),
    tools: getCurrentTools(transcript.messages),
    messages: transcript.messages.filter(m => m.role !== "system"),
  };
}
```

У `streamSimpleGigaChat` заменить входной тип на `TranscriptContext`, затем перед формированием запроса вызвать:

```ts
let body = payload(model, toGigaContext(context), options);
```

Внутренние `payload` и `convertMessages` могут продолжить принимать `Context`. Для текущего адаптера, формирующего одно ведущее системное сообщение GigaChat, свёртка восстанавливает актуальное состояние промпта и инструментов.

Адаптер должен учитывать **все изменения** промпта, именованных секций и инструментов. Чтение только первого системного сообщения или простое приведение типов скроет часть проблемы: запрос может перестать падать, но потеряет последующие обновления инструкций и инструментов.

Источник: [официальные transcript helpers](https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/src/utils/transcript.ts).

### JSON-типы аргументов инструмента

В новых версиях `ToolCall.arguments` имеет тип `JsonObject`. Присваивание в [`src/stream.ts`](../../src/stream.ts), строка 418, после локального `object(args)` даёт **TS2322**: проверка сужает значение лишь до `Record<string, unknown>`. Несовместимость типов проверена компилятором TypeScript 5.9.2 в памяти.

После `JSON.parse` нужна отдельная проверка JSON-объекта с соответствующим типом. Общий `object()` менять не следует: он используется и для произвольных объектов.

Источник: [типы Pi AI 1.0.1](https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/src/types.ts).

### Зависимости и публикуемая сборка

В [`package.json`](../../package.json):

- Обе Pi `devDependencies` закрепить на `1.0.1`.
- Host `peerDependencies` оформить как `"*"` согласно правилам Pi.
- В README явно указать проверенные версии.

Текущий диапазон `^0.85.1` означает `<0.86.0`, поэтому исключает все перечисленные обновления. `"*"` — правило подключения модулей хоста, **не доказательство совместимости** с любыми версиями Pi.

Обязательно пересобрать `extension.js`: он содержит helper-код Pi 0.85.1. Обновить и [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES).

Текущую схему [`scripts/build.mjs`](../../scripts/build.mjs) можно сохранить для минимальной миграции: корневые host API остаются внешними, чистые внутренние helpers встраиваются из закреплённой версии для разработки. Это сохраняет зависимость сборки от конкретной версии helper-кода и требует контроля при обновлениях. Механически делать все deep imports внешними нельзя: загрузчик Pi не подставляет хост-модули для `api/transform-messages` и `utils/abort`, а публичный root их не экспортирует.

Официальное правило Pi — не встраивать host-пакеты и не объявлять их обычными `dependencies`. Текущая схема со встроенными helpers требует отдельной проверки загрузки публикуемого файла; она не должна приводить к включению второй копии host API или registry.

Источники: [правила зависимостей расширений](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/packages.md#declare-dependencies), [загрузчик расширений](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/extensions/loader.ts), [виртуальные host-модули](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/extensions/virtual-modules.ts).

### Наблюдение событий провайдера

Для интеграции с `provider_stream_event`, добавленным в 0.99.0, вызывать:

```ts
await options.onProviderStreamEvent?.(providerEvent, model);
```

Callback вызывается после разбора JSON/SSE, до `consume.add()`. Для SSE потребуется последовательное ожидание callback: текущий `onEvent` синхронный.

Отсутствие этого hook не блокирует базовую генерацию, но новые средства диагностики не увидят события GigaChat. `onPayload` и `onResponse` в расширении уже реализованы.

Источник: [требования custom stream](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/custom-provider.md#implement-custom-streaming).

## API, которые сохраняются

`createProvider()`, `pi.registerProvider(provider)`, текущие методы авторизации и используемые методы `SettingsManager` доступны в 1.0.1. Для устранения описанной несовместимости их переписывать не требуется.

MCP и codemode работают через инструменты хоста; отдельную реализацию их протоколов в `pi-gigachat` добавлять не требуется. Текущие chat-модели также не обязаны получать реализацию генерации изображений или классификации.

Источники: [регистрация и авторизация custom provider](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/custom-provider.md), [SettingsManager](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/settings-manager.ts).

## Проверка миграции

Следующий шаг — адаптер контекста и JSON-типы, затем сборка и проверки на Pi 1.0.1. Поддержку промежуточных версий объявлять после проверки на соответствующих версиях хоста.

Критерии успеха:

- Обе модели проходят JSON и SSE.
- Системный промпт Pi и дополнительный промпт провайдера присутствуют ровно один раз.
- Изменение и удаление секций промпта корректно отражаются в следующем HTTP-запросе.
- Добавление, удаление и переопределение инструментов корректно отражаются в `functions` и режиме вызова функций.
- Проходит цепочка вызов инструмента → результат → продолжение, с сохранением `functions_state_id` и reasoning.
- Проходят сохранение и восстановление сессии, compaction, отмена запроса, retries и обновление OAuth-токена.
- Проверена загрузка публикуемого `extension.js` внутри native Pi, а не только прямой вызов функций библиотеки.

Прямые тесты `streamSimpleGigaChat` должны передавать `normalizeContext(fixture)`, иначе старые fixtures обойдут новый контракт. Тесты публичного `createModels()` могут продолжить использовать обычный `Context`: нормализация выполняется библиотекой.

**Confidence: High — изменение контракта, ошибка конвертации и несовместимость типов подтверждены.** Работоспособность предложенной миграции в полном интеграционном запуске пока не проверена.
