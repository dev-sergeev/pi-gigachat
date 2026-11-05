import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Response as UndiciResponse } from 'undici';
import { describeDiscoveryError, discoverModels } from '../dist/discovery.js';
import { chooseModels } from '../dist/gigachat-dialogs.js';

for (const key of Object.keys(process.env)) {
  if (/^(GIGACHAT_|https?_proxy$|HTTPS?_PROXY$|ALL_PROXY$|all_proxy$)/.test(key)) delete process.env[key];
}

const secret = 'synthetic-discovery-secret';
const completion = (content = 'OK', finish_reason = 'stop') => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
});
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function withServer(respond, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const request = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    try { await respond(request, res, requests); }
    catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

// The public discovery call and actual HTTP requests are the seam: probes are
// scoped to each exact server Model ID, not catalog rows or display names.
test('deduplicates exact Model IDs before one-token probes and accepts truncated empty completions', async () => {
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [
      { id: 'Exact', name: 'First\u001b[31m name', context_window: 8192, max_output_tokens: 256, reasoning: false },
      { id: 'Exact', name: 'Duplicate' },
      { id: 'exact', name: 'First name' },
      { id: '' }, { id: 'bad\nmodel' }, { name: 'No ID' },
    ] });
    json(res, completion('', 'length'));
  }, async ({ baseUrl, requests }) => {
    const progress = [];
    const probes = await discoverModels(`${baseUrl}///`, secret, {
      signal: new AbortController().signal,
      progress: (completed, total, probe) => progress.push([completed, total, probe?.model.id]),
    });
    assert.deepEqual(probes.map(probe => [probe.model.id, probe.status]), [['Exact', 'available'], ['exact', 'available']]);
    assert.equal(probes[0].model.name, 'First name');
    assert.equal(probes[0].model.contextWindow, 8192);
    assert.equal(probes[0].model.maxTokens, 256);
    assert.equal(probes[0].model.reasoning, false);
    assert.equal(probes[0].model.thinkingLevelMap, undefined);
    assert.deepEqual(progress.map(([completed, total]) => [completed, total]), [[0, 2], [1, 2], [2, 2]]);
    assert.deepEqual(progress.slice(1).map(([, , id]) => id).sort(), ['Exact', 'exact']);
    assert.deepEqual(requests.map(req => req.url), ['/v1/models', '/v1/chat/completions', '/v1/chat/completions']);
    for (const req of requests) assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(requests.slice(1).map(req => req.body), ['Exact', 'exact'].map(model => ({
      model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false,
    })));
  });
});

for (const protocol of ['v1', 'v2', 'openai']) {
  test(`${protocol} uses its catalog route independently from the generation endpoint and preserves an explicit full catalog URL`, async () => {
    await withServer((req, res) => {
      if (req.method === 'GET') return json(res, { data: [{ id: 'one', reasoning: true }] });
      json(res, protocol === 'v2'
        ? { messages: [{ role: 'assistant', content: [{ text: '' }] }], finish_reason: 'length' }
        : completion());
    }, async ({ baseUrl, requests }) => {
      const root = protocol === 'v2' ? baseUrl.replace('/v1', '/custom/v2') : baseUrl + '/custom';
      const options = { protocol, signal: new AbortController().signal };
      const probes = await discoverModels(root, secret, options);
      assert.equal(probes[0].status, 'available');
      if (protocol === 'v2') {
        assert.equal(probes[0].model.reasoning, false, 'V2 reasoning requires an explicit model edit');
        assert.equal(probes[0].model.thinkingLevelMap, undefined);
      }
      assert.equal(requests[0].url,
        { v1: '/v1/custom/models', v2: '/v1/models', openai: '/gc/models' }[protocol]);
      assert.equal(requests[1].url, new URL(root).pathname + '/chat/completions');
      assert.deepEqual(requests[1].body, protocol === 'v2'
        ? { model: 'one', messages: [{ role: 'user', content: [{ text: 'Hi' }] }], model_options: { max_tokens: 1 }, stream: false }
        : { model: 'one', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false });
      const custom = new URL('/independent/catalog?exact=1', baseUrl).href;
      const overridden = await discoverModels(root, secret, { ...options, modelsUrl: custom });
      assert.equal(overridden[0].status, 'available');
      assert.equal(requests[2].url, '/independent/catalog?exact=1');
      assert.equal(requests[3].url, requests[1].url);
      for (const request of requests) assert.equal(request.headers.authorization, `Bearer ${secret}`);
    });
  });
}

