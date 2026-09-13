import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { gigachatProvider } from '../dist/index.js';
import { completion, json, token, user, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('GIGACHAT_')) delete process.env[key];
const credentials = Buffer.from('synthetic:credentials').toString('base64');
const tokenResponse = () => ({ access_token: token, expires_at: Date.now() + 1800000 });
function collection(env = {}, store = new InMemoryCredentialStore()) {
  const models = createModels({ credentials: store, authContext: { env: async name => env[name], fileExists: async () => false } });
  models.setProvider(gigachatProvider);
  return models;
}
const context = { messages: [user('Hello')] };

test('native OAuth login persists a canonical credential and keeps a custom endpoint on refresh', async () => {
  await withServer(async ({ baseUrl, model, requests }) => {
    process.env.GIGACHAT_AUTH_URL = baseUrl + '/oauth';
    const store = new InMemoryCredentialStore();
    const models = collection({}, store);
    const answers = ['token', baseUrl, 'GIGACHAT_API_PERS', credentials];
    const originalConsole = console.info;
    try {
      const auth = await models.login('gigachat', 'oauth', { prompt: async () => answers.shift(), notify() {} });
      assert.equal(auth.type, 'oauth');
      assert.equal(auth.baseUrl, baseUrl);
      assert.equal(auth.access, token);
      assert.equal(answers.length, 0);
      assert.equal(console.info, originalConsole);
      await store.modify('gigachat', async current => ({ ...current, expires: 0 }));
      const result = await models.completeSimple(model, context);
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      const renewed = await store.read('gigachat');
      assert.equal(renewed.baseUrl, baseUrl);
      assert.equal(renewed.refresh, credentials);
      assert.equal(requests.filter(r => r.url.endsWith('/oauth')).length, 2);
      assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + token);
    } finally { delete process.env.GIGACHAT_AUTH_URL; }
  }, (req, res) => json(res, req.url.endsWith('/oauth') ? tokenResponse() : completion()));
});

test('pi refreshes existing legacy OAuth data once under the credential store lock', async () => {
  await withServer(async ({ baseUrl, model, requests }) => {
    process.env.GIGACHAT_AUTH_URL = baseUrl + '/oauth';
    const store = new InMemoryCredentialStore();
    await store.modify('gigachat', async () => ({ type: 'oauth', access: 'expired.synthetic.token', expires: 0, refresh: credentials, authorizationKey: credentials, authMode: 'token', scope: 'GIGACHAT_API_PERS', baseUrl }));
    try {
      const models = collection({}, store);
      const results = await Promise.all([models.completeSimple(model, context), models.completeSimple(model, context)]);
      assert(results.every(r => r.stopReason === 'stop'));
      assert.equal(requests.filter(r => r.url.endsWith('/oauth')).length, 1);
      assert.equal((await store.read('gigachat')).access, token);
    } finally { delete process.env.GIGACHAT_AUTH_URL; }
  }, (req, res) => json(res, req.url.endsWith('/oauth') ? tokenResponse() : completion()));
});

test('environment authorization keys are checked without I/O and reuse an exchanged token', async () => {
  await withServer(async ({ baseUrl, model, requests }) => {
    const models = collection({ GIGACHAT_CREDENTIALS: credentials, GIGACHAT_AUTH_URL: baseUrl + '/oauth', GIGACHAT_BASE_URL: baseUrl });
    assert(await models.checkAuth('gigachat'));
    assert.equal(requests.length, 0);
    for (let i = 0; i < 2; i++) {
      const result = await models.completeSimple(model, context, { env: { GIGACHAT_EXTRA_BODY: JSON.stringify({ temperature: i / 10 }) } });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
    }
    assert.equal(requests.filter(r => r.url.endsWith('/oauth')).length, 1);
    assert.equal(new URLSearchParams(requests[0].body).get('scope'), 'GIGACHAT_API_PERS');
    assert.equal(requests[0].headers.authorization, 'Basic ' + credentials);
  }, (req, res) => json(res, req.url.endsWith('/oauth') ? tokenResponse() : completion()));
});

test('aborting during token exchange cancels before any chat request is sent', async () => {
  const controller = new AbortController();
  await withServer(async ({ baseUrl, model, requests }) => {
    const models = collection({ GIGACHAT_CREDENTIALS: credentials, GIGACHAT_AUTH_URL: baseUrl + '/oauth' });
    const start = Date.now();
    const result = await models.completeSimple(model, context, { signal: controller.signal });
    // pi 0.85.1's lazyStream reports failures during auth resolution as error.
    // Cancellation itself must still stop HTTP immediately, before generation.
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /abort/i);
    assert(Date.now() - start < 450, 'Token exchange ignored cancellation');
    assert.equal(requests.length, 1);
  }, async (_req, res) => {
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 500));
    json(res, tokenResponse());
  });
});

test('stored OAuth owns auth; an explicit per-request key overrides it', async () => {
  await withServer(async ({ baseUrl, model, requests }) => {
    const store = new InMemoryCredentialStore();
    await store.modify('gigachat', async () => ({ type: 'oauth', access: token, refresh: credentials, expires: Date.now() + 1800000, baseUrl }));
    const models = collection({ GIGACHAT_ACCESS_TOKEN: 'ambient.synthetic.token' }, store);
    await models.completeSimple(model, context);
    await models.completeSimple(model, context, { apiKey: 'explicit.synthetic.token' });
    assert.deepEqual(requests.map(r => r.headers.authorization), ['Bearer ' + token, 'Bearer explicit.synthetic.token']);
  });
});

test('environment access token wins over an authorization key and accepts opaque tokens', async () => {
  await withServer(async ({ model, requests }) => {
    const models = collection({ GIGACHAT_CREDENTIALS: credentials, GIGACHAT_ACCESS_TOKEN: 'opaque-access' });
    const result = await models.completeSimple(model, context);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, 'Bearer opaque-access');
  });
});

test('stored OAuth endpoint wins over ambient base URL; explicit request env can override it', async () => {
  const store = new InMemoryCredentialStore();
  await store.modify('gigachat', async () => ({ type: 'oauth', access: token, refresh: credentials,
    expires: Date.now() + 1800000, baseUrl: 'https://saved.example/v1' }));
  const models = collection({}, store);
  const model = models.getModel('gigachat', 'GigaChat-3-Ultra');
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    return Response.json(completion());
  };
  process.env.GIGACHAT_BASE_URL = 'https://ambient.example/v1';
  try {
    for (const env of [undefined, { GIGACHAT_BASE_URL: 'https://explicit.example/v1' }]) {
      const result = await models.completeSimple(model, context, { fetch, env });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
    }
    assert.deepEqual(urls, ['https://saved.example/v1/chat/completions', 'https://explicit.example/v1/chat/completions']);
  } finally {
    delete process.env.GIGACHAT_BASE_URL;
  }
});

test('password authentication supports the corporate token response format', async () => {
  await withServer(async ({ baseUrl, model, requests }) => {
    const models = collection({ GIGACHAT_USER: 'test-user', GIGACHAT_PASSWORD: 'test-password', GIGACHAT_BASE_URL: baseUrl });
    const result = await models.completeSimple(model, context);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests[0].url, '/v1/token');
    assert.equal(requests[0].headers.authorization, 'Basic ' + Buffer.from('test-user:test-password').toString('base64'));
    assert.equal(requests[1].headers.authorization, 'Bearer ' + token);
  }, (req, res) => json(res, req.url.endsWith('/token') ? { tok: token, exp: Math.floor(Date.now() / 1000) + 1800 } : completion()));
});
