import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { gigachatProvider } from '../dist/index.js';
import { ask, completion, reply, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const extra = 'Правила провайдера 🙂:\nОтмечай предположения.\n\nБлок кода:\nСохраняй буквальное \\n.';
const respond = (req, res) => reply(req, res, completion());

for (const streaming of [false, true]) test(`provider instructions append to one system message without accumulating or mutating context (stream=${streaming})`, async () => {
  await withServer(async ({ model, requests }) => {
    const original = '  Original pi system prompt.\n';
    const context = Object.freeze({ systemPrompt: original, messages: Object.freeze([Object.freeze(user('Hello'))]) });
    const snapshot = structuredClone(context);
    const options = { env: { GIGACHAT_STREAM: String(streaming), GIGACHAT_SYSTEM_PROMPT: `\n${extra}\n ` } };
    for (let i = 0; i < 2; i++) {
      const result = await ask(model, context, options);
      assert.equal(result.stopReason, 'stop', result.errorMessage);
    }
    for (const { body } of requests) {
      assert.deepEqual(body.messages, [{ role: 'system', content: original + '\n\n' + extra }, { role: 'user', content: 'Hello' }]);
      assert.equal(body.stream, streaming);
    }
    assert.deepEqual(context, snapshot);
  }, respond);
});

test('extra instructions create a system message when pi supplies none', async () => {
  await withServer(async ({ model, requests }) => {
    await ask(model, { messages: [user('Hello')] }, { env: { GIGACHAT_SYSTEM_PROMPT: extra } });
    assert.deepEqual(requests[0].body.messages, [{ role: 'system', content: extra }, { role: 'user', content: 'Hello' }]);
  });
});

test('unset, empty and whitespace-only settings leave the original message list unchanged', async () => {
  await withServer(async ({ model, requests }) => {
    for (const value of [undefined, '', ' \n\t ']) {
      for (const systemPrompt of [undefined, '  Original pi prompt.\n']) {
        await ask(model, { systemPrompt, messages: [user('Hello')] }, { env: value === undefined ? {} : { GIGACHAT_SYSTEM_PROMPT: value } });
        assert.deepEqual(requests.at(-1).body.messages, [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: 'Hello' }]);
      }
    }
  });
});

test('request-scoped settings override the process prompt and an explicit empty value disables it', async () => {
  process.env.GIGACHAT_SYSTEM_PROMPT = 'Ambient instructions';
  try {
    await withServer(async ({ model, requests }) => {
      const context = { systemPrompt: 'Original pi prompt.', messages: [user('Hello')] };
      await ask(model, context);
      await ask(model, context, { env: { GIGACHAT_SYSTEM_PROMPT: 'Scoped instructions' } });
      await ask(model, context, { env: { GIGACHAT_SYSTEM_PROMPT: '' } });
      assert.deepEqual(requests.map(r => r.body.messages[0].content), ['Original pi prompt.\n\nAmbient instructions', 'Original pi prompt.\n\nScoped instructions', 'Original pi prompt.']);
    });
  } finally { delete process.env.GIGACHAT_SYSTEM_PROMPT; }
});

test('native auth context forwards provider instructions to the adapter', async () => {
  await withServer(async ({ model, requests }) => {
    const env = { GIGACHAT_ACCESS_TOKEN: token, GIGACHAT_SYSTEM_PROMPT: extra };
    const models = createModels({ authContext: { env: async name => env[name], fileExists: async () => false } });
    models.setProvider(gigachatProvider);
    const result = await models.completeSimple(model, { systemPrompt: 'Original pi prompt.', messages: [user('Hello')] });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].body.messages[0].content, 'Original pi prompt.\n\n' + extra);
  });
});
