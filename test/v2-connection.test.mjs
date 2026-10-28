import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConnectionStore, createConnectionProvider, prepareConnectionCredential } from '../dist/connections.js';
import { json, user, withServer } from './helpers.mjs';

const tool = { name: 'lookup_number', description: 'Look up a number', parameters: {
  type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
} };
const ids = ['1a391204-6c45-4aa1-8c6b-a10e65a526fb', 'e6dc25c2-79f6-4d3f-b9fe-3653f7f6dce3'];
const state = '01a182a9-fc5a-7406-a993-5768b0aaa2a0';
const usage = { input_tokens: 29, input_tokens_details: { prompt_tokens: 29, cached_tokens: 3 }, output_tokens: 31, total_tokens: 60 };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const message = (role, content) => ({ role, content });

async function withNative(baseUrl, run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-v2-'));
  try {
    const authPath = join(directory, 'auth.json');
    const entry = {
      id: 'gigachat-v2-native', revision: 'one', name: 'v2-native', protocol: 'v2',
      baseUrl: baseUrl.replace(/\/v1$/, '/v2'), authorization: { type: 'token' },
      models: [{ id: 'GigaChat-3-Ultra', name: 'Ultra', contextWindow: 200000, maxTokens: 1000, reasoning: true }],
    };
    const store = new ConnectionStore(authPath);
    const signal = new AbortController().signal;
    await store.save(await prepareConnectionCredential(entry, 'synthetic-v2-token', signal), {
      signal, prompt: async () => { throw new Error('Unexpected secret prompt'); }, notify() {},
    });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    runtime.registerNativeProvider(createConnectionProvider(entry, store));
    await run(runtime, runtime.getModel(entry.id, entry.models[0].id));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Public Ultra live traces: calls arrive together in a done-only SSE event;
// ordinary text arrives as unindexed deltas and a metadata-only done event.
for (const streaming of [false, true]) test(`native V2 roundtrips repeated-name calls, IDs and state (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => withNative(baseUrl, async (runtime, model) => {
    const context = { messages: [user('Look up alpha and beta')], tools: [tool] };
    const first = await runtime.completeSimple(model, context, { stream: streaming, maxRetries: 0 });
    assert.equal(first.stopReason, 'toolUse', first.errorMessage);
    const calls = first.content.filter(part => part.type === 'toolCall');
    assert.deepEqual(calls.map(call => [call.id, call.name, call.arguments]), [
      [ids[0], tool.name, { key: 'alpha' }], [ids[1], tool.name, { key: 'beta' }],
    ]);
    assert.equal(first.usage.totalTokens, 60, 'Cached input must not inflate occupied context');
    assert.equal(first.usage.input, 26);
    assert.equal(first.usage.cacheRead, 3);
    const history = [...context.messages, first, ...calls.map((call, i) => ({
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: String(i + 2) }], isError: false, timestamp: 0,
    }))];
    const before = JSON.stringify(history);
    const second = await runtime.completeSimple(model, { messages: history, tools: [tool] }, { stream: streaming, maxRetries: 0 });
    assert.equal(second.stopReason, 'stop', second.errorMessage);
    assert.equal(second.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Сумма: 5');
    assert.equal(JSON.stringify(history), before, 'Wire conversion must not mutate saved Pi history');
    const replay = requests[1].body.messages;
    const assistant = replay.find(part => part.role === 'assistant');
    assert.equal(assistant.tool_state_id, state);
    assert.deepEqual(assistant.content.map(part => part.function_call.id), ids);
    const results = replay.filter(part => part.role === 'tool').flatMap(part => part.content.map(item => item.function_result));
    assert.deepEqual(results.map(result => [result.id, result.name, JSON.parse(result.result).result]), [
      [ids[0], tool.name, '2'], [ids[1], tool.name, '3'],
    ]);
    assert(requests.every(request => request.url === '/v2/chat/completions'));
    assert(requests.every(request => request.headers.authorization === 'Bearer synthetic-v2-token'));
  }), (request, res, requests) => {
    if (requests.length === 1) {
      const result = { messages: [{ role: 'assistant', tool_state_id: state, content: ids.map((id, i) => ({
        function_call: { id, name: tool.name, arguments: { key: i ? 'beta' : 'alpha' } },
      })) }], finish_reason: 'function_call', usage };
      if (!request.body.stream) return json(res, result);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(event('response.message.done', result));
    }
    if (!request.body.stream) return json(res, { messages: [message('assistant', [{ text: 'Сумма: 5' }])], finish_reason: 'stop', usage });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event('response.message.delta', { messages: [message('assistant', [{ text: 'Сумма:' }])] }) +
      event('response.message.delta', { messages: [message('assistant', [{ text: ' 5' }])] }) +
      event('response.message.done', { finish_reason: 'stop', usage }));
  });
});

for (const streaming of [false, true]) test(`native V2 preserves reasoning-only length and off omits reasoning (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => withNative(baseUrl, async (runtime, model) => {
    const first = await runtime.completeSimple(model, { messages: [user('Think')] }, { stream: streaming, reasoning: 'medium', maxRetries: 0 });
    assert.equal(first.stopReason, 'length', first.errorMessage);
    assert.deepEqual(first.content.map(part => [part.type, part.thinking]), [['thinking', 'Separate reasoning.']]);
    const saved = JSON.stringify(first);
    const second = await runtime.completeSimple(model, { messages: [user('Think'), first, user('Continue')] }, {
      stream: streaming, reasoning: 'off', maxRetries: 0,
      onPayload(body) { return { ...body, model_options: { ...body.model_options, reasoning: { effort: 'medium' } } }; },
    });
    assert.equal(second.stopReason, 'length', second.errorMessage);
    assert.deepEqual(requests[0].body.model_options.reasoning, { effort: 'medium' });
    assert(!Object.hasOwn(requests[1].body.model_options, 'reasoning'));
    assert(requests[1].body.messages.some(part => part.role === 'reasoning' && part.content[0].text === 'Separate reasoning.'));
    assert.equal(JSON.stringify(first), saved);
  }), (request, res) => {
    const result = { messages: [message('reasoning', [{ text: 'Separate reasoning.' }])], finish_reason: 'length', usage };
    if (!request.body.stream) return json(res, result);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event('response.message.delta', { messages: [message('reasoning', [{ text: 'Separate ' }])] }) +
      event('response.message.delta', { messages: [message('reasoning', [{ text: 'reasoning.' }])] }) +
      event('response.message.done', { finish_reason: 'length', usage }));
  });
});

test('native V2 rejects an SSE response without its named completion marker', async () => {
  await withServer(async ({ baseUrl }) => withNative(baseUrl, async (runtime, model) => {
    const result = await runtime.completeSimple(model, { messages: [user('Hello')] }, { stream: true, maxRetries: 0 });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /missing response\.message\.done/);
  }), (_request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event('response.message.delta', { messages: [message('assistant', [{ text: 'Partial' }])] }));
  });
});
