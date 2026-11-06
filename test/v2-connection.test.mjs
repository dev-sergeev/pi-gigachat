import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConnectionStore, createConnectionProvider, prepareConnectionCredential } from '../dist/connections.js';
import { convertV2Messages, V2_STATE_SIGNATURE_PREFIX } from '../dist/v2-messages.js';
import { streamSimpleGigaChatV2 } from '../dist/v2-stream.js';
import { json, testModel, user, withServer } from './helpers.mjs';

const tool = { name: 'lookup_number', description: 'Look up a number', parameters: {
  type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
} };
const ids = ['1a391204-6c45-4aa1-8c6b-a10e65a526fb', 'e6dc25c2-79f6-4d3f-b9fe-3653f7f6dce3'];
const state = '01a182a9-fc5a-7406-a993-5768b0aaa2a0';
const usage = { input_tokens: 29, input_tokens_details: { prompt_tokens: 29, cached_tokens: 3 }, output_tokens: 31, total_tokens: 60 };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const message = (role, content) => ({ role, content });
const reasoningModes = [undefined, 'false', 'true'];
const toolThought = ' \n  Plan both lookups.\t ';
const assistantMessage = (model, content, extra = {}) => ({
  role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
  stopReason: 'stop', timestamp: 0, ...extra,
});
const wireText = message => message.content.map(part => part.text ?? '').join('');

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
for (const streaming of [false, true]) for (const inContent of reasoningModes)
test(`native V2 roundtrips reasoning, repeated-name calls, IDs and state (stream=${streaming}, inContent=${inContent ?? 'default'})`, async () => {
  await withServer(async ({ baseUrl, requests }) => withNative(baseUrl, async (runtime, model) => {
    const context = { messages: [user('Look up alpha and beta')], tools: [tool] };
    const options = { stream: streaming, maxRetries: 0, env: { GIGACHAT_REASONING_IN_CONTENT: inContent } };
    const first = await runtime.completeSimple(model, context, options);
    assert.equal(first.stopReason, 'toolUse', first.errorMessage);
    assert.equal(first.content.find(part => part.type === 'thinking').thinking, toolThought);
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
    const second = await runtime.completeSimple(model, { messages: history, tools: [tool] }, options);
    assert.equal(second.stopReason, 'stop', second.errorMessage);
    assert.equal(second.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Сумма: 5');
    assert.equal(JSON.stringify(history), before, 'Wire conversion must not mutate saved Pi history');
    const replay = requests[1].body.messages;
    const assistant = replay.find(part => part.role === 'assistant');
    assert.equal(assistant.tool_state_id, state);
    assert.equal(wireText(assistant), inContent === 'true' ? toolThought : '');
    assert.deepEqual(replay.filter(part => part.role === 'reasoning').map(wireText),
      inContent === 'true' ? [] : [toolThought]);
    assert.deepEqual(assistant.content.filter(part => part.function_call).map(part => part.function_call.id), ids);
    const results = replay.filter(part => part.role === 'tool').flatMap(part => part.content.map(item => item.function_result));
    assert.deepEqual(results.map(result => [result.id, result.name, JSON.parse(result.result).result]), [
      [ids[0], tool.name, '2'], [ids[1], tool.name, '3'],
    ]);
    assert(requests.every(request => request.url === '/v2/chat/completions'));
    assert(requests.every(request => request.headers.authorization === 'Bearer synthetic-v2-token'));
  }), (request, res, requests) => {
    if (requests.length === 1) {
      const result = { messages: [message('reasoning', [{ text: toolThought }]),
        { role: 'assistant', tool_state_id: state, content: ids.map((id, i) => ({
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

for (const streaming of [false, true]) for (const inContent of reasoningModes)
test(`native V2 preserves reasoning-only length and off omits reasoning (stream=${streaming}, inContent=${inContent ?? 'default'})`, async () => {
  await withServer(async ({ baseUrl, requests }) => withNative(baseUrl, async (runtime, model) => {
    const env = { GIGACHAT_REASONING_IN_CONTENT: inContent };
    const first = await runtime.completeSimple(model, { messages: [user('Think')] }, { stream: streaming, reasoning: 'medium', maxRetries: 0, env });
    assert.equal(first.stopReason, 'length', first.errorMessage);
    assert.deepEqual(first.content.map(part => [part.type, part.thinking]), [['thinking', 'Separate reasoning.']]);
    const saved = JSON.stringify(first);
    const second = await runtime.completeSimple(model, { messages: [user('Think'), first, user('Continue')] }, {
      stream: streaming, reasoning: 'off', maxRetries: 0, env,
      onPayload(body) { return { ...body, model_options: { ...body.model_options, reasoning: { effort: 'medium' } } }; },
    });
    assert.equal(second.stopReason, 'length', second.errorMessage);
    assert.deepEqual(requests[0].body.model_options.reasoning, { effort: 'medium' });
    assert(!Object.hasOwn(requests[1].body.model_options, 'reasoning'));
    const replay = requests[1].body.messages;
    assert(replay.some(part => part.role === (inContent === 'true' ? 'assistant' : 'reasoning') && wireText(part) === 'Separate reasoning.'));
    if (inContent === 'true') assert(!replay.some(part => part.role === 'reasoning'));
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

test('native V2 completes text with a state-only assistant done and replays the saved state', async () => {
  await withServer(async ({ baseUrl, requests }) => withNative(baseUrl, async (runtime, model) => {
    const context = { messages: [user('Add 17 and 25')] };
    const stream = runtime.streamSimple(model, context, { stream: true, maxRetries: 0 });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(result.content, [{ type: 'text', text: '42', textSignature: V2_STATE_SIGNATURE_PREFIX + state }]);
    assert.deepEqual(events, ['start', 'text_start', 'text_delta', 'text_end', 'done']);
    const history = JSON.parse(JSON.stringify([...context.messages, result, user('Continue')]));
    const saved = structuredClone(history);
    const followup = await runtime.completeSimple(model, { messages: history }, { stream: false, maxRetries: 0 });
    assert.equal(followup.stopReason, 'stop', followup.errorMessage);
    assert.deepEqual(requests[1].body.messages.find(message => message.role === 'assistant'),
      { role: 'assistant', content: [{ text: '42' }], tool_state_id: state });
    assert.deepEqual(history, saved, 'Replay must not mutate saved text or state');
  }), (request, res) => {
    if (!request.body.stream) return json(res, { messages: [message('assistant', [{ text: 'Continued' }])], finish_reason: 'stop', usage });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event('response.message.delta', { messages: [message('assistant', [{ text: '42' }])] }) +
      event('response.message.done', { messages: [{ role: 'assistant', tool_state_id: state }], finish_reason: 'stop', usage }));
  });
});

for (const [name, malformed] of [
  ['ordinary missing content', { role: 'assistant' }],
  ['empty state', { role: 'assistant', tool_state_id: '' }],
  ['non-string state', { role: 'assistant', tool_state_id: 42 }],
  ['null content', { role: 'assistant', tool_state_id: state, content: null }],
  ['non-array content', { role: 'assistant', tool_state_id: state, content: {} }],
  ['reasoning missing content', { role: 'reasoning', tool_state_id: state }],
])
test(`native V2 rejects ${name} in an SSE completion`, async () => {
  await withServer(async ({ baseUrl }) => withNative(baseUrl, async (runtime, model) => {
    const result = await runtime.completeSimple(model, { messages: [user('Hello')] }, { stream: true, maxRetries: 0 });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Invalid GigaChat V2 message/);
  }), (_request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event('response.message.done', { messages: [malformed], finish_reason: 'stop', usage }));
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

for (const inContent of reasoningModes)
test(`V2 converter preserves reasoning whitespace, matching turns and state-only messages (inContent=${inContent ?? 'default'})`, () => {
  const model = testModel();
  const thought = ' \nFirst thought.  Second thought.\t ';
  const answer = '  Answer\n tail ';
  const history = [
    user('Begin'),
    assistantMessage(model, [
      { type: 'thinking', thinking: ' \nFirst thought.  ' },
      { type: 'thinking', thinking: 'Second thought.\t ' },
      { type: 'text', text: '' }, { type: 'text', text: '  Answer\n' }, { type: 'text', text: ' tail ' },
    ]),
    user('Continue'),
    assistantMessage(model, [{ type: 'thinking', thinking: 'Only reasoning.\n  ' }]),
    assistantMessage(model, [{ type: 'text', text: 'A different assistant turn.' }]),
    user('Keep the state'),
    assistantMessage(model, [{ type: 'text', text: '', textSignature: V2_STATE_SIGNATURE_PREFIX + state }]),
    user('Reason with state'),
    assistantMessage(model, [
      { type: 'thinking', thinking: 'State thought.  ' },
      { type: 'text', text: '', textSignature: V2_STATE_SIGNATURE_PREFIX + state },
    ]),
  ];
  const before = structuredClone(history);
  const replay = convertV2Messages(model, { messages: history }, undefined,
    inContent === undefined ? undefined : inContent === 'true');
  const assistants = replay.filter(part => part.role === 'assistant');
  assert.deepEqual(assistants.map(wireText), inContent === 'true'
    ? [`${thought}\n\n${answer}`, 'Only reasoning.\n  ', 'A different assistant turn.', '', 'State thought.  ']
    : [answer, 'A different assistant turn.', '', '']);
  assert.deepEqual(replay.filter(part => part.role === 'reasoning').map(wireText),
    inContent === 'true' ? [] : [thought, 'Only reasoning.\n  ', 'State thought.  ']);
  assert.deepEqual(assistants.slice(-2).map(part => part.tool_state_id), [state, state]);
  assert.deepEqual(history, before, 'Conversion must not rewrite saved reasoning, answers or signatures');
});

for (const inContent of reasoningModes)
test(`V2 replay keeps same-model reasoning private across redaction and model handoff (inContent=${inContent ?? 'default'})`, () => {
  const model = testModel();
  const origins = [{}, { provider: 'other-provider' }, { api: 'other-api' }, { model: 'other-model' }];
  const history = origins.map((origin, index) => assistantMessage(model, [
    { type: 'thinking', thinking: `PRIVATE_THOUGHT_${index}`, thinkingSignature: 'gigachat:v2:reasoning' },
    { type: 'thinking', thinking: `REDACTED_THOUGHT_${index}`, redacted: true, thinkingSignature: 'opaque' },
    { type: 'text', text: `Visible ${index}`, textSignature: V2_STATE_SIGNATURE_PREFIX + state },
  ], origin));
  const before = structuredClone(history);
  const replay = convertV2Messages(model, { messages: history }, undefined,
    inContent === undefined ? undefined : inContent === 'true');
  const assistants = replay.filter(part => part.role === 'assistant');
  assert.deepEqual(assistants.map(wireText), [
    inContent === 'true' ? 'PRIVATE_THOUGHT_0\n\nVisible 0' : 'Visible 0',
    'Visible 1', 'Visible 2', 'Visible 3',
  ]);
  assert.deepEqual(replay.filter(part => part.role === 'reasoning').map(wireText),
    inContent === 'true' ? [] : ['PRIVATE_THOUGHT_0']);
  assert.equal(assistants[0].tool_state_id, state);
  assert(assistants.slice(1).every(part => !Object.hasOwn(part, 'tool_state_id')));
  const serialized = JSON.stringify(replay);
  assert(!serialized.includes('REDACTED_THOUGHT'));
  assert(!serialized.includes('PRIVATE_THOUGHT_1'));
  assert(!serialized.includes('PRIVATE_THOUGHT_2'));
  assert(!serialized.includes('PRIVATE_THOUGHT_3'));
  assert.deepEqual(history, before);
});

for (const inContent of reasoningModes) for (const source of ['extraBody', 'environment', 'onPayload', 'mutatePayload'])
test(`V2 applies reasoning representation after ${source} without mutating overrides (inContent=${inContent ?? 'default'})`, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const call = { id: ids[0], name: tool.name, arguments: { key: 'alpha', nested: { role: 'reasoning', text: 'Keep nested data' } } };
    const result = { id: ids[0], name: tool.name, result: '{"result":"2"}' };
    const messages = [
      message('reasoning', [{ text: ' \nFirst ' }]),
      message('reasoning', [{ text: 'second.\t ' }]),
      { role: 'assistant', tool_state_id: state, content: [{ text: '' }, { function_call: call }, { text: ' Answer.  ' }] },
      message('tool', [{ function_result: result }]),
      message('reasoning', [{ text: 'Do not cross the user boundary.  ' }]),
      message('user', [{ text: 'New turn' }]),
      message('assistant', [{ text: 'Unrelated answer.' }]),
      message('reasoning', [{ text: 'State thought.  ' }]),
      { role: 'assistant', content: [], tool_state_id: state },
      { role: 'assistant', content: [], tool_state_id: 'state-only' },
      message('reasoning', [{ text: 'Trailing thought.\n  ' }]),
    ];
    const override = Object.freeze({
      messages, stream: true, model_options: Object.freeze({ reasoning: { effort: 'medium' } }),
    });
    const before = structuredClone(override);
    const options = {
      apiKey: 'synthetic-v2-token', maxRetries: 0, stream: false, reasoning: 'off',
      env: { GIGACHAT_REASONING_IN_CONTENT: inContent, GIGACHAT_EXTRA_BODY: '{}' },
    };
    if (source === 'extraBody') options.extraBody = override;
    if (source === 'environment') options.env.GIGACHAT_EXTRA_BODY = JSON.stringify(override);
    if (source === 'onPayload') options.onPayload = () => override;
    if (source === 'mutatePayload') options.onPayload = body => { body.messages = messages; };
    const model = testModel({ baseUrl: baseUrl.replace(/\/v1$/, '/v2') });
    const response = await streamSimpleGigaChatV2(model, { messages: [user('Original context')] }, options).result();
    assert.equal(response.stopReason, 'stop', response.errorMessage);
    const replay = requests[0].body.messages;
    if (inContent !== 'true') assert.deepEqual(replay, messages);
    else {
      assert(!replay.some(part => part.role === 'reasoning'));
      const assistants = replay.filter(part => part.role === 'assistant');
      assert.deepEqual(assistants.map(wireText), [
        ' \nFirst second.\t \n\n Answer.  ', 'Do not cross the user boundary.  ',
        'Unrelated answer.', 'State thought.  ', '', 'Trailing thought.\n  ',
      ]);
      assert.deepEqual(assistants.map(part => part.tool_state_id),
        [state, undefined, undefined, state, 'state-only', undefined]);
      assert.deepEqual(assistants[0].content.find(part => part.function_call).function_call, call);
      assert.deepEqual(replay.find(part => part.role === 'tool').content, [{ function_result: result }]);
      assert.deepEqual(assistants[4].content, [], 'State-only assistant messages must not be dropped');
    }
    assert.equal(requests[0].body.stream, false, 'Overrides must not change response transport');
    assert(!Object.hasOwn(requests[0].body.model_options, 'reasoning'), 'Replay selection must not enable new reasoning');
    assert.deepEqual(override, before, 'Caller-owned override messages and body must remain unchanged');
  }, (_request, res) => json(res, { messages: [message('assistant', [{ text: 'OK' }])], finish_reason: 'stop', usage }));
});

test('V2 rejects an invalid reasoning-in-content value before sending a request', async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await streamSimpleGigaChatV2(testModel({ baseUrl }), { messages: [user('Hello')] }, {
      apiKey: 'synthetic-v2-token', maxRetries: 0, env: { GIGACHAT_REASONING_IN_CONTENT: 'yes' },
    }).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /GIGACHAT_REASONING_IN_CONTENT must be true or false/);
    assert.equal(requests.length, 0);
  });
});
