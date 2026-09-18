# `@dev-sergeev/pi-gigachat`

Native GigaChat provider for **pi 0.85.1** (`@earendil-works/pi-*`). Requires
Node.js **22.19 or later**. Uses `createProvider()` and
`pi.registerProvider(provider)`, with pi's native authentication and session
lifecycle. The legacy provider API and `@mariozechner/pi-*` packages are no longer used.

Includes `GigaChat-2` (Lite), `GigaChat-2-Pro`, `GigaChat-2-Max`,
`GigaChat-3-Ultra`, and `glm-5.2`, text conversations, pi tools, and JSON or SSE responses.
GLM 5.2 requires a GigaChat-compatible endpoint that exposes the `glm-5.2` model ID;
registering it does not make it available on every GigaChat account or endpoint.
This repository continues [ai-forever/pi-gigachat](https://github.com/ai-forever/pi-gigachat)
under its original MIT license.

## Install in Pi

With Pi 0.85.1 installed:

```bash
pi install git:github.com/dev-sergeev/pi-gigachat
pi --provider gigachat --model GigaChat-3-Ultra
```

Use `/login gigachat` to configure authentication, then select a GigaChat model
with `/model`. Restart an existing Pi session or use `/reload` after installation.

Pi loads the prebuilt `extension.js` and supplies its own `@earendil-works`
APIs. Installation only adds two runtime packages: `undici` for HTTP/proxy support
and `eventsource-parser` for SSE. Pi peers are optional to avoid installing another
agent; they are required for development and supplied by the host at runtime.

To work on a local checkout:

```bash
git clone https://github.com/dev-sergeev/pi-gigachat.git
cd pi-gigachat
npm ci
./node_modules/.bin/pi install .
cp -n .env.example .env
```

After changing source, run `npm run build`, then restart Pi or use `/reload`.
The build updates `extension.js` and produces JavaScript and declarations in
`dist/` for programmatic use; `npm pack` builds them automatically. Commit the
updated `extension.js` with source changes so Git installs need no build tools. To load the checkout for one session, use
`pi -e /absolute/path/to/pi-gigachat`.

## Token, base URL and request settings

Edit `.env`:

```dotenv
GIGACHAT_ACCESS_TOKEN=your_current_access_token
GIGACHAT_BASE_URL=https://api.giga.chat/v1
GIGACHAT_STREAM=false
GIGACHAT_EXTRA_BODY='{"temperature":0.2,"max_tokens":4096,"repetition_penalty":1.05}'
```

Use the OAuth **access token**, without `Bearer`. `GIGACHAT_BASE_URL` is the API
root; the adapter appends `/chat/completions`. An authorization key used to obtain
tokens belongs in `GIGACHAT_CREDENTIALS`, described below.

**Creating `.env` and installing this package does not load `.env` automatically.**
Launch from this checkout with Bash/Zsh:

```bash
(
  set -a
  . ./.env
  set +a
  ./node_modules/.bin/pi --provider gigachat --model GigaChat-3-Ultra
)
```

Use an absolute `.env` path if starting elsewhere, and `pi` in place of the local
binary if using a global installation. Add `-p "Привет!"` for a single request.
Keep JSON and values containing spaces inside single quotes, as above.
Environment-file changes require loading the file again and starting a new pi
process; `/reload` alone does not reread it.

| Variable | Default | Effect |
| --- | --- | --- |
| `GIGACHAT_ACCESS_TOKEN` | Unset | Current bearer token; cannot renew itself |
| `GIGACHAT_BASE_URL` | `https://api.giga.chat/v1` | API root, including `/v1` |
| `GIGACHAT_STREAM` | `false` | Exactly `true` for SSE or `false` for a complete JSON response |
| `GIGACHAT_REASONING_IN_CONTENT` | `false` | Exactly `true` to include saved thinking in outgoing assistant `content`; `false` keeps the normal `reasoning_content` field |
| `GIGACHAT_EXTRA_BODY` | `{}` | JSON object shallow-merged into every chat request |
| `GIGACHAT_SYSTEM_PROMPT` | Built-in single-tool instruction | Replaces the default provider block; an empty value disables the block |
| `GIGACHAT_TIMEOUT` | `300` | HTTP timeout in seconds per attempt, excluding retry waits |
| `GIGACHAT_MAX_RETRIES` | `10` | Retries after the initial HTTP attempt; `0` disables provider retries |
| `GIGACHAT_RETRY_BASE_DELAY_MS` | `1000` | Initial retry wait in milliseconds; doubles up to 600,000 ms |
| `GIGACHAT_CREDENTIALS` | Unset | Authorization key for automatic token exchange |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | `GIGACHAT_API_PERS`, `GIGACHAT_API_B2B`, or `GIGACHAT_API_CORP` |
| `GIGACHAT_AUTH_URL` | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | Token exchange endpoint |

With `stream=false`, pi receives its text, thinking and tool events when the complete
JSON response arrives. With `stream=true`, text and thinking appear incrementally.
Both modes support tools, usage accounting, cancellation, and compaction.

`GIGACHAT_EXTRA_BODY` overrides corresponding fields in the generated request.
For example, `{"max_tokens":4096,"temperature":0.2,"top_p":0.8}` changes those
three fields while retaining the model, messages and tool definitions. Nested
objects replace their whole field; they are not merged recursively. You can
pass other fields supported by the [GigaChat API](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat),
including `response_format`. Changes apply to **tool follow-ups and summaries too**.
Overriding `model`, `messages` or `functions` replaces the corresponding pi data.
Malformed JSON or a non-object value fails before a chat request is sent.

`stream` is controlled by `GIGACHAT_STREAM` and is not overridden by the extra
JSON or payload hooks, so the request format always matches its response parser.
Sampling settings are otherwise left to the model unless explicitly supplied.

### Retries

The provider retries transient HTTP 408/429/5xx responses, per-attempt timeouts
and temporary connection failures. By default, it makes **up to 10 retries after
the first attempt**: at most 11 HTTP attempts for one request. This also applies
to token exchange and refresh. Authentication/parameter errors, HTTP 413 context
overflow, known quota exhaustion, certificate errors and malformed responses
are returned immediately for the caller to handle.

Retry waits use `min(baseDelayMs * 2^retryIndex, 600000)`, with a zero-based retry
index. The default waits are **1, 2, 4, 8, 16, 32, 64, 128, 256, 512 seconds**.
If more retries are configured, subsequent waits remain at most **10 minutes**.
The ten default waits total 17 minutes 3 seconds, excluding request time.
`GIGACHAT_TIMEOUT` starts afresh for each HTTP attempt; it does not expire during
backoff. Cancellation interrupts both the active request and its retry wait.

`Retry-After` (seconds or HTTP date) and `retry-after-ms` may extend a wait up to
the same ten-minute ceiling. A longer server-requested wait fails immediately
instead of retrying earlier than the server allows. Responses are released
before waiting, and `onResponse` observes every HTTP attempt.

After any text, thinking or tool output has been emitted, the provider does not replay the
response; Pi can still apply its normal turn-level recovery. Retry exhaustion
is marked as a terminal retry-budget error, preserving the last failure. This
prevents Pi 0.85's outer retry loop from starting another full provider budget.
The extension does not change Pi's global retry settings or other providers.

Set `GIGACHAT_MAX_RETRIES=0` to disable provider retries. In programmatic use,
`options.maxRetries` overrides that environment setting for chat; OAuth uses the
environment settings. Pi can pass the chat override through
`retry.provider.maxRetries` in its settings. Provider-scoped environment values
override process variables. Retry counts must be non-negative safe integers;
the base delay must be an integer from 0 to 600000 ms (0 permits immediate retries).

### Provider-specific system instructions

By default, the adapter appends this English instruction after pi's original
system prompt, separated by a blank line, within the same first `system` message:

> Call at most one tool per assistant message. Do not make multiple or parallel tool calls. Wait for the tool result before calling another tool.

`GIGACHAT_SYSTEM_PROMPT` controls this entire provider block:

| Value | Behavior |
| --- | --- |
| Unset | Append the built-in single-tool instruction |
| Custom text | Append that text instead of the built-in instruction |
| Empty or whitespace-only | Append nothing |

For example, this **replaces** the default single-tool instruction:

```dotenv
GIGACHAT_SYSTEM_PROMPT='Правила для ответов:
- Отвечай на русском языке.
- Явно отмечай предположения.

Правила работы с кодом:
- Сохраняй стиль существующего проекта.'
```

Pi's original system prompt is preserved. The selected provider block applies to
all requests through this provider, including tool follow-ups and compaction;
other providers are unaffected.
The original context is not mutated, so the block is added once per request.
If there is no original system prompt, the block becomes the system message.
To retain the single-tool instruction with custom rules, include it in the custom
value explicitly. `.env.example` contains the complete default text.
Outer whitespace is trimmed;
internal line breaks are preserved. Use actual line breaks inside the quotes,
as above; literal `\n` sequences are not decoded.

Provider-scoped `env.GIGACHAT_SYSTEM_PROMPT` overrides the process environment;
an explicit empty string disables the extra prompt for that request. As with pi's
original messages, a `messages` override in `GIGACHAT_EXTRA_BODY` or a payload hook
can replace the generated message list. Reload `.env` and restart pi after changes.

The default block is a model instruction; it does not add an API parameter or a
runtime guarantee of model compliance.

For GLM 5.2 on a compatible endpoint:

```bash
pi --provider gigachat --model glm-5.2
```

## Authentication and renewal

To renew tokens automatically, leave `GIGACHAT_ACCESS_TOKEN` empty and use:

```dotenv
GIGACHAT_CREDENTIALS=your_base64_authorization_key
GIGACHAT_SCOPE=GIGACHAT_API_PERS
```

Environment authorization keys are exchanged and cached until expiry. Corporate
username/password authentication is also available through `GIGACHAT_USER` and
`GIGACHAT_PASSWORD`. A rejected standalone access token returns HTTP 401; replace
it and restart pi.

Alternatively, run `/login gigachat`. Select an access token or the renewable
login option. Renewable login asks for an authorization key or username/password,
base URL, and scope. pi stores the credential in its `auth.json` and owns token
renewal with a storage lock. Existing OAuth credentials saved by this extension
remain usable.

The native pi rules apply: **a stored credential takes priority over environment
credentials**. Use `/logout gigachat` to switch to `.env` authentication. With no
stored credential, `GIGACHAT_ACCESS_TOKEN` takes priority over
`GIGACHAT_CREDENTIALS`, then username/password. Programmatic `apiKey` explicitly
overrides saved credentials and must contain an access token. A saved OAuth
profile's base URL takes priority over the process environment. An explicit
per-request `env.GIGACHAT_BASE_URL` can override that address.

## Certificates and proxy

For an API requiring the Russian Trusted Root CA, follow the official
[certificate instructions](https://developers.sber.ru/docs/ru/gigachat/certificates)
and add this before launching pi:

```dotenv
NODE_EXTRA_CA_CERTS=/absolute/path/to/trusted-ca-bundle.pem
```

The launch command above sets it before Node starts. TLS verification remains
enabled. Optional `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables route both
OAuth and chat traffic, including SSE. Include the proxy CA in the trusted bundle if it intercepts TLS.

## Context and tools

### Reasoning history

When an endpoint returns `message.reasoning_content` (JSON) or
`delta.reasoning_content` (SSE), the adapter stores it in native Pi `thinking`
blocks. This works for GLM 5.2 and other models using this response format,
including replies with empty `content` and a `function_call`. No setting is needed
to preserve reasoning that the endpoint already returns.

Pi displays these blocks and saves them in its session history. `Ctrl+T` toggles
their visibility without removing them from history. By default, on subsequent requests to
the same provider/API/model, the adapter restores the complete reasoning text in
the assistant message's `reasoning_content` field, alongside `content`,
`function_call` and `functions_state_id`. Whitespace and streamed fragments are
preserved without adding separators. Tool follow-ups and resumed sessions use
the same path. Responses labeled `glm-5.2:latest` keep the selected `glm-5.2`
session identity, so that alias does not interrupt replay.

History follows Pi's normal rules: aborted/failed assistant turns are excluded
from requests, while model switches convert non-redacted thinking into ordinary
assistant text and strip model-specific state. Redacted blocks are not sent as
plaintext reasoning. Compaction can include thinking in its summary input and
replace older active context with a summary; the original session entries remain
on disk. Older reasoning discarded by earlier adapter versions cannot be recovered.

This feature preserves returned reasoning; it does not configure how much the
server generates or map Pi's thinking-level selector to API options. Use
`GIGACHAT_EXTRA_BODY` for reasoning parameters supported by your endpoint.
Whether the server uses replayed `reasoning_content` depends on that endpoint's
input contract; returning the field alone does not establish that support.

#### Optional replay in content

For endpoints that ignore `reasoning_content` on input, explicitly enable:

```bash
GIGACHAT_REASONING_IN_CONTENT=true pi --provider gigachat --model glm-5.2
```

This setting defaults to `false`. Unset or `false` preserves the normal behavior
described above. Only the exact values `true` and `false` are accepted; other
values fail before a request is sent. Export the variable or reload your `.env`
when starting Pi, as described in the launch instructions.

When enabled, the adapter prepends saved, non-redacted thinking to each outgoing
assistant message's `content` in this format:

```text
<previous_reasoning>
The original reasoning text, with its whitespace preserved.
</previous_reasoning>

The original assistant answer, if any.
```

The separate `reasoning_content` field is omitted in this mode to avoid sending
the same reasoning twice. Empty reasoning adds no marker. Replies containing
only reasoning and a tool call also receive this content; `function_call`,
`functions_state_id`, and the corresponding tool results are preserved. For
multiple tool calls in imported history, the reasoning is included once, with
the first call.

This transformation happens only when building requests, including tool
follow-ups and resumed sessions. Pi still displays and stores native `thinking`
blocks, so disabling the setting restores the default request format without
rewriting history. Compaction and model switches still follow Pi's normal rules.
Explicit overrides of `messages` via extra body settings or payload hooks can
replace the generated messages.

The endpoint receives reasoning as ordinary assistant text in its context. This
uses additional input tokens on endpoints that previously ignored the separate
field; it does not enable a server's native reasoning mode or guarantee better
answers.

### Context management

Compaction uses pi's original implementation: `/compact`, automatic compaction,
branch summaries, and resuming saved sessions all use this provider. Function
state survives serialization; tool results are JSON objects encoded as strings,
as required by GigaChat. Parallel tool history is replayed as ordered call/result
pairs. The build includes pi's history normalization from the pinned `pi-ai` version;
see `THIRD_PARTY_NOTICES`.

Cached input is included in pi's context usage:
`prompt_tokens + precached_prompt_tokens + completion_tokens`. GigaChat's
billable `total_tokens` alone would undercount context. `X-Session-ID` provides
session affinity; `cacheRetention: "none"` suppresses the automatic header.
HTTP 413 is marked as context overflow so pi can compact and retry. Requests in
one adapter instance are serialized for the personal account concurrency limit;
separate processes still share the account's limits.

All registered models advertise text input. Configured token budgets are:

| Models | Context window | Maximum generated tokens |
| --- | --- | --- |
| GigaChat 2 Lite / Pro / Max, GigaChat 3 Ultra | 128,000 | 8,192 |
| GLM 5.2 | 200,000 | 64,000 |

Pi's `maxTokens` is capped at the selected model's configured output budget.
An explicit `max_tokens` in the extra JSON overrides that cap, subject to
the API's limits. pi rejects truncated summaries, but model-generated summaries
can still omit details. Images in history become omission markers; media upload,
API v2, embeddings and batch processing are not implemented. Cost metadata is
zero because USD prices are unknown, not because usage is free.

## Programmatic use

Build the checkout first with `npm run build`. In a separate Node.js application,
install `@earendil-works/pi-ai@0.85.1` alongside this package; Pi normally provides
that peer for extensions.

```ts
import { createModels } from "@earendil-works/pi-ai";
import { gigachatProvider } from "@dev-sergeev/pi-gigachat";

const models = createModels();
models.setProvider(gigachatProvider);
const model = models.getModel("gigachat", "GigaChat-3-Ultra")!;
const answer = await models.completeSimple(model, {
  messages: [{ role: "user", content: "Привет!", timestamp: Date.now() }],
}, {
  env: { GIGACHAT_STREAM: "true", GIGACHAT_EXTRA_BODY: '{"temperature":0.2}' },
});
```

This example reads environment credentials. Pass a `CredentialStore` to
`createModels()` when embedding persisted authentication in another application.
The default export registers the provider in a pi extension. The low-level
`streamSimpleGigaChat` export requires a resolved access token in `apiKey`.
Set the model base URL or pass `env.GIGACHAT_BASE_URL` explicitly when using the
low-level export. Its `GigaChatStreamOptions` also supports `stream`, `extraBody`, `topP`,
`responseFormat`, `functionCall`, `repetitionPenalty` and `profanityCheck`.
Body precedence is generated fields → model/request `samplingParams` → environment
JSON → `extraBody` → `onPayload`. `options.stream` overrides `GIGACHAT_STREAM`.
Custom `fetch`, headers (including null removals), `onResponse`, `timeoutMs`, and
provider-scoped `env` are supported. `maxRetries` overrides the provider's HTTP
retry count; Pi retains its separate turn-level recovery policy as described above.

## Development

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

Tests use synthetic credentials, local HTTP fixtures and actual pi RPC sessions.
For another installed pi, set `PI_TEST_CLI=/absolute/path/to/pi/dist/cli.js`.
Secrets, local traffic captures, audit scripts and generated files are excluded
from Git; `.env.example` is included in the package.
