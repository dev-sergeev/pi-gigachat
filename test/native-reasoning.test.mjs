import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { completion, reply, testModel, withServer } from './helpers.mjs';
import { piRoot, withPi } from './pi-rpc.mjs';

const { AssistantMessageComponent } = await import(pathToFileURL(`${piRoot}/dist/modes/interactive/components/assistant-message.js`));
const { initTheme } = await import(pathToFileURL(`${piRoot}/dist/modes/interactive/theme/theme.js`));
const toolThought = 'REASONING_TOOL_742\n  Check the file before answering.  ';
const answerThought = 'REASONING_ANSWER_742\n  Use the file result.  ';
const summary = 'Summary: the file contains NATIVE_REASONING_FIXTURE_742.';
const isSummary = req => req.body.messages[0]?.content?.includes('summariz');

for (const streaming of [false, true]) test(`native Pi displays, saves, resumes and compacts consumer-model reasoning (stream=${streaming})`, { timeout: 60000 }, async () => {
  let path;
  let called = false;
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async (pi, restart) => {
      path = join(dirname(pi.sessionFile), 'fixture.txt');
      await writeFile(path, 'NATIVE_REASONING_FIXTURE_742');
      await pi.prompt(`Read ${path}`);
      assert(pi.events.some(e => e.type === 'tool_execution_end' && !e.isError));
      const followup = requests[1].body.messages.find(m => m.role === 'assistant');
      assert(!Object.hasOwn(followup, 'reasoning_content'));
      assert(!Object.hasOwn(followup, 'functions_state_id'));
      assert.equal(followup.content, toolThought);
      const messages = (await pi.command('get_messages')).data.messages;
      const assistants = messages.filter(m => m.role === 'assistant');
      assert.deepEqual(assistants.map(m => m.content[0].thinking), [toolThought, answerThought]);
      const thinkingEvents = pi.events.filter(e => e.type === 'message_update' && e.assistantMessageEvent?.type?.startsWith('thinking'));
      assert.equal(thinkingEvents.filter(e => e.assistantMessageEvent.type === 'thinking_end').length, 2);
      assert.deepEqual((await pi.entries()).filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message.content), assistants.map(m => m.content));

      initTheme('dark', false);
      const before = JSON.stringify(assistants[1]);
      assert(new AssistantMessageComponent(assistants[1], false).render(100).join('\n').includes('REASONING_ANSWER_742'));
      assert(!new AssistantMessageComponent(assistants[1], true).render(100).join('\n').includes('REASONING_ANSWER_742'));
      assert.equal(JSON.stringify(assistants[1]), before, 'hiding thinking must not change history');

      pi = await restart();
      assert.deepEqual((await pi.command('get_messages')).data.messages.filter(m => m.role === 'assistant').map(m => m.content), assistants.map(m => m.content));
      await pi.prompt('Continue from the previous reasoning.');
      const replayed = requests.at(-1).body.messages.filter(m => m.role === 'assistant');
      assert(replayed.every(m => !Object.hasOwn(m, 'reasoning_content')));
      assert.equal(replayed[0].content, toolThought);
      assert.equal(replayed[1].content, `${answerThought}\n\nThe file contains NATIVE_REASONING_FIXTURE_742.`);
      assert(replayed.every(m => !Object.hasOwn(m, 'functions_state_id')));
      for (let i = 0; i < 3; i++) await pi.prompt(`Keep the file fact ${i}. ${'conversation '.repeat(200)}`);
      const compacted = await pi.command('compact');
      assert.equal(compacted.success, true, compacted.error);
      const summaries = requests.filter(isSummary);
      assert(summaries.length > 0);
      assert(summaries.every(req => req.body.messages.every(m => !m.content.includes('REASONING_TOOL_742') && !m.content.includes('REASONING_ANSWER_742'))),
        'Pi 1.3 compaction omits thinking rather than treating it as visible conversation');
      assert(summaries.some(req => req.body.messages.some(m => m.content.includes('NATIVE_REASONING_FIXTURE_742'))),
        'Compaction must retain the visible answer and tool-result fact');
      assert((await pi.entries()).some(e => e.type === 'message' && e.message.content?.some?.(b => b.thinking === toolThought)), 'compaction must keep the original session entries');
      await pi.prompt('Continue after compaction.');
      assert(requests.at(-1).body.messages.some(m => m.content.includes(summary)));
    }, {}, { tools: 'read', timeout: 30000, env: { GIGACHAT_STREAM: String(streaming) } });
  }, (req, res) => {
    if (isSummary(req)) reply(req, res, completion({ role: 'assistant', content: summary }));
    else if (!called) {
      called = true;
      reply(req, res, completion({ role: 'assistant', content: '', reasoning_content: toolThought,
        function_call: { name: 'read', arguments: { path } }, functions_state_id: 'native-reasoning-state' }, 'function_call'));
    } else reply(req, res, completion({ role: 'assistant', content: 'The file contains NATIVE_REASONING_FIXTURE_742.', reasoning_content: answerThought }));
  });
});

test('native model handoff drops foreign thinking but retains visible history and saved reasoning', { timeout: 30000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async pi => {
      await pi.prompt('Remember VISIBLE_HANDOFF_FACT_742.');
      const selected = await pi.command('set_model', { provider: 'gigachat', modelId: 'handoff-target' });
      assert.equal(selected.success, true, selected.error);
      await pi.prompt('Continue with the visible fact.');
      assert.equal(requests.length, 2, 'Changing the selected model must not run a hidden generation probe');
      const previousAnswers = requests[1].body.messages.filter(message => message.role === 'assistant');
      assert(previousAnswers.some(message => message.content.includes('VISIBLE_HANDOFF_FACT_742')));
      assert(previousAnswers.every(message => !message.content.includes('FOREIGN_PRIVATE_THOUGHT_742')),
        'Pi 1.3 must not turn another model\'s thinking into visible conversation');
      const saved = (await pi.entries()).filter(entry => entry.type === 'message' && entry.message.role === 'assistant');
      assert(saved[0].message.content.some(block => block.type === 'thinking' && block.thinking === 'FOREIGN_PRIVATE_THOUGHT_742'),
        'Dropping foreign thinking from a request must not alter saved reasoning');
    }, {}, { fixtureModels: [
      testModel({ id: 'test-model', baseUrl }),
      testModel({ id: 'handoff-target', baseUrl }),
    ] });
  }, (req, res) => reply(req, res, completion({
    role: 'assistant', content: 'VISIBLE_HANDOFF_FACT_742 retained.',
    reasoning_content: req.body.model === 'test-model' ? 'FOREIGN_PRIVATE_THOUGHT_742' : 'Target reasoning.',
  })));
});
