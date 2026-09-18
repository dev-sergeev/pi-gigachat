import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { completion, reply, withServer } from './helpers.mjs';
import { piRoot, withPi } from './pi-rpc.mjs';

const { AssistantMessageComponent } = await import(pathToFileURL(`${piRoot}/dist/modes/interactive/components/assistant-message.js`));
const { initTheme } = await import(pathToFileURL(`${piRoot}/dist/modes/interactive/theme/theme.js`));
const toolThought = 'REASONING_TOOL_742\n  Check the file before answering.  ';
const answerThought = 'REASONING_ANSWER_742\n  Use the file result.  ';
const summary = 'Summary: the file contains NATIVE_REASONING_FIXTURE_742.';
const isSummary = req => req.body.messages[0]?.content?.includes('summariz');

for (const reasoningInContent of [false, true])
for (const streaming of [false, true]) test(`native Pi displays, saves, resumes and compacts GLM reasoning (stream=${streaming}, content=${reasoningInContent})`, { timeout: 60000 }, async () => {
  let path;
  let called = false;
  await withServer(async ({ baseUrl, requests }) => {
    await withPi(baseUrl, async (pi, restart) => {
      path = join(dirname(pi.sessionFile), 'fixture.txt');
      await writeFile(path, 'NATIVE_REASONING_FIXTURE_742');
      await pi.prompt(`Read ${path}`);
      assert(pi.events.some(e => e.type === 'tool_execution_end' && !e.isError));
      const followup = requests[1].body.messages.find(m => m.role === 'assistant');
      assert.equal(followup.reasoning_content, reasoningInContent ? undefined : toolThought);
      assert.equal(followup.functions_state_id, 'native-reasoning-state');
      assert.equal(followup.content, reasoningInContent ? `<previous_reasoning>\n${toolThought}\n</previous_reasoning>` : '');
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
      if (reasoningInContent) {
        assert(replayed.every(m => !Object.hasOwn(m, 'reasoning_content')));
        assert.deepEqual(replayed.map(m => m.content.split('<previous_reasoning>').length - 1), [1, 1]);
        assert.equal(replayed[0].content, `<previous_reasoning>\n${toolThought}\n</previous_reasoning>`);
        assert.equal(replayed[1].content, `<previous_reasoning>\n${answerThought}\n</previous_reasoning>\n\nThe file contains NATIVE_REASONING_FIXTURE_742.`);
      } else assert.deepEqual(replayed.map(m => m.reasoning_content), [toolThought, answerThought]);
      assert.equal(replayed[0].functions_state_id, 'native-reasoning-state');
      for (let i = 0; i < 3; i++) await pi.prompt(`Keep the file fact ${i}. ${'conversation '.repeat(200)}`);
      const compacted = await pi.command('compact');
      assert.equal(compacted.success, true, compacted.error);
      const summaries = requests.filter(isSummary);
      assert(summaries.some(req => req.body.messages.some(m => m.content.includes('REASONING_TOOL_742'))), 'thinking must reach Pi compaction input');
      assert(summaries.some(req => req.body.messages.some(m => m.content.includes('REASONING_ANSWER_742'))));
      assert((await pi.entries()).some(e => e.type === 'message' && e.message.content?.some?.(b => b.thinking === toolThought)), 'compaction must keep the original session entries');
      await pi.prompt('Continue after compaction.');
      assert(requests.at(-1).body.messages.some(m => m.content.includes(summary)));
    }, {}, { model: 'glm-5.2', tools: 'read', timeout: 30000, env: { GIGACHAT_STREAM: String(streaming), ...(reasoningInContent ? { GIGACHAT_REASONING_IN_CONTENT: 'true' } : {}) } });
  }, (req, res) => {
    if (isSummary(req)) reply(req, res, completion({ role: 'assistant', content: summary }));
    else if (!called) {
      called = true;
      reply(req, res, completion({ role: 'assistant', content: '', reasoning_content: toolThought,
        function_call: { name: 'read', arguments: { path } }, functions_state_id: 'native-reasoning-state' }, 'function_call'));
    } else reply(req, res, completion({ role: 'assistant', content: 'The file contains NATIVE_REASONING_FIXTURE_742.', reasoning_content: answerThought }));
  });
});
