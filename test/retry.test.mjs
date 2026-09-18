import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModels, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { gigachatProvider } from '../dist/index.js';
import { request } from '../dist/http.js';
import { ask, completion, json, reply, token, user, withServer } from './helpers.mjs';
import { until, withPi } from './pi-rpc.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const fast = { GIGACHAT_RETRY_BASE_DELAY_MS: '0' };
const consume = response => response.json();
const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });

for (const extended of [false, true]) test(`exponential waits and bounded request count use virtual time (extended=${extended})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pending = request('https://example.invalid', { method: 'POST', body: 'same request' }, {
    ...(extended ? { maxRetries: 12 } : {}),
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.body, 'same request');
      return Response.json({ message: 'temporary failure' }, { status: 503 });
    },
  }, consume).catch(error => error);
  await flush();
  assert.equal(calls, 1);
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, ...(extended ? [600000, 600000] : [])];
  for (const [index, delay] of delays.entries()) {
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(calls, index + 1, 'request sent before its delay');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, index + 2);
  }
  const error = await pending;
  assert(error instanceof Error);
  assert.match(error.message, new RegExp(`${delays.length} retries exhausted`));
  assert.match(error.message, /503.*temporary failure/);
  assert.equal(isRetryableAssistantError({ stopReason: 'error', errorMessage: error.message }), false);
  t.mock.timers.tick(3600000);
  await flush();
  assert.equal(calls, delays.length + 1);
});

for (const streaming of [false, true]) for (const status of [408, 429, 500, 503]) {
  test(`HTTP ${status} recovers before JSON/SSE tool output (stream=${streaming})`, async () => {
    await withServer(async ({ model, requests }) => {
      const observed = [];
      const result = await ask(model, undefined, { maxRetries: 2, env: { ...fast, GIGACHAT_STREAM: String(streaming) }, onResponse: r => { observed.push(r.status); } });
      assert.equal(result.stopReason, 'toolUse', result.errorMessage);
      assert.deepEqual(observed, [status, status, 200]);
      assert.equal(result.content.filter(c => c.type === 'toolCall').length, 1);
      assert.deepEqual(requests.map(r => r.body), Array(3).fill(requests[0].body));
    }, (req, res, requests) => requests.length < 3
      ? json(res, { message: 'temporary failure' }, status)
      : reply(req, res, completion({ role: 'assistant', content: '', function_call: { name: 'read', arguments: { path: 'fixture.txt' } } }, 'function_call')));
  });
}

test('permanent HTTP failures, quota exhaustion and disabled retries return after one request', async () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
    await withServer(async ({ model, requests }) => {
      const result = await ask(model, undefined, { env: fast });
      assert.equal(result.stopReason, 'error');
      assert.equal(requests.length, 1);
    }, (_req, res) => json(res, { message: status === 429 ? 'insufficient_quota' : 'invalid request' }, status));
  }
  await withServer(async ({ model, requests }) => {
    await ask(model, undefined, { maxRetries: 0, env: { ...fast, GIGACHAT_MAX_RETRIES: '10' } });
    assert.equal(requests.length, 1, 'explicit maxRetries must win over env');
  }, (_req, res) => json(res, { message: 'busy' }, 503));
});

test('network resets recover, but certificate errors and response-hook failures do not retry', async () => {
  let calls = 0;
  const value = await request('https://example.invalid', {}, { env: fast, fetch: async () => {
    if (++calls < 3) throw networkError();
    return Response.json({ ok: true });
  } }, consume);
  assert.equal(calls, 3);
  assert.deepEqual(value, { ok: true });
  calls = 0;
  await assert.rejects(request('https://example.invalid', {}, { env: fast, fetch: async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  } }, consume), /certificate failure/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(request('https://example.invalid', {}, { env: fast, fetch: async () => {
    calls++;
    return Response.json({ ok: true });
  } }, consume, () => { throw networkError(); }), /socket reset/);
  assert.equal(calls, 1);
});

test('each attempt gets a fresh timeout and backoff is outside that timeout', async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask(model, undefined, { maxRetries: 1, timeoutMs: 50, env: { GIGACHAT_RETRY_BASE_DELAY_MS: '80' } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests.length, 2);
  }, (_req, res, requests) => { if (requests.length > 1) json(res, completion()); });
});

test('cancellation interrupts a ten-minute wait without another request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let calls = 0;
  const pending = request('https://example.invalid', {}, {
    signal: controller.signal, env: { GIGACHAT_RETRY_BASE_DELAY_MS: '600000' },
    fetch: async () => { calls++; return Response.json({ message: 'busy' }, { status: 503 }); },
  }, consume).catch(error => error);
  await flush();
  assert.equal(calls, 1);
  const reason = new Error('cancelled by user');
  controller.abort(reason);
  assert.equal(await pending, reason);
  t.mock.timers.tick(3600000);
  await flush();
  assert.equal(calls, 1);
});

for (const headers of [{ 'retry-after': '3' }, { 'retry-after-ms': '3000' }, { 'retry-after': 'Wed, 01 Jan 2031 00:00:03 GMT' }]) {
  test(`server-requested wait is respected: ${JSON.stringify(headers)}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2031-01-01T00:00:00Z') });
    let calls = 0;
    const pending = request('https://example.invalid', {}, { fetch: async () => ++calls === 1
      ? Response.json({ message: 'busy' }, { status: 429, headers })
      : Response.json({ ok: true }) }, consume);
    await flush();
    t.mock.timers.tick(2999); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(await pending, { ok: true });
    assert.equal(calls, 2);
  });
}

