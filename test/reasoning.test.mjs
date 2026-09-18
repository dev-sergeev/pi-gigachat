import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GIGACHAT_MODELS } from '../dist/models.js';
import { convertMessages } from '../dist/messages.js';
import { streamSimpleGigaChat } from '../dist/stream.js';
import { completion, reply, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const glm = GIGACHAT_MODELS.find(model => model.id === 'glm-5.2');
const reasoning = 'L checks manifest files etc.';
const state = '01a0b48f-f796-7e85-ad6c-b730d5bc0619';
const fixture = {
  choices: [{ message: {
    content: '', role: 'assistant',
    function_call: { id: 'd5957e6c-52eb-4876-9b17-d6ef71948d69', name: 'bash', arguments: { command: 'cd /home ' } },
    functions_state_id: state, reasoning_content: reasoning,
  }, index: 0, finish_reason: 'function_call' }],
  created: 1789735729, model: 'glm-5.2:latest', object: 'chat.completions',
  usage: { prompt_tokens: 17452, completion_tokens: 168, total_tokens: 17620, precached_prompt_tokens: 0 },
};
const toolResult = call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
  content: [{ type: 'text', text: 'Synthetic result; command was not executed.' }], isError: false, timestamp: 0 });
const assistant = (content, extra = {}) => ({ role: 'assistant', content, api: glm.api,
  provider: glm.provider, model: glm.id, stopReason: 'stop', timestamp: 0, ...extra });
const wireThinking = text => ({ type: 'thinking', thinking: text, thinkingSignature: 'reasoning_content' });
const data = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';

