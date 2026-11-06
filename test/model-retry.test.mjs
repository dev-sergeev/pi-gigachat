import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Response as UndiciResponse } from 'undici';
import { retryModel } from '../dist/discovery.js';
import { chooseModels } from '../dist/gigachat-dialogs.js';
import { registerGigaChatCommand } from '../dist/gigachat-ui.js';
import { completion, json, token, withServer } from './helpers.mjs';

for (const key of Object.keys(process.env)) {
  if (/^(GIGACHAT_|https?_proxy$|HTTPS?_PROXY$|ALL_PROXY$|all_proxy$)/.test(key)) delete process.env[key];
}
const model = id => ({ id, name: id, contextWindow: 8192, maxTokens: 256, reasoning: false });
const result = protocol => protocol === 'v2'
  ? { messages: [{ role: 'assistant', content: [{ text: '' }] }], finish_reason: 'length' }
  : completion();
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const text = component => component.render(200).join('\n');
const keys = { matches: (data, action) => data === {
  'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b', 'app.interrupt': '\x03',
}[action] };

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
}

// Exercise the actual custom components through their input/render lifecycle.
function dialogs(onScreen = () => {}, signal) {
  const screens = [];
  const waiting = [];
  const ui = {
    custom: factory => signal?.aborted ? Promise.resolve(undefined) : new Promise((resolve, reject) => {
      let component;
      let settled = false;
      const done = value => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        queueMicrotask(() => { component.dispose?.(); resolve(value); });
      };
      const abort = () => done(undefined);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        component = factory({ requestRender() {} }, { fg: (_color, value) => value }, keys, done);
        if (waiting.length) waiting.shift()(component);
        else screens.push(component);
        onScreen(component, done);
      } catch (error) {
        signal?.removeEventListener('abort', abort);
        component?.dispose?.();
        reject(error);
      }
    }),
  };
  return {
    ui,
    next: () => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (screens.length) return Promise.resolve(screens.shift());
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        waiting.push(component => {
          signal?.removeEventListener('abort', abort);
          resolve(component);
        });
      });
    },
  };
}

for (const protocol of ['v1', 'v2', 'openai']) {
  test(`${protocol} manual retry sends exactly one authorized POST without reloading the catalog`, { timeout: 3000 }, async t => {
    await withServer(async ({ baseUrl, requests }) => {
      const target = model('exact-ID');
      const probe = await retryModel(baseUrl + '///', token, target, { protocol, signal: t.signal });
      assert.deepEqual(probe, { model: target, status: 'available' });
      assert.equal(probe.model, target);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/v1/chat/completions');
      assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
      assert.deepEqual(requests[0].body, protocol === 'v2'
        ? { model: 'exact-ID', messages: [{ role: 'user', content: [{ text: 'Hi' }] }], model_options: { max_tokens: 1 }, stream: false }
        : { model: 'exact-ID', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false });
    }, (_req, res) => json(res, result(protocol)));
  });

  test(`${protocol} manual retry keeps one fixed 600000ms deadline through the entire body`, { timeout: 3000 }, async t => {
    const reading = Promise.withResolvers();
    const timers = [];
    let now = 0;
    t.mock.method(AbortSignal, 'timeout', delay => {
      const controller = new AbortController();
      timers.push({ delay, deadline: now + delay, controller });
      return controller.signal;
    });
    const advance = milliseconds => {
      now += milliseconds;
      for (const timer of timers) {
        if (timer.deadline <= now && !timer.controller.signal.aborted)
          timer.controller.abort(new DOMException('Full body deadline exceeded', 'TimeoutError'));
      }
    };
    const originalJson = UndiciResponse.prototype.json;
    t.mock.method(UndiciResponse.prototype, 'json', function () {
      reading.resolve();
      return originalJson.call(this);
    });
    environment(t, { GIGACHAT_TIMEOUT: '1', GIGACHAT_MAX_RETRIES: '9' });
    await withServer(async ({ baseUrl, requests }) => {
      let settled = false;
      const pending = retryModel(baseUrl, token, model('slow'), { protocol, signal: t.signal });
      void pending.then(() => { settled = true; });
      await reading.promise;
      assert.deepEqual(timers.map(timer => timer.delay), [600000]);
      advance(599999);
      await flush();
      assert.equal(settled, false, 'the initial scan and generation deadlines must not apply');
      advance(1);
      const probe = await pending;
      assert.equal(probe.status, 'unavailable');
      assert.match(probe.reason, /timed out/i);
      await flush();
      assert.equal(requests.length, 1, 'a timeout never causes an automatic manual retry');
    }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"unfinished":');
    });
  });
}

