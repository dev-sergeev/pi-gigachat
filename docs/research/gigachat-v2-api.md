# GigaChat V2: контракт API и вопросы для объединения пакетов

Дата исследования: **28 октября 2026 года**. Сначала выполнено исследование первичной документации без обращений к пользовательскому серверу; последующая реализация и реальные проверки на публичном `GigaChat-3-Ultra` описаны в разделе 11. Работающие у пользователя GigaChat V1 и соседний OpenAI-compatible пакет приняты как исходные условия. Пользовательские `auth.json` и `.env` не читались; авторизационный ключ и временный токен не включены в эту заметку или файлы проекта.

Согласованные термины находятся в [CONTEXT.md](../../CONTEXT.md), продуктовые и архитектурные решения — в [ADR 0003](../adr/0003-connection-api-protocol.md). Параметр V1 / V2 / OpenAI-compatible называется **протокол API** и не является способом авторизации. Эта заметка сохраняет первичные источники и наблюдения, а не заменяет принятые решения.

## Основной вывод

**V2 — не замена `/v1` на `/v2` и не OpenAI Chat Completions.** Меняются тело запроса, сообщения, обёртка функций, результаты функций, JSON-ответ, usage и завершение SSE. При этом публичная и B2Bank-спецификации V2 различаются: в B2Bank явно описаны reasoning и идентификатор результата параллельной функции, которых нет в опубликованной публичной схеме. Перенос этих возможностей между серверами нельзя считать доказанным. [S1: `ChatCompletionV2Request`, `Message`, `ChatCompletionV2Response`][S2: одноимённые схемы][S8]

Наиболее существенная развилка для обсуждения: требуется ли одинаковый полный набор возможностей на публичном OAuth-сервере и на пользовательском mTLS-сервере, либо возможности определяются конкретным подключением и моделью? Публичная документация ограничивает parallel tool calls моделью `GigaChat-3-Ultra`, а reasoning описан в отдельной B2Bank-документации. [S1: `model_options.parallel_tool_calls`][S3][S4]

## Первичные источники и пределы доказательств

