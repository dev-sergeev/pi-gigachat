import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { describeDiscoveryError, discoverModels } from '../dist/discovery.js';

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

// The public discovery call and actual HTTP requests are the seam: one paid
// generation per exact server Model ID, not per catalog row or display name.
test('deduplicates exact Model IDs before serial one-token probes and accepts truncated empty completions', async () => {
  let active = 0;
  let peak = 0;
  await withServer(async (req, res) => {
    if (req.method === 'GET') return json(res, { data: [
      { id: 'Exact', name: 'First\u001b[31m name', context_window: 8192, max_output_tokens: 256, reasoning: false },
      { id: 'Exact', name: 'Duplicate' },
      { id: 'exact', name: 'First name' },
      { id: '' }, { id: 'bad\nmodel' }, { name: 'No ID' },
    ] });
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
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
    assert.deepEqual(progress, [[0, 2, undefined], [1, 2, 'Exact'], [2, 2, 'exact']]);
    assert.equal(peak, 1);
    assert.deepEqual(requests.map(req => req.url), ['/v1/models', '/v1/chat/completions', '/v1/chat/completions']);
    for (const req of requests) assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(requests.slice(1).map(req => req.body), ['Exact', 'exact'].map(model => ({
      model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false,
    })));
  });
});

test('keeps partial successes and distinguishes denied models from temporary HTTP and network failures without retries', async () => {
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
      'available', 'unavailable', 'unavailable', 'unverified', 'unverified', 'unverified', 'available',
    ]);
    assert.deepEqual(reported, probes);
    assert.deepEqual(requests.filter(req => req.method === 'POST').map(req => req.body.model), ids);
    assert.match(probes[1].reason, /403.*denied/i);
    assert.match(probes[3].reason, /429.*rate/i);
    assert.match(probes[4].reason, /503.*temporar/i);
    assert.match(probes[5].reason, /network/i);
    assert.ok(probes.every(probe => !probe.reason?.includes(secret)));
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

test('malformed completions remain unverified and do not prevent later successful probes', async () => {
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
    assert.deepEqual(probes.map(probe => probe.status), [...malformed.map(() => 'unverified'), 'available']);
    for (const probe of probes.slice(0, -1)) {
      assert.match(probe.reason, /invalid response/i);
      assert.ok(!probe.reason.includes(secret));
    }
    assert.equal(requests.length, malformed.length + 2);
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

test('cancellation from partial progress preserves reported success but never probes remaining models', async () => {
  await withServer((req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'one' }, { id: 'two' }] });
    json(res, completion());
  }, async ({ baseUrl, requests }) => {
    const controller = new AbortController();
    const reason = new Error('cancel after first probe');
    const reported = [];
    await assert.rejects(discoverModels(baseUrl, secret, {
      signal: controller.signal,
      progress: (completed, _total, probe) => {
        if (completed === 1) { reported.push(probe); controller.abort(reason); }
      },
    }), error => error === reason);
    assert.deepEqual(reported.map(probe => [probe.model.id, probe.status]), [['one', 'available']]);
    assert.deepEqual(requests.filter(req => req.method === 'POST').map(req => req.body.model), ['one']);
  });
});

for (const phase of ['catalog', 'probe']) {
  test(`cancelling an in-flight ${phase} propagates cancellation without an error status row`, async () => {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${phase}`);
    await withServer((req, res) => {
      if (req.method === 'GET' && phase === 'probe') return json(res, { data: [{ id: 'one' }, { id: 'two' }] });
      controller.abort(reason);
      // Leave the response open: abort must interrupt transport consumption.
    }, async ({ baseUrl, requests }) => {
      const reported = [];
      await assert.rejects(discoverModels(baseUrl, secret, {
        signal: controller.signal,
        progress: (_completed, _total, probe) => { if (probe) reported.push(probe); },
      }), error => error === reason);
      assert.deepEqual(reported, []);
      assert.equal(requests.length, phase === 'catalog' ? 1 : 2);
    });
  });
}

test('a timed-out paid probe is unverified and later models still run', async () => {
  const original = process.env.GIGACHAT_TIMEOUT;
  process.env.GIGACHAT_TIMEOUT = '0.2';
  try {
    await withServer((req, res) => {
      if (req.method === 'GET') return json(res, { data: [{ id: 'slow' }, { id: 'good' }] });
      if (req.body.model === 'good') json(res, completion());
    }, async ({ baseUrl, requests }) => {
      const probes = await discoverModels(baseUrl, secret, { signal: new AbortController().signal });
      assert.deepEqual(probes.map(probe => probe.status), ['unverified', 'available']);
      assert.match(probes[0].reason, /timed out/i);
      assert.deepEqual(requests.filter(req => req.method === 'POST').map(req => req.body.model), ['slow', 'good']);
    });
  } finally {
    if (original === undefined) delete process.env.GIGACHAT_TIMEOUT;
    else process.env.GIGACHAT_TIMEOUT = original;
  }
});