for (const protocol of ['v1', 'v2', 'openai']) {
  test(`${protocol} keeps five models in flight and refills each free slot without batching`, { timeout: 3000 }, async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `model-${index}`);
    const starts = ids.map(() => [Promise.withResolvers(), Promise.withResolvers()]);
    const reports = ids.map(() => Promise.withResolvers());
    const attempts = ids.map(() => 0);
    const active = new Map();
    const progress = [];
    let peak = 0;
    await withServer((req, res) => {
      if (req.method === 'GET') return json(res, { data: ids.map(id => ({ id })) });
      const index = ids.indexOf(req.body.model);
      assert.ok(!active.has(index), 'attempts of the same model must never overlap');
      active.set(index, res);
      peak = Math.max(peak, active.size);
      assert.ok(active.size <= 5);
      starts[index][attempts[index]++].resolve();
    }, async ({ baseUrl, requests }) => {
      const release = (index, status = 200) => {
        const res = active.get(index);
        active.delete(index);
        json(res, status === 200
          ? protocol === 'v2'
            ? { messages: [{ role: 'assistant', content: [{ text: 'OK' }] }], finish_reason: 'stop' }
            : completion()
          : { error: 'temporary' }, status);
      };
      const pending = discoverModels(baseUrl, secret, {
        protocol, signal: new AbortController().signal,
        progress: (_completed, _total, probe) => {
          if (probe) { progress.push(probe.model.id); reports[progress.length - 1].resolve(); }
        },
      });
      await Promise.all(starts.slice(0, 5).map(attempts => attempts[0].promise));
      await flush();
      assert.equal(requests.length, 6, 'only the initial five models may start');
      release(2, 503);
      await starts[2][1].promise;
      assert.equal(active.size, 5, 'a retry retains its model slot');
      assert.equal(attempts[5], 0);
      release(2);
      await starts[5][0].promise;
      assert.equal(active.size, 5, 'the sixth model starts while the other four are held');
      release(5);
      await starts[6][0].promise;
      assert.equal(active.size, 5, 'the seventh model also refills immediately');
      release(6);
      await reports[2].promise;
      for (const index of [0, 1, 3, 4]) release(index);
      const probes = await pending;
      assert.equal(peak, 5);
      assert.deepEqual(probes.map(probe => probe.model.id), ids);
      assert.ok(probes.every(probe => probe.status === 'available'));
      assert.deepEqual(progress.slice(0, 3), [ids[2], ids[5], ids[6]], 'progress follows completion, not catalog order');
      assert.deepEqual(attempts, [1, 1, 2, 1, 1, 1, 1], 'successful models never use their remaining attempts');
    });
  });

  for (const count of [0, 2]) {
    test(`${protocol} handles a catalog of ${count} models`, async () => {
      const ids = Array.from({ length: count }, (_, index) => `model-${index}`);
      await withServer((req, res) => {
        if (req.method === 'GET') return json(res, { data: ids.map(id => ({ id })) });
        json(res, protocol === 'v2'
          ? { messages: [{ role: 'assistant', content: [{ text: 'OK' }] }], finish_reason: 'stop' }
          : completion());
      }, async ({ baseUrl, requests }) => {
        const progress = [];
        const probes = await discoverModels(baseUrl, secret, {
          protocol, signal: new AbortController().signal,
          progress: (completed, total) => progress.push([completed, total]),
        });
        assert.deepEqual(probes.map(probe => probe.model.id), ids);
        assert.ok(probes.every(probe => probe.status === 'available'));
        assert.equal(requests.length, count + 1);
        assert.deepEqual(progress, Array.from({ length: count + 1 }, (_, completed) => [completed, count]));
      });
    });
  }
}

