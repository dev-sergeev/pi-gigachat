# `@dev-sergeev/pi-gigachat`

Native GigaChat provider for **pi 0.85.1** (`@earendil-works/pi-*`). Requires
Node.js **22.19 or later**. Uses `createProvider()` and
`pi.registerProvider(provider)`, with pi's native authentication and session
lifecycle. The legacy provider API and `@mariozechner/pi-*` packages are no longer used.

Includes `GigaChat-2` (Lite), `GigaChat-2-Pro`, `GigaChat-2-Max`, and
`GigaChat-3-Ultra`, text conversations, pi tools, and JSON or SSE responses.
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
| `GIGACHAT_EXTRA_BODY` | `{}` | JSON object shallow-merged into every chat request |
| `GIGACHAT_SYSTEM_PROMPT` | Empty | Provider instructions appended to pi's system prompt |
| `GIGACHAT_TIMEOUT` | `300` | HTTP timeout in seconds |
| `GIGACHAT_CREDENTIALS` | Unset | Authorization key for automatic token exchange |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | `GIGACHAT_API_PERS`, `GIGACHAT_API_B2B`, or `GIGACHAT_API_CORP` |
| `GIGACHAT_AUTH_URL` | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | Token exchange endpoint |

With `stream=false`, pi receives its text/tool events when the complete JSON
response arrives. With `stream=true`, text appears incrementally. Both modes
support tools, usage accounting, cancellation, and compaction.

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

### Provider-specific system instructions

Use `GIGACHAT_SYSTEM_PROMPT` to add instruction blocks for this provider:

```dotenv
GIGACHAT_SYSTEM_PROMPT='Правила для ответов:
- Отвечай на русском языке.
- Явно отмечай предположения.

Правила работы с кодом:
- Сохраняй стиль существующего проекта.'
```

The adapter appends this text after pi's original system prompt, separated by a
blank line, within the same first `system` message. It applies to all GigaChat
requests, including tool follow-ups and compaction; other providers are unaffected.
The original context is not mutated, so the block is added once per request.
If there is no original system prompt, the extra text becomes the system message.
An unset, empty or whitespace-only value adds nothing. Outer whitespace is trimmed;
internal line breaks are preserved. Use actual line breaks inside the quotes,
as above; literal `\n` sequences are not decoded.

Provider-scoped `env.GIGACHAT_SYSTEM_PROMPT` overrides the process environment;
an explicit empty string disables the extra prompt for that request. As with pi's
original messages, a `messages` override in `GIGACHAT_EXTRA_BODY` or a payload hook
can replace the generated message list. Reload `.env` and restart pi after changes.

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

All registered models advertise text input and a 128,000-token context. The
configured output budget is 8,192 tokens; pi's `maxTokens` is capped at that
value. An explicit `max_tokens` in the extra JSON overrides that cap, subject to
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
provider-scoped `env` are supported. Retry policy belongs to pi.

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
