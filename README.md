# `@dev-sergeev/pi-gigachat`

GigaChat-compatible server connections for **pi 1.3.0**
(`@earendil-works/pi-*`). Requires Node.js **22.19 or later**. Uses
`createProvider()` and `pi.registerProvider(provider)`, with Pi's native
authentication and session lifecycle.

The `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`@earendil-works/pi-tui` peers are supplied by Pi. Their `"*"` peer ranges follow
Pi's package-loading convention; they do not declare compatibility with arbitrary
host versions. Development dependencies are pinned to `1.3.0`. At activation,
the extension checks the host-provided `VERSION` and accepts only `1.3.0`,
before registering commands or restoring connections. Managed `pi install`
disables peer resolution, so downloading/installing package files can still
succeed on an unsupported host. If activation prevents startup, remove the
package or start without extensions with `pi -ne`.

The package has no built-in models and does not change Pi's saved default
provider or model. Use `/gigachat` to add a server connection and select models
from its catalog, then choose one through `/model`. The adapter supports text
conversations, Pi tools, and JSON or SSE responses.
This repository continues [ai-forever/pi-gigachat](https://github.com/ai-forever/pi-gigachat)
under its original MIT license.

## Release 0.7.2

- Added **Сертификаты (mTLS)** as a third authorization mode in `/gigachat` creation and editing, with certificate-only catalog discovery, JSON/SSE generation, and native summaries.
- Import CA, client certificate, and private key from PEM paths, including password-protected keys. Saved connections no longer depend on the source files; explicit reimport replaces the full set only after successful checks.
- Server CA and hostname verification are mandatory, scoped to the imported CA bundle. No OAuth token or `Authorization` header is used, and client identity is not supplied to the proxy's TLS endpoint.
- **Security:** importing stores an unencrypted private-key copy in `auth.json`, protected by file permissions. The wizard explicitly requests confirmation; the import password is not saved.

## Release 0.7.1

- Migrated the native provider to Pi **1.3.0**. Pi 0.85.1 is no longer supported by this release.
- Adapted request conversion to `TranscriptContext`, including replacement/removal of prompt sections and current tool declarations, without changing saved history.
- Updated bundled Pi helpers: model handoffs drop foreign thinking; same-provider/API/model reasoning replay remains supported. Pi 1.3 compaction omits thinking from summary input.
- Added awaited `onProviderStreamEvent` observation for JSON and SSE. Cancellation and observer failures cannot normalize a late event or silently retry the observer.
- Final malformed tool arguments now carry Pi's `argumentsError` instead of executable partial input; native tool validation reports the error to the model.
- Updated masked input to Pi's fake-cursor markers, including hardware-cursor mode.
- Preserved saved connection identities, credentials, user-selected models, bounded retries and passive installation. Existing connections do not require discovery or paid probes again.

## Release 0.6.5

- Added a host-version activation guard: only Pi `0.85.1` can load the extension; older, newer, and prerelease versions are rejected with the detected and required versions.
- Changed the prebuilt Pi entrypoint to `extension.ts` so Pi applies host API aliases even when local `0.85.1` peers are present. The file is still bundled ahead of time; Git installs need no build tools.
- Installation itself is not blocked. Unlike `0.6.4`, this release rejects activation on unsupported Pi hosts even when peer-dependency checks are bypassed.

## Release 0.6.4

- Pinned all three Pi peer dependencies (`pi-ai`, `pi-coding-agent`, and `pi-tui`) to exactly `0.85.1`, excluding newer releases.
- Clarified that Pi 0.85.1 is the supported host version. Peer-dependency constraints are not a runtime version check and can be bypassed by package-manager options.
- No generation, model discovery, reasoning replay, or saved-history behavior changes.

## Release 0.6.3

- Saved, non-redacted reasoning is always prepended to outgoing assistant `content` as plain text, without an added XML wrapper or a separate `reasoning_content` field.
- Removed `GIGACHAT_REASONING_IN_CONTENT`; existing values are ignored, including `false`. Remove it from your launch environment.
- Pi's native thinking display, saved history, tool calls, and session resumption remain unchanged.
- Explicit `messages` overrides through extra body settings and payload hooks retain their existing behavior.
- Includes the bounded model checks described in Release 0.6.2 below.

## Release 0.6.2

- Model availability checks now allow up to three sequential attempts per model, each with a fixed five-second timeout covering the complete response.
- Every failed probe is retried immediately, including HTTP, network, and invalid-response errors; retry-delay headers do not add waits.
- Models that exhaust all three attempts remain visible with the last failure reason but cannot be selected. Cancellation stops the check without further attempts.
- Normal generation, authentication, and catalog-request timeout/retry policies are unchanged.

## Release 0.6.1

- New `/gigachat` connections use readable, case-sensitive provider IDs such as `gigachat-LDBR`, shown directly in Pi's native `/model` selector.
- New connection names accept ASCII letters, digits, hyphens, and underscores. Occupied IDs are rejected without overwriting existing credentials.
- Existing autogenerated IDs remain unchanged until explicit renaming. Renaming atomically replaces the connection; historical sessions and default-model references are not migrated, so select the model again.
- Explicitly selecting an already-current fallback model now acknowledges an unavailable historical connection and allows generation to resume.
- Outgoing tool-result messages omit `function_state`.

## Release 0.6.0

- Removed built-in GLM/Qwen models and installation/activation default-model writes.
- `/gigachat` adds only explicitly selected models without changing the active model or Pi defaults.
- Missing server metadata defaults to 262,144 context tokens, 64,000 output tokens, and reasoning support.
- Catalog refresh retains previously saved model parameters.
- Breaking: the programmatic `gigachatProvider` has no model catalog; callers must supply models through `getModels()`.
- Upgrade: defaults left by earlier versions are preserved. If they reference a removed built-in model, add a connection through `/gigachat` and select it through `/model`.

## Release 0.5.1

- Added per-model temperature settings to `/gigachat`, persisted with each server connection and sent with generation requests.
- Added recovery after HTTP 422 during generation with a temporary single-tool instruction scoped to retries of that generation; Pi history and subsequent generations remain unchanged.

## Release 0.5.0

- Added the `/gigachat` wizard for independent server connections and model discovery.
- Connection management includes authentication, model selection, and saved defaults.
- Supports private connection selections without overwriting them during default-model initialization.
- Still targets Pi 0.85.1; the documented Pi 1.0.1 and official SDK migrations are not implemented in this release.

## Install in Pi

With Pi 1.3.0 installed:

```bash
pi install npm:@dev-sergeev/pi-gigachat@0.7.2
pi
```

You can also install from Git with `pi install git:github.com/dev-sergeev/pi-gigachat`.
Installation and extension activation do not register any built-in models or
write `defaultProvider` / `defaultModel`. Restart Pi or use `/reload`, then run
`/gigachat` to configure a server connection. Adding models makes them available
in `/model`; it does not select them automatically or change saved Pi defaults.

Previously saved connections are restored on restart. Defaults left by older
package versions are not rewritten or removed: if one points to an unavailable
built-in model, add a connection through `/gigachat` and choose a model explicitly.

Pi loads the prebuilt `extension.ts` through its host-aware module loader and
supplies its own `@earendil-works` APIs. Runtime dependencies are `undici` for
HTTP/proxy support, `eventsource-parser` for SSE and `proper-lockfile` for shared
credential-store locking. Optional Pi peers avoid installing another agent;
they are supplied by the host at runtime and installed for local development.

To work on a local checkout:

```bash
git clone https://github.com/dev-sergeev/pi-gigachat.git
cd pi-gigachat
npm ci
./node_modules/.bin/pi install .
cp -n .env.example .env
```

After changing source, run `npm run build`, then restart Pi or use `/reload`.
The build updates `extension.ts` and produces JavaScript and declarations in
`dist/` for programmatic use; `npm pack` builds them automatically. Commit the
updated `extension.ts` with source changes so Git installs need no build tools. To load the checkout for one session, use
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
  ./node_modules/.bin/pi
)
```