test('explicit catalogs may use another trusted origin with the same connection authorization', async () => {
  await withServer((_req, res) => json(res, { data: [{ id: 'remote-catalog-model' }] }), async catalogServer => {
    await withServer((_req, res) => json(res, completion()), async generationServer => {
      const modelsUrl = catalogServer.baseUrl + '/catalog?keep=query';
      const probes = await discoverModels(generationServer.baseUrl, secret, {
        protocol: 'openai', modelsUrl, signal: new AbortController().signal,
      });
      assert.equal(probes[0].status, 'available');
      assert.deepEqual(catalogServer.requests.map(request => request.url), ['/v1/catalog?keep=query']);
      assert.deepEqual(generationServer.requests.map(request => request.url), ['/v1/chat/completions']);
      assert.equal(catalogServer.requests[0].headers.authorization, `Bearer ${secret}`);
      assert.equal(generationServer.requests[0].headers.authorization, `Bearer ${secret}`);
    });
  });
});

test('unknown protocols, invalid full catalog URLs and either insecure mTLS endpoint reject before HTTP', async () => {
  await withServer((_req, res) => json(res, { data: [] }), async ({ baseUrl, requests }) => {
    const mtls = { ca: 'synthetic-ca', cert: 'synthetic-cert', key: 'synthetic-key' };
    for (const options of [
      { protocol: 'unknown' },
      { modelsUrl: 'file:///models' },
      { modelsUrl: '/relative/models' },
      { modelsUrl: '' },
      { protocol: 'v1', mtls, modelsUrl: 'https://catalog.invalid/models' },
      { protocol: 'v2', mtls },
      { protocol: 'openai', mtls },
    ]) {
      await assert.rejects(discoverModels(baseUrl, secret, { ...options, signal: new AbortController().signal }));
    }
    await assert.rejects(discoverModels('https://generation.invalid/v2', secret, {
      protocol: 'v2', mtls, modelsUrl: baseUrl + '/catalog', signal: new AbortController().signal,
    }), /HTTPS/);
    assert.equal(requests.length, 0);
  });
});

test('OpenAI probes accept modern multiple tool calls while rejecting malformed calls', async () => {
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'one' }, { id: 'two' }, { id: 'malformed' }] });
    json(res, { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'call-one', type: 'function', function: { name: 'read', arguments: '{}' } },
        { id: 'call-two', type: 'function', function: { name: 'read',
          arguments: req.body.model === 'malformed' ? {} : '{"path":"other"}' } },
      ],
    } }] });
  }, async ({ baseUrl, requests }) => {
    const probes = await discoverModels(baseUrl, secret, { protocol: 'openai', signal: new AbortController().signal });
    assert.deepEqual(probes.map(probe => probe.status), ['available', 'available', 'unavailable']);
    assert.equal(requests.filter(request => request.body?.model === 'malformed').length, 5);
  });
});

test('V2 probes validate native messages and finish reasons rather than V1 choices', async () => {
  const ids = ['native', 'v1-envelope', 'missing-finish', 'invalid-content', 'valid-calls'];
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: ids.map(id => ({ id })) });
    const responses = {
      native: { messages: [{ role: 'assistant', content: [{ text: 'OK' }] }], finish_reason: 'stop' },
      'v1-envelope': completion(),
      'missing-finish': { messages: [{ role: 'assistant', content: [{ text: 'OK' }] }] },
      'invalid-content': { messages: [{ role: 'assistant', content: 'OK' }], finish_reason: 'stop' },
      'valid-calls': { messages: [{ role: 'assistant', content: [
        { function_call: { id: 'one', name: 'read', arguments: { path: 'one' } } },
        { function_call: { id: 'two', name: 'read', arguments: { path: 'two' } } },
      ] }], finish_reason: 'function_call' },
    };
    json(res, responses[req.body.model]);
  }, async ({ baseUrl, requests }) => {
    const probes = await discoverModels(baseUrl.replace('/v1', '/v2'), secret, { protocol: 'v2', signal: new AbortController().signal });
    assert.deepEqual(probes.map(probe => probe.status), ['available', 'unavailable', 'unavailable', 'unavailable', 'available']);
    for (const probe of probes) {
      assert.equal(requests.filter(req => req.body?.model === probe.model.id).length, probe.status === 'available' ? 1 : 5);
    }
  });
});

