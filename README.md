# `@dev-sergeev/pi-gigachat`

GigaChat provider extension for the current
[`@earendil-works/pi`](https://github.com/earendil-works/pi) distribution.

This fork accepts a ready-to-use `GIGACHAT_ACCESS_TOKEN` without performing an
OAuth exchange. In access-token mode, requests go directly to
`https://api.giga.chat/v1/chat/completions` and never use
`ngw.devices.sberbank.ru`.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.83.x or a compatible newer release

## Install from GitHub

Remove the old npm extension, if it is installed, and install this fork:

```bash
pi remove npm:@gigachain/pi-gigachat
pi install git:github.com/dev-sergeev/pi-gigachat
```

Pi loads the TypeScript extension source directly. This is intentional: git
package installs use production dependencies only, so installation does not
depend on a development-only TypeScript compiler.

## Minimal usage

```bash
export GIGACHAT_ACCESS_TOKEN='raw-access-token'
pi --provider gigachat --model GigaChat
```

Built-in defaults:

- provider: `gigachat`
- model: `GigaChat`
- base URL: `https://api.giga.chat/v1`
- TLS certificate verification: disabled for GigaChat connections

The access token should normally be supplied without `Bearer `. A leading
`Bearer ` prefix is accepted and removed before the token is passed to the SDK.
Opaque tokens without dots are valid.

`GIGACHAT_SCOPE` is not needed when a ready access token is supplied. Access
tokens are not refreshed automatically. After a token expires, obtain a new
one, update `GIGACHAT_ACCESS_TOKEN`, and restart Pi.

## Generation parameters

For one-off interactive runs, use the extension's namespaced Pi flags:

```bash
pi --provider gigachat --model GigaChat \
  --gigachat-temperature 0.2 \
  --gigachat-max-tokens 4096 \
  --gigachat-repetition-penalty 1.1
```

For persistent shell, container, or service configuration, use environment
variables:

```bash
export GIGACHAT_TEMPERATURE=0.2
export GIGACHAT_MAX_TOKENS=4096
export GIGACHAT_REPETITION_PENALTY=1.1
export GIGACHAT_UPDATE_INTERVAL=0.25
```

Supported scalar controls are:

| GigaChat request field | Pi flag | Environment variable |
| --- | --- | --- |
| `temperature` | `--gigachat-temperature` | `GIGACHAT_TEMPERATURE` |
| `top_p` | `--gigachat-top-p` | `GIGACHAT_TOP_P` |
| `max_tokens` | `--gigachat-max-tokens` | `GIGACHAT_MAX_TOKENS` |
| `repetition_penalty` | `--gigachat-repetition-penalty` | `GIGACHAT_REPETITION_PENALTY` |
| `update_interval` | `--gigachat-update-interval` | `GIGACHAT_UPDATE_INTERVAL` |

`temperature` must be greater than zero. `top_p` must be between zero and one.
They are alternative sampling strategies: configure one, not both. Token limits
from flags, environment variables, or `samplingParams` must be positive 32-bit
integers; `repetition_penalty` must be positive, and `update_interval` must be
non-negative. Invalid flag, environment, or `samplingParams` configuration fails
before an API request is sent. For compatibility with Pi, a positive fractional
`options.maxTokens` value is floored and an invalid one is omitted.

If no sampling control is configured, `temperature`, `top_p`, and
`repetition_penalty` are omitted so that GigaChat can use its model-dependent
defaults. `max_tokens` defaults to the Pi model's `maxTokens` metadata (8192 for
the bundled GigaChat models and 131071 for `glm-5.1`).

The current GigaChat REST API also supports structured output through
`response_format`. Programmatic callers can use the exported
`GigaChatStreamOptions` type:

```ts
import type { GigaChatStreamOptions } from "@dev-sergeev/pi-gigachat";

const options: GigaChatStreamOptions = {
  responseFormat: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    },
    strict: true,
  },
};
```

The extension also understands extension-specific `model.samplingParams` and
`options.samplingParams` fields using the request-field names `temperature`,
`top_p`, `max_tokens`, `repetition_penalty`, `update_interval`,
`profanity_check`, and `response_format`. Flags and environment variables are
the recommended user-facing configuration. Resolution order, from highest to
lowest priority, is:

1. `options.samplingParams`
2. named runtime options such as `temperature`, `topP`, and `maxTokens`
3. `--gigachat-*` flags
4. request-scoped `options.env`
5. `GIGACHAT_*` process environment variables
6. `model.samplingParams`
7. `model.maxTokens` for `max_tokens`

A higher-priority `top_p` removes a lower-priority `temperature`, and vice
versa. The existing `onPayload` hook remains the final trusted override.