test('server waits above ten minutes fail without retrying early', async () => {
  let calls = 0;
  await assert.rejects(request('https://example.invalid', {}, { fetch: async () => {
    calls++;
    return Response.json({ message: 'busy' }, { status: 429, headers: { 'Retry-After': '601' } });
  } }, consume), /out of budget.*longer than 600 seconds/);
  assert.equal(calls, 1);
});

for (const partial of [{ content: 'partial answer' }, { function_call: { name: 'read', arguments: '{' } }]) {
  test(`broken SSE never replays emitted ${partial.content ? 'text' : 'tool'} output`, async () => {
    await withServer(async ({ model }) => {
      let calls = 0;
      const result = await ask(model, undefined, { env: { ...fast, GIGACHAT_STREAM: 'true' }, fetch: async () => {
        calls++;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: partial, finish_reason: null }] }) + '\n\n'));
          setTimeout(() => controller.error(networkError()), 15);
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      } });
      assert.equal(result.stopReason, 'error');
      assert.equal(calls, 1);
      assert.equal(result.content.length, 1);
    });
  });
}

for (const valid of [false, true]) test(`SSE retry clears metadata from an interrupted empty attempt (valid=${valid})`, async () => {
  await withServer(async ({ model }) => {
    let calls = 0;
    const result = await ask(model, undefined, { env: { ...fast, GIGACHAT_STREAM: 'true' }, fetch: async () => {
      const first = ++calls === 1;
      return new Response(new ReadableStream({ start(controller) {
        const chunk = first
          ? { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10000, completion_tokens: 100 } }
          : { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: valid ? 'stop' : null }] };
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        if (first) setTimeout(() => controller.error(networkError()), 15);
        else { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    assert.equal(calls, 2);
    assert.equal(result.stopReason, valid ? 'stop' : 'error', result.errorMessage);
    if (!valid) assert.match(result.errorMessage, /missing finish_reason/);
    assert.equal(result.usage.totalTokens, 0, 'usage from the discarded attempt leaked');
    assert.equal(result.content[0].text, 'OK');
  });
});

test('OAuth and chat retries receive scoped environment settings', async () => {
  await withServer(async ({ model, baseUrl, requests }) => {
    const env = { GIGACHAT_CREDENTIALS: 'synthetic.retry.credentials', GIGACHAT_AUTH_URL: baseUrl + '/oauth', GIGACHAT_MAX_RETRIES: '1', ...fast };
    const models = createModels({ authContext: { env: async name => env[name], fileExists: async () => false } });
    models.setProvider(gigachatProvider);
    const result = await models.completeSimple(model, { messages: [user('Hi')] });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests.filter(r => r.url.endsWith('/oauth')).length, 2);
    assert.equal(requests.filter(r => r.url.endsWith('/chat/completions')).length, 2);
  }, (req, res, requests) => {
    const count = requests.filter(r => r.url === req.url).length;
    if (count === 1) json(res, { message: 'temporary failure' }, 503);
    else json(res, req.url.endsWith('/oauth') ? { access_token: token, expires_at: Date.now() + 1800000 } : completion());
  });
});

test('invalid retry settings fail before HTTP', async () => {
  await withServer(async ({ model, requests }) => {
    for (const env of [
      { GIGACHAT_MAX_RETRIES: '-1' }, { GIGACHAT_MAX_RETRIES: '1.5' }, { GIGACHAT_MAX_RETRIES: 'nope' },
      { GIGACHAT_RETRY_BASE_DELAY_MS: '-1' }, { GIGACHAT_RETRY_BASE_DELAY_MS: '600001' }, { GIGACHAT_RETRY_BASE_DELAY_MS: 'NaN' },
    ]) {
      const result = await ask(model, undefined, { env });
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /maxRetries|GIGACHAT_RETRY_BASE_DELAY_MS/);
    }
    assert.equal(requests.length, 0);
  });
});

for (const recover of [false, true]) test(`native Pi retries within the provider without multiplying its budget (recover=${recover})`, { timeout: 30000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async pi => {
      await pi.prompt('Say OK.');
      const last = pi.events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
      assert(last);
      assert.equal(last.stopReason, recover ? 'stop' : 'error', last.errorMessage);
      assert.equal(requests.length, recover ? 3 : 11);
      assert(!pi.events.some(e => e.type === 'auto_retry_start'), 'Pi restarted an exhausted provider budget');
    }, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }, { env: fast });
  }, (_req, res, requests) => recover && requests.length > 2 ? json(res, completion()) : json(res, { message: 'temporary service failure' }, 503));
});

test('native Pi abort stops a provider backoff immediately', { timeout: 30000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async pi => {
      const pending = pi.prompt('Say OK.');
      await until(() => requests.length === 1, 'first failing request');
      await pi.command('abort');
      await pending;
      const last = pi.events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
      assert.equal(last?.stopReason, 'aborted');
      assert.equal(requests.length, 1);
      assert(!pi.events.some(e => e.type === 'auto_retry_start'));
    }, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }, { env: { GIGACHAT_RETRY_BASE_DELAY_MS: '600000' } });
  }, (_req, res) => json(res, { message: 'temporary failure' }, 503));
});
