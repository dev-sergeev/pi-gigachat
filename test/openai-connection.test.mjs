import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryModelsStore, retryAssistantCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConnectionStore, createConnectionProvider, prepareConnectionCredential } from '../dist/connections.js';
import { completion, json, reply, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const context = { messages: [user('Hello')] };
const signal = () => new AbortController().signal;
const interaction = () => ({ signal: signal(), prompt: async () => { throw new Error('Unexpected secret prompt'); }, notify() {} });
const chunk = (delta, finish_reason = null, usage) => ({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
const data = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const begin = res => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const end = (res, value = chunk({}, 'stop')) => res.end(data(value) + data('[DONE]'));
const toolResult = (call, text) => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
  content: [{ type: 'text', text }], isError: false, timestamp: 0 });

async function withSavedConnection(baseUrl, run, changes = {}, secret = 'saved-openai-token') {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-openai-connection-'));
  try {
    const authPath = join(directory, 'auth.json');
    const entry = { id: 'gigachat-openai-fixture', revision: 'fixture-revision', name: 'OpenAI fixture', baseUrl,
      protocol: 'openai', authorization: { type: 'token' },
      models: [{ id: 'shared-model', name: 'Shared model', contextWindow: 32000, maxTokens: 1000, reasoning: true }],
      ...changes };
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(entry, secret, signal()), interaction());
    const restored = (await new ConnectionStore(authPath).list())[0].gigachatConnection;
    const models = await ModelRuntime.create({ authPath, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    models.registerNativeProvider(createConnectionProvider(restored, store));
    return await run({ models, model: models.getModel(restored.id, 'shared-model'), authPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const streaming of [false, true]) for (const authorization of ['token', 'credentials']) {
  test(`saved OpenAI ${authorization} preserves repeated-name tool calls, reasoning and correlated follow-up (stream=${streaming})`, async () => {
    const thought = ' \nCompare two files 🙂.\t ';
    const args = [{ path: 'first🙂.txt', line: 1 }, { path: 'second.txt', line: 2 }];
    await withServer(async ({ baseUrl, requests }) => {
      await withSavedConnection(baseUrl, async ({ models, model }) => {
        const options = { env: { GIGACHAT_STREAM: String(streaming) }, reasoning: 'medium', maxRetries: 0 };
        const stream = models.streamSimple(model, { messages: [user('Read both files')], tools: [
          { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' } }, required: ['path'] } },
        ] }, options);
        const events = [];
        for await (const event of stream) events.push(event.type);
        const first = await stream.result();
        assert.equal(first.stopReason, 'toolUse', first.errorMessage);
        assert.equal(first.content.find(block => block.type === 'thinking').thinking, thought);
        const calls = first.content.filter(block => block.type === 'toolCall');
        assert.deepEqual(calls.map(({ id, name, arguments: value }) => ({ id, name, value })), [
          { id: 'read-first', name: 'read', value: args[0] }, { id: 'read-second', name: 'read', value: args[1] },
        ]);
        assert.equal(events.filter(type => type === 'toolcall_start').length, 2);
        assert.equal(events.filter(type => type === 'toolcall_end').length, 2);
        assert.equal(events.at(-1), 'done');
        assert.deepEqual([first.usage.input, first.usage.cacheRead, first.usage.output, first.usage.totalTokens], [1, 37, 4, 42]);
        const history = { messages: [user('Read both files'), first,
          toolResult({ id: 'orphan', name: 'read' }, 'unmatched'), toolResult(calls[1], 'second result'),
          toolResult(calls[0], 'first result'), toolResult(calls[1], 'duplicate result'), user('Summarize')] };
        const saved = structuredClone(history);
        const followup = await models.completeSimple(model, history, options);
        assert.equal(followup.stopReason, 'stop', followup.errorMessage);
        assert.deepEqual(history, saved, 'Wire conversion must not mutate saved reasoning or tool history');
        const chat = requests.filter(request => request.url.endsWith('/chat/completions'));
        assert.deepEqual(chat.map(request => request.headers.authorization), Array(2).fill(authorization === 'token' ? 'Bearer saved-openai-token' : 'Bearer exchanged-openai-token'));
        const messages = chat[1].body.messages;
        assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user', 'user']);
        assert.equal(messages[1].content, `${thought}\n\nReading both`);
        assert.deepEqual(messages[1].tool_calls.map(call => call.id), ['read-first', 'read-second']);
        assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]),
          [['read-second', 'second result'], ['read-first', 'first result']]);
        assert(!messages.some(message => Object.hasOwn(message, 'reasoning_content')));
      }, authorization === 'credentials' ? { authorization: { type: 'credentials', tokenUrl: baseUrl + '/oauth', scope: 'GIGACHAT_API_PERS' } } : {});
    }, (request, res, requests) => {
      if (request.url.endsWith('/oauth')) return json(res, { access_token: 'exchanged-openai-token', expires_at: Date.now() + 3600000 });
      if (requests.filter(value => value.url.endsWith('/chat/completions')).length > 1) return reply(request, res, completion());
      const usage = { prompt_tokens: 38, prompt_tokens_details: { cached_tokens: 37 }, completion_tokens: 4, total_tokens: 42 };
      if (!request.body.stream) return json(res, completion({ role: 'assistant', reasoning_content: thought, content: 'Reading both',
        tool_calls: args.map((value, index) => ({ id: index ? 'read-second' : 'read-first', type: 'function', function: { name: 'read', arguments: JSON.stringify(value) } })) }, 'tool_calls', usage));
      begin(res);
      res.write(data(chunk({ reasoning_content: thought })));
      res.write(data(chunk({ content: 'Reading both' })));
      res.write(data(chunk({ tool_calls: args.map((_value, index) => ({ index, id: index ? 'read-second' : 'read-first', type: 'function', function: { name: 'read', arguments: '{"path":' } })) })));
      res.write(data(chunk({ tool_calls: [{ index: 1, function: { arguments: '"second.txt","line":2}' } }] })));
      res.write(data(chunk({ tool_calls: [{ index: 0, function: { arguments: '"first🙂.txt","line":1}' } }] })));
      res.write(data(chunk({}, 'tool_calls')));
      res.end(data({ choices: [], usage }) + data('[DONE]'));
    });
  });
}

for (const streaming of [false, true]) test(`OpenAI observer failure cannot be retried or normalize rejected output (stream=${streaming})`, async () => {
  await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    let observations = 0;
    const result = await retryAssistantCall(() => models.completeSimple(model, context, {
      maxRetries: 2, env: { GIGACHAT_STREAM: String(streaming), GIGACHAT_RETRY_BASE_DELAY_MS: '0' },
      onProviderStreamEvent: async () => {
        observations++;
        await new Promise(resolve => setImmediate(resolve));
        throw Object.assign(new Error('Observer refused: fetch failed'), { code: 'ECONNRESET' });
      },
    }), { enabled: true, maxRetries: 2, baseDelayMs: 0 });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Observer refused/);
    assert.equal(observations, 1);
    assert.deepEqual(result.content, []);
    assert.equal(requests.length, 1);
  }), (request, res) => reply(request, res, completion()));
});