test('discovery defaults missing or invalid metadata while preserving explicit server limits and reasoning', async () => {
  const cases = [
    { id: 'missing-metadata', expected: [262144, 64000, true] },
    { id: 'camel-case', contextWindow: 12288, maxTokens: 1536, reasoning: false, expected: [12288, 1536, false] },
    { id: 'snake-case', context_window: 8192, max_output_tokens: 256, reasoning: true, expected: [8192, 256, true] },
    { id: 'alternate-limits', context_length: 4096, max_tokens: 128, expected: [4096, 128, true] },
    { id: 'minimum-explicit-limits', contextWindow: 1, maxTokens: 1, reasoning: false, expected: [1, 1, false] },
    { id: 'invalid-limits', contextWindow: 0, context_window: -1, context_length: 2.5, maxTokens: '64', max_tokens: null, max_output_tokens: 0, reasoning: 'false', expected: [262144, 64000, true] },
    { id: 'valid-alias-after-invalid', contextWindow: 0, context_window: 6144, maxTokens: -1, max_output_tokens: 512, reasoning: null, expected: [6144, 512, true] },
  ];
  const thinkingLevelMap = { off: 'off', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: cases.map(({ expected, ...metadata }) => metadata) });
    json(res, completion());
  }, async ({ baseUrl, requests }) => {
    const probes = await discoverModels(baseUrl, secret, { signal: new AbortController().signal });
    assert.equal(probes.length, cases.length);
    for (const [index, probe] of probes.entries()) {
      const [contextWindow, maxTokens, reasoning] = cases[index].expected;
      assert.equal(probe.status, 'available');
      assert.deepEqual(probe.model, {
        id: cases[index].id, name: cases[index].id, contextWindow, maxTokens, reasoning,
        ...(reasoning ? { thinkingLevelMap } : {}),
      });
    }
    assert.deepEqual(requests.slice(1).map(req => [req.body.model, req.body.max_tokens]), cases.map(({ id }) => [id, 1]));
  });
});

test('refreshing model availability preserves selected saved parameters and gives new selections discovered defaults', async () => {
  const saved = [
    { id: 'saved-nonreasoning', name: 'Consumer-edited name', contextWindow: 16384, maxTokens: 777, reasoning: false, temperature: 0.2 },
    { id: 'saved-reasoning', name: 'Custom reasoning', contextWindow: 24576, maxTokens: 888, reasoning: true, temperature: 0.6,
      thinkingLevelMap: { off: 'none', minimal: null, low: 'light', medium: 'balanced', high: 'deep', xhigh: null, max: null } },
    { id: 'denied-model', name: 'Previously selected', contextWindow: 4096, maxTokens: 128, reasoning: false },
    { id: 'removed-model', name: 'No longer in catalog', contextWindow: 4096, maxTokens: 128, reasoning: false },
  ];
  const before = structuredClone(saved);
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [
      { id: 'saved-nonreasoning', name: 'Changed server name', context_window: 8192, max_output_tokens: 256, reasoning: true },
      { id: 'saved-reasoning', reasoning: false },
      { id: 'new-model' },
      { id: 'denied-model' },
    ] });
    if (req.body.model === 'denied-model') return json(res, { message: 'not permitted' }, 403);
    json(res, completion());
  }, async ({ baseUrl }) => {
    const probes = await discoverModels(baseUrl, secret, { signal: new AbortController().signal });
    const ctx = { ui: {
      custom: factory => new Promise(resolve => {
        const component = factory(
          { requestRender() {} },
          { fg: (_color, text) => text },
          { matches: (data, action) => data === 'confirm' && action === 'tui.select.confirm' },
          resolve,
        );
        component.handleInput('\x01');
        component.handleInput('confirm');
      }),
    } };
    const chosen = await chooseModels(ctx, probes, saved);
    assert.deepEqual(chosen, [saved[0], saved[1], probes[2].model]);
    assert.equal(chosen[0], saved[0]);
    assert.equal(chosen[1], saved[1]);
    assert.equal(chosen[2].contextWindow, 262144);
    assert.equal(chosen[2].maxTokens, 64000);
    assert.equal(chosen[2].reasoning, true);
    assert.deepEqual(saved, before, 'refreshing and selecting must not mutate saved metadata or parameters');
  });
});

