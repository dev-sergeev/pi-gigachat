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
  for (const mode of [undefined, 'false', 'true'])
  test(`saved reasoning uses the selected representation without modifying history (stream=${streaming}, mode=${mode ?? 'default'})`, async () => {
    await withServer(async ({ model, requests }) => {
      const previous = history(model, [thinking,
        { type: 'thinking', thinking: 'Other field.', thinkingSignature: 'reasoning' },
        { type: 'text', text: answer, textSignature: 'gigachat:functions_state_id:text-state' }]);
      const context = { messages: [user('First'), previous, user('Continue')] };
      const original = structuredClone(context);
      for (let i = 0; i < 2; i++) {
        const result = await ask(model, context, { env: {
          GIGACHAT_STREAM: String(streaming), ...(mode === undefined ? {} : { GIGACHAT_REASONING_IN_CONTENT: mode }),
        } });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        const replay = requests.at(-1).body.messages.find(m => m.role === 'assistant');
        assert.deepEqual(replay, mode === 'true'
          ? { role: 'assistant', content: `${thought}Other field.\n\n${answer}` }
          : { role: 'assistant', content: answer, reasoning_content: thought, reasoning: 'Other field.' });
        assert.deepEqual(context, original, 'wire transformation must not modify stored thinking or answer');
      }
      assert.deepEqual(requests[0].body, requests[1].body, 'repeated sends must not accumulate reasoning');
    }, respond);
  });
}

for (const mode of ['false', 'true'])
test(`reasoning replay retains tool pairs without function state or repeated reasoning (mode=${mode})`, async () => {
  await withServer(async ({ model, requests }) => {
    const calls = ['read', 'bash'].map((name, index) => ({ type: 'toolCall', id: `call-${index}`, name,
      arguments: { value: index }, thoughtSignature: `gigachat:functions_state_id:state-${index}` }));
    const previous = history(model, [thinking, ...calls], { stopReason: 'toolUse' });
    const results = calls.map(call => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Fixture' }], isError: false, timestamp: 0 }));
    const context = { messages: [previous, ...results] };
    const original = structuredClone(context);
    const result = await ask(model, context, { env: { GIGACHAT_REASONING_IN_CONTENT: mode } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const messages = requests[0].body.messages.filter(m => m.role !== 'system');
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'function', 'assistant', 'function']);
    assert.deepEqual({ content: messages[0].content, ...(Object.hasOwn(messages[0], 'reasoning_content')
      ? { reasoning_content: messages[0].reasoning_content } : {}) },
      mode === 'true' ? { content: thought } : { content: '', reasoning_content: thought });
    assert.equal(messages[2].content, '');
    assert(!Object.hasOwn(messages[2], 'reasoning_content'));
    assert.deepEqual(context, original);
    for (const index of [0, 1]) {
      assert.deepEqual(messages[index * 2].function_call, { name: calls[index].name, arguments: calls[index].arguments });
      assert(!Object.hasOwn(messages[index * 2], 'functions_state_id'));
      assert.equal(JSON.parse(messages[index * 2 + 1].content).result, 'Fixture');
    }
  });
});

for (const mode of ['false', 'true'])
test(`reasoning replay preserves ordered whitespace-only fragments (mode=${mode})`, async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [history(model, [
      { ...thinking, thinking: ' \n' }, { type: 'text', text: 'A' },
      { ...thinking, thinking: '\t ' }, { type: 'text', text: 'B' },
    ])];
    const result = await ask(model, { messages }, { env: { GIGACHAT_REASONING_IN_CONTENT: mode } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(requests[0].body.messages.find(m => m.role === 'assistant'), mode === 'true'
      ? { role: 'assistant', content: ' \n\t \n\nAB' }
      : { role: 'assistant', content: 'AB', reasoning_content: ' \n\t ' });
  });
});