for (const streaming of [false, true]) test(`OpenAI cancellation during an awaited observer cannot admit late content (stream=${streaming})`, async () => {
  let entered;
  let release;
  const observing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    const stream = models.streamSimple(model, context, { signal: controller.signal, env: { GIGACHAT_STREAM: String(streaming) },
      onProviderStreamEvent: async () => { entered(); await gate; } });
    await observing;
    controller.abort();
    const result = await stream.result();
    assert.equal(result.stopReason, 'aborted');
    assert.deepEqual(result.content, []);
    assert.equal(requests.length, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(result.content, []);
  }), (request, res) => reply(request, res, completion()));
});

test('saved OpenAI split-turn summaries can generate concurrently with pre-resolved native auth', { timeout: 10000 }, async () => {
  const pending = [];
  await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    const { auth } = await models.getAuth(model);
    const results = await Promise.all(['First summary', 'Second summary'].map(prompt => models.completeSimple(model,
      { systemPrompt: 'Summarize the conversation', messages: [user(prompt)] }, { apiKey: auth.apiKey, timeoutMs: 1000, maxRetries: 0 })));
    for (const result of results) assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.body.messages.at(-1).content).sort(), ['First summary', 'Second summary']);
  }), (_request, res) => {
    pending.push(res);
    if (pending.length === 2) for (const response of pending) json(response, completion());
  });
});