test('keeps partial successes and exhausts five attempts for HTTP and network failures', async () => {
  const ids = ['good', 'denied', 'invalid', 'limited', 'server-down', 'network-down', 'last-good'];
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: ids.map(id => ({ id })) });
    switch (req.body.model) {
      case 'denied': return json(res, { error: `denied ${secret}` }, 403);
      case 'invalid': return json(res, { error: `unknown ${secret}` }, 400);
      case 'limited': return json(res, { error: `limited ${secret}` }, 429);
      case 'server-down': return json(res, { error: `broken ${secret}` }, 503);
      case 'network-down': return res.destroy();
      default: return json(res, completion());
    }
  }, async ({ baseUrl, requests }) => {
    const reported = [];
    const probes = await discoverModels(baseUrl, secret, {
      signal: new AbortController().signal,
      progress: (_completed, _total, probe) => { if (probe) reported.push(probe); },
    });
    assert.deepEqual(probes.map(probe => probe.status), [
      'available', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'available',
    ]);
    assert.deepEqual(reported.map(probe => probe.model.id).sort(), [...ids].sort());
    for (const id of ids) {
      assert.equal(requests.filter(req => req.body?.model === id).length, id.endsWith('good') ? 1 : 5);
    }
    assert.ok(probes.filter(probe => probe.status === 'unavailable').every(probe => /after 5 attempts/.test(probe.reason)));
    assert.match(probes[1].reason, /403.*denied/i);
    assert.match(probes[3].reason, /429.*rate/i);
    assert.match(probes[4].reason, /503.*temporar/i);
    assert.match(probes[5].reason, /network/i);
    assert.ok(probes.every(probe => !probe.reason?.includes(secret)));
  });
});

test('a model can recover on its third attempt after different errors without retry waits', { timeout: 3000 }, async () => {
  let attempts = 0;
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'recovering' }, { id: 'next' }] });
    if (req.body.model === 'next') return json(res, completion());
    attempts++;
    if (attempts === 1) return json(res, { error: 'denied' }, 403);
    if (attempts === 2) {
      res.writeHead(429, { 'Retry-After': '600' });
      return res.end('limited');
    }
    json(res, completion());
  }, async ({ baseUrl, requests }) => {
    const progress = [];
    const probes = await discoverModels(baseUrl, secret, {
      signal: new AbortController().signal,
      progress: (completed, total, probe) => progress.push([completed, total, probe?.status]),
    });
    assert.deepEqual(probes.map(probe => [probe.model.id, probe.status]), [
      ['recovering', 'available'], ['next', 'available'],
    ]);
    assert.deepEqual(requests.filter(req => req.body?.model === 'recovering').map(req => req.body.model),
      ['recovering', 'recovering', 'recovering']);
    assert.equal(requests.filter(req => req.body?.model === 'next').length, 1);
    assert.deepEqual(progress, [[0, 2, undefined], [1, 2, 'available'], [2, 2, 'available']]);
  });
});

