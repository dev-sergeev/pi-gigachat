import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConnectionStore, createConnectionProvider, prepareConnectionCredential } from '../dist/connections.js';
import { completion, json, user, withServer } from './helpers.mjs';

const context = { messages: [user('Hello')] };
const signal = () => new AbortController().signal;
const interaction = () => ({ signal: signal(), prompt: async () => { throw new Error('Unexpected native secret prompt'); }, notify() {} });
const connection = (id, baseUrl, changes = {}) => ({
  id: 'gigachat-server-' + id, revision: 'revision-1', name: 'Same connection name', baseUrl,
  authorization: { type: 'token' },
  models: [{ id: 'shared-model', name: 'Shared model', contextWindow: 32000, maxTokens: 1000, reasoning: false }],
  ...changes,
});
async function withStorage(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-connections-'));
  try { return await run(join(directory, 'auth.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function runtime(authPath, connections) {
  const result = await ModelRuntime.create({ authPath, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  for (const entry of connections) result.registerNativeProvider(createConnectionProvider(entry, new ConnectionStore(authPath)));
  return result;
}
async function send(models, entry, modelId = 'shared-model', options) {
  return models.completeSimple(models.getModel(entry.id, modelId), context, options);
}
function successful(result) { assert.equal(result.stopReason, 'stop', result.errorMessage); }

// All requests cross native credential storage and provider dispatch, not a mock auth adapter.
test('same named server and Model ID remain independent across native save and restart', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    await writeFile(authPath, JSON.stringify({ unrelated: { type: 'api_key', key: 'keep-this-provider' } }));
    const first = connection('first', baseUrl);
    const second = connection('second', baseUrl);
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(first, 'Bearer !literal-token', signal()), interaction());
    await store.save(await prepareConnectionCredential(second, '$literal-token', signal()), interaction());
    const restarted = await new ConnectionStore(authPath).list();
    assert.deepEqual(restarted.map(entry => entry.gigachatConnection.id).sort(), [first.id, second.id].sort());
    const models = await runtime(authPath, restarted.map(entry => entry.gigachatConnection));
    successful(await send(models, first));
    successful(await send(models, second));
    assert.deepEqual(requests.map(request => request.headers.authorization), ['Bearer !literal-token', 'Bearer $literal-token']);
    assert.deepEqual(requests.map(request => request.body.model), ['shared-model', 'shared-model']);
    assert.match(models.getModel(first.id, 'shared-model').name, /Same connection name/);
    const saved = JSON.parse(await readFile(authPath, 'utf8'));
    assert.deepEqual(saved.unrelated, { type: 'api_key', key: 'keep-this-provider' });
    assert.equal(saved[first.id].key, undefined);
    assert.equal(saved[first.id].env.GIGACHAT_ACCESS_TOKEN, '!literal-token');
  }));
});

test('native pre-resolved bearer authentication keeps private credentials and rejects stale overrides before HTTP', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    const tokenProfile = connection('bearer-token', baseUrl);
    const oauthProfile = connection('bearer-oauth', baseUrl, {
      authorization: { type: 'credentials', tokenUrl: baseUrl + '/oauth/', scope: 'GIGACHAT_API_PERS' },
    });
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(tokenProfile, '$literal-profile-token', signal()), interaction());
    await store.save(await prepareConnectionCredential(oauthProfile, 'oauth-authorization-key', signal()), interaction());
    const models = await runtime(authPath, [tokenProfile, oauthProfile]);
    for (const entry of [tokenProfile, oauthProfile]) {
      const { auth } = await models.getAuth(models.getModel(entry.id, 'shared-model'));
      successful(await send(models, entry, 'shared-model', { apiKey: auth.apiKey,
        env: { GIGACHAT_ACCESS_TOKEN: 'unrelated-legacy-token', GIGACHAT_BASE_URL: 'http://invalid.example' } }));
      const credential = (await store.list()).find(value => value.gigachatConnection.id === entry.id);
      await store.save({ ...credential, gigachatConnection: { ...entry, revision: 'changed-bearer-revision' } }, interaction());
      const before = requests.length;
      const rejected = await send(models, entry, 'shared-model', { apiKey: auth.apiKey });
      assert.equal(rejected.stopReason, 'error');
      assert.match(rejected.errorMessage, /\/gigachat.*restart/i);
      assert.equal(requests.length, before, 'A pre-resolved key cannot bypass saved revision checks');
    }
    assert.deepEqual(requests.filter(request => request.url.endsWith('/chat/completions')).map(request => request.headers.authorization),
      ['Bearer $literal-profile-token', 'Bearer oauth-access-token']);
  }, (request, res) => json(res, request.url.endsWith('/oauth/')
    ? { access_token: 'oauth-access-token', expires_at: Date.now() + 1800000 } : completion())));
});

