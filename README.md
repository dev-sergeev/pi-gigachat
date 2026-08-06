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
- `gigachat/GigaChat-2`
- `gigachat/GigaChat-2-Pro`
- `gigachat/GigaChat-2-Max`

For `GigaChat`, the extension carries `contextWindow: 128000` and
`maxTokens: 8192` as operational metadata inherited from the current extension.
These values are not presented as official limits for every GigaChat API
deployment.

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
