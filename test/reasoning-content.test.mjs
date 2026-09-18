import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { gigachatProvider } from '../dist/index.js';
import { ask, completion, reply, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const setting = 'GIGACHAT_REASONING_IN_CONTENT';
const thought = ' \nRemember CODE_742 🙂𐐀.\t ';
const answer = 'The original answer.';
const wrapped = `<previous_reasoning>\n${thought}\n</previous_reasoning>`;
const respond = (req, res) => reply(req, res, completion());
const history = (model, content, extra = {}) => ({ role: 'assistant', content,
  api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, ...extra });
const thinking = { type: 'thinking', thinking: thought, thinkingSignature: 'reasoning_content' };

for (const streaming of [false, true]) for (const enabled of [undefined, 'false', 'true']) {
  test(`reasoning content is opt-in and request-only (stream=${streaming}, setting=${enabled ?? 'unset'})`, async () => {
    await withServer(async ({ model, requests }) => {
      const previous = history(model, [thinking, { type: 'text', text: answer, textSignature: 'gigachat:functions_state_id:text-state' }]);
      const context = { messages: [user('First'), previous, user('Continue')] };
      const original = structuredClone(context);
      const env = { GIGACHAT_STREAM: String(streaming), ...(enabled === undefined ? {} : { [setting]: enabled }) };
      for (let i = 0; i < 2; i++) {
        const result = await ask(model, context, { env });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        const replay = requests.at(-1).body.messages.find(m => m.role === 'assistant');
        assert.deepEqual(replay, { role: 'assistant', content: enabled === 'true' ? `${wrapped}\n\n${answer}` : answer,
          ...(enabled === 'true' ? {} : { reasoning_content: thought }), functions_state_id: 'text-state' });
        assert.deepEqual(context, original, 'wire transformation must not modify stored thinking or answer');
      }
      assert.deepEqual(requests[0].body, requests[1].body, 'repeated sends must not accumulate wrappers');
      await ask(model, context, { env: { ...env, [setting]: 'false' } });
      const restored = requests.at(-1).body.messages.find(m => m.role === 'assistant');
      assert.equal(restored.content, answer);
      assert.equal(restored.reasoning_content, thought);
    }, respond);
  });
}

test('content fallback retains tool pairs and function state without repeating reasoning for multiple calls', async () => {
  await withServer(async ({ model, requests }) => {
    const calls = ['read', 'bash'].map((name, index) => ({ type: 'toolCall', id: `call-${index}`, name,
      arguments: { value: index }, thoughtSignature: `gigachat:functions_state_id:state-${index}` }));
    const previous = history(model, [thinking, ...calls], { stopReason: 'toolUse' });
    const results = calls.map(call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Fixture' }], isError: false, timestamp: 0 }));
    const result = await ask(model, { messages: [previous, ...results] }, { env: { [setting]: 'true' } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const messages = requests[0].body.messages.filter(m => m.role !== 'system');
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'function', 'assistant', 'function']);
    assert.equal(messages[0].content, wrapped);
    assert.equal(messages[2].content, '');
    assert(!messages.some(m => Object.hasOwn(m, 'reasoning_content')));
    for (const index of [0, 1]) {
      assert.deepEqual(messages[index * 2].function_call, { name: calls[index].name, arguments: calls[index].arguments });
      assert.equal(messages[index * 2].functions_state_id, `state-${index}`);
      assert.equal(JSON.parse(messages[index * 2 + 1].content).result, 'Fixture');
    }
  });
});

test('fallback preserves ordered thinking fragments, including whitespace-only reasoning', async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [history(model, [
      { ...thinking, thinking: ' \n' }, { type: 'text', text: 'A' },
      { ...thinking, thinking: '\t ' }, { type: 'text', text: 'B' },
    ])];
    await ask(model, { messages }, { env: { [setting]: 'true' } });
    assert.equal(requests[0].body.messages.find(m => m.role === 'assistant').content, '<previous_reasoning>\n \n\t \n</previous_reasoning>\n\nAB');
  });
});

test('fallback leaves ordinary answers unchanged and excludes redacted, aborted and failed reasoning', async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [
      history(model, [{ type: 'text', text: answer }]),
      history(model, [{ ...thinking, thinking: '' }, { type: 'text', text: answer }]),
      history(model, [{ ...thinking, redacted: true }, { type: 'text', text: answer }]),
      ...['aborted', 'error'].map(stopReason => history(model, [thinking], { stopReason })),
    ];
    await ask(model, { messages }, { env: { [setting]: 'true' } });
    assert.deepEqual(requests[0].body.messages.filter(m => m.role === 'assistant'), Array.from({ length: 3 }, () => ({ role: 'assistant', content: answer })));
  });
});

test('request-scoped false overrides an enabled process environment', async () => {
  process.env[setting] = 'true';
  try {
    await withServer(async ({ model, requests }) => {
      const context = { messages: [history(model, [thinking, { type: 'text', text: answer }])] };
      await ask(model, context);
      await ask(model, context, { env: { [setting]: 'false' } });
      assert.equal(requests[0].body.messages.find(m => m.role === 'assistant').content, `${wrapped}\n\n${answer}`);
      assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').content, answer);
      assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').reasoning_content, thought);
    });
  } finally { delete process.env[setting]; }
});

test('native auth context forwards the content fallback setting', async () => {
  await withServer(async ({ model, requests }) => {
    const env = { GIGACHAT_ACCESS_TOKEN: token, [setting]: 'true' };
    const models = createModels({ authContext: { env: async name => env[name], fileExists: async () => false } });
    models.setProvider(gigachatProvider);
    const result = await models.completeSimple(model, { messages: [history(model, [thinking])] });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].body.messages.find(m => m.role === 'assistant').content, wrapped);
  });
});

test('invalid content fallback settings fail before sending a request', async () => {
  await withServer(async ({ model, requests }) => {
    for (const value of ['', '1', 'TRUE', 'yes']) {
      const result = await ask(model, undefined, { env: { [setting]: value } });
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /GIGACHAT_REASONING_IN_CONTENT must be true or false/);
    }
    assert.equal(requests.length, 0);
  });
});