for (const mode of ['token', 'credentials']) {
  test(`a stale ${mode} revision refuses HTTP until the native provider is re-registered`, async () => {
    await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
      const original = connection('stale-' + mode, baseUrl, {
        authorization: mode === 'token' ? { type: 'token' } : { type: 'credentials', tokenUrl: baseUrl + '/custom/oauth?audience=test', scope: 'GIGACHAT_API_B2B' },
      });
      const store = new ConnectionStore(authPath);
      const prior = await prepareConnectionCredential(original, 'original-secret', signal());
      await store.save(prior, interaction());
      const models = await runtime(authPath, [original]);
      const retained = models.getModel(original.id, 'shared-model');
      const updated = { ...original, revision: 'revision-2', name: 'Renamed connection',
        models: [{ ...original.models[0], contextWindow: 64000, maxTokens: 2000 }] };
      const next = await prepareConnectionCredential(updated, 'original-secret', signal(), prior);
      assert.equal(requests.length, mode === 'credentials' ? 1 : 0, 'Label/model edits must not exchange an unexpired token');
      await store.save(mode === 'credentials' ? { ...next, expires: 0 } : next, interaction());
      const before = requests.length;
      const rejected = await models.completeSimple(retained, context);
      assert.equal(rejected.stopReason, 'error');
      assert.match(rejected.errorMessage, /\/gigachat.*restart/i);
      assert.equal(requests.length, before, 'A stale revision must fail before token renewal or generation');
      models.registerNativeProvider(createConnectionProvider(updated, store));
      successful(await send(models, updated));
      assert.equal(requests.length - before, mode === 'credentials' ? 2 : 1);
      assert.equal(requests.at(-1).body.max_tokens, 2000);
      assert.equal(requests.at(-1).body.model, 'shared-model');
    }, (request, res) => json(res, request.url.includes('/custom/oauth')
      ? { access_token: 'renewed-token', expires_at: Date.now() + 1800000 } : completion())));
  });
}

test('deselected retained models cannot generate after fresh registration', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    const original = connection('selection', baseUrl);
    original.models.push({ ...original.models[0], id: 'remaining-model', name: 'Remaining model' });
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(original, 'selection-token', signal()), interaction());
    const models = await runtime(authPath, [original]);
    const retained = models.getModel(original.id, 'shared-model');
    const updated = { ...original, revision: 'revision-2', models: [original.models[1]] };
    await store.save(await prepareConnectionCredential(updated, 'selection-token', signal()), interaction());
    models.registerNativeProvider(createConnectionProvider(updated, store));
    assert.equal(models.getModel(updated.id, 'shared-model'), undefined);
    const rejected = await models.completeSimple(retained, context);
    assert.equal(rejected.stopReason, 'error');
    assert.match(rejected.errorMessage, /\/gigachat/);
    assert.equal(requests.length, 0);
    successful(await send(models, updated, 'remaining-model'));
    assert.equal(requests[0].body.model, 'remaining-model');
  }));
});

test('native deletion cannot fall back to ambient tokens and preserves other credentials', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    const first = connection('deleted', baseUrl);
    const second = connection('surviving', baseUrl);
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(first, 'deleted-token', signal()), interaction());
    await store.save(await prepareConnectionCredential(second, 'surviving-token', signal()), interaction());
    const models = await runtime(authPath, [first, second]);
    const retained = models.getModel(first.id, 'shared-model');
    const previous = process.env.GIGACHAT_ACCESS_TOKEN;
    process.env.GIGACHAT_ACCESS_TOKEN = 'ambient-must-not-work';
    try {
      await new ConnectionStore(authPath).remove(first.id);
      const result = await models.completeSimple(retained, context);
      assert.equal(result.stopReason, 'error');
      assert.equal(requests.length, 0);
      assert.deepEqual((await store.list()).map(entry => entry.gigachatConnection.id), [second.id]);
      successful(await send(models, second));
      assert.equal(requests[0].headers.authorization, 'Bearer surviving-token');
    } finally {
      if (previous === undefined) delete process.env.GIGACHAT_ACCESS_TOKEN;
      else process.env.GIGACHAT_ACCESS_TOKEN = previous;
    }
  }));
});