for (const mode of ['false', 'true'])
test(`reasoning replay leaves answers unchanged and excludes redacted, aborted and failed reasoning (mode=${mode})`, async () => {
  await withServer(async ({ model, requests }) => {
    const messages = [
      history(model, [{ type: 'text', text: answer }]),
      history(model, [{ ...thinking, thinking: '' }, { type: 'text', text: answer }]),
      history(model, [{ ...thinking, redacted: true }, { type: 'text', text: answer }]),
      ...['aborted', 'error'].map(stopReason => history(model, [thinking], { stopReason })),
    ];
    const result = await ask(model, { messages }, { env: { GIGACHAT_REASONING_IN_CONTENT: mode } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(requests[0].body.messages.filter(m => m.role === 'assistant'), [
      { role: 'assistant', content: answer },
      { role: 'assistant', content: answer, ...(mode === 'false' ? { reasoning_content: '' } : {}) },
      { role: 'assistant', content: answer },
    ]);
  });
});

test('reasoning replay reads process.env and lets options.env override or unset it', async () => {
  const key = 'GIGACHAT_REASONING_IN_CONTENT';
  const original = process.env[key];
  try {
    await withServer(async ({ model, requests }) => {
      const context = { messages: [history(model, [thinking, { type: 'text', text: answer }])] };
      for (const [processMode, env, folded] of [
        ['true', {}, true],
        ['false', {}, false],
        ['true', { [key]: 'false' }, false],
        ['false', { [key]: 'true' }, true],
        ['true', { [key]: undefined }, false],
        ['invalid', { [key]: 'false' }, false],
      ]) {
        process.env[key] = processMode;
        const result = await ask(model, context, { env });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        assert.deepEqual(requests.at(-1).body.messages.find(m => m.role === 'assistant'), folded
          ? { role: 'assistant', content: `${thought}\n\n${answer}` }
          : { role: 'assistant', content: answer, reasoning_content: thought });
      }
    }, respond);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

for (const value of ['', 'TRUE', 'False', ' true', 'false ', '1', '0', 'yes'])
test(`reasoning replay rejects a non-boolean environment value: ${JSON.stringify(value)}`, async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask(model, undefined, { env: { GIGACHAT_REASONING_IN_CONTENT: value } });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /GIGACHAT_REASONING_IN_CONTENT.*true.*false/);
    assert.equal(requests.length, 0, 'invalid configuration must fail before sending a request');
  }, respond);
});

for (const streaming of [false, true])
for (const mode of ['false', 'true'])
test(`V1 payload overrides retain selected reasoning and strip only message-level state immutably (stream=${streaming}, mode=${mode})`, async () => {
  await withServer(async ({ model, requests }) => {
    const call = { type: 'toolCall', id: 'override-call', name: 'read',
      arguments: { path: 'fixture', functions_state_id: 'tool-input' }, thoughtSignature: 'gigachat:functions_state_id:saved-state' };
    const context = { messages: [history(model, [thinking, call], { stopReason: 'toolUse' }), {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Fixture' }], isError: false, timestamp: 0,
    }] };
    const original = structuredClone(context);
    let override;
    let originalOverride;
    const options = { env: { GIGACHAT_STREAM: String(streaming), GIGACHAT_REASONING_IN_CONTENT: mode },
      onPayload(body) {
        if (!override) {
          override = { ...body, messages: body.messages.map(message => ({ ...message, functions_state_id: 'override-state' })) };
          originalOverride = structuredClone(override);
        }
        return override;
      } };
    for (let i = 0; i < 2; i++) {
      const result = await ask(model, context, options);
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.deepEqual(context, original);
      assert.deepEqual(override, originalOverride, 'sending must not rewrite a reusable onPayload object');
      const messages = requests.at(-1).body.messages;
      assert(messages.every(message => !Object.hasOwn(message, 'functions_state_id')));
      assert.deepEqual(messages.find(message => message.role === 'assistant'), {
        role: 'assistant', content: mode === 'true' ? thought : '',
        ...(mode === 'false' ? { reasoning_content: thought } : {}),
        function_call: { name: 'read', arguments: { path: 'fixture', functions_state_id: 'tool-input' } },
      });
      assert.equal(messages.find(message => message.role === 'function').name, 'read');
    }
    assert.deepEqual(requests[0].body, requests[1].body);
  }, respond);
});