Use an absolute `.env` path if starting elsewhere, and `pi` in place of the local
binary if using a global installation. Add `-p "Привет!"` for a single request.
Keep JSON and values containing spaces inside single quotes, as above.
Environment-file changes require loading the file again and starting a new pi
process; `/reload` alone does not reread it.

In Pi, configure connection credentials through `/gigachat` and choose a saved
connection model through `/model`. The environment credential variables below
apply to programmatic `gigachatProvider` consumers; they do not add models or
replace a saved connection's credentials.

| Variable | Default | Effect |
| --- | --- | --- |
| `GIGACHAT_ACCESS_TOKEN` | Unset | Current bearer token; cannot renew itself |
| `GIGACHAT_BASE_URL` | `https://api.giga.chat/v1` | API root, including `/v1` |
| `GIGACHAT_STREAM` | `false` | Exactly `true` for SSE or `false` for a complete JSON response |
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
and temporary connection failures. For chat generation, **every HTTP 422 response**
is retried regardless of its body, including parameter and quota diagnostics.
For other API requests, HTTP 422 is retried only when its JSON body has a
top-level `"error": "EventException"` and does not indicate quota exhaustion.
By default, it makes **up to 10 retries after the first attempt**: at most 11 HTTP
attempts for one request. This also applies to token exchange and refresh.
Other authentication/parameter errors, HTTP 413 context overflow, known quota
exhaustion outside chat HTTP 422, certificate errors and malformed successful
responses are returned immediately for the caller to handle.