for (const body of [{ error: 'EventException', message: 'bad generation' }, { error: 'ValidationException', message: 'bad input' }]) {
  test(`OpenAI ${body.error} 422 is terminal without V1 recovery`, async () => {
    await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
      const result = await models.completeSimple(model, context, { maxRetries: 2, env: { GIGACHAT_RETRY_BASE_DELAY_MS: '0' } });
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /HTTP 422/);
      assert.equal(requests.length, 1);
    }), (_request, res) => json(res, body, 422));
  });
}

test('native OpenAI tool disabling takes precedence over a legacy forced function', async () => {
  await withServer(async ({ baseUrl }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    const result = await models.completeSimple(model, {
      messages: [user('Do not call any tools')],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    }, { functionCall: { name: 'read' }, toolChoice: 'none', maxRetries: 0 });
    assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'A disabled tool must not be called');
    assert.deepEqual(result.content, [{ type: 'text', text: 'Tools disabled.' }]);
  }), (request, res) => json(res, request.body.tool_choice === 'none'
    ? completion({ role: 'assistant', content: 'Tools disabled.' })
    : completion({ role: 'assistant', content: '', tool_calls: [
      { id: 'unwanted-read', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] }, 'tool_calls')));
});

test('OpenAI 422 load diagnostics cannot trigger the native outer retry loop', async () => {
  await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    const result = await retryAssistantCall(
      () => models.completeSimple(model, context, { maxRetries: 2, env: { GIGACHAT_RETRY_BASE_DELAY_MS: '0' } }),
      { enabled: true, maxRetries: 2, baseDelayMs: 0 },
    );
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /HTTP 422.*overloaded/);
    assert.equal(requests.length, 1);
  }), (_request, res) => json(res, { error: 'EventException', message: 'overloaded upstream internal server error' }, 422));
});

test('OpenAI structured response options use a valid named JSON schema without changing the shared option', async () => {
  const responseFormat = { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, strict: true };
  const saved = structuredClone(responseFormat);
  await withServer(async ({ baseUrl, requests }) => withSavedConnection(baseUrl, async ({ models, model }) => {
    const result = await models.completeSimple(model, context, { responseFormat });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const wire = requests[0].body.response_format;
    assert.equal(wire.type, 'json_schema');
    assert.equal(typeof wire.json_schema.name, 'string');
    assert(wire.json_schema.name.length > 0);
    assert.deepEqual(wire.json_schema.schema, responseFormat.schema);
    assert.equal(wire.json_schema.strict, true);
    assert.deepEqual(responseFormat, saved);
  }));
});

test('saved OpenAI mTLS authenticates JSON and SSE with the client certificate and no bearer header', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-openai-tls-'));
  let server;
  try {
    const keyPath = join(directory, 'fixture-key.pem');
    const certPath = join(directory, 'fixture-cert.pem');
    const configPath = join(directory, 'fixture.cnf');
    await writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nextendedKeyUsage=serverAuth,clientAuth\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-config', configPath], { stdio: 'ignore' });
    const cert = await readFile(certPath, 'utf8');
    const key = await readFile(keyPath, 'utf8');
    const requests = [];
    server = createHttpsServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
      const buffers = [];
      for await (const part of req) buffers.push(part);
      const request = { body: JSON.parse(Buffer.concat(buffers).toString()), authorization: req.headers.authorization,
        authorized: req.socket.authorized, peer: req.socket.getPeerCertificate().subject.CN };
      requests.push(request);
      reply(request, res, completion({ role: 'assistant', content: 'Certificate accepted' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `https://127.0.0.1:${server.address().port}/v1`;
    await withSavedConnection(baseUrl, async ({ models, model, authPath }) => {
      for (const streaming of [false, true]) {
        const result = await models.completeSimple(model, context, { maxRetries: 0, env: { GIGACHAT_STREAM: String(streaming) },
          apiKey: 'must-not-be-sent', headers: { Authorization: 'Bearer must-also-not-be-sent' } });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        assert.equal(result.content[0].text, 'Certificate accepted');
      }
      assert.deepEqual(requests.map(({ authorization, authorized, peer }) => ({ authorization, authorized, peer })),
        Array.from({ length: 2 }, () => ({ authorization: undefined, authorized: true, peer: 'localhost' })));
      const credential = Object.values(JSON.parse(await readFile(authPath, 'utf8')))[0];
      assert.equal(credential.key, undefined);
      assert.equal(credential.env, undefined);
    }, { authorization: { type: 'mtls', materials: { ca: cert, cert, key } } }, '');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
