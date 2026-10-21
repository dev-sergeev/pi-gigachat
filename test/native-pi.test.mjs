import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { completion, reply, withServer } from './helpers.mjs';
import { withPi } from './pi-rpc.mjs';

const singleToolInstruction = 'Call at most one tool per assistant message. Do not make multiple or parallel tool calls. Wait for the tool result before calling another tool.';


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

test('native context_with_system applies current sections and tool deltas without changing saved history', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-transcript-'));
  const extensionPath = join(directory, 'transcript.mjs');
  try {
    await writeFile(extensionPath, `export default function (pi) {
  pi.on('context_with_system', event => ({
    messages: [
      ...event.messages,
      { role: 'system', content: 'NATIVE_DELTA_INSTRUCTION_42',
        sections: { rules: 'OBSOLETE_NATIVE_SECTION_42', temporary: 'REMOVED_NATIVE_SECTION_42' },
        timestamp: 1 },
      { role: 'system', content: '',
        sections: { rules: 'CURRENT_NATIVE_SECTION_42', temporary: null },
        toolsRemoved: [{ name: 'read' }],
        toolsAdded: [{ name: 'native_delta_tool', description: 'Current declaration',
          parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } }],
        timestamp: 2 },
    ],
  }));
}
`);
    await withServer(async ({ baseUrl, requests }) => {
      await withPi(baseUrl, async (pi, restart) => {
        await pi.prompt('Keep NATIVE_TRANSCRIPT_FACT_42.');
        pi = await restart();
        await pi.prompt('Recall NATIVE_TRANSCRIPT_FACT_42.');
        assert.equal(requests.length, 2, 'Native activation and resume must not make hidden requests');
        for (const { body } of requests) {
          const systems = body.messages.filter(message => message.role === 'system');
          assert.equal(systems.length, 1);
          assert(systems[0].content.includes('NATIVE_DELTA_INSTRUCTION_42'));
          assert(systems[0].content.includes('CURRENT_NATIVE_SECTION_42'));
          assert(!systems[0].content.includes('OBSOLETE_NATIVE_SECTION_42'));
          assert(!systems[0].content.includes('REMOVED_NATIVE_SECTION_42'));
          assert(body.functions.some(tool => tool.name === 'native_delta_tool'));
          assert(!body.functions.some(tool => tool.name === 'read'));
        }
        assert(requests.at(-1).body.messages.some(message => message.role === 'user' && message.content.includes('NATIVE_TRANSCRIPT_FACT_42')));
        assert(!(await pi.entries()).some(entry => JSON.stringify(entry).includes('NATIVE_DELTA_INSTRUCTION_42')),
          'Request-local transcript changes must not rewrite saved conversation history');
      }, {}, { tools: 'read', extensionPath });
    }, (req, res) => reply(req, res, completion({ role: 'assistant', content: 'NATIVE_TRANSCRIPT_FACT_42 retained.' })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