The `samplingParams` interface rejects unknown and structural fields, including
`model`, `messages`, `stream`, `functions`, and `function_call`. Function calls
continue to use the existing typed `functionCall` option and Pi tool context.
The extension deliberately does not expose `n`: its streaming consumer handles
one response choice. `profanity_check` remains available only as a legacy
programmatic option for compatibility with `gigachat` 0.0.20; it has no CLI
flag or documented environment variable because it is absent from the current
REST v1 schema. See the official
[chat completion reference](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat)
and [structured output guide](https://developers.sber.ru/docs/ru/gigachat/guides/structured-output).

## Authentication priority

The extension resolves authentication in this order:

1. `GIGACHAT_ACCESS_TOKEN`
2. `GIGACHAT_CREDENTIALS`
3. saved Pi OAuth configuration or `options.apiKey`
4. `GIGACHAT_USER` and `GIGACHAT_PASSWORD`

When `GIGACHAT_ACCESS_TOKEN` is set, stale credentials, username/password, and
stored OAuth data cannot trigger a token exchange. The SDK receives only the
normalized access token.

`/login gigachat` remains available for OAuth-backed setups. In its `token`
mode, the prompt expects an Authorization Key/credentials (often shown as
`Basic <authorization_key>`), not an already-issued access token. Use
`GIGACHAT_ACCESS_TOKEN` for an already-issued token.

Never commit tokens to the repository or `.env` files.

## Endpoint configuration

Override the API endpoint without changing source code:

```bash
export GIGACHAT_BASE_URL='https://another-host.example/v1'
```

Base URL priority is:

1. request `options.baseUrl`
2. `GIGACHAT_BASE_URL`
3. the Pi model base URL
4. `https://api.giga.chat/v1`

Trailing slashes are removed. Configure the API root only; do not append
`/chat/completions`, because the extension adds that endpoint.

`GIGACHAT_MODEL` does not override the model selected by Pi. For example,
`pi --provider gigachat --model GigaChat` always sends
`"model": "GigaChat"`.

## Request timeout

The request timeout is an HTTP transport setting, not a
`POST /chat/completions` JSON field. It is therefore expected that mitmproxy
does not show `timeout` in the request body. `update_interval` only controls
how often buffered streaming chunks are emitted; it does not extend the HTTP
timeout.

Pi supplies the standard `options.timeoutMs` value in milliseconds. The
extension converts it to seconds for `gigachat-js`, which uses the value for
both API and OAuth Axios clients. A normal Pi CLI run defaults to the Pi HTTP
timeout (currently 300000 ms), instead of the SDK's otherwise independent
30-second default.

To override the timeout only for GigaChat, set `GIGACHAT_TIMEOUT` in seconds:

```bash
export GIGACHAT_TIMEOUT=600
pi --provider gigachat --model GigaChat
```

`0` disables the SDK transport timeout and may leave a stalled request waiting
indefinitely. Invalid or negative values fail before a network request. Timeout
priority is:

1. programmatic `options.timeoutSeconds`
2. request-scoped `options.env.GIGACHAT_TIMEOUT`
3. process `GIGACHAT_TIMEOUT`
4. standard Pi `options.timeoutMs`
5. the `gigachat-js` default when no value is supplied

See the official
[JavaScript SDK configuration](https://developers.sber.ru/docs/ru/gigachain/tools/js/gigachat).

## TLS certificate verification

This specialized fork disables certificate verification by default only on the
HTTPS Agent passed to the GigaChat SDK. It prints this warning once per process:

```text
[pi-gigachat] TLS certificate verification is disabled
```

Enable verification with:

```bash
export GIGACHAT_VERIFY_SSL_CERTS=true
```

Accepted true values are `true`, `1`, `yes`, and `on`. Accepted false values
are `false`, `0`, `no`, and `off`. Values are case-insensitive. An unknown
value is a configuration error.

Disabling certificate verification weakens transport security. Enable it when
the host trust store contains the required certificate chain. Do not use
`NODE_TLS_REJECT_UNAUTHORIZED=0`; that disables verification globally for Pi
and every other HTTPS connection in the process.

## Models

- `gigachat/GigaChat`
- `gigachat/glm-5.1`
- `gigachat/GigaChat-2`
- `gigachat/GigaChat-2-Pro`
- `gigachat/GigaChat-2-Max`

For `GigaChat`, the extension carries `contextWindow: 128000` and
`maxTokens: 8192` as operational metadata inherited from the current extension.
For `glm-5.1`, it carries `contextWindow: 192000`, `maxTokens: 131071`, and
`temperature: 0.2` as operational defaults. The public GigaChat model catalog
does not currently list `glm-5.1`; this is an experimental/custom-route entry
whose availability must be confirmed for the active token with `GET /v1/models`.
These values are not presented as official limits for every GigaChat API
deployment. A route with a smaller server-side output limit may require
`--gigachat-max-tokens` with a lower value. See the official
[model selection guide](https://developers.sber.ru/docs/ru/gigachat/guides/selecting-a-model)
and [`GET /v1/models` reference](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/get-models).

## Optional Pi defaults

The package does not modify `~/.pi/agent/settings.json`. To make GigaChat the
user-selected default, add this configuration yourself:

```json
{
  "defaultProvider": "gigachat",
  "defaultModel": "GigaChat"
}
```

Pi can then be started with:

```bash
pi
```

## Troubleshooting `ENOTFOUND ngw.devices.sberbank.ru`

```text
Error: Failed to login to GigaChat:
getaddrinfo ENOTFOUND ngw.devices.sberbank.ru
```

This is a DNS error, not a TLS certificate error. It means a credentials-based
OAuth exchange was attempted. With this fork and a non-empty
`GIGACHAT_ACCESS_TOKEN`, no request to `ngw.devices.sberbank.ru` should occur.

Check the installed package source:

```bash
pi list
```

It should show `git:github.com/dev-sergeev/pi-gigachat`, not the old
`npm:@gigachain/pi-gigachat` package. Then restart Pi after exporting the access
token.

## Troubleshooting `timeout of 30000ms exceeded`

This message is generated by the SDK's Axios transport and is not a Sber API
validation error. It means the client did not receive the required HTTP data
within 30 seconds. Update this fork and either rely on Pi's timeout setting or
set, for example, `GIGACHAT_TIMEOUT=600` before starting Pi. Do not add
`timeout` to the chat JSON payload; the API schema does not define that field.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run check` runs lint, type checking, and tests without rewriting source
files. Use `npm run format` explicitly to apply formatting.

The implementation uses the official
[`gigachat`](https://github.com/ai-forever/gigachat-js) JavaScript SDK and a
custom robust SSE parser retained from upstream for tool-call streams.