- **S1 — [публичная OpenAPI](https://developers.sber.ru/docs/files/openapi/gigachat/api.yml)**: `openapi: 3.1.1`, `info.version: 1.0.0`. Ссылки далее называют точный путь/схему внутри YAML; номер `info.version` не является номером протокола чата.
- **S2 — [B2Bank OpenAPI](https://developers.sber.ru/docs/files/openapi/gigachat-b2bank/api-b2bank.yml)**: отдельная спецификация `GigaChat API B2Bank`; не подмена публичного S1.
- **S3 — [GigaChat 3 Ultra](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-3-ultra)**, обновлено 17 июля 2026.
- **S4 — [B2Bank: работа в режиме рассуждений](https://developers.sber.ru/docs/ru/gigachat-b2bank/guides/reasoning)**, обновлено 23 сентября 2026.
- **S5 — [генерация структурированных данных](https://developers.sber.ru/docs/ru/gigachat/guides/structured-output)**, обновлено 20 июля 2026; содержит отдельный раздел V2, JSON-ответ V2 и пример `client.chat.stream()` с `chunk.messages`.
- **S6 — [публичная REST-страница V2](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat-v-2)**, обновлено 7 октября 2026; динамическая схема не извлекается из текстового представления, поэтому поля взяты из S1.
- **S7 — [B2Bank REST-страница V2](https://developers.sber.ru/docs/ru/gigachat-b2bank/api/reference/rest/post-chat-v-2)**, обновлено 27 октября 2026; ссылается на S2.
- **S8 — [официальный OpenAI Chat Completions reference](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create.md)**. Используется как эталон формата OpenAI, **не доказательство полноты совместимости конкретного стороннего сервера**.
- **S9 — [каталог моделей GigaChat](https://developers.sber.ru/docs/ru/gigachat/models/main)**.
- **S10 — [общая инструкция потоковой генерации](https://developers.sber.ru/docs/ru/gigachat/guides/response-token-streaming)**, обновлено 17 июля 2026; основной HTTP-пример относится к V1, не к V2.
- **S11 — [npm registry `gigachat@0.0.20`](https://registry.npmjs.org/gigachat/0.0.20)**: версия npm `latest` на дату исследования по `npm view`; `gitHead = d4977f956091e764051e83dfd220aa186cc8b667`, официальный репозиторий `ai-forever/gigachat-js`. Ниже исходники SDK привязаны к этому commit, а не к изменяемой default branch.

Обозначение **[НЕ ПОДТВЕРЖДЕНО]** означает отсутствие достаточного первичного контракта для соответствующего сервера, а не доказанное отсутствие возможности. **[ВЫВОД]** — следствие сопоставления источников, а не наблюдение работающего backend.

## 1. Точные адреса, авторизация и каталог моделей

| Операция | Подтверждённый адрес/контракт | Источник |
| --- | --- | --- |
| Публичный чат V1 | `POST https://api.giga.chat/v1/chat/completions` | S1: `paths./v1/chat/completions.post.servers` задаёт origin `https://api.giga.chat` |
| Публичный чат V2 | `POST https://api.giga.chat/v2/chat/completions` | S1: `paths./v2/chat/completions.post.servers`; независимый curl в S3 |
| Публичные модели | `GET https://api.giga.chat/v1/models` | S1: глобальный `servers = https://api.giga.chat/v1`, путь `/models`, без отдельного override |
| Описание модели | `GET https://api.giga.chat/v1/models/{model}` | S1: `paths./models/{model}` и глобальный `servers` |
| OAuth | `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | S1: вводное описание и `paths./oauth.post.servers` |
| B2Bank V2, ИФТ | `POST https://gigachat-ift.sberdevices.delta.sbrf.ru/v2/chat/completions` | S2: `paths./v2/chat/completions.post.servers`; S4 |
| B2Bank модели, ИФТ | `GET https://gigachat-ift.sberdevices.delta.sbrf.ru/v1/models` | S2: глобальные `servers`, путь `/models` |

B2Bank S2 также перечисляет ПСИ и ПРОМ origin для `sigma.sbrf.ru` и `omega.sbrf.ru`; чат V2 переопределяет серверы на origin без `/v1`, а `/models` наследует глобальный сервер с `/v1`. Это описание адресов документацией, не подтверждение их доступности из окружения пользователя. [S2: `servers`, `paths./v2/chat/completions.post.servers`, `paths./models`]

**Общий origin есть; единого versioned base URL вида `<base>/models` и `<base>/chat/completions` для V2 документация не задаёт.** Пара `https://api.giga.chat/v2/models` + `https://api.giga.chat/v2/chat/completions` не документирована в S1. Общим root можно считать `https://api.giga.chat`, но тогда относительные пути различаются: `/v1/models` и `/v2/chat/completions`. Аналогично устроена S2. **[ВЫВОД]** Простое изменение сохранённого base URL с `/v1` на `/v2` недостаточно, если каталог моделей продолжает запрашиваться добавлением `/models`. Это не означает, что пользователь обязательно должен заполнять два URL: форма настройки остаётся решением, а не требованием API. [S1/S2: глобальные и operation-level `servers`]

Публичные `/models` и чат V2 требуют `Authorization: Bearer <access_token>`: схема безопасности `Токен доступа` имеет `type: http`, `scheme: bearer`, `bearerFormat: JWT`. Авторизационный ключ используется для получения токена, а не как новый способ авторизации V2. OAuth принимает Basic-ключ, обязательный `RqUID` UUIDv4 и `scope`; токен действует 30 минут. Значения scope `GIGACHAT_API_PERS/B2B/CORP` описывают категории доступа, **не выбор формата чата V1/V2**. Совпадение `/api/v2/oauth` с номером V2 чата не связывает эти переключатели. [S1: вводное описание, `paths./oauth`, `securitySchemes`, `paths./v2/chat/completions.post.security`]

B2Bank `/models` и V2 объявляют `security: mTLSAuthentication`, `type: mutualTLS`. Строка описания этой схемы «Basic HTTP Authentication» противоречит её машинному типу; примеры с `cert_file` и `key_file` согласуются с mTLS. В S4 одновременно встречаются Python-примеры с сертификатом и curl с Bearer: их нельзя трактовать как доказательство взаимозаменяемости способов авторизации на любом сервере. [S2: `securitySchemes.mTLSAuthentication`, `paths./models`, `paths./v2/chat/completions`; S4]

Параметры заголовков публичного V2: `X-Client-ID`, `X-Request-ID`, `X-Session-ID`; в схеме они не помечены обязательными. `X-Client-ID` также связан с доступом к файлам, поэтому это не просто другой spelling session ID. [S1: параметры операции V2, `components.parameters`]

Каталог возвращает `data[]` с `id`, `object`, `owned_by`, `type`; `type` различает `chat`, `aicheck`, `embedder`. В этой модели каталога нет поля «поддерживает V2/parallel/reasoning», контекстного окна или лимита output. Нельзя вывести полный capability matrix только из `/models`. [S1: `Model`, `Models`; S2: `Model`, `Models`]

`GigaChat-3-Ultra` по публичной документации доступен только физлицам во freemium; платным физлицам и юрлицам доступ пока не предоставлен. Сам Ultra принимает и V1, и V2: выбор V2 не тождествен выбору модели Ultra. [S3]

## 2. Тело запроса и обязательные поля V2

Публичная `ChatCompletionV2Request.required` содержит **`model`, `messages`**. Каждый `Message` требует **`role`, `content`**. Схема не задаёт `minItems` для `messages` и `content`; отсутствие ограничения в YAML не доказывает, что backend принимает пустые массивы. Описание `model` упоминает исключение при `assistant_id`, но публичная схема не объявляет такого свойства и всё равно требует `model`: это несогласованность документации, не готовый контракт работы с assistant ID. [S1: `ChatCompletionV2Request`, `Message`]

Минимальный пример формы из документации, без утверждения о выполнении:

```json
{
  "model": "GigaChat-2-Max",
  "messages": [
    {"role": "user", "content": [{"text": "Привет"}]}
  ]
}
```

Источник формы: S1 `ChatCompletionV2Request`/`Message`; аналогичный curl V2 опубликован в S3.

В `model_options` перенесены `temperature`, `top_p`, `max_tokens`, `repetition_penalty`, `update_interval`, `unnormalized_history`, `top_logprobs`, `response_format`, `parallel_tool_calls`. `stream` остаётся в корне, default `false`; `tool_config` и `tools` также в корне. `disable_filter` заменяет `profanity_check`; отключение фильтра согласуется отдельно. Следовательно, существующие V1 overrides нельзя считать автоматически переносимыми без изменения вложенности. [S1: `Chat`, `ChatCompletionV2Request`]

`unnormalized_history` выключает нормализацию: при обычной нормализации system без следующего user превращается в user, а последовательные сообщения user или assistant конкатенируются. Это важно для сохранения границ блоков истории Pi. [S1: `ChatCompletionV2Request.model_options.unnormalized_history`]

## 3. Сообщения, функции и результаты: сравнение форматов

| Элемент | GigaChat V1 | GigaChat V2, публичная S1 | OpenAI Chat Completions, S8 |
| --- | --- | --- | --- |
| Текст сообщения | `content: "..."` | `content: [{"text":"..."}]` | Строка либо typed parts, например `{"type":"text","text":"..."}` |
| Пользовательские функции | `functions: [{name, parameters, ...}]` | `tools: [{"functions":{"specifications":[{name, parameters, ...}]}}]` | `tools: [{"type":"function","function":{name, parameters, ...}}]` |
| Выбор функции | `function_call: "auto"/"none"/{name}` | `tool_config: {mode: "auto"/"none"/"forced", function_name? / tool_name?}` | `tool_choice`, в частности `auto/none/required` и выбор named function |
| Вызов функции в ответе | `choices[].message.function_call` | `messages[].content[].function_call` | `choices[].message.tool_calls[]` |
| Аргументы функции | Схема `FunctionCallArgsResponse.arguments` имеет `type: object` | Та же общая схема `type: object` | `tool_calls[].function.arguments` — JSON-строка |
| Результат функции | `role: "function"`, `name`, строковый `content` | `role: "tool"`, `content: [{"function_result":{"name":"...","result":"JSON-строка"}}]` | `role: "tool"`, `tool_call_id`, `content` |
| Состояние обращения | `functions_state_id` у assistant | `tool_state_id` у assistant | Не эквивалент OpenAI `tool_call_id` |
| Файлы пользователя | `attachments: [file_id]` | `content[].files: [{"id":"..."}]` | Typed parts `file`, `image_url`, `input_audio` и т. д.; структура иная |

Источники строк: S1 `Chat`, `message`, `AssistantMessage`, `FunctionMessage`, `FunctionCallArgsRequest/Response`, `ChatCompletionV2Request`, `Message`, `MessageResponse`, `ToolsFunctions`; S8 параметры `messages`, `tools`, `tool_choice` и возвращаемый `ChatCompletion`.

Публичная V2-схема ролей допускает `user/system/assistant/tool`; OpenAI также описывает `developer`, которого в публичной V2-схеме нет. Слово `tools` в двух API **не означает совместимость их JSON**. [S1: `Message.role`; S8: `ChatCompletionDeveloperMessageParam`, `tools`]

У `CustomFunction` обязательны `name` и `parameters`. В схеме есть дополнительные `few_shot_examples` и `return_parameters`; они не превращаются автоматически в поля OpenAI function tool. Текст требования к имени «только латинские буквы» расходится с собственным примером `weather_forecast`; для изменения валидации этого текста недостаточно. [S1: `CustomFunction`]

Встроенные инструменты V2 явно описаны как `{"image_generate":{}}` и `{"model_3d_generate":{}}`; их статус приходит через `tool_execution`/SSE tool events, а не обязательно через пользовательский вызов, исполняемый Pi. **[ВЫВОД]** Нельзя каждый `finish_reason: function_call` безусловно считать запросом исполнить локальный инструмент Pi: описание включает и встроенные инструменты. [S1: `ToolImageGenerate`, `ToolModel3DGenerate`, `MessageResponse.content[].tool_execution`, `ChatCompletionV2Response.finish_reason`]

## 4. Параллельные вызовы: подтверждённое и пробел публичной схемы

- Публичный V2 включает параллельный режим через `model_options.parallel_tool_calls: true`, default `false`; S1 прямо ограничивает его моделью **`GigaChat-3-Ultra`**. Возможны несколько пользовательских функций или несколько встроенных инструментов одновременно. Ни максимальное число вызовов, ни порядок результатов, ни число одновременно исполняемых приложением функций S1 не определяет. [S1: `ChatCompletionV2Request.model_options.parallel_tool_calls`]
- В V2 вместо единственного верхнего `function_call` есть несколько `content[]` в нескольких `messages[]`; каждый part может содержать `function_call`. Но публичный `function_result` объявляет только `name` и строковый `result`, **без `id`**, хотя `function_call.id` описан. Привязка двух параллельных вызовов одной и той же функции по одному имени публичной схемой не объяснена. [S1: `Message`, `MessageResponse`, `FunctionCallArgsResponse`]
- B2Bank S2 **явно добавляет `content[].function_result.id`**: при параллельных вызовах он должен совпадать с `function_call.id`. `result` допускает строку **или объект**. Это точный контракт для описанного B2Bank API, но **[НЕ ПОДТВЕРЖДЕНО]** для публичного S1. [S2: `Message.content.items.properties.function_result`]
- S2 не содержит публичного ограничения parallel режимом Ultra; её описание говорит о `messages.message.content` и `additional_data.execution_steps.step.function_calls`, причём доступ к `additional_data.execution_steps` согласуется отдельно. Нельзя переносить публичное ограничение на любой корпоративный сервер, равно как и считать корпоративные поля общедоступными. [S2: `ChatCompletionV2Request.model_options.parallel_tool_calls`]
- Публичный пример параллельного запроса содержит `flags: ["execution_steps"]`, но свойства `flags` нет в `ChatCompletionV2Request` публичной S1; в S2 `flags` есть. Не установлено, обязателен ли этот флаг для обычных результатов функций публичного V2. [S1: пример `Параллельные функции` операции V2 и `ChatCompletionV2Request`; S2: одноимённая схема]

**Вопрос для обсуждения, не решение:** должен ли первый согласованный набор V2 поддерживать параллельные вызовы, включая повторное имя функции, либо пользователь выбирает последовательный режим? Если parallel обязателен, публичной документации недостаёт однозначной корреляции результата с вызовом; B2Bank-контракт эту корреляцию описывает. Нельзя выдавать ограничение адаптера «одна функция» за ограничение всего V2. [S1/S2: приведённые поля]

## 5. JSON-ответ, structured output, usage, ошибки

Обычный V2 JSON-ответ имеет верхние `model`, `thread_id`, `created_at`, **`messages[]`**, **`finish_reason`**, `usage`; `messages[].content[]` содержит текст, вызовы функций, файлы и сведения об инструментах. Это не `choices[0].message` из V1/OpenAI. Публичная response-схема не объявляет эти поля через `required`; это не гарантия их фактического отсутствия или наличия во всех событиях. [S1: `ChatCompletionV2Response`, `MessageResponse`; S5: полный пример ответа V2; S8: `ChatCompletion`]

Structured output V2 задаётся `model_options.response_format: {type:"json_schema", schema:{...}, strict?:true}`. V1 использует тот же GigaChat-объект в корневом `response_format`. JSON результата остаётся **строкой в текстовом part**, а не новым объектом вместо `content`. В документации требуется `schema.required`; без него модель может вернуть произвольный JSON. OpenAI использует другую вложенность: `response_format: {type:"json_schema", json_schema:{name, schema, strict}}`; также описывает старый `json_object`, которого нет среди вариантов публичной GigaChat-схемы. [S1: `ChatResponseFormat`; S5: раздел V2 и пример ответа; S8: `response_format`]

V2 usage: `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `total_tokens`. Пример S5 дополнительно содержит `input_tokens_details.prompt_tokens`, отсутствующий в публичной response-схеме S1. V1 использует `prompt_tokens`, `precached_prompt_tokens`, `completion_tokens`, `total_tokens`. **[НЕ ПОДТВЕРЖДЕНО]** Можно ли на всех V2-серверах пересчитывать occupied context ровно по нынешней V1-формуле: спецификация не объясняет достаточно чётко, включён ли cache в каждый из счётчиков. [S1: `Usage`, `ChatCompletionV2Response.usage`; S5: пример V2]

Описанные V2 `finish_reason`: `stop`, `length`, `function_call`, `function_call_error`, `blacklist`, `request_blacklist`, `request_whitelist`, `request_filter`, `response_blacklist`. `function_call_error` означает невалидные аргументы пользовательской функции; детальные фильтры требуют отдельного доступа. В SSE-примере есть ещё `finish_reason:"error"`, которого нет в enum: список enum и пример несовместимы. OpenAI, напротив, использует `tool_calls` для современного function tool и `content_filter` для фильтрации. [S1: `ChatCompletionV2Response.finish_reason`, описание SSE операции V2; S8: `Choice.finish_reason`]

HTTP-ответы V2: `400` неверный формат, `401` авторизация, `404` неизвестная модель, `422` валидация, `429` частота, `500` внутренняя ошибка. Схемы 401/404/422/429/500 используют `{status, message}`, не OpenAI-обёртку, а для 400 в S1 задано только текстовое описание, без единой схемы тела. Превышение контекста большим файлом также описано как 422: этот статус нельзя в общем случае интерпретировать только как ошибку порядка вызовов функций. [S1: ответы операции V2, `components.responses`; S6]

## 6. SSE: явное несовпадение завершения и неполная схема delta

V2 при `stream:true` возвращает `text/event-stream`; события имеют имена:

- `response.message.delta` — фрагмент сообщения;
- `response.message.done` — окончание потока;
- `response.tool.in_progress` и `response.tool.completed` — состояние встроенного инструмента.

**Сигнал конца V2 — `response.message.done`, не `data: [DONE]`.** Это прямо сформулировано в S1/S2, а не выведено по аналогии. V1 и OpenAI Chat Completions документируют `[DONE]`. [S1/S2: `paths./v2/chat/completions.post.responses.200.content.text/event-stream`; S10; S8: `stream_options`, пример потока]

Но точная схема delta **недостаточно согласована**: SSE объявлен строкой, без отдельной object-схемы события; пример `response.message.delta` в S1/S2 содержит старое `choices[].delta`, тогда как JSON-схема V2 и рабочий способ чтения Python-примера S5 используют `messages[].content[]`. Финальный пример в описании содержит V2-поля, но соседний example блока SSE — V1-поля. **[НЕ ПОДТВЕРЖДЕНО]** Индексирование частичных message/content, корреляция фрагментов аргументов разных параллельных вызовов и возможность многократной отправки полных блоков вместо delta: их нельзя надёжно восстановить из этих примеров. [S1/S2: SSE-описание и example операции V2; S5: раздел «Потоковая передача данных»]

Общая инструкция S10 говорит «последнее событие `[DONE]`», но её curl идёт на `/v1/chat/completions`. Применять эту фразу к V2 вопреки специальному V2-контракту нельзя. [S10; S1/S2]

## 7. Reasoning: отдельный вариант B2Bank, не обещание публичному API

Публичная S1 **не объявляет** `model_options.reasoning`, `reasoning_effort`, `reasoning_content` или роль `reasoning` в V2. Поэтому из S1 нельзя обещать поддержку thinking для публичного V2 или любой выбранной пользователем модели. [S1: `ChatCompletionV2Request`, `Message`, `MessageResponse`]

B2Bank S2 и S4 описывают V2 `model_options.reasoning: {effort:"medium", max_tokens?:N}`. В enum S2 только **`medium`**; `max_tokens` для рассуждений имеет minimum 1. Ответ включает отдельное сообщение `role:"reasoning"` перед `role:"assistant"`; B2Bank Message/MessageResponse допускают роль `reasoning`. V1 B2Bank использует корневой `reasoning_effort` и `assistant.reasoning_content`. Не установлены названия доступных пользователю reasoning-моделей или их наличие на его сервере. [S2: `ChatCompletionV2Request.model_options.reasoning`, `Message.role`, `MessageResponse.role`; S4]

Python SDK версии `0.2.2a3+` упоминается S4 для V2. **Это не свидетельство поддержки V2 npm-пакетом `gigachat`**. Примеры Python и Java в документации не являются доказательством возможностей установленной JavaScript-зависимости. [S4; S10: отдельный Java-пример с `apiUrl`/`apiV2Url`]

Короткая дополнительная проверка первичного source npm `latest` **`gigachat@0.0.20`**: его `Chat` описывает V1-поля (`functions`, `function_call`, корневые sampling-параметры), а `ChatCompletion` — V1-ответ `choices/created/usage/object`. `post_chat` передаёт `chat` как есть на `/chat/completions` и приводит ответ к V1-типу без преобразования. Поэтому **[ВЫВОД] полноценная типизированная поддержка V2 по этим интерфейсам не подтверждается**, хотя raw JSON в таком транспорте не обязательно отвергается. [S11; [`chat.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/interfaces/chat.ts), [`chat_completion.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/interfaces/chat_completion.ts), [`post_chat.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/api/post_chat.ts)]

У этого же SDK `get_models` использует относительный `/models`, а `post_chat` — `/chat/completions`. SSE helper `parseChunk` обрабатывает только строки `data:`, игнорирует строки `event:`, а `stream_chat_readable` сообщает `end` при закрытии HTTP body. Значит, по этому коду нельзя обещать сохранение V2 event names или завершение по `response.message.done`. Это ограниченное source-наблюдение версии `0.0.20`, **не решение отказаться от официального SDK или написать свой транспорт**, и не runtime-проверка V2. [S11; [`get_models.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/api/get_models.ts), [`utils.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/api/utils.ts), [`stream_chat.ts`](https://github.com/ai-forever/gigachat-js/blob/d4977f956091e764051e83dfd220aa186cc8b667/src/api/stream_chat.ts)]

## 8. Протокольное сопоставление с историей Pi и текущим адаптером

Ниже — только наблюдаемое по двум исходным файлам; архитектура будущего объединения не задана.

| Текущее поведение | Последствие для обсуждения V2 | Локальный источник / API |
| --- | --- | --- |
| Исходящие сообщения имеют строковый content и роли `system/user/assistant/function` | Нужна другая wire-форма V2, а не отправка нынешнего массива без изменения | [`src/messages.ts:14–19`](../../src/messages.ts#L14), S1 `Message` |
| Pi thinking объединяется с assistant text перед отправкой | Это не эквивалент B2Bank V2-сообщению `reasoning`; политика replay thinking между моделями ещё не выбрана | [`src/messages.ts:66–82`](../../src/messages.ts#L66), S2/S4 |
| Несколько Pi tool calls преобразуются в последовательные пары call/result | Сейчас теряются исходная группировка parallel-вызовов и native ID в wire-форме; сохранять ли это для V2 — пользовательская развилка | [`src/messages.ts:83–110`](../../src/messages.ts#L83), S1/S2 `function_call`/`function_result` |
| Результаты Pi сопоставляются с вызовом по `toolCallId`, затем отправляются с именем функции и JSON `{result,isError?}` | B2Bank V2 требует сохранить отдельную корреляцию `function_result.id = function_call.id`; публичная схема этот id результата не описывает | [`src/messages.ts:88–109`](../../src/messages.ts#L88), S2 `function_result.id` |
| Непарный результат превращается в user-текст | Это существующая политика истории, не правило V2; решать отдельно от преобразования штатных вызовов | [`src/messages.ts:124–146`](../../src/messages.ts#L124) |
| Для user multimodal content выбираются только текстовые parts | Наличие V2 `files` само по себе не добавляет поддержку Pi изображений/аудио и не загружает файлы в хранилище | [`src/messages.ts:47–62`](../../src/messages.ts#L47), S1 `Message.content[].files` |
| Default system prompt запрещает несколько/parallel tool calls | Сохранение этого prompt автоматически запретит ключевую возможность V2, если пользователь ожидает parallel | [`src/stream.ts:33–34`](../../src/stream.ts#L33) |
| `payload` отправляет V1 sampling/functions/reasoning в корне | Для V2 меняется вложенность и tool config | [`src/stream.ts:90–114`](../../src/stream.ts#L90), S1/S2 `ChatCompletionV2Request` |
| URL чата получается добавлением `/chat/completions` к base URL | V2 URL чата можно представить base с `/v2`, но это не решает документированный `/v1/models` | [`src/stream.ts:171–175`](../../src/stream.ts#L171), S1/S2 `servers` |
| Consumer требует `choices`, строковый content, хранит один `tool`, создаёт собственный случайный tool ID | Это V1 consumer, не V2 JSON/parallel consumer; нельзя принять новые ответы только переключением URL | [`src/stream.ts:286–289`](../../src/stream.ts#L286), [`362–407`](../../src/stream.ts#L362), S1 `ChatCompletionV2Response` |
| Сохраняется signature из `functions_state_id`, но исходящее поле с этим именем удаляется | `tool_state_id` V2 — отдельное поле состояния, которое нельзя автоматически отождествить с текущим V1 replay | [`src/messages.ts:13`](../../src/messages.ts#L13), [`src/stream.ts:154–166`](../../src/stream.ts#L154), [`392–393`](../../src/stream.ts#L392), [`461–468`](../../src/stream.ts#L461), S1 `Message.tool_state_id` |
| SSE parser сохраняет только `event.data` и требует `[DONE]` | Теряет имя события V2 и считает корректный V2 end marker неполным потоком | [`src/stream.ts:492–523`](../../src/stream.ts#L492), S1/S2 SSE |
| finish reason `function_call` требует локальный tool, прочие кроме stop/length бросают ошибку | Для встроенных инструментов, `function_call_error` и фильтров семантика V2 требует отдельного согласования | [`src/stream.ts:439–460`](../../src/stream.ts#L439), S1 `finish_reason` |

### Соседний OpenAI-пакет и локальная smoke-проверка

В соседнем проекте генерация использует OpenAI Chat Completions: `assistant.tool_calls[]`, JSON-строки аргументов и результаты `role: "tool"` с `tool_call_id`. Адрес каталога задаётся отдельно через необязательный `modelsUrl`; без него используется `/gc/models` от origin основного endpoint, а не `<baseUrl>/models`. Это существующий контракт соседнего проекта, не правило публичного GigaChat V2. Источники: [`messages.ts`](../../../pi-gigachat-openai/src/messages.ts#L11), [`discovery.ts`](../../../pi-gigachat-openai/src/discovery.ts#L146).

**Старые записи двух проектов не содержат надёжного признака протокола:** оба используют provider prefix `gigachat-` и marker `gigachatConnection`, а поле протокола отсутствует в обеих схемах. Наличие `modelsUrl` не является универсальным признаком OpenAI, поскольку оно необязательно. **[ВЫВОД]** Выбор V1 по умолчанию для новых подключений не определяет безопасную политику классификации старых записей; её предстоит согласовать отдельно. Источники: [`текущая схема`](../../src/connection-types.ts#L24), [`соседняя схема`](../../../pi-gigachat-openai/src/connection-types.ts#L17), [`текущий reader`](../../src/connections.ts#L527), [`соседний reader`](../../../pi-gigachat-openai/src/connections.ts#L491).

Выполнены два локальных smoke-вызова настоящих исходников `convertMessages` через Node и `jiti`, без сборки и без backend: один и тот же сценарий с двумя вызовами инструмента в одном сообщении ассистента и двумя результатами. V1 выдал две последовательные пары `assistant.function_call` / `role: "function"`; соседний OpenAI — один `assistant.tool_calls` с обоими вызовами и два `role: "tool"` с исходными идентификаторами. Оба процесса завершились с кодом `0`; это проверка преобразования истории, не генерации или доступности сервера.

## 9. Вопросы исходного grilling

Эти вопросы обсуждены в завершённой проектной сессии; ответы зафиксированы в [ADR 0003](../adr/0003-connection-api-protocol.md). Список ниже сохранён как контекст исследования, не как незавершённый план.

1. **Назначение V2:** нужен полный отдельный формат для тех же серверов/моделей или V2 добавляется ради конкретного корпоративного endpoint, parallel tool calls либо reasoning? Основание: публичный и B2Bank V2 не имеют одинаковой опубликованной матрицы возможностей. [S1–S4]
2. **Единица настройки:** может ли одна самостоятельная запись подключения сервера менять параметр V1/V2/OpenAI-compatible, или одному серверу разрешены несколько записей с разными выбранными моделями и форматами? API не отвечает на вопрос идентичности пользовательской записи; общий origin и разные versioned пути лишь делают вопрос существенным. [S1/S2: `servers`, `/models`, операции чата]
3. **Адреса:** ожидается один вводимый origin/endpoint с известными путями или поддержка произвольного gateway, где пути моделей и чата не выводятся заменой `/v1` на `/v2`? Документированный публичный случай требует `/v1/models` вместе с `/v2/chat/completions`; обязательность двух полей URL из этого не следует. [S1/S2]
4. **Параллельность:** обязательны несколько вызовов, в том числе одинакового имени, или пользователь намеренно выбирает последовательный режим? Если первое, требуется уточнить публичную корреляцию результата с id вызова; для B2Bank она документирована. [S1/S2: `parallel_tool_calls`, `function_result`]
5. **Потоковый режим:** должны ли JSON и SSE быть равноправно поддержаны во всех вариантах? Для SSE известны имена событий и end marker, но публичная delta-схема противоречива. Это вопрос требуемого поведения, а не повод молча выдать JSON-only за весь V2. [S1/S2/S5]
6. **История при переключении:** должны ли существующие Pi-сессии, tool results, thinking и state signatures сохранять смысл при смене формата/подключения? Если да, какой предел потери специфических серверных полей пользователь считает допустимым? Сейчас код явно делает V1-специфические преобразования. [локальные ссылки раздела 8]
7. **Граница возможностей:** входят ли в запрос только обычный текст и пользовательские Pi tools либо также файлы/изображения, встроенные инструменты и reasoning? Документированность wire-полей не означает их уже имеющуюся сквозную поддержку Pi или npm SDK. [S1/S2/S4; локальные ссылки раздела 8]

## 10. Границы подтверждённого контракта

- Реальные проверки относятся к публичному `GigaChat-3-Ultra`, а не ко всем моделям и корпоративным серверам. Корпоративный B2Bank endpoint не вызывался.
- Официальный npm SDK не использован: общий пакет сохраняет действующий транспорт Undici, миграция на SDK отделена от этой задачи.
- Недокументированный `/v2/models` не проверялся; для публичного V2 используется документированный `/v1/models`.
- Подтверждены text/reasoning delta без индексов и готовые tool calls внутри завершающего события. Иные серверные варианты фрагментированных аргументов и много-message snapshot не наблюдались в живом ответе.
- В реальных запросах `cached_tokens` оставался нулём, включая повторный запрос с 1989 входными токенами. Ненулевой кэш проверен только на локальном контрактном стенде; первичный пример S5 задаёт `input_tokens:29`, `cached_tokens:3`, `output_tokens:31`, `total_tokens:60`.
- OpenAI-compatible адаптер проверен через native ModelRuntime и локальный JSON/SSE HTTPS-стенд, включая mTLS. Независимый живой OpenAI-compatible шлюз не предоставлялся; его универсальная совместимость не утверждается.

## 11. Наблюдения реального API и проверка реализации

Авторизационный ключ обменян на временный токен с `scope: GIGACHAT_API_PERS`. OAuth и `GET https://api.giga.chat/v1/models` вернули HTTP 200; каталог явно содержит `GigaChat-3-Ultra`. TLS-проверка оставалась включённой: для процесса проверки добавлен корневой сертификат из официально указанного HTTPS-источника, без `-k` или отключения проверки. Ключ и токен использовались в памяти; в приведённых ниже наблюдениях секретов нет.

| Проверка на `GigaChat-3-Ultra` | Наблюдение |
| --- | --- |
| V1 JSON и SSE через native ModelRuntime | Текст `PROTOCOL_OK`, вызов инструмента `lookup_number(alpha)` и продолжение с результатом `2` |
| V2 JSON и SSE через native ModelRuntime | Текст `PROTOCOL_OK`, два вызова `lookup_number(alpha/beta)` с разными ID и продолжение с суммой `5` |
| Публичный V2 function results | Приняты `function_result.id`, `name` и JSON-строка `result`; ID совпадают с исходными вызовами |
| V2 текстовый SSE | Несколько `response.message.delta` с `messages:[{role:"assistant",content:[{text:fragment}]}]` без индексов; `response.message.done` содержит finish reason и usage |
| V2 SSE инструментов | Единственное `response.message.done` содержит два полных вызова, `tool_state_id`, finish reason и usage; delta-событий может не быть |
| V2 reasoning | Публичный Ultra принял `model_options.reasoning:{effort:"medium"}` в JSON и SSE; отдельная роль `reasoning`, остановка по лимиту 128/64 токенов без финального текста ассистента |

Наблюдение reasoning подтверждает формат, но не качество генерации: модель повторяла фрагменты рассуждений до `finish_reason:"length"`. Адаптер сохраняет такой ответ как отдельные рассуждения и не подменяет его выдуманным текстом или другим протоколом.

Помимо реального API, временный локальный HTTPS-стенд подтвердил каталог и JSON/SSE для всех девяти сочетаний трёх протоколов и трёх способов авторизации. mTLS-запросы предъявляли клиентский сертификат без Bearer; неверные CA и имя сервера отвергались до HTTP.

Настоящий TUI Pi запускался в изолированном каталоге: проверены скрытый ввод, V1 по умолчанию после авторизации, создание V2, выбор в штатном `/model`, генерация, редактирование в OpenAI без смены ID/секрета и предупреждение о другом origin каталога до запросов. Отмена предупреждения сохранила прежнюю запись без обращения к новому каталогу.