async function collect(model, context = { messages: [user('Test')] }, options = {}) {
  const stream = streamSimpleGigaChat(model, context, { apiKey: token, maxRetries: 0, ...options });
  const events = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

for (const streaming of [false, true]) test(`GLM reasoning survives a tool response, JSON serialization and the next request (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const model = { ...glm, baseUrl };
    const { result, events } = await collect(model, undefined, { stream: streaming });
    assert.equal(result.stopReason, 'toolUse', result.errorMessage);
    assert.equal(result.model, 'glm-5.2', 'the response alias must not break same-model replay');
    assert.deepEqual(result.content.map(block => block.type), ['thinking', 'toolCall']);
    assert.equal(result.content[0].thinking, reasoning);
    assert.deepEqual(events.filter(e => e.type.startsWith('thinking')).map(e => e.type), ['thinking_start', 'thinking_delta', 'thinking_end']);
    assert(events.findIndex(e => e.type === 'thinking_end') < events.findIndex(e => e.type === 'toolcall_start'));
    const restored = JSON.parse(JSON.stringify(result));
    const call = restored.content.find(block => block.type === 'toolCall');
    assert.deepEqual(call.arguments, fixture.choices[0].message.function_call.arguments);
    const next = await collect(model, { messages: [user('Test'), restored, toolResult(call)] }, { stream: streaming });
    assert.equal(next.result.stopReason, 'stop', next.result.errorMessage);
    const messages = requests[1].body.messages;
    const replay = messages.find(message => message.role === 'assistant');
    assert.deepEqual(replay, { role: 'assistant', content: '', reasoning_content: reasoning,
      function_call: { name: 'bash', arguments: { command: 'cd /home ' } }, functions_state_id: state });
    assert.equal(messages[messages.indexOf(replay) + 1].role, 'function');
  }, (req, res, requests) => reply(req, res, requests.length === 1 ? fixture : completion()));
});

for (const text of [' \nПроверка 🙂𐐀\t ', ' \n\t ']) test(`replay preserves reasoning verbatim, including whitespace: ${JSON.stringify(text)}`, () => {
  const history = [assistant([wireThinking(text), { type: 'text', text: 'Answer' }])];
  const before = JSON.stringify(history);
  const [message] = convertMessages(glm, { messages: history });
  assert.equal(message.reasoning_content, text);
  assert.equal(message.content, 'Answer');
  assert.equal(JSON.stringify(history), before);
});

test('native thinking blocks are replayed in order without requiring a provider signature', () => {
  const [message] = convertMessages(glm, { messages: [assistant([
    { type: 'thinking', thinking: 'First\n' }, { type: 'thinking', thinking: ' Second' }, { type: 'text', text: 'Answer' },
  ])] });
  assert.equal(message.reasoning_content, 'First\n Second');
});

test('model switching retains Pi normalization and never sends foreign reasoning as reasoning_content', () => {
  for (const foreign of [{ model: 'other' }, { provider: 'foreign' }, { api: 'foreign-api' }]) {
    const [message] = convertMessages(glm, { messages: [assistant([
      wireThinking('Prior thought. '), { type: 'text', text: 'Answer', textSignature: 'gigachat:functions_state_id:old-state' },
    ], foreign)] });
    assert.equal(message.reasoning_content, undefined);
    assert.equal(message.functions_state_id, undefined);
    assert.equal(message.content, 'Prior thought. Answer');
  }
});

test('redacted and failed reasoning is not replayed as plaintext reasoning_content', () => {
  const [message] = convertMessages(glm, { messages: [assistant([
    { ...wireThinking('encrypted placeholder'), redacted: true }, { type: 'text', text: 'Answer' },
  ])] });
  assert.equal(message.reasoning_content, undefined);
  for (const stopReason of ['error', 'aborted']) assert.deepEqual(convertMessages(glm, {
    messages: [assistant([wireThinking('incomplete')], { stopReason })],
  }), []);
});

for (const streaming of [false, true]) {
  test(`reasoning-only length responses remain visible and replayable with function state (stream=${streaming})`, async () => {
    await withServer(async ({ model }) => {
      const { result, events } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'length', result.errorMessage);
      assert.equal(result.content[0].thinking, 'Still thinking.');
      assert.equal(events.filter(e => e.type === 'thinking_end').length, 1);
      const [message] = convertMessages(model, { messages: [JSON.parse(JSON.stringify(result))] });
      assert.equal(message.reasoning_content, 'Still thinking.');
      assert.equal(message.functions_state_id, state);
      assert.equal(message.content, '');
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: '', reasoning_content: 'Still thinking.', functions_state_id: state }, 'length')));
  });

  test(`absent, null and empty reasoning keep ordinary answers unchanged (stream=${streaming})`, async () => {
    for (const value of [undefined, null, '']) await withServer(async ({ model }) => {
      const { result, events } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.deepEqual(result.content, [{ type: 'text', text: 'Answer' }]);
      assert(!events.some(e => e.type.startsWith('thinking')));
      const [message] = convertMessages(model, { messages: [result] });
      assert.equal(message.reasoning_content, undefined);
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'Answer', reasoning_content: value })));
  });

  test(`invalid reasoning types fail explicitly (stream=${streaming})`, async () => {
    for (const value of [42, {}, []]) await withServer(async ({ model }) => {
      const { result } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /reasoning_content/);
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'Answer', reasoning_content: value })));
  });
}

test('SSE thinking is incremental, survives fragmented UTF-8 and preserves alternating blocks', async () => {
  let continueResponse;
  const proceed = new Promise(resolve => { continueResponse = resolve; });
  await withServer(async ({ model }) => {
    const stream = streamSimpleGigaChat(model, { messages: [user('Test')] }, { apiKey: token, stream: true, maxRetries: 0 });
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'thinking_delta') continueResponse();
    }
    const result = await stream.result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(result.content.map(block => block.type), ['thinking', 'text', 'thinking', 'text']);
    const [message] = convertMessages(model, { messages: [result] });
    assert.equal(message.reasoning_content, ' \nПроверка 🙂𐐀\t Second\n');
    assert.equal(message.content, 'AB');
    assert.deepEqual(events.filter(e => !e.type.endsWith('_delta')).map(e => e.type), [
      'start', 'thinking_start', 'thinking_end', 'text_start', 'text_end',
      'thinking_start', 'thinking_end', 'text_start', 'text_end', 'done',
    ]);
  }, async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const byte of Buffer.from(data({ reasoning_content: ' \nПроверка 🙂𐐀' }))) {
      res.write(Buffer.from([byte]));
      await new Promise(resolve => setImmediate(resolve));
    }
    await Promise.race([proceed, new Promise((_, reject) => setTimeout(() => reject(new Error('No incremental thinking event')), 2000).unref())]);
    res.end(data({ reasoning_content: '\t ' }) + data({ content: 'A' }) + data({ reasoning_content: 'Second\n' }) + data({ content: 'B' }, 'stop') + 'data: [DONE]\n\n');
  });
});

test('cancellation keeps partial thinking for display but excludes the aborted turn from replay', async () => {
  const controller = new AbortController();
  await withServer(async ({ model, requests }) => {
    const stream = streamSimpleGigaChat(model, { messages: [user('Test')] }, { apiKey: token, stream: true, signal: controller.signal });
    for await (const event of stream) if (event.type === 'thinking_delta') controller.abort();
    const result = await stream.result();
    assert.equal(result.stopReason, 'aborted', result.errorMessage);
    assert.equal(result.content[0].thinking, 'Partial thought');
    assert.equal(requests.length, 1);
    assert.deepEqual(convertMessages(model, { messages: [result] }), []);
  }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(data({ reasoning_content: 'Partial thought' }));
  });
});