test('legacy ambient and request body/base URL settings cannot redirect a selected connection', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    const entry = connection('no-redirect', baseUrl);
    const store = new ConnectionStore(authPath);
    await store.save(await prepareConnectionCredential(entry, 'selected-token', signal()), interaction());
    const models = await runtime(authPath, [entry]);
    const ambient = { GIGACHAT_BASE_URL: process.env.GIGACHAT_BASE_URL, GIGACHAT_EXTRA_BODY: process.env.GIGACHAT_EXTRA_BODY };
    process.env.GIGACHAT_BASE_URL = 'http://127.0.0.1:1/not-this-server';
    process.env.GIGACHAT_EXTRA_BODY = JSON.stringify({ model: 'not-this-model' });
    try {
      successful(await send(models, entry));
      successful(await send(models, entry, 'shared-model', { env: {
        GIGACHAT_BASE_URL: 'http://127.0.0.1:1/not-this-server',
        GIGACHAT_EXTRA_BODY: JSON.stringify({ model: 'not-this-model' }),
      } }));
      assert.deepEqual(requests.map(request => request.url), ['/v1/chat/completions', '/v1/chat/completions']);
      assert.deepEqual(requests.map(request => request.body.model), ['shared-model', 'shared-model']);
    } finally {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));
});

test('custom-endpoint OAuth renewals are native-locked across runtimes and isolated by connection', async () => {
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    await writeFile(authPath, JSON.stringify({ unrelated: { type: 'api_key', key: 'untouched' } }));
    const first = connection('oauth-first', baseUrl, { authorization: { type: 'credentials',
      tokenUrl: baseUrl + '/issuer/one?exact=1', scope: 'GIGACHAT_API_B2B' } });
    const second = connection('oauth-second', baseUrl, { authorization: { type: 'credentials',
      tokenUrl: baseUrl + '/issuer/two?exact=2', scope: 'GIGACHAT_API_CORP' } });
    const store = new ConnectionStore(authPath);
    const firstCredential = await prepareConnectionCredential(first, 'Basic first-key', signal());
    const secondCredential = await prepareConnectionCredential(second, 'Basic second-key', signal());
    await store.save({ ...firstCredential, expires: 0 }, interaction());
    await store.save({ ...secondCredential, expires: 0 }, interaction());
    const one = await runtime(authPath, [first, second]);
    const two = await runtime(authPath, [first, second]);
    const before = requests.length;
    const results = await Promise.all([send(one, first), send(two, first), send(two, second)]);
    results.forEach(successful);
    const renewals = requests.slice(before).filter(request => request.url.includes('/issuer/'));
    assert.deepEqual(renewals.map(request => request.url).sort(), ['/v1/issuer/one?exact=1', '/v1/issuer/two?exact=2']);
    assert.deepEqual(renewals.map(request => request.headers.authorization).sort(), ['Basic first-key', 'Basic second-key']);
    const firstRequest = renewals.find(request => request.headers.authorization === 'Basic first-key');
    const secondRequest = renewals.find(request => request.headers.authorization === 'Basic second-key');
    assert.equal(new URLSearchParams(firstRequest.body).get('scope'), 'GIGACHAT_API_B2B');
    assert.equal(new URLSearchParams(secondRequest.body).get('scope'), 'GIGACHAT_API_CORP');
    assert.deepEqual(requests.slice(before).filter(request => request.url.endsWith('/chat/completions'))
      .map(request => request.headers.authorization).sort(),
      ['Bearer access-for-first-key', 'Bearer access-for-first-key', 'Bearer access-for-second-key']);
    const after = await new ConnectionStore(authPath).list();
    const refreshedFirst = after.find(entry => entry.gigachatConnection.id === first.id);
    const refreshedSecond = after.find(entry => entry.gigachatConnection.id === second.id);
    assert.deepEqual(refreshedFirst.gigachatConnection, first);
    assert.deepEqual(refreshedSecond.gigachatConnection, second);
    assert.equal(refreshedFirst.refresh, 'first-key');
    assert.equal(refreshedSecond.refresh, 'second-key');
    assert(refreshedFirst.expires > Date.now() + 300000);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')).unrelated, { type: 'api_key', key: 'untouched' });
  }, async (request, res) => {
    if (!request.url.includes('/issuer/')) return json(res, completion());
    await sleep(30);
    json(res, { access_token: 'access-for-' + request.headers.authorization.slice(6), expires_at: Date.now() + 1800000 });
  }));
});

