import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamSimpleGigaChat } from '../dist/stream.js';
import { ask, completion, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const context = { messages: [user('Hello')] };
const chunk = (delta, finish_reason = null, usage) => ({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
const data = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
function begin(res) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); }
function end(res, value = chunk({}, 'stop')) { res.end(data(value) + data('[DONE]')); }

test('SSE delivers text events before the HTTP response ends and preserves fragmented UTF-8', async () => {
  let continueResponse;
  const proceed = new Promise(resolve => { continueResponse = resolve; });
  await withServer(async ({ model, requests }) => {
    const stream = streamSimpleGigaChat(model, context, { apiKey: token, env: { GIGACHAT_STREAM: 'true' } });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === 'text_delta') {
        assert.equal(event.delta, 'Привет 🙂𐐀');
        continueResponse();
      }
    }
    const result = await stream.result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(result.content[0].text, 'Привет 🙂𐐀');
    assert.deepEqual(events, ['start', 'text_start', 'text_delta', 'text_end', 'done']);
    assert.deepEqual([result.usage.input, result.usage.cacheRead, result.usage.output, result.usage.totalTokens], [1, 37, 4, 42]);
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].headers.accept, 'text/event-stream');
  }, async (_req, res) => {
    begin(res);
    const encoded = Buffer.from(': keepalive\r\n\r\n' + data(chunk({ content: 'Привет 🙂𐐀', role: 'assistant' })));
    for (const byte of encoded) {
      res.write(Buffer.from([byte]));
      await new Promise(resolve => setImmediate(resolve));
    }
    await Promise.race([proceed, new Promise((_, reject) => setTimeout(() => reject(new Error('No incremental pi text event')), 2000).unref())]);
    end(res, chunk({}, 'stop', { prompt_tokens: 1, precached_prompt_tokens: 37, completion_tokens: 4, total_tokens: 5 }));
  });
});

for (const format of ['object', 'fragments']) test(`SSE tool calls preserve ${format} arguments and late function state`, async () => {
  const args = { path: '🙂.txt', content: 'literal \\n and actual\nline', nested: { values: [0, false, null] } };
  await withServer(async ({ model }) => {
    const stream = streamSimpleGigaChat(model, context, { apiKey: token, stream: true });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, 'toolUse', result.errorMessage);
    const call = result.content.find(b => b.type === 'toolCall');
    assert.equal(call.name, 'write');
    assert.deepEqual(call.arguments, args);
    assert.equal(call.thoughtSignature, 'gigachat:functions_state_id:late-state');
    assert(events.indexOf('text_end') < events.indexOf('toolcall_start'));
    assert.equal(events.at(-2), 'toolcall_end');
    assert.equal(events.at(-1), 'done');
  }, (_req, res) => {
    begin(res);
    res.write(data(chunk({ content: 'Запишу.' })));
    res.write(data(chunk({ function_call: { name: 'write' } })));
    for (const part of format === 'object' ? [args] : Array.from(JSON.stringify(args))) res.write(data(chunk({ function_call: { arguments: part } })));
    end(res, chunk({ functions_state_id: 'late-state' }, 'function_call'));
  });
});

for (const [name, events] of [
  ['missing DONE', [chunk({ content: 'partial' }, 'stop')]],
  ['missing finish reason', [chunk({ content: 'partial' }), '[DONE]']],
  ['missing tool', [chunk({}, 'function_call'), '[DONE]']],
  ['invalid JSON arguments', [chunk({ function_call: { name: 'read', arguments: '{' } }, 'function_call'), '[DONE]']],
  ['unknown finish reason', [chunk({}, 'unknown'), '[DONE]']],
]) test(`SSE fails clearly on ${name}`, async () => {
  await withServer(async ({ model }) => {
    const result = await ask(model, context, { env: { GIGACHAT_STREAM: 'true' } });
    assert.equal(result.stopReason, 'error');
    assert(result.errorMessage);
  }, (_req, res) => { begin(res); res.end(events.map(data).join('')); });
});

test('SSE cancellation retains partial content and closes the request', async () => {
  const controller = new AbortController();
  await withServer(async ({ model }) => {
    const stream = streamSimpleGigaChat(model, context, { apiKey: token, stream: true, signal: controller.signal });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === 'text_delta') controller.abort();
    }
    const result = await stream.result();
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.content[0].text, 'partial');
    assert.equal(events.at(-1), 'error');
  }, (_req, res) => { begin(res); res.write(data(chunk({ content: 'partial' }))); });
});

test('additional JSON parameters override defaults without replacing unrelated fields', async () => {
  await withServer(async ({ model, requests }) => {
    const extra = { temperature: 0.3, max_tokens: 2048, repetition_penalty: 1.1, response_format: { type: 'json_schema', schema: { type: 'object' }, strict: true }, custom: { nested: ['🙂', 7] }, stream: true };
    const result = await ask(model, context, { temperature: 0.9, maxTokens: 32, env: { GIGACHAT_EXTRA_BODY: JSON.stringify(extra), GIGACHAT_STREAM: 'false' } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const body = requests[0].body;
    for (const [key, value] of Object.entries(extra)) if (key !== 'stream') assert.deepEqual(body[key], value);
    assert.equal(body.stream, false);
    assert.equal(body.model, model.id);
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: 'Hello' }]);
  });
});

test('per-request extraBody and payload hooks have documented precedence', async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask(model, context, {
      env: { GIGACHAT_EXTRA_BODY: '{"temperature":0.1}' }, extraBody: { temperature: 0.2 },
      onPayload: async body => { assert.equal(body.temperature, 0.2); return { ...body, temperature: 0.4, stream: true }; },
    });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].body.temperature, 0.4);
    assert.equal(requests[0].body.stream, false);
  });
});

for (const value of ['[]', 'null', 'true', '"hello"', '{invalid']) test(`invalid EXTRA_BODY ${value} fails before HTTP`, async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask(model, context, { env: { GIGACHAT_EXTRA_BODY: value } });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /GIGACHAT_EXTRA_BODY.*JSON object/);
    assert.equal(requests.length, 0);
  });
});

test('invalid stream switch fails before HTTP', async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask(model, context, { env: { GIGACHAT_STREAM: 'yes' } });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /GIGACHAT_STREAM/);
    assert.equal(requests.length, 0);
  });
});

test('custom fetch implementations are supported by the native transport', async () => {
  const result = await streamSimpleGigaChat({ id: 'test', api: 'gigachat-extension-api', provider: 'gigachat', input: ['text'], baseUrl: 'https://example.invalid/v1', maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, context, {
    apiKey: token,
    fetch: async (url, init) => {
      assert.equal(url, 'https://example.invalid/v1/chat/completions');
      assert.equal(JSON.parse(init.body).stream, false);
      return new Response(JSON.stringify(completion()), { headers: { 'Content-Type': 'application/json' } });
    },
  }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
});