After the first chat HTTP 422 with a retry available, the adapter appends one
temporary final `user` message:

> Call at most one tool per assistant message. Do not make multiple or parallel tool calls. Wait for the tool result before calling another tool.

This message remains in subsequent attempts of that generation without duplication,
including attempts after other transient failures. All errors share the existing
retry budget and backoff; adding the instruction does not reset either.
The message is never saved in Pi's conversation history and is absent from the next
generation after success, exhaustion or cancellation. Existing system instructions
and a custom `GIGACHAT_SYSTEM_PROMPT` are unchanged.

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

Models such as GLM or Qwen can be selected through `/gigachat` if the server's
catalog exposes them. No Model IDs are registered by installation.

## Add server connections through `/gigachat`

This is the model setup path for the Pi extension. The programmatic
`gigachatProvider` export supplies transport and authentication but no models;
library callers must supply their own model definitions.

1. Run `/gigachat` and choose **Токен** (access token),
   **Авторизационный ключ** (renewable authorization key), or
   **Сертификаты (mTLS)** ([certificate setup](#certificates-mtls)).
2. Enter a connection name and the API root URL. Token and authorization-key
   modes accept their secret in a masked field.
   Authorization-key mode also accepts the token endpoint URL. For a nonstandard
   API server this URL is required; the standard server uses its usual endpoint
   when the field is empty. **Ctrl+O** exposes the scope setting:
   `GIGACHAT_API_PERS` by default, or `GIGACHAT_API_B2B` / `GIGACHAT_API_CORP`.
   This wizard accepts an authorization key, not a username/password pair.
3. The extension reads `GET <API URL>/models`, removes duplicate Model IDs within
   this connection, and checks each unique model sequentially with a simple
   non-streaming generation using `max_tokens: 1`. Each model gets up to three
   attempts, stopping on the first valid response. Every attempt has a fixed
   five-second timeout covering both response headers and the complete body;
   time spent waiting in the generation queue is not part of that timeout.
4. Use **Space** to select successful models, **Ctrl+A** to select all successful
   models, and **Enter** to save. Failed models remain visible with a reason but
   cannot be selected. An empty successful set is never saved.
5. Open the normal `/model` picker and select an added model. It is available
   immediately, without restarting Pi or creating a named provider manually.

The discovery generations can be billed, including repeat attempts. Any failed
probe is retried immediately without backoff or `Retry-After` waits. After three
failures, the model is unavailable for selection in the current check; the
displayed reason describes the last failure. Cancellation stops the active
request and prevents further attempts. Thirty models exhausting all three
timeouts require about 7.5 minutes of request time, excluding queue waits and
catalog/authentication requests.

A one-token output budget does not prove tool compatibility, reasoning support,
or the server's maximum output budget. Failed checks do not replace an existing
connection. Probe limits are independent of `GIGACHAT_TIMEOUT` and
`GIGACHAT_MAX_RETRIES`; ordinary generation, authentication, and catalog requests
keep their existing policies.

Each connection has one name and authorization configuration shared by its
selected models. New connection names and changed names must match
`/^[A-Za-z0-9_-]+$/`: ASCII letters, digits, hyphens, and underscores only.
Names are case-sensitive: `LDBR` creates provider ID `gigachat-LDBR`, while
`ldbr` creates `gigachat-ldbr`. An occupied provider ID is an error, including
IDs belonging to non-GigaChat providers or credentials; no suffix is added.
Connections with the same server and Model ID still have independent credentials.
Pi's native `/model` picker remains unchanged and shows `model-id [provider-id]`;
the connection name is also included in **Model Name** and is searchable.
The `/gigachat` management list adds an ID marker only when connection captions
collide.

Previously saved connections retain their IDs, including `gigachat-server-…`,
until explicitly renamed. Existing names that do not match the new rule can
remain unchanged. Editing an address, secret, or model selection without changing
the name preserves the provider ID. Renaming creates a replacement with the new
name-derived ID: the new connection must save successfully before the old one is
removed. If saving the replacement fails, the old connection remains.

Renaming does not migrate provider/model references in saved sessions or Pi's
saved defaults. Choose the replacement model again through `/model`. This
tradeoff makes the connection name visible in the native provider ID without
changing Pi's selector, which has no separate connection-name badge.

Valid catalog context/output/reasoning metadata is used when available. Missing
metadata defaults to **262,144 context tokens**, **64,000 output tokens**, and
reasoning support with levels **off / low / medium / high**. Explicit server
metadata takes precedence, including `reasoning: false`. Saved parameters are
retained when refreshing an existing selected model. Under `/gigachat` →
**Управление подключениями** → **Параметры моделей**, edit the context/output
budgets, set **Температура**, or disable reasoning support for servers that do not
accept it. Temperature accepts finite numbers greater than or equal to zero,
including `0`. Leave the field empty to omit `temperature` and use the server's
default. The saved value applies to generation requests, including tool follow-ups
and summaries; an explicit programmatic `temperature` overrides this default.
Existing connections without a temperature retain their previous behavior. Use Pi's
normal thinking controls to choose a supported reasoning level. Model pricing is
not inferred from the catalog; zero-valued Pi cost estimates are not a free-tier
claim.

Pi saves connection metadata, its revision, and its secret together in the global
native `auth.json` (`$PI_CODING_AGENT_DIR`, or `~/.pi/agent`). This is a plaintext
file protected by native file permissions, not encryption or an OS keychain.
Other providers' credentials are preserved. Authorization-key connections use
Pi's locked OAuth renewal, retaining their own token URL and scope.

Saved catalogs are restored after restart without paid generation checks. Use
**Обновить каталог и выбор моделей** explicitly to discover and check again.
Opening `/gigachat` rereads saved connections; another open Pi with an older
revision refuses requests until this refresh or a restart.

The same management menu edits or deletes connections. Changing or deleting the
active connection aborts its current operation first; it cannot undo completed
tool actions. Deleting its selected model or connection does not route prompts
to another server. Select another model explicitly through `/model`. If a saved
private selection is missing at startup, prompts and summarization are blocked
until an explicit model selection.

No environment variables or manual configuration-file edits are required for
connection setup or authorization. The server must be reachable and its TLS
certificate trusted. Token and authorization-key connections use the existing
[certificate settings](#certificates-and-proxy); mTLS connections use their
imported CA bundle. The existing proxy settings apply to all three modes.

### Certificates (mTLS)

Choose **Сертификаты (mTLS)** to authenticate with a client certificate instead
of a token. This mode never exchanges OAuth tokens or sends an `Authorization`
header. The API root must use **HTTPS**.

Enter paths to all three PEM files:

- **Путь к PEM CA**: the trusted CA bundle for the API server.
- **Путь к PEM сертификату клиента**: the client certificate, followed by any
  intermediate certificates needed by the server.
- **Путь к PEM приватному ключу**: the matching private key.

Absolute paths, paths relative to Pi's current working directory, and `~/` paths
are supported. For an encrypted PEM key, enter its password in the masked
**Пароль PEM ключа** field; leave it empty for an unencrypted key. DER and
PKCS#12/PFX files are not accepted; prepare PEM files before importing.

**Import creates an unencrypted copy of the private key in `auth.json`.**
The wizard requests confirmation before import. The key is decrypted during
import, and the password is not saved. Protect `auth.json` and its backups:
file permissions are its protection, not encryption or an OS keychain.

Once saved, the connection uses its imported copy, so the original files can
be moved or removed. Replacing their contents does not rotate the saved
certificate. To rotate it, open **Управление подключениями** → **Изменить
подключение** → **Сертификаты (mTLS)** and provide all three paths again.
For an ordinary edit, leave all three paths empty to retain the current
materials without access to the original files. Partial replacements are
rejected. Failed imports or model checks leave the previous saved connection
unchanged.

Server certificate and hostname verification are mandatory. Only the imported
CA bundle is trusted for this connection; system CAs and `NODE_EXTRA_CA_CERTS`
are not added to it. There is no equivalent of `curl -k`, and redirects are
rejected rather than presenting the client identity to a redirected endpoint.
The client certificate applies to the API server, not the proxy's own TLS
connection or other saved connections.

Catalog discovery, model probes, generation, and summaries use the connection's
certificate identity. As with other modes, the server must provide `GET /models`
and successful generation probes before a new connection can be saved.

## Authentication and renewal

This section applies to programmatic `gigachatProvider` consumers.
Connections created through `/gigachat` manage their authorization independently.

To renew tokens automatically, leave `GIGACHAT_ACCESS_TOKEN` empty and use:

```dotenv
GIGACHAT_CREDENTIALS=your_base64_authorization_key
GIGACHAT_SCOPE=GIGACHAT_API_PERS
```

Environment authorization keys are exchanged and cached until expiry. Corporate
username/password authentication is also available through `GIGACHAT_USER` and
`GIGACHAT_PASSWORD`. A rejected standalone access token returns HTTP 401; replace
it and restart pi.

For persisted library authentication, supply a `CredentialStore` to
`createModels()` and use Pi's provider authentication APIs. The extension does
not register the library-only `gigachat` provider in `/login`; use `/gigachat`
for connection authorization.

The native Pi rules apply: **a stored credential takes priority over environment
credentials**. Remove the library provider's saved credential to switch to
environment authentication. With no stored credential, `GIGACHAT_ACCESS_TOKEN` takes priority over
`GIGACHAT_CREDENTIALS`, then username/password. Programmatic `apiKey` explicitly
overrides saved credentials and must contain an access token. A saved OAuth
profile's base URL takes priority over the process environment. An explicit
per-request `env.GIGACHAT_BASE_URL` can override that address.

## Certificates and proxy

For token and authorization-key connections requiring the Russian Trusted Root CA, follow the official
[certificate instructions](https://developers.sber.ru/docs/ru/gigachat/certificates)
and add this before launching pi:

```dotenv
NODE_EXTRA_CA_CERTS=/absolute/path/to/trusted-ca-bundle.pem
```

The launch command above sets it before Node starts. TLS verification remains
enabled. Optional `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables route both
OAuth and chat traffic, including SSE. Include the proxy CA in the trusted bundle if it intercepts TLS.
For an HTTPS proxy, Node must trust the proxy's own CA separately from the
imported mTLS CA bundle.

## Context and tools

Pi 1.3 passes providers a normalized transcript. The adapter resolves all system
messages into one leading GigaChat system message, including named section
updates/removals and the current tool set. Tools added, removed or redefined
during a session are reflected in the next request; request conversion does not
rewrite saved messages. MCP, codemode and tool search remain Pi features, not
separate protocols implemented by this package.

Final malformed function arguments carry `argumentsError` with empty arguments.
Pi's tool validation rejects that call and reports the problem to the model;
partially parsed arguments are never executed as a completed call. Invalid
provider envelopes, missing function names and truncated streams remain errors.

### Reasoning levels

Models with reasoning support use Pi's `off`, `low`, `medium`, and `high`
thinking levels by default. Choose a level with Pi's normal thinking controls
after selecting a connection model through `/model`.

The adapter sends the selected level unchanged in the top-level
`reasoning_effort` field: `off`, `low`, `medium`, or `high`. This requires a gateway
that implements this request field for these models; direct model APIs can use
different controls.

In programmatic `completeSimple` calls, pass `reasoning: "low"`, `"medium"`, or
`"high"`; omit it for `off`. The low-level `streamSimpleGigaChat` also accepts
`reasoning: "off"`. Unsupported Pi levels are clamped: `minimal` becomes `low`,
and `xhigh`/`max` become `high`. Explicit `samplingParams`, `GIGACHAT_EXTRA_BODY`,
`extraBody`, or `onPayload` overrides take precedence over the generated field.

The selected level controls new generation. Returned thinking still follows the
history rules below, including when an endpoint returns it with thinking off.

### Reasoning history

When an endpoint returns `message.reasoning_content` (JSON) or
`delta.reasoning_content` (SSE), the adapter stores it in native Pi `thinking`
blocks. This works for GLM 5.2 and other models using this response format,
including replies with empty `content` and a `function_call`. No setting is needed
to preserve reasoning that the endpoint already returns.

Pi displays these blocks and saves them in its session history. `Ctrl+T` toggles
their visibility without removing them from history. On subsequent requests to
the same provider/API/model, the adapter prepends the complete reasoning text to
the assistant message's `content`, preserving `function_call`. Reasoning fragments
are joined in their original order without inserting separators between them;
their whitespace is preserved. Tool follow-ups and resumed sessions use the same
path. Responses labeled `glm-5.2:latest` keep the selected `glm-5.2` session
identity, so that alias does not interrupt replay.

For all connections and models, the adapter removes `functions_state_id` from
every message in the final outgoing `messages` array, including payload
overrides. This avoids API errors when replaying function state. Stored Pi
history and response parsing are unchanged; nested function arguments are not
modified.

History follows Pi 1.3's rules: aborted/failed assistant turns are excluded from
requests, while model switches drop foreign thinking and strip model-specific
state. Redacted blocks are not sent as plaintext reasoning. Compaction omits
thinking from its summary input and can replace older active context with a
summary; the original session entries remain on disk. Older reasoning discarded
by earlier adapter versions cannot be recovered.

Preserving and replaying reasoning history is independent of the generation level
above. Use `GIGACHAT_EXTRA_BODY` for additional reasoning parameters supported by
your endpoint.

#### Replay in content

The adapter prepends saved, non-redacted thinking to each generated outgoing
assistant message's `content` as plain text:

```text
The original reasoning text, with its whitespace preserved.

The original assistant answer, if any.
```

The separate `reasoning_content` field is omitted from generated messages to avoid
sending the same reasoning twice. Two newline characters separate non-empty
reasoning and an answer; when either part is empty, no separator is added.
Whitespace-only reasoning is preserved. The adapter adds no XML tags and does
not strip literal tags already present in the source text.

Replies containing only reasoning and a tool call also receive this content;
`function_call` and the corresponding tool results are preserved. For multiple
tool calls in imported history, reasoning is included once, with the first call.

This transformation happens only when building requests, including tool follow-ups
and resumed sessions. Pi still displays and stores native `thinking` blocks;
incoming response parsing and saved history are unchanged. Compaction and model
switches still follow Pi's normal rules. `GIGACHAT_REASONING_IN_CONTENT` has been
removed: any existing value, including `false`, is ignored and can be deleted
from the launch environment.

Explicit overrides of `messages` via extra body settings or payload hooks can
replace the generated messages. Their reasoning fields are not converted;
the existing removal of `functions_state_id` still applies.

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

Connection models advertise text input. Context and output budgets come from
server metadata or saved user parameters. When metadata is missing, newly added
models use a 262,144-token context and a 64,000-token output budget. These values
are configuration defaults, not a guarantee of the server's actual limits.

Pi's `maxTokens` is capped at the selected model's configured output budget.
An explicit `max_tokens` in the extra JSON overrides that cap, subject to
the API's limits. pi rejects truncated summaries, but model-generated summaries
can still omit details. Images in history become omission markers; media upload,
API v2, embeddings and batch processing are not implemented. Cost metadata is
zero because USD prices are unknown, not because usage is free.

## Programmatic use

Build the checkout first with `npm run build`. In a separate Node.js application,
install `@earendil-works/pi-ai@1.3.0` alongside this package; Pi normally provides
that peer for extensions.

```ts
import { createModels, type Model } from "@earendil-works/pi-ai";
import { gigachatProvider } from "@dev-sergeev/pi-gigachat";

// Explicit consumer-owned model; use a Model ID supported by your server.
const model: Model<"gigachat-extension-api"> = {
  id: "your-server-model",
  name: "Your server model",
  api: "gigachat-extension-api",
  provider: "gigachat",
  baseUrl: "https://api.giga.chat/v1",
  input: ["text"],
  contextWindow: 262144,
  maxTokens: 64000,
  reasoning: true,
  thinkingLevelMap: {
    off: "off", minimal: null, low: "low", medium: "medium",
    high: "high", xhigh: null, max: null,
  },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const models = createModels();
const catalog = [model];
models.setProvider({
  ...gigachatProvider,
  getModels: () => catalog,
  getAllModels: () => catalog,
});
const answer = await models.completeSimple(model, {
  messages: [{ role: "user", content: "Привет!", timestamp: Date.now() }],
}, {
  env: { GIGACHAT_STREAM: "true", GIGACHAT_EXTRA_BODY: '{"temperature":0.2}' },
});
```

This example reads environment credentials. Pass a `CredentialStore` to
`createModels()` when embedding persisted authentication in another application.
The default export registers `/gigachat` and restores saved server connections,
not the library provider. Keep `getModels()` and `getAllModels()` consistent when
supplying a consumer-owned catalog.

The low-level `streamSimpleGigaChat` export accepts a normalized
`TranscriptContext`: pass `normalizeContext({ systemPrompt, tools, messages })`
from `@earendil-works/pi-ai`, plus a resolved access token in `apiKey`.
`Models.completeSimple()` still accepts ordinary `Context` and normalizes it
before provider dispatch. Set the model base URL or pass `env.GIGACHAT_BASE_URL`
explicitly when using the low-level export. `GigaChatStreamOptions` also supports
`stream`, `extraBody`, `topP`, `responseFormat`, `functionCall`,
`repetitionPenalty` and `profanityCheck`.
Body precedence is generated fields → model/request `samplingParams` → environment
JSON → `extraBody` → `onPayload`. `options.stream` overrides `GIGACHAT_STREAM`.
Custom `fetch`, headers (including null removals), `onResponse`, `timeoutMs`, and
provider-scoped `env` are supported. `onProviderStreamEvent` is awaited for each
parsed JSON/SSE event before assistant-message normalization; the SSE `[DONE]`
sentinel is not an event. `maxRetries` overrides the provider's HTTP retry count;
Pi retains its separate turn-level recovery policy as described above.

## Development

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

Tests use synthetic credentials, local HTTP fixtures and actual pi RPC sessions.
For another Pi 1.3.0 installation, set `PI_TEST_CLI=/absolute/path/to/pi/dist/bundle/cli.js`.
Secrets, local traffic captures, audit scripts and generated files are excluded
from Git; `.env.example` is included in the package.
