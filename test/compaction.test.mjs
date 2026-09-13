import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamSimpleGigaChat } from '../dist/stream.js';
import { completion, json, reply, token, user, withServer } from './helpers.mjs';
import { piRoot, until, withPi } from './pi-rpc.mjs';
import { pathToFileURL } from 'node:url';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const isSummary = req => req.body.messages[0]?.content?.includes('summariz');
const summary = '# Goal\nRemember AUDIT-42.\n## Progress\nConversation condensed.\n## Next Steps\nContinue.';
const seed = async pi => {
  for (let i = 0; i < 3; i++) await pi.prompt(`Turn ${i}: AUDIT-42. ${'history '.repeat(300)}`);
};
const respond = (req, res) => reply(req, res, completion({ role: 'assistant', content: isSummary(req) ? summary : 'Acknowledged.' }));

for (const streaming of [false, true]) {
  const modeTest = (name, ...args) => test(`${name} (stream=${streaming})`, ...args);
  const withTestPi = (url, run, settings) => withPi(url, run, settings, { env: { GIGACHAT_STREAM: String(streaming) } });
  const streamFn = (model, context, options) => streamSimpleGigaChat(model, context, { ...options, stream: streaming });

modeTest('real pi compacts, includes its prior summary on recompaction, and resumes the saved session', { timeout: 45000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    await withTestPi(baseUrl, async (pi, restart) => {
      await seed(pi);
      const first = await pi.command('compact', { customInstructions: 'Preserve AUDIT-42.' });
      assert.equal(first.success, true, first.error);
      assert.match(first.data.summary, /AUDIT-42/);
      assert((await pi.entries()).some(e => e.type === 'compaction'));
      await pi.prompt('Continue after compaction.');
      assert(requests.at(-1).body.messages.some(m => m.content?.includes(summary)));
      const before = requests.length;
      await seed(pi);
      const second = await pi.command('compact');
      assert.equal(second.success, true, second.error);
      assert(requests.slice(before).filter(isSummary).some(r => JSON.stringify(r.body).includes('<previous-summary>')));
      pi = await restart();
      await pi.prompt('Continue after restart.');
      assert(requests.at(-1).body.messages.some(m => m.content?.includes(summary)));
      const summaries = requests.filter(isSummary);
      assert(summaries.length >= 2);
      assert(summaries.every(r => r.body.stream === streaming && !r.body.functions && r.body.max_tokens <= 8192));
      assert(requests.every(r => r.body.stream === streaming && r.headers.authorization === `Bearer ${token}`));
    });
  }, respond);
});

modeTest('real pi recovers from HTTP 413 by compacting and retrying the original turn', { timeout: 45000 }, async () => {
  let overflow = false;
  await withServer(async ({ baseUrl, requests }) => {
    await withTestPi(baseUrl, async pi => {
      await seed(pi);
      await pi.command('set_auto_compaction', { enabled: true });
      overflow = true;
      const start = requests.length;
      await pi.prompt('OVERFLOW_TURN: keep AUDIT-42.');
      await until(() => requests.slice(start).some(isSummary), 'overflow compaction');
      await until(() => requests.slice(start).filter(r => !isSummary(r)).length >= 2, 'retry after compaction');
      await until(async () => (await pi.entries()).some(e => e.type === 'compaction'), 'saved compaction');
      assert(requests.at(-1).body.messages.some(m => m.content?.includes(summary)));
      assert(requests.at(-1).body.messages.some(m => m.content?.includes('OVERFLOW_TURN')));
    });
  }, (req, res) => {
    if (overflow && !isSummary(req)) { overflow = false; json(res, { status: 413, message: 'Payload too large' }, 413); }
    else respond(req, res);
  });
});

for (const cached of [false, true]) modeTest(`real pi uses full context usage to trigger threshold compaction (cache=${cached})`, { timeout: 45000 }, async () => {
  let highUsage = false;
  await withServer(async ({ baseUrl, requests }) => {
    await withTestPi(baseUrl, async pi => {
      await seed(pi);
      await pi.command('set_auto_compaction', { enabled: true });
      highUsage = true;
      const start = requests.length;
      await pi.prompt('THRESHOLD_TURN');
      await until(() => requests.slice(start).some(isSummary), 'usage-based compaction');
      await until(async () => (await pi.entries()).some(e => e.type === 'compaction'), 'saved threshold summary');
    });
  }, (req, res) => {
    if (highUsage && !isSummary(req)) {
      highUsage = false;
      reply(req, res, completion({ role: 'assistant', content: 'High usage.' }, 'stop', cached
        ? { prompt_tokens: 5000, precached_prompt_tokens: 110000, completion_tokens: 20, total_tokens: 5020 }
        : { prompt_tokens: 115000, completion_tokens: 20, total_tokens: 115020 }));
    } else respond(req, res);
  });
});