for (const failure of [403, 429, 503, 'malformed', 'network']) {
  test(`manual ${failure} failure is terminal after one POST and uses safe diagnostics`, { timeout: 3000 }, async t => {
    environment(t, { GIGACHAT_MAX_RETRIES: '9' });
    await withServer(async ({ baseUrl, requests }) => {
      const probe = await retryModel(baseUrl, token, model('denied'), { signal: t.signal });
      assert.equal(probe.status, 'unavailable');
      assert.ok(probe.reason);
      assert.ok(!probe.reason.includes('PRIVATE-BODY'));
      await flush();
      assert.equal(requests.length, 1);
    }, (_req, res) => {
      if (failure === 'network') return res.destroy();
      if (failure === 'malformed') return json(res, { private: 'PRIVATE-BODY' });
      res.setHeader('Retry-After', '600');
      json(res, { error: 'PRIVATE-BODY' }, failure);
    });
  });
}

test('manual retry rejects pre-cancellation and insecure mTLS before any HTTP', async t => {
  await withServer(async ({ baseUrl, requests }) => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    await assert.rejects(retryModel(baseUrl, token, model('one'), { signal: controller.signal }), error => error === reason);
    await assert.rejects(retryModel(baseUrl, token, model('one'), {
      signal: t.signal, mtls: { ca: 'synthetic-ca', cert: 'synthetic-cert', key: 'synthetic-key' },
    }), /HTTPS/);
    assert.equal(requests.length, 0);
  });
});

test('Ctrl+R targets the highlighted unchecked or unavailable row, auto-checks success and preserves saved config', { timeout: 3000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const saved = { ...model('keep'), name: 'Edited', maxTokens: 777, temperature: 0.2 };
    const probes = [
      { model: model('keep'), status: 'available' },
      { model: model('unchecked'), status: 'available' },
      { model: model('denied'), status: 'unavailable', reason: 'Previous failure' },
    ];
    const keep = structuredClone(probes[0]);
    const ui = dialogs();
    const pending = chooseModels({ ui: ui.ui }, probes, (target, signal) => retryModel(baseUrl, token, target, { signal }), [saved]);
    const first = await ui.next();
    first.handleInput('\x1b[B');
    first.handleInput('\x12');
    const progress = await ui.next();
    assert.match(text(progress), /Повторная проверка · unchecked/);
    progress.handleInput('\x12');
    progress.handleInput(' ');
    progress.handleInput('\r');
    const second = await ui.next();
    assert.match(text(second), /→ \[x\] unchecked/);
    assert.match(text(second), /\[x\] keep/);
    assert.deepEqual(probes[0], keep);
    second.handleInput('\x1b[B');
    second.handleInput('\x12');
    await ui.next();
    const third = await ui.next();
    assert.match(text(third), /→ \[x\] denied/);
    third.handleInput('\r');
    const chosen = await pending;
    assert.equal(chosen[0], saved);
    assert.deepEqual(chosen.map(value => value.id), ['keep', 'unchecked', 'denied']);
    assert.deepEqual(requests.map(request => request.body.model), ['unchecked', 'denied']);
    assert.deepEqual(probes.map(probe => probe.status), ['available', 'available', 'available']);
  });
});

for (const succeeds of [false, true]) {
  test(`rechecking a selected available model ${succeeds ? 'retains its mark on success' : 'replaces its status and unchecks on failure'}`, { timeout: 3000 }, async () => {
    await withServer(async ({ baseUrl, requests }) => {
      const saved = [model('keep'), { ...model('target'), maxTokens: 987, temperature: 0.7 }];
      const probes = saved.map(value => ({ model: model(value.id), status: 'available' }));
      const ui = dialogs();
      const pending = chooseModels({ ui: ui.ui }, probes, (target, signal) => retryModel(baseUrl, token, target, { signal }), saved);
      const first = await ui.next();
      first.handleInput('\x1b[B');
      first.handleInput('\x12');
      await ui.next();
      const restored = await ui.next();
      assert.match(text(restored), succeeds ? /→ \[x\] target/ : /→ \[—\] target/);
      assert.equal(probes[1].status, succeeds ? 'available' : 'unavailable');
      restored.handleInput('\r');
      assert.deepEqual(await pending, succeeds ? saved : [saved[0]]);
      assert.equal(requests.length, 1);
    }, (_req, res) => json(res, succeeds ? completion() : { error: 'denied' }, succeeds ? 200 : 503));
  });
}

for (const status of ['selected', 'unchecked', 'unavailable']) {
  test(`Esc during manual ${status} retry restores status, cursor and every mark without saving`, { timeout: 3000 }, async t => {
    const reading = Promise.withResolvers();
    const originalJson = UndiciResponse.prototype.json;
    t.mock.method(UndiciResponse.prototype, 'json', function () {
      reading.resolve();
      return originalJson.call(this);
    });
    await withServer(async ({ baseUrl, requests }) => {
      const saved = [model('keep'), ...(status === 'selected' ? [model('target')] : [])];
      const probes = [
        { model: model('keep'), status: 'available' },
        { model: model('target'), status: status === 'unavailable' ? 'unavailable' : 'available', reason: 'Old diagnostic' },
      ];
      const before = structuredClone(probes);
      const ui = dialogs();
      let finished = false;
      let active = 0;
      let peak = 0;
      const pending = chooseModels({ ui: ui.ui }, probes, async (target, signal) => {
        peak = Math.max(peak, ++active);
        try { return await retryModel(baseUrl, token, target, { signal }); }
        finally { active--; }
      }, saved);
      void pending.then(() => { finished = true; });
      const first = await ui.next();
      first.handleInput('\x1b[B');
      const previous = text(first);
      first.handleInput('\x12');
      const progress = await ui.next();
      await reading.promise;
      for (const key of ['\x12', '\r', ' ', '\x01']) progress.handleInput(key);
      await flush();
      assert.equal(requests.length, 1);
      assert.equal(finished, false);
      progress.handleInput('\x1b');
      const restored = await ui.next();
      assert.equal(active, 0, 'transport cancellation completes before list input can launch a new request');
      assert.deepEqual(probes, before);
      assert.equal(text(restored), previous);
      assert.equal(finished, false);
      restored.handleInput('\x12');
      const secondProgress = await ui.next();
      secondProgress.handleInput('\x1b');
      const final = await ui.next();
      assert.equal(peak, 1);
      assert.deepEqual(probes, before);
      final.handleInput('\r');
      assert.deepEqual(await pending, saved);
    }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"unfinished":');
    });
  });
}

