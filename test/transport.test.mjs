import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { ask, completion, json, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];

test('onResponse observes HTTP errors before their bodies become diagnostics', async () => {
  await withServer(async ({ model }) => {
    let observed;
    const result = await ask(model, undefined, { onResponse(response) { observed = response; } });
    assert.equal(result.stopReason, 'error');
    assert.equal(observed.status, 429);
    assert.equal(observed.headers['retry-after'], '5');
    assert.match(result.errorMessage, /429.*rate limit/);
  }, (_req, res) => { res.setHeader('Retry-After', '5'); json(res, { message: 'rate limit' }, 429); });
});

test('case-insensitive request headers override defaults and null removes a model header', async () => {
  await withServer(async ({ model, requests }) => {
    const result = await ask({ ...model, headers: { 'X-Test': 'model', 'X-Remove': 'remove' } }, undefined, { headers: { 'x-test': 'request', 'x-remove': null, 'user-agent': 'test-client' } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].headers['x-test'], 'request');
    assert.equal(requests[0].headers['x-remove'], undefined);
    assert.equal(requests[0].headers['user-agent'], 'test-client');
  });
});

test('JSON-encoded function arguments are decoded once without changing escapes', async () => {
  const args = { content: 'literal \\n and actual\nline; 🙂', nested: { value: true } };
  await withServer(async ({ model }) => {
    const result = await ask(model);
    assert.equal(result.stopReason, 'toolUse', result.errorMessage);
    assert.deepEqual(result.content[0].arguments, args);
  }, (_req, res) => json(res, completion({ role: 'assistant', content: '', function_call: { name: 'write', arguments: JSON.stringify(args) } }, 'function_call')));
});

test('scoped proxy settings override ambient lowercase variables and NO_PROXY bypasses the proxy', async () => {
  const original = process.env.http_proxy;
  let forwarded = 0;
  const proxy = createServer((req, res) => {
    forwarded++;
    const target = new URL(req.url);
    assert.equal(target.hostname, '127.0.0.1');
    const upstream = request(target, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    req.pipe(upstream);
    upstream.on('error', error => res.destroy(error));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  process.env.http_proxy = 'http://127.0.0.1:1';
  try {
    await withServer(async ({ model }) => {
      const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' };
      const proxied = await ask(model, undefined, { env, timeoutMs: 5000 });
      assert.equal(proxied.stopReason, 'stop', proxied.errorMessage);
      assert.equal(forwarded, 1);
      const direct = await ask(model, undefined, { env: { ...env, NO_PROXY: '127.0.0.1' }, timeoutMs: 5000 });
      assert.equal(direct.stopReason, 'stop', direct.errorMessage);
      assert.equal(forwarded, 1);
    });
  } finally {
    if (original === undefined) delete process.env.http_proxy; else process.env.http_proxy = original;
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
});