modeTest('failed compaction does not replace the existing session history', { timeout: 45000 }, async () => {
  await withServer(async ({ baseUrl }) => {
    await withTestPi(baseUrl, async pi => {
      await seed(pi);
      const before = (await pi.entries()).filter(e => e.type === 'message').length;
      const result = await pi.command('compact');
      assert.equal(result.success, false);
      const entries = await pi.entries();
      assert(!entries.some(e => e.type === 'compaction'));
      assert.equal(entries.filter(e => e.type === 'message').length, before);
    });
  }, (req, res) => isSummary(req) ? json(res, { message: 'Temporary service failure' }, 500) : respond(req, res));
});

modeTest('pi rejects truncated summaries without replacing history', { timeout: 45000 }, async () => {
  await withServer(async ({ baseUrl }) => {
    await withTestPi(baseUrl, async pi => {
      await seed(pi);
      const result = await pi.command('compact');
      assert.equal(result.success, false, result.error);
      assert.equal((await pi.entries()).some(e => e.type === 'compaction'), false);
    });
  }, (req, res) => isSummary(req) ? reply(req, res, completion({ role: 'assistant', content: 'Truncated summary' }, 'length')) : respond(req, res));
});

modeTest('RPC abort cancels compaction without replacing history', { timeout: 45000 }, async () => {
  let summaryResponse;
  await withServer(async ({ baseUrl }) => {
    await withTestPi(baseUrl, async pi => {
      await seed(pi);
      const pending = pi.command('compact');
      await until(() => summaryResponse, 'summary request');
      await pi.command('abort');
      const result = await pending;
      assert.equal(result.success, false, result.error);
      assert.equal((await pi.entries()).some(e => e.type === 'compaction'), false);
    });
  }, (req, res) => { if (isSummary(req)) summaryResponse = res; else respond(req, res); });
});

modeTest('original pi branch summarizer uses the adapter and preserves file-operation context', async () => {
  const { generateBranchSummary } = await import(pathToFileURL(`${piRoot}/dist/core/compaction/branch-summarization.js`));
  await withServer(async ({ model, requests }) => {
    const call = { type: 'toolCall', id: 'branch-read', name: 'read', arguments: { path: '/tmp/example.txt' } };
    const assistant = { role: 'assistant', content: [call], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16 }, timestamp: 0 };
    const messages = [user('Keep branch fact AUDIT-42'), assistant, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'AUDIT-42 file data' }], isError: false, timestamp: 0 }];
    const entries = messages.map((message, i) => ({ type: 'message', id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp: new Date(0).toISOString(), message }));
    const result = await generateBranchSummary(entries, { model, apiKey: token, signal: new AbortController().signal, streamFn });
    assert.match(result.summary, /AUDIT-42/);
    assert(result.readFiles.includes('/tmp/example.txt'));
    assert.match(JSON.stringify(requests[0].body), /Keep branch fact AUDIT-42/);
    assert.match(JSON.stringify(requests[0].body), /example.txt/);
    assert.equal(requests[0].body.stream, streaming);
    assert(!requests[0].body.functions);
  }, respond);
});

modeTest('original pi split-turn compaction retains both summaries without concurrent GigaChat requests', async () => {
  const { compact } = await import(pathToFileURL(`${piRoot}/dist/core/compaction/compaction.js`));
  let active = 0;
  let maximum = 0;
  await withServer(async ({ model, requests }) => {
    const preparation = {
      firstKeptEntryId: 'kept-entry', messagesToSummarize: [user('Earlier history AUDIT-42')],
      turnPrefixMessages: [user('Beginning of a long turn: preserve PREFIX-42')], isSplitTurn: true,
      tokensBefore: 2000, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 256 },
    };
    const signal = new AbortController().signal;
    const result = await compact(preparation, model, token, undefined, undefined, signal, undefined, streamFn);
    assert.match(result.summary, /Turn Context \(split turn\)/);
    assert.equal(result.firstKeptEntryId, 'kept-entry');
    assert.equal(requests.length, 2);
    assert.equal(maximum, 1);
    assert(requests.every(r => r.body.function_call === 'none' && r.body.max_tokens <= model.maxTokens && r.body.stream === streaming));
  }, async (req, res) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 35));
    active--;
    respond(req, res);
  });
});

}
