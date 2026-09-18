import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { GIGACHAT_MODELS } from '../dist/models.js';
import { ask, completion, json, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const toolResult = (call, text) => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError: false, timestamp: 0 });

test('documented GigaChat 413 is recognized by pi as context overflow', async () => {
  await withServer(async ({ model }) => {
    const result = await ask(model);
    assert.equal(result.stopReason, 'error');
    assert.equal(isContextOverflow(result, model.contextWindow), true, result.errorMessage);
    assert.match(result.errorMessage, /Payload too large/);
  }, (_req, res) => json(res, { status: 413, message: 'Payload too large' }, 413));
});

for (const [status, message] of [[422, 'Invalid params: system message must be the first message'], [429, 'Too many requests']]) {
  test(`HTTP ${status} preserves diagnostics and does not trigger compaction`, async () => {
    await withServer(async ({ model }) => {
      const result = await ask(model, undefined, { maxRetries: 0 });
      assert.equal(result.stopReason, 'error');
      assert(result.errorMessage.includes(message), result.errorMessage);
      assert.equal(isContextOverflow(result, model.contextWindow), false);
    }, (_req, res) => json(res, { message }, status));
  });
}

test('Unicode survives system prompt, history, tool arguments and tool results', async () => {
  await withServer(async ({ model, requests }) => {
    const first = await ask(model);
    const call = first.content.find(b => b.type === 'toolCall');
    await ask(model, { systemPrompt: '🙂𐐀', messages: [user('👋'), first, toolResult(call, '🚀'), user('𐐀')] });
    const messages = requests.at(-1).body.messages;
    assert(messages[0].content.startsWith('🙂𐐀\n\n'));
    assert.equal(messages[1].content, '👋');
    assert.equal(messages[2].content, '🙂');
    assert.equal(messages[2].function_call.arguments.path, '🚀');
    assert.equal(JSON.parse(messages[3].content).result, '🚀');
    assert.equal(messages.at(-1).content, '𐐀');
  }, (_req, res) => json(res, completion({ role: 'assistant', content: '🙂', function_call: { name: 'read', arguments: { path: '🚀' } } }, 'function_call')));
});

test('function state survives session serialization and tool call ids are unique', async () => {
  await withServer(async ({ model, requests }) => {
    const first = await ask(model);
    const restored = JSON.parse(JSON.stringify(first));
    const call = restored.content.find(b => b.type === 'toolCall');
    const second = await ask(model, { messages: [user('read'), restored, toolResult(call, 'contents')] });
    assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').functions_state_id, 'state-fixture');
    assert.notEqual(second.content.find(b => b.type === 'toolCall').id, call.id);
  }, (_req, res) => json(res, completion({ role: 'assistant', content: '', functions_state_id: 'state-fixture', function_call: { name: 'read', arguments: { path: 'a' } } }, 'function_call')));
});

test('text-only replies also preserve function state for subsequent turns', async () => {
  await withServer(async ({ model, requests }) => {
    const first = await ask(model);
    await ask(model, { messages: [user('hello'), JSON.parse(JSON.stringify(first)), user('next')] });
    assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').functions_state_id, 'text-state');
  }, (_req, res) => json(res, completion({ role: 'assistant', content: 'OK', functions_state_id: 'text-state' })));
});

test('parallel tool history from another provider is replayed as complete sequential pairs', async () => {
  await withServer(async ({ model, requests }) => {
    const previous = await ask(model);
    const calls = ['read', 'bash'].map((name, i) => ({ type: 'toolCall', id: `foreign-${i}`, name, arguments: { value: i } }));
    Object.assign(previous, { provider: 'foreign', model: 'other', content: calls, stopReason: 'toolUse' });
    await ask(model, { messages: [user('go'), previous, toolResult(calls[1], 'second'), toolResult(calls[0], 'first'), user('continue')] });
    const messages = requests.at(-1).body.messages;
    assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'function', 'assistant', 'function', 'user']);
    assert.deepEqual(messages.filter(m => m.function_call).map(m => m.function_call.name), ['read', 'bash']);
    assert.deepEqual(messages.filter(m => m.role === 'function').map(m => JSON.parse(m.content).result), ['first', 'second']);
  });
});