for (const [label, list] of [
  ['missing data', { choices: [] }],
  ['non-array data', { data: { id: 'one' } }],
  ['only malformed entries', { data: [null, { id: 3 }, { id: '' }] }],
  ['broken JSON containing a secret', `{"data":${secret}`],
]) {
  test(`rejects a malformed catalog (${label}) before paid requests`, async () => {
    await withServer((_req, res) => {
      if (typeof list === 'string') { res.end(list); return; }
      json(res, list);
    }, async ({ baseUrl, requests }) => {
      let failure;
      await assert.rejects(discoverModels(baseUrl, secret, { signal: new AbortController().signal }), error => {
        failure = error;
        return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.match(describeDiscoveryError(failure), /invalid response/i);
      assert.ok(!describeDiscoveryError(failure).includes(secret));
    });
  });
}

test('catalog HTTP failure rejects instead of returning or probing models and does not expose the body', async () => {
  await withServer((_req, res) => json(res, { error: `token ${secret}` }, 401), async ({ baseUrl, requests }) => {
    let failure;
    await assert.rejects(discoverModels(baseUrl, secret, { signal: new AbortController().signal }), error => {
      failure = error;
      return true;
    });
    assert.equal(requests.length, 1);
    assert.match(describeDiscoveryError(failure), /401.*token rejected/i);
    assert.ok(!describeDiscoveryError(failure).includes(secret));
  });
});

test('malformed completions exhaust their attempts without preventing later successful probes', async () => {
  const malformed = [
    { choices: [] },
    { choices: [{ message: { role: 'assistant', content: 'unfinished' } }] },
    { choices: [{ message: { role: 'assistant', content: 42 }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'user', content: 'not a completion' }, finish_reason: 'stop' }] },
    completion('', 'function_call'),
    `{"choices":${secret}`,
  ];
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [...malformed.map((_body, index) => ({ id: `bad-${index}` })), { id: 'good' }] });
    if (req.body.model === 'good') return json(res, completion(null, 'length'));
    const body = malformed[Number(req.body.model.slice(4))];
    if (typeof body === 'string') return res.end(body);
    json(res, body);
  }, async ({ baseUrl, requests }) => {
    const probes = await discoverModels(baseUrl, secret, { signal: new AbortController().signal });
    assert.deepEqual(probes.map(probe => probe.status), [...malformed.map(() => 'unavailable'), 'available']);
    for (const probe of probes.slice(0, -1)) {
      assert.match(probe.reason, /invalid response/i);
      assert.ok(!probe.reason.includes(secret));
    }
    assert.equal(requests.length, 32);
  });
});

test('pre-cancelled discovery sends no catalog or paid requests', async () => {
  await withServer((_req, res) => json(res, { data: [{ id: 'one' }] }), async ({ baseUrl, requests }) => {
    const controller = new AbortController();
    const reason = new Error('cancel before discovery');
    controller.abort(reason);
    await assert.rejects(discoverModels(baseUrl, secret, { signal: controller.signal }), error => error === reason);
    assert.equal(requests.length, 0);
  });
});

test('cancellation after catalog enumeration prevents the first paid probe', async () => {
  await withServer((_req, res) => json(res, { data: [{ id: 'one' }] }), async ({ baseUrl, requests }) => {
    const controller = new AbortController();
    const reason = new Error('cancel before first probe');
    await assert.rejects(discoverModels(baseUrl, secret, {
      signal: controller.signal,
      progress: () => controller.abort(reason),
    }), error => error === reason);
    assert.equal(requests.length, 1);
  });
});

for (const protocol of ['v1', 'v2', 'openai']) {
  test(`${protocol} cancellation from progress stops active and queued models without late reports`, { timeout: 3000 }, async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `model-${index}`);
    const ready = Promise.withResolvers();
    const responses = [];
    const controller = new AbortController();
    const reason = new Error('cancel after first probe');
    const reported = [];
    await withServer((req, res) => {
      if (req.method === 'GET') return json(res, { data: ids.map(id => ({ id })) });
      responses.push({ id: req.body.model, res });
      if (responses.length === 5) ready.resolve();
    }, async ({ baseUrl, requests }) => {
      const pending = discoverModels(baseUrl, secret, {
        protocol, signal: controller.signal,
        progress: (_completed, _total, probe) => {
          if (probe) { reported.push(probe); controller.abort(reason); }
        },
      });
      const rejected = assert.rejects(pending, error => error === reason);
      await ready.promise;
      const body = protocol === 'v2'
        ? { messages: [{ role: 'assistant', content: [{ text: 'OK' }] }], finish_reason: 'stop' }
        : completion();
      json(responses[0].res, body);
      await rejected;
      for (const { res } of responses.slice(1)) json(res, body);
      await flush();
      assert.deepEqual(reported.map(probe => [probe.model.id, probe.status]), [[responses[0].id, 'available']]);
      assert.equal(requests.length, 6, 'queued models and retries must not start after cancellation');
    });
  });
}

