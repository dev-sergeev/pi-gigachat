import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { GIGACHAT_MODELS } from '../dist/models.js';
import { ask, completion, reply, user, withServer } from './helpers.mjs';
import { withPi } from './pi-rpc.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];

const levels = ['off', 'low', 'medium', 'high'];
const models = ['glm-5.2', 'Qwen3.5-397b'].map(id => GIGACHAT_MODELS.find(model => model.id === id));

test('GLM and Qwen expose exactly the requested thinking levels', () => {
  for (const model of models) {
    assert(model);
    assert.equal(model.reasoning, true);
    assert.deepEqual(getSupportedThinkingLevels(model), levels);
  }
  assert.equal(models[1].contextWindow, 262144);
  assert.equal(models[1].maxTokens, 32768);
});

for (const selected of models)
for (const streaming of [false, true]) test(`${selected.id} sends reasoning levels and replays returned thinking (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const model = { ...selected, baseUrl };
    const env = { GIGACHAT_STREAM: String(streaming) };
    for (const level of levels) {
      const options = { reasoning: level === 'off' ? undefined : level, env };
      const answer = await ask(model, undefined, options);
      assert.equal(answer.stopReason, 'stop', answer.errorMessage);
      assert.equal(answer.model, selected.id);
      assert.equal(requests.at(-1).body.model, selected.id);
      assert.equal(requests.at(-1).body.reasoning_effort, level);
      assert.equal(requests.at(-1).body.max_tokens, selected.maxTokens);
      assert.equal(requests.at(-1).body.stream, streaming);
      if (level !== 'off') {
        assert.equal(answer.content[0].thinking, `Thinking at ${level}`);
        await ask(model, { messages: [user('Hi'), JSON.parse(JSON.stringify(answer)), user('Continue')] }, options);
        const replay = requests.at(-1).body.messages.find(message => message.role === 'assistant');
        assert.equal(replay.reasoning_content, `Thinking at ${level}`);
        assert.equal(requests.at(-1).body.reasoning_effort, level);
      }
    }
    for (const [reasoning, expected] of [['off', 'off'], ['minimal', 'low'], ['xhigh', 'high'], ['max', 'high']]) {
      await ask(model, undefined, { reasoning, env });
      assert.equal(requests.at(-1).body.reasoning_effort, expected);
    }
  }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'OK',
    ...(req.body.reasoning_effort !== 'off' ? { reasoning_content: `Thinking at ${req.body.reasoning_effort}` } : {}) })));
});

test('reasoning supports gateway mappings and explicit payload overrides', async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const model = { ...models[0], baseUrl, thinkingLevelMap: { ...models[0].thinkingLevelMap, off: 'none' } };
    await ask(model);
    assert.equal(requests.at(-1).body.reasoning_effort, 'none');
    await ask({ ...model, samplingParams: { reasoning_effort: 'medium' } }, undefined, { reasoning: 'high' });
    assert.equal(requests.at(-1).body.reasoning_effort, 'medium');
    await ask(model, undefined, { reasoning: 'high', samplingParams: { reasoning_effort: 'medium' },
      env: { GIGACHAT_EXTRA_BODY: '{"reasoning_effort":"low"}' } });
    assert.equal(requests.at(-1).body.reasoning_effort, 'low');
    await ask(model, undefined, { reasoning: 'high', extraBody: { reasoning_effort: 'medium' },
      onPayload(body) { return { ...body, reasoning_effort: 'off' }; } });
    assert.equal(requests.at(-1).body.reasoning_effort, 'off');
  });
});

test('custom non-reasoning models do not acquire reasoning fields', async () => {
  await withServer(async ({ model, requests }) => {
    await ask({ ...model, reasoning: false, thinkingLevelMap: undefined }, undefined, { reasoning: 'high' });
    assert(!Object.hasOwn(requests[0].body, 'reasoning_effort'));
  });
});

for (const selected of models)
for (const streaming of [false, true]) test(`native Pi selects and persists ${selected.id} thinking levels (stream=${streaming})`, { timeout: 45000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async (pi, restart) => {
      const available = await pi.command('get_available_thinking_levels');
      assert.deepEqual(available.data.levels, levels);
      for (const level of ['low', 'medium', 'high', 'off']) {
        const changed = await pi.command('set_thinking_level', { level });
        assert.equal(changed.success, true, changed.error);
        assert.equal((await pi.command('get_state')).data.thinkingLevel, level);
        await pi.prompt(`Reply at ${level}.`);
        assert.equal(requests.at(-1).body.model, selected.id);
        assert.equal(requests.at(-1).body.reasoning_effort, level);
        assert.equal(requests.at(-1).body.stream, streaming);
      }
      await pi.command('set_thinking_level', { level: 'medium' });
      pi = await restart();
      assert.equal((await pi.command('get_state')).data.thinkingLevel, 'medium');
      await pi.prompt('Continue after restart.');
      assert.equal(requests.at(-1).body.reasoning_effort, 'medium');
    }, {}, { model: selected.id, env: { GIGACHAT_STREAM: String(streaming) } });
  }, (req, res) => reply(req, res, completion()));
});