test('an interrupted last tool call gets a synthetic result before resuming', async () => {
  await withServer(async ({ model, requests }) => {
    const previous = await ask(model);
    previous.content = [{ type: 'toolCall', id: 'unfinished', name: 'read', arguments: {} }];
    previous.stopReason = 'toolUse';
    await ask(model, { messages: [user('go'), previous] });
    assert.equal(requests.at(-1).body.messages.at(-1).role, 'function');
    assert.match(requests.at(-1).body.messages.at(-1).content, /No result provided/);
  });
});

for (const orphanFirst of [false, true]) {
  test(`unmatched tool results survive beside matched results (orphan first: ${orphanFirst})`, async () => {
    await withServer(async ({ model, requests }) => {
      const previous = await ask(model);
      const call = { type: 'toolCall', id: 'current', name: 'read', arguments: {} };
      previous.content = [call];
      previous.stopReason = 'toolUse';
      const matched = toolResult(call, 'matched-result');
      const orphan = toolResult({ id: 'old-orphan', name: 'bash' }, 'orphan-result');
      const result = await ask(model, { messages: [user('go'), previous,
        ...(orphanFirst ? [orphan, matched] : [matched, orphan]), user('continue')] });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      const messages = requests.at(-1).body.messages;
      assert.equal(messages.find(m => m.role === 'function').content, JSON.stringify({ result: 'matched-result' }));
      assert(messages.some(m => m.role === 'user' && m.content === 'Tool result (bash):\norphan-result'));
    });
  });
}

test('tool schemas retain nested requirements, numeric enums and validation constraints', async () => {
  const parameters = { type: 'object', properties: { config: { type: 'object', properties: { mode: { type: 'integer', enum: [1, 2], minimum: 1 } }, required: ['mode'], additionalProperties: false } }, required: ['config'] };
  await withServer(async ({ model, requests }) => {
    await ask(model, { messages: [user('go')], tools: [{ name: 'configure', description: 'Configure', parameters }] });
    assert.deepEqual(requests[0].body.functions[0].parameters, parameters);
  });
});

test('default output budget follows the model; explicit budgets are bounded by its limit', async () => {
  await withServer(async ({ model, requests }) => {
    await ask(model);
    await ask(model, undefined, { maxTokens: 64 });
    await ask(model, undefined, { maxTokens: model.maxTokens * 2 });
    assert.deepEqual(requests.map(r => r.body.max_tokens), [model.maxTokens, 64, model.maxTokens]);
  });
});

test('GLM 5.2 uses a 64,000-token output budget while GigaChat budgets are unchanged', async () => {
  const glm = GIGACHAT_MODELS.find(model => model.id === 'glm-5.2');
  assert(glm);
  assert.equal(glm.contextWindow, 200000);
  for (const model of GIGACHAT_MODELS.filter(model => model.id.startsWith('GigaChat-'))) {
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 8192);
  }
  await withServer(async ({ baseUrl, requests }) => {
    const model = { ...glm, baseUrl };
    await ask(model);
    await ask(model, undefined, { maxTokens: 32000 });
    await ask(model, undefined, { maxTokens: 100000 });
    assert(requests.every(r => r.body.model === 'glm-5.2'));
    assert.deepEqual(requests.map(r => r.body.max_tokens), [64000, 32000, 64000]);
  });
});

test('all advertised models reflect the implemented text-only transport', () => {
  assert(GIGACHAT_MODELS.every(model => !model.input.includes('image')));
});

test('unsupported images in history become visible placeholders rather than disappearing', async () => {
  await withServer(async ({ model, requests }) => {
    await ask(model, { messages: [user([{ type: 'image', data: 'AA==', mimeType: 'image/png' }])] });
    const userMessages = requests[0].body.messages.filter(m => m.role === 'user');
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0].content, /image omitted/i);
  });
});

test('provider env overrides, custom headers and response hook reach the HTTP boundary', async () => {
  await withServer(async ({ model, requests, baseUrl }) => {
    let response;
    const result = await ask({ ...model, baseUrl: 'http://127.0.0.1:1/unused', headers: { 'X-Model-Header': 'model' } }, undefined, {
      env: { GIGACHAT_BASE_URL: baseUrl, GIGACHAT_ACCESS_TOKEN: 'scoped.synthetic.token' },
      headers: { 'X-Request-Header': 'request' },
      onResponse(value) { response = value; },
    });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].headers.authorization, 'Bearer scoped.synthetic.token');
    assert.equal(requests[0].headers['x-model-header'], 'model');
    assert.equal(requests[0].headers['x-request-header'], 'request');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
  });
});

