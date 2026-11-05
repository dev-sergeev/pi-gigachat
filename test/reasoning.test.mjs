import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { convertMessages } from '../dist/messages.js';
import { streamSimpleGigaChat } from '../dist/stream.js';
import { completion, reply, testModel, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const selected = testModel({ id: 'test-reasoning-model' });
const reasoning = 'L checks manifest files etc.';
const state = '01a0b48f-f796-7e85-ad6c-b730d5bc0619';
const fixture = {
  choices: [{ message: {
    content: '', role: 'assistant',
    function_call: { id: 'd5957e6c-52eb-4876-9b17-d6ef71948d69', name: 'bash', arguments: { command: 'cd /home ' } },
    functions_state_id: state, reasoning_content: reasoning,
  }, index: 0, finish_reason: 'function_call' }],
  created: 1789735729, model: `${selected.id}:latest`, object: 'chat.completions',
  usage: { prompt_tokens: 17452, completion_tokens: 168, total_tokens: 17620, precached_prompt_tokens: 0 },
};
const toolResult = call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
  content: [{ type: 'text', text: 'Synthetic result; command was not executed.' }], isError: false, timestamp: 0 });
const assistant = (content, extra = {}) => ({ role: 'assistant', content, api: selected.api,
  provider: selected.provider, model: selected.id, stopReason: 'stop', timestamp: 0, ...extra });
const wireThinking = (text, field = 'reasoning_content') => ({ type: 'thinking', thinking: text, thinkingSignature: field });
const data = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';