for (const phase of ['catalog', 'probe']) {
  test(`cancelling an in-flight ${phase} propagates cancellation without an error status row`, async () => {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${phase}`);
    await withServer((req, res, requests) => {
      if (req.method === 'GET' && phase === 'probe') return json(res, {
        data: Array.from({ length: 7 }, (_, index) => ({ id: `model-${index}` })),
      });
      if (phase === 'catalog' || requests.length === 6) controller.abort(reason);
      // Leave the response open: abort must interrupt transport consumption.
    }, async ({ baseUrl, requests }) => {
      const reported = [];
      await assert.rejects(discoverModels(baseUrl, secret, {
        signal: controller.signal,
        progress: (_completed, _total, probe) => { if (probe) reported.push(probe); },
      }), error => error === reason);
      assert.deepEqual(reported, []);
      await flush();
      assert.equal(requests.length, phase === 'catalog' ? 1 : 6);
    });
  });
}

for (const protocol of ['v1', 'v2', 'openai']) {
  test(`${protocol} uses exact 1/3/9/27/60-second body deadlines with virtual time, independent of generation settings`, { timeout: 3000 }, async t => {
    const original = process.env.GIGACHAT_TIMEOUT;
    process.env.GIGACHAT_TIMEOUT = '1';
    const reads = Array.from({ length: 5 }, () => Promise.withResolvers());
    const timers = [];
    let now = 0;
    let reading = 0;
    // AbortSignal.timeout uses internal timers, so virtualize that boundary directly.
    t.mock.method(AbortSignal, 'timeout', delay => {
      const controller = new AbortController();
      timers.push({ delay, deadline: now + delay, controller });
      return controller.signal;
    });
    const advance = milliseconds => {
      now += milliseconds;
      for (const timer of timers) {
        if (timer.deadline <= now && !timer.controller.signal.aborted)
          timer.controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError'));
      }
    };
    const originalJson = UndiciResponse.prototype.json;
    t.mock.method(UndiciResponse.prototype, 'json', function () {
      if (this.headers.has('x-test-slow')) reads[reading++].resolve();
      return originalJson.call(this);
    });
    try {
      await withServer((req, res) => {
        if (req.method === 'GET') return json(res, { data: [{ id: 'slow' }] });
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test-Slow': 'true' });
        res.write('{"unfinished":');
      }, async ({ baseUrl, requests }) => {
        const pending = discoverModels(baseUrl, secret, { protocol, signal: t.signal });
        for (const [index, delay] of [1000, 3000, 9000, 27000, 60000].entries()) {
          await reads[index].promise;
          assert.equal(timers.at(-1).delay, delay);
          assert.equal(requests.length, index + 2);
          advance(delay - 1);
          await flush();
          assert.equal(reading, index + 1, 'a fresh attempt must keep its entire deadline');
          assert.equal(requests.length, index + 2, 'no retry before the deadline');
          advance(1);
        }
        const probes = await pending;
        assert.equal(probes[0].status, 'unavailable');
        assert.match(probes[0].reason, /after 5 attempts.*timed out/i);
        assert.deepEqual(timers.map(timer => timer.delay), [1000, 1000, 3000, 9000, 27000, 60000]);
        assert.equal(requests.length, 6);
        advance(3600000);
        await flush();
        assert.equal(requests.length, 6);
      });
    } finally {
      if (original === undefined) delete process.env.GIGACHAT_TIMEOUT;
      else process.env.GIGACHAT_TIMEOUT = original;
    }
  });
}

test('cancelling during a retry stops remaining attempts and queued models without reporting unavailability', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const reason = new Error('cancel second attempt');
  const ready = Promise.withResolvers();
  const responses = new Map();
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, {
      data: Array.from({ length: 7 }, (_, index) => ({ id: `model-${index}` })),
    });
    if (responses.has(req.body.model)) return controller.abort(reason);
    responses.set(req.body.model, res);
    if (responses.size === 5) ready.resolve();
  }, async ({ baseUrl, requests }) => {
    const reported = [];
    const pending = discoverModels(baseUrl, secret, {
      signal: controller.signal,
      progress: (_completed, _total, probe) => { if (probe) reported.push(probe); },
    });
    const rejected = assert.rejects(pending, error => error === reason);
    await ready.promise;
    json(responses.get('model-0'), { error: 'temporary' }, 503);
    await rejected;
    await flush();
    assert.deepEqual(reported, []);
    assert.equal(requests.length, 7);
    assert.deepEqual(requests.filter(req => req.body?.model === 'model-0').map(req => req.body.model), ['model-0', 'model-0']);
    assert.ok(requests.filter(req => req.body).every(req => responses.has(req.body.model)));
  });
});