test('explicit request timeout is honored while waiting for a non-streaming completion', async () => {
  await withServer(async ({ model }) => {
    const result = await ask(model, undefined, { timeoutMs: 25, maxRetries: 0 });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /timeout/i);
  }, async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 150)); json(res, completion()); });
});

test('unknown finish reasons do not masquerade as successful completions', async () => {
  await withServer(async ({ model }) => {
    const result = await ask(model);
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /unexpected_reason/);
  }, (_req, res) => json(res, completion(undefined, 'unexpected_reason')));
});

test('documented cached usage counts the full context, not just billable tokens', async () => {
  await withServer(async ({ model }) => {
    const result = await ask(model);
    assert.deepEqual([result.usage.input, result.usage.cacheRead, result.usage.output, result.usage.totalTokens], [1, 37, 4, 42]);
  }, (_req, res) => json(res, completion(undefined, 'stop', { prompt_tokens: 1, precached_prompt_tokens: 37, completion_tokens: 4, total_tokens: 5 })));
});

test('session affinity uses X-Session-ID and cacheRetention:none suppresses automatic affinity', async () => {
  await withServer(async ({ model, requests }) => {
    await ask(model, undefined, { sessionId: 'session-fixture' });
    await ask(model, undefined, { sessionId: 'summary-fixture', cacheRetention: 'none' });
    assert.equal(requests[0].headers['x-session-id'], 'session-fixture');
    assert.equal(requests[1].headers['x-session-id'], undefined);
    assert.match(requests[0].headers['user-agent'], /pi-gigachat/);
  });
});

test('requests without pi tools explicitly disable built-in GigaChat functions', async () => {
  await withServer(async ({ model, requests }) => {
    await ask(model);
    assert.equal(requests[0].body.function_call, 'none');
  });
});

test('GigaChat top_p and response_format are forwarded without changing model sampling defaults', async () => {
  const responseFormat = { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, strict: true };
  await withServer(async ({ model, requests }) => {
    await ask(model);
    await ask(model, undefined, { topP: 0.5, responseFormat });
    assert.equal(requests[0].body.temperature, undefined);
    assert.equal(requests[0].body.top_p, undefined);
    assert.equal(requests[1].body.top_p, 0.5);
    assert.deepEqual(requests[1].body.response_format, responseFormat);
  });
});

test('tool result content is a serialized JSON object with an explicit error status', async () => {
  await withServer(async ({ model, requests }) => {
    const previous = await ask(model);
    const call = { type: 'toolCall', id: 'result-shape', name: 'read', arguments: {} };
    previous.content = [call]; previous.stopReason = 'toolUse';
    await ask(model, { messages: [user('read'), previous, { ...toolResult(call, 'File unavailable'), isError: true }] });
    const result = JSON.parse(requests.at(-1).body.messages.at(-1).content);
    assert.equal(typeof result, 'object');
    assert.equal(result.isError, true);
    assert.match(result.result, /File unavailable/);
  });
});

test('parallel summaries share a serialized client to respect the personal API concurrency limit', async () => {
  let active = 0;
  let maximum = 0;
  await withServer(async ({ model }) => {
    const results = await Promise.all([ask(model), ask(model)]);
    assert(results.every(result => result.stopReason === 'stop'));
    assert.equal(maximum, 1);
  }, async (_req, res) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 35));
    active--;
    json(res, completion());
  });
});

test('cancelling a queued request returns immediately and never sends it later', async () => {
  const controller = new AbortController();
  await withServer(async ({ model, requests }) => {
    const first = ask(model);
    const second = ask(model, undefined, { signal: controller.signal });
    const result = await second;
    assert.equal(result.stopReason, 'aborted');
    assert.equal(requests.length, 1);
    await first;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.length, 1);
  }, async (_req, res) => {
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 80));
    json(res, completion());
  });
});