test('Esc from the model list still cancels the wizard without probing', async () => {
  const ui = dialogs();
  const pending = chooseModels({ ui: ui.ui }, [{ model: model('one'), status: 'available' }], () => { throw new Error('Unexpected retry'); });
  (await ui.next()).handleInput('\x1b');
  assert.equal(await pending, undefined);
});

for (const mode of ['create', 'refresh']) {
  test(`${mode} wizard recovers and saves after every initial model probe failed`, { timeout: 5000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-gigachat-manual-retry-'));
    const oldDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      await withServer(async ({ baseUrl, requests }) => {
        const entry = {
          type: 'api_key', env: { GIGACHAT_ACCESS_TOKEN: token },
          gigachatConnection: {
            id: 'gigachat-Recover', revision: 'before', name: 'Recover', baseUrl, protocol: 'v1',
            authorization: { type: 'token' }, models: [{ ...model('recover'), maxTokens: 123, temperature: 0.3 }],
          },
        };
        if (mode === 'refresh') await writeFile(join(directory, 'auth.json'), JSON.stringify({ 'gigachat-Recover': entry }));
        const providers = new Map();
        let command;
        await registerGigaChatCommand({
          on() {}, registerProvider: provider => providers.set(provider.id, provider), unregisterProvider: id => providers.delete(id),
          registerCommand: (_name, definition) => { command = definition; },
        });
        const notifications = [];
        const controller = new AbortController();
        const ui = dialogs((component, done) => {
          const screen = text(component);
          if (screen.includes('Добавить подключение · Токен')) done({ name: 'Recover', secret: token });
          else if (screen.includes('Адреса ·')) done({ url: baseUrl, modelsUrl: '' });
        }, AbortSignal.any([t.signal, controller.signal]));
        Object.assign(ui.ui, {
          notify: (message, type) => notifications.push([message, type]), setStatus() {},
          select: async (title, options) => {
            if (title === 'GigaChat · способ авторизации') return mode === 'refresh' ? 'Управление подключениями' : 'Токен';
            if (title.startsWith('«Recover»')) return 'Обновить каталог и выбор моделей';
            return options[0];
          },
        });
        const pending = command.handler('', {
          mode: 'tui', cwd: directory, ui: ui.ui,
          isIdle: () => true,
          modelRegistry: { refresh: async () => {}, getProvider: id => providers.get(id) },
        });
        const next = () => Promise.race([
          ui.next(),
          pending.then(() => { throw new Error(`Wizard ended before the expected dialog: ${JSON.stringify(notifications)}`); }),
        ]);
        try {
          let picker;
          do { picker = await next(); } while (!text(picker).includes('Выберите модели GigaChat'));
          assert.match(text(picker), /\[—\] recover/);
          assert.equal(requests.length, 6, 'one catalog and the unchanged five automatic attempts');
          picker.handleInput('\x12');
          await next();
          const recovered = await next();
          assert.match(text(recovered), /→ \[x\] recover/);
          recovered.handleInput('\r');
          await pending;
          assert.ok(!notifications.some(([, type]) => type === 'error'), JSON.stringify(notifications));
          const stored = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))['gigachat-Recover'];
          assert.deepEqual(stored.gigachatConnection.models.map(value => value.id), ['recover']);
          if (mode === 'refresh') assert.deepEqual(stored.gigachatConnection.models, entry.gigachatConnection.models);
          assert.equal(requests.length, 7, 'manual recovery does not reload catalog or start extra attempts');
          assert.equal(requests.filter(request => request.url.endsWith('/models')).length, 1);
          assert.ok(requests.every(request => request.headers.authorization === `Bearer ${token}`));
        } finally {
          controller.abort();
          await pending;
        }
      }, (request, res, requests) => {
        if (request.url.endsWith('/models')) return json(res, { data: [{ id: 'recover' }] });
        const attempt = requests.filter(value => value.url.endsWith('/chat/completions')).length;
        json(res, attempt > 5 ? completion() : { error: 'initially denied' }, attempt > 5 ? 200 : 403);
      });
    } finally {
      if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