async function collect(model, context = { messages: [user('Test')] }, options = {}) {
  const stream = streamSimpleGigaChat(model, normalizeContext(context), { apiKey: token, maxRetries: 0, ...options });
  const events = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

for (const field of ['reasoning_content', 'reasoning'])
for (const streaming of [false, true]) test(`${field} survives a tool response, JSON serialization and the next request (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const model = { ...selected, baseUrl };
    const { result, events } = await collect(model, undefined, { stream: streaming });
    assert.equal(result.stopReason, 'toolUse', result.errorMessage);
    assert.equal(result.model, selected.id, 'the response alias must not break same-model replay');
    assert.deepEqual(result.content.map(block => block.type), ['thinking', 'toolCall']);
    assert.deepEqual(result.content[0], wireThinking(reasoning, field));
    assert.deepEqual(events.filter(e => e.type.startsWith('thinking')).map(e => e.type), ['thinking_start', 'thinking_delta', 'thinking_end']);
    assert(events.findIndex(e => e.type === 'thinking_end') < events.findIndex(e => e.type === 'toolcall_start'));
    const restored = JSON.parse(JSON.stringify(result));
    const call = restored.content.find(block => block.type === 'toolCall');
    assert.deepEqual(call.arguments, fixture.choices[0].message.function_call.arguments);
    const next = await collect(model, { messages: [user('Test'), restored, toolResult(call)] }, { stream: streaming });
    assert.equal(next.result.stopReason, 'stop', next.result.errorMessage);
    const messages = requests[1].body.messages;
    const replay = messages.find(message => message.role === 'assistant');
    assert.deepEqual(replay, { role: 'assistant', content: '', [field]: reasoning,
      function_call: { name: 'bash', arguments: { command: 'cd /home ' } } });
    assert.equal(messages[messages.indexOf(replay) + 1].role, 'function');
  }, (req, res, requests) => {
    const response = structuredClone(fixture);
    delete response.choices[0].message.reasoning_content;
    response.choices[0].message[field] = reasoning;
    reply(req, res, requests.length === 1 ? response : completion());
  });
});

for (const inContent of [false, true])
for (const field of ['reasoning_content', 'reasoning'])
for (const text of [' \nПроверка 🙂𐐀\t ', ' \n\t '])
test(`replay preserves ${field} verbatim (inContent=${inContent}): ${JSON.stringify(text)}`, () => {
  for (const answer of ['', 'Answer']) {
    const history = [assistant([wireThinking(text, field), { type: 'text', text: answer }])];
    const before = structuredClone(history);
    const [message] = convertMessages(selected, normalizeContext({ messages: history }), undefined, inContent);
    assert.deepEqual(message, inContent
      ? { role: 'assistant', content: text + (answer ? '\n\nAnswer' : '') }
      : { role: 'assistant', content: answer, [field]: text });
    assert.deepEqual(history, before);
  }
});

test('unsigned and unknown-signature thinking has no native fallback but remains available for content replay', () => {
  const history = [assistant([
    { type: 'thinking', thinking: 'Unsigned\n' },
    { type: 'thinking', thinking: ' Unknown', thinkingSignature: 'foreign-signature' },
    wireThinking(' Native'), wireThinking(' Other', 'reasoning'),
    { type: 'text', text: 'Answer' },
  ])];
  const before = structuredClone(history);
  const context = normalizeContext({ messages: history });
  assert.deepEqual(convertMessages(selected, context), [
    { role: 'assistant', content: 'Answer', reasoning_content: ' Native', reasoning: ' Other' },
  ]);
  assert.deepEqual(convertMessages(selected, context, undefined, true), [
    { role: 'assistant', content: 'Unsigned\n Unknown Native Other\n\nAnswer' },
  ]);
  assert.deepEqual(history, before);
});

for (const inContent of [false, true])
for (const streaming of [false, true]) test(`model switching drops foreign reasoning without changing the answer (stream=${streaming}, inContent=${inContent})`, async () => {
  for (const foreign of [{ model: 'other' }, { provider: 'foreign' }, { api: 'foreign-api' }]) {
    await withServer(async ({ baseUrl, requests }) => {
      const model = { ...selected, baseUrl };
      const context = { messages: [assistant([
        wireThinking('Prior thought. '), { type: 'text', text: 'Answer', textSignature: 'gigachat:functions_state_id:old-state' },
      ], foreign), user('Continue')] };
      const original = structuredClone(context);
      const { result } = await collect(model, context, {
        stream: streaming, env: { GIGACHAT_REASONING_IN_CONTENT: String(inContent) },
      });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.deepEqual(requests[0].body.messages.find(message => message.role === 'assistant'),
        { role: 'assistant', content: 'Answer' });
      assert.deepEqual(context, original);
    }, (req, res) => reply(req, res, completion()));
  }
});

for (const inContent of [false, true])
test(`redacted and failed reasoning is not replayed (inContent=${inContent})`, () => {
  const [message] = convertMessages(selected, normalizeContext({ messages: [assistant([
    { ...wireThinking('encrypted placeholder'), redacted: true }, { type: 'text', text: 'Answer' },
  ])] }), undefined, inContent);
  assert.deepEqual(message, { role: 'assistant', content: 'Answer' });
  for (const stopReason of ['error', 'aborted']) assert.deepEqual(convertMessages(selected, normalizeContext({
    messages: [assistant([wireThinking('incomplete')], { stopReason })],
  }), undefined, inContent), []);
});

for (const streaming of [false, true]) {
  test(`reasoning-only length responses remain visible and replay without function state (stream=${streaming})`, async () => {
    await withServer(async ({ model, requests }) => {
      const { result, events } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'length', result.errorMessage);
      assert.equal(result.content[0].thinking, 'Still thinking.');
      assert.equal(events.filter(e => e.type === 'thinking_end').length, 1);
      const next = await collect(model, { messages: [JSON.parse(JSON.stringify(result)), user('Continue')] }, { stream: streaming });
      assert.equal(next.result.stopReason, 'length', next.result.errorMessage);
      assert.deepEqual(requests[1].body.messages.find(m => m.role === 'assistant'),
        { role: 'assistant', content: '', reasoning_content: 'Still thinking.' });
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: '', reasoning_content: 'Still thinking.', functions_state_id: state }, 'length')));
  });

  for (const field of ['reasoning_content', 'reasoning']) {
  test(`absent, null and empty ${field} keep ordinary answers unchanged (stream=${streaming})`, async () => {
    for (const value of [undefined, null, '']) await withServer(async ({ model }) => {
      const { result, events } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.deepEqual(result.content, [{ type: 'text', text: 'Answer' }]);
      assert(!events.some(e => e.type.startsWith('thinking')));
      const [message] = convertMessages(model, normalizeContext({ messages: [result] }));
      assert.deepEqual(message, { role: 'assistant', content: 'Answer' });
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'Answer', [field]: value })));
  });

  test(`invalid ${field} types fail explicitly (stream=${streaming})`, async () => {
    for (const value of [42, {}, []]) await withServer(async ({ model }) => {
      const { result } = await collect(model, undefined, { stream: streaming });
      assert.equal(result.stopReason, 'error');
      assert(result.errorMessage.includes(field), result.errorMessage);
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'Answer', [field]: value })));
  });
  }
}

test('SSE thinking is incremental, survives fragmented UTF-8 and preserves alternating blocks', async () => {
  let continueResponse;
  const proceed = new Promise(resolve => { continueResponse = resolve; });
  await withServer(async ({ model }) => {
    const stream = streamSimpleGigaChat(model, normalizeContext({ messages: [user('Test')] }), { apiKey: token, stream: true, maxRetries: 0 });
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'thinking_delta') continueResponse();
    }
    const result = await stream.result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(result.content, [
      wireThinking(' \nПроверка 🙂𐐀\t '), { type: 'text', text: 'A' },
      wireThinking('Second\n', 'reasoning'), wireThinking('Third'),
      { type: 'text', text: 'B' },
    ]);
    const [message] = convertMessages(model, normalizeContext({ messages: [result] }));
    assert.deepEqual(message, {
      role: 'assistant', content: 'AB', reasoning_content: ' \nПроверка 🙂𐐀\t Third', reasoning: 'Second\n',
    });
    assert.deepEqual(events.filter(e => !e.type.endsWith('_delta')).map(e => e.type), [
      'start', 'thinking_start', 'thinking_end', 'text_start', 'text_end',
      'thinking_start', 'thinking_end', 'thinking_start', 'thinking_end', 'text_start', 'text_end', 'done',
    ]);
  }, async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const byte of Buffer.from(data({ reasoning_content: ' \nПроверка 🙂𐐀' }))) {
      res.write(Buffer.from([byte]));
      await new Promise(resolve => setImmediate(resolve));
    }
    await Promise.race([proceed, new Promise((_, reject) => setTimeout(() => reject(new Error('No incremental thinking event')), 2000).unref())]);
    res.end(data({ reasoning_content: '\t ' }) + data({ content: 'A' }) + data({ reasoning: 'Second\n' }) +
      data({ reasoning_content: 'Third' }) + data({ content: 'B' }, 'stop') + 'data: [DONE]\n\n');
  });
});

for (const streaming of [false, true])
test(`both reasoning fields retain provenance when received together (stream=${streaming})`, async () => {
  await withServer(async ({ model }) => {
    const { result, events } = await collect(model, undefined, { stream: streaming });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(result.content, [
      wireThinking('First '), wireThinking('Second ', 'reasoning'), { type: 'text', text: 'Answer' },
    ]);
    assert.deepEqual(events.filter(e => e.type.startsWith('thinking')).map(e => [e.type, e.contentIndex, e.delta ?? e.content]), [
      ['thinking_start', 0, undefined], ['thinking_delta', 0, 'First '], ['thinking_end', 0, 'First '],
      ['thinking_start', 1, undefined], ['thinking_delta', 1, 'Second '], ['thinking_end', 1, 'Second '],
    ]);
    assert.deepEqual(convertMessages(model, normalizeContext({ messages: [result] })), [{
      role: 'assistant', content: 'Answer', reasoning_content: 'First ', reasoning: 'Second ',
    }]);
  }, (req, res) => reply(req, res, completion({
    role: 'assistant', reasoning_content: 'First ', reasoning: 'Second ', content: 'Answer',
  })));
});

test('cancellation keeps partial thinking for display but excludes the aborted turn from replay', async () => {
  const controller = new AbortController();
  await withServer(async ({ model, requests }) => {
    const stream = streamSimpleGigaChat(model, normalizeContext({ messages: [user('Test')] }), { apiKey: token, stream: true, signal: controller.signal });
    for await (const event of stream) if (event.type === 'thinking_delta') controller.abort();
    const result = await stream.result();
    assert.equal(result.stopReason, 'aborted', result.errorMessage);
    assert.equal(result.content[0].thinking, 'Partial thought');
    assert.equal(requests.length, 1);
    assert.deepEqual(convertMessages(model, normalizeContext({ messages: [result] })), []);
  }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(data({ reasoning_content: 'Partial thought' }));
  });
});
