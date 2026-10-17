import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, completion, reply, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const thought = ' \nRemember CODE_742 🙂𐐀.\t ';
const answer = 'The original answer.';
const respond = (req, res) => reply(req, res, completion());
const history = (model, content, extra = {}) => ({ role: 'assistant', content,
  api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, ...extra });
const thinking = { type: 'thinking', thinking: thought, thinkingSignature: 'reasoning_content' };

for (const streaming of [false, true]) {
  test(`saved reasoning is replayed as plain content without modifying history (stream=${streaming})`, async () => {
    await withServer(async ({ model, requests }) => {
      const previous = history(model, [thinking, { type: 'text', text: answer, textSignature: 'gigachat:functions_state_id:text-state' }]);
      const context = { messages: [user('First'), previous, user('Continue')] };
      const original = structuredClone(context);
      for (let i = 0; i < 2; i++) {
        const result = await ask(model, context, { env: { GIGACHAT_STREAM: String(streaming) } });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        const replay = requests.at(-1).body.messages.find(m => m.role === 'assistant');
        assert.deepEqual(replay, { role: 'assistant', content: `${thought}\n\n${answer}` });
        assert.deepEqual(context, original, 'wire transformation must not modify stored thinking or answer');
      }
      assert.deepEqual(requests[0].body, requests[1].body, 'repeated sends must not accumulate reasoning');
    }, respond);
  });
}

test('reasoning replay retains tool pairs without function state or repeated reasoning for multiple calls', async () => {
  await withServer(async ({ model, requests }) => {
    const calls = ['read', 'bash'].map((name, index) => ({ type: 'toolCall', id: `call-${index}`, name,
      arguments: { value: index }, thoughtSignature: `gigachat:functions_state_id:state-${index}` }));
    const previous = history(model, [thinking, ...calls], { stopReason: 'toolUse' });
    const results = calls.map(call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Fixture' }], isError: false, timestamp: 0 }));
    const result = await ask(model, { messages: [previous, ...results] });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const messages = requests[0].body.messages.filter(m => m.role !== 'system');
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'function', 'assistant', 'function']);
    assert.equal(messages[0].content, thought);
    assert.equal(messages[2].content, '');
    assert(!messages.some(m => Object.hasOwn(m, 'reasoning_content')));
    for (const index of [0, 1]) {
      assert.deepEqual(messages[index * 2].function_call, { name: calls[index].name, arguments: calls[index].arguments });
      assert(!Object.hasOwn(messages[index * 2], 'functions_state_id'));
      assert.equal(JSON.parse(messages[index * 2 + 1].content).result, 'Fixture');
    }
  });
});

test('reasoning replay preserves ordered thinking fragments, including whitespace-only reasoning', async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [history(model, [
      { ...thinking, thinking: ' \n' }, { type: 'text', text: 'A' },
      { ...thinking, thinking: '\t ' }, { type: 'text', text: 'B' },
    ])];
    await ask(model, { messages });
    assert.equal(requests[0].body.messages.find(m => m.role === 'assistant').content, ' \n\t \n\nAB');
  });
});

test('reasoning replay leaves ordinary answers unchanged and excludes redacted, aborted and failed reasoning', async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [
      history(model, [{ type: 'text', text: answer }]),
      history(model, [{ ...thinking, thinking: '' }, { type: 'text', text: answer }]),
      history(model, [{ ...thinking, redacted: true }, { type: 'text', text: answer }]),
      ...['aborted', 'error'].map(stopReason => history(model, [thinking], { stopReason })),
    ];
    await ask(model, { messages });
    assert.deepEqual(requests[0].body.messages.filter(m => m.role === 'assistant'), Array.from({ length: 3 }, () => ({ role: 'assistant', content: answer })));
  });
});
