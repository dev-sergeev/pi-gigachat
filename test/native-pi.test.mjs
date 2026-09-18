import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import extension, { gigachatProvider } from '../dist/index.js';
import { completion, reply, withServer } from './helpers.mjs';
import { withPi } from './pi-rpc.mjs';

const singleToolInstruction = 'Call at most one tool per assistant message. Do not make multiple or parallel tool calls. Wait for the tool result before calling another tool.';

test('extension registers a native Provider object using the one-argument API', () => {
  let args;
  extension({ registerProvider(...values) { args = values; } });
  assert.equal(args.length, 1);
  assert.equal(args[0], gigachatProvider);
  assert.equal(typeof args[0].auth.oauth.toAuth, 'function');
  assert.equal(typeof args[0].stream, 'function');
  assert(args[0].getModels().some(model => model.id === 'GigaChat-3-Ultra'));
});

for (const providerPrompt of [undefined, 'GIGA_PROVIDER_RULES\nСохраняй точные идентификаторы.'])
for (const streaming of [false, true]) test(`native pi uses GigaChat tools, compaction, saved history and extra parameters (stream=${streaming}, prompt=${providerPrompt === undefined ? 'default' : 'custom'})`, { timeout: 45000 }, async () => {
  let path;
  let called = false;
  const summary = 'Remember GIGA-NATIVE-42 from the tool output.';
  const expectedPrompt = providerPrompt ?? singleToolInstruction;
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async (pi, restart) => {
      path = join(dirname(pi.sessionFile), 'fixture.txt');
      await writeFile(path, 'GIGA-NATIVE-42');
      await pi.prompt(`Read ${path}`);
      assert(requests.some(r => r.body.messages.some(m => m.role === 'function' && m.content.includes('GIGA-NATIVE-42'))));
      assert(pi.events.some(e => e.type === 'tool_execution_end' && !e.isError));
      for (let i = 0; i < 3; i++) await pi.prompt('Keep the file fact. ' + 'conversation '.repeat(200));
      const compacted = await pi.command('compact');
      assert.equal(compacted.success, true, compacted.error);
      assert.match(compacted.data.summary, /GIGA-NATIVE-42/);
      pi = await restart();
      await pi.prompt('Recall the file fact.');
      assert(requests.at(-1).body.messages.some(m => m.content.includes(summary)));
      assert(requests.every(r => r.body.stream === streaming && r.body.temperature === 0.2 && r.body.max_tokens === 1024 && r.body.repetition_penalty === 1.05));
      assert(requests.every(r => r.body.messages[0].role === 'system' && r.body.messages[0].content.endsWith('\n\n' + expectedPrompt)));
      assert(requests.every(r => r.body.messages.filter(m => m.role === 'system').length === 1));
      assert(requests.every(r => r.body.messages[0].content.split(expectedPrompt).length === 2));
      if (providerPrompt !== undefined) assert(requests.every(r => !r.body.messages[0].content.includes(singleToolInstruction)));
      assert(requests.every(r => r.headers.accept === (streaming ? 'text/event-stream' : 'application/json')));
      const summaries = requests.filter(r => r.body.messages[0]?.content.includes('summariz'));
      assert(summaries.length);
      assert(summaries.every(r => !r.body.functions && r.body.function_call === 'none'));
    }, {}, { tools: 'read', env: { ...(providerPrompt === undefined ? {} : { GIGACHAT_SYSTEM_PROMPT: providerPrompt }), GIGACHAT_STREAM: String(streaming), GIGACHAT_EXTRA_BODY: '{"temperature":0.2,"max_tokens":1024,"repetition_penalty":1.05}' } });
  }, (req, res) => {
    const summarizing = req.body.messages[0]?.content.includes('summariz');
    if (!called && !summarizing) {
      called = true;
      reply(req, res, completion({ role: 'assistant', content: '', function_call: { name: 'read', arguments: { path } }, functions_state_id: 'native-tool-state' }, 'function_call'));
    } else reply(req, res, completion({ role: 'assistant', content: summarizing ? summary : 'Remembered GIGA-NATIVE-42.' }));
  });
});

test('native pi selects GLM 5.2 with its context and output budgets', { timeout: 30000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async pi => {
      const state = await pi.command('get_state');
      assert.equal(state.data.model.id, 'glm-5.2');
      assert.equal(state.data.model.contextWindow, 200000);
      assert.equal(state.data.model.maxTokens, 64000);
      await pi.prompt('Say hello.');
      assert.equal(requests[0].body.model, 'glm-5.2');
      assert.equal(requests[0].body.max_tokens, 64000);
      assert(requests[0].body.messages[0].content.endsWith(singleToolInstruction));
    }, {}, { model: 'glm-5.2' });
  });
});