test('profile enumeration shares the native OAuth lock and is cancellable while renewal is pending', async () => {
  let renewal = false;
  let reached;
  const pendingRequest = new Promise(resolve => { reached = resolve; });
  let release;
  const allowRenewal = new Promise(resolve => { release = resolve; });
  await withStorage(async authPath => withServer(async ({ baseUrl, requests }) => {
    const entry = connection('locked', baseUrl, { authorization: { type: 'credentials', tokenUrl: baseUrl + '/held/oauth', scope: 'GIGACHAT_API_PERS' } });
    const store = new ConnectionStore(authPath);
    const prepared = await prepareConnectionCredential(entry, 'held-key', signal());
    await store.save({ ...prepared, expires: 0 }, interaction());
    const models = await runtime(authPath, [entry]);
    renewal = true;
    const answer = send(models, entry);
    try {
      await pendingRequest;
      let enumerated = false;
      const controller = new AbortController();
      const listing = new ConnectionStore(authPath).list(controller.signal).then(result => {
        enumerated = true;
        return result;
      });
      // Register rejection before cancellation, avoiding an unhandled promise.
      const reason = new Error('Cancelled profile enumeration');
      const rejected = assert.rejects(listing, error => error === reason);
      await sleep(30);
      assert.equal(enumerated, false, 'Enumeration must not read a snapshot while native renewal owns auth.json');
      controller.abort(reason);
      await rejected;
      assert.equal(requests.filter(request => request.url.endsWith('/chat/completions')).length, 0);
    } finally { release(); }
    successful(await answer);
    const current = (await store.list())[0];
    assert.equal(current.access, 'fresh-after-lock');
    assert.equal(current.gigachatConnection.revision, 'revision-1');
  }, async (request, res) => {
    if (!request.url.endsWith('/held/oauth')) return json(res, completion());
    if (renewal) { reached(); await allowRenewal; }
    json(res, { access_token: renewal ? 'fresh-after-lock' : 'original-access', expires_at: Date.now() + 1800000 });
  }));
});

test('credential preparation does not retry or expose a token endpoint response body', async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const secret = 'secret-that-the-server-echoes';
    const entry = connection('unsafe-response', baseUrl, { authorization: { type: 'credentials', tokenUrl: baseUrl + '/failing/oauth', scope: 'GIGACHAT_API_PERS' } });
    await assert.rejects(prepareConnectionCredential(entry, 'Basic ' + secret, signal()), error => {
      assert.equal(error.code, 'GIGACHAT_AUTH_ERROR');
      assert.match(error.message, /HTTP 503/);
      assert(!error.message.includes(secret));
      assert(!error.message.includes('private response body'));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests.length, 1);
    await assert.rejects(prepareConnectionCredential(entry, 'Basic ', signal()), /secret is required/);
    await assert.rejects(prepareConnectionCredential({ ...entry, authorization: { type: 'token' } }, 'Bearer ', signal()), /secret is required/);
    assert.equal(requests.length, 1);
  }, (_request, res) => json(res, { error: 'secret-that-the-server-echoes; private response body' }, 503));
});

test('malformed native storage fails visibly and cannot be silently overwritten', async () => {
  await withStorage(async authPath => {
    const store = new ConnectionStore(authPath);
    assert.deepEqual(await store.list(), []);
    const entry = connection('malformed', 'https://example.invalid/v1');
    const credential = await prepareConnectionCredential(entry, 'literal-token', signal());
    for (const corrupt of ['{', '[]', JSON.stringify({ [entry.id]: { ...credential, gigachatConnection: { ...entry, revision: '' } } })]) {
      await writeFile(authPath, corrupt);
      await assert.rejects(store.list(), error => error.code === 'GIGACHAT_STORAGE_ERROR');
      await assert.rejects(store.save(credential, interaction()), error => error.code === 'GIGACHAT_STORAGE_ERROR');
      assert.equal(await readFile(authPath, 'utf8'), corrupt);
    }
    await writeFile(authPath, JSON.stringify({ gigachat: { type: 'api_key', key: 'legacy-provider' } }));
    await assert.rejects(store.remove('gigachat'), error => error.code === 'GIGACHAT_STORAGE_ERROR');
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')).gigachat, { type: 'api_key', key: 'legacy-provider' });
  });
});
