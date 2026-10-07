import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConnectionStore, prepareConnectionCredential } from '../dist/connections.js';
import { cleanEnv, completion, reply, withServer } from './helpers.mjs';
import { cliPath, until } from './pi-rpc.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const modelId = 'saved-private-model';
const connection = (id, baseUrl, changes = {}) => ({
  id: 'gigachat-server-' + id,
  revision: 'original-revision',
  name: 'Saved private server',
  baseUrl,
  authorization: { type: 'token' },
  models: [{ id: modelId, name: 'Private model', contextWindow: 200000, maxTokens: 64000, reasoning: false }],
  ...changes,
});

async function saveConnection(authPath, entry, secret) {
  const signal = new AbortController().signal;
  // ConnectionStore commits through the public native ModelRuntime login API.
  await new ConnectionStore(authPath).save(await prepareConnectionCredential(entry, secret, signal), {
    signal,
    prompt: async () => { throw new Error('Saved token must not request interactive authorization'); },
    notify() {},
  });
}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label())), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// This harness differs from withPi only at the required seam: credentials exist
// before process startup, and no --provider or --model flags are ever supplied.
async function withSavedPi(defaultConnection, records, run, runtime = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-gigachat-saved-runtime-'));
  const agentDir = join(dir, 'agent');
  const sessionFile = join(dir, 'session.jsonl');
  const authPath = join(agentDir, 'auth.json');
  let current;
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      packages: [repo],
      defaultProvider: defaultConnection.id,
      defaultModel: modelId,
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false },
      ...runtime.settings,
    }));
    for (const [entry, secret] of records) await saveConnection(authPath, entry, secret);

    async function start() {
      const events = [];
      const pending = new Map();
      let sequence = 0;
      let stderr = '';
      let closed = false;
      const child = spawn(process.execPath, [cliPath, '--mode', 'rpc', '--session', sessionFile,
        '--no-tools', '--no-skills', '--no-prompt-templates'], {
        cwd: dir,
        env: { ...cleanEnv(), HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', ...runtime.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const diagnostics = () => stderr.slice(-3000);
      const rejectPending = error => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      };
      const exited = new Promise(resolve => {
        child.once('close', (code, signal) => {
          closed = true;
          rejectPending(new Error(`Pi exited (${code ?? signal}); ${diagnostics()}`));
          resolve();
        });
      });
      child.on('error', rejectPending);
      child.stdin.on('error', rejectPending);
      child.stderr.on('data', data => { stderr += data; });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        events.push(event);
        if (event.type === 'response') pending.get(event.id)?.resolve(event);
      });
      const command = async (type, args = {}) => {
        assert(!closed, `Pi is not running; ${diagnostics()}`);
        const id = String(++sequence);
        try {
          return await bounded(new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n');
          }), 15000, () => `RPC ${type} timed out; ${diagnostics()}`);
        } finally { pending.delete(id); }
      };
      current = {
        events, agentDir,
        command,
        async prompt(message) {
          const offset = events.length;
          const response = await command('prompt', { message });
          if (!response.success) return { error: response.error };
          await until(() => {
            assert(!closed, `Pi exited during generation; ${diagnostics()}`);
            return events.slice(offset).some(event => event.type === 'agent_end');
          }, 'saved-profile agent_end', 15000);
          await until(async () => {
            const state = await command('get_state');
            assert.equal(state.success, true, state.error);
            return !state.data.isStreaming && !state.data.isCompacting;
          }, 'saved-profile idle', 15000);
          const assistant = events.slice(offset).filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
          assert(assistant, `Prompt did not produce an assistant result; ${diagnostics()}`);
          return { assistant, error: assistant.errorMessage };
        },
        async stop() {
          try {
            if (!closed) {
              child.kill('SIGTERM');
              try { await bounded(exited, 3000, () => 'Pi ignored SIGTERM'); }
              catch {
                child.kill('SIGKILL');
                await bounded(exited, 3000, () => `Pi ignored SIGKILL; ${diagnostics()}`);
              }
            }
          } finally { lines.close(); }
        },
      };
      const state = await command('get_state');
      assert.equal(state.success, true, state.error);
      return current;
    }

    await run(await start(), async () => {
      await current.stop();
      return start();
    }, authPath);
  } finally {
    try { await current?.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function assertSelected(pi, entry) {
  const state = await pi.command('get_state');
  assert.equal(state.success, true, state.error);
  assert.equal(state.data.model.provider, entry.id);
  assert.equal(state.data.model.id, modelId);
  assert.equal(state.data.model.baseUrl, entry.baseUrl);
  assert.equal(state.data.model.contextWindow, entry.models[0].contextWindow);
  assert.equal(state.data.model.maxTokens, entry.models[0].maxTokens);
}

async function assertSuccessfulPrompt(pi, entry, text) {
  const result = await pi.prompt(text);
  assert(result.assistant, result.error);
  assert.equal(result.assistant.stopReason, 'stop', result.error);
  assert.equal(result.assistant.provider, entry.id);
  assert.equal(result.assistant.model, modelId);
  assert.deepEqual(result.assistant.content, [{ type: 'text', text: 'Private fixture reply.' }]);
}

function assertGenerationsOnly(requests, expectedTokens, maxTokens = 64000, expectedModel = modelId) {
  assert.equal(requests.length, expectedTokens.length, 'Startup/selection/restart must not make discovery or paid verification requests');
  assert(requests.every(request => !request.url.includes('/models')), 'Saved profiles must not rediscover GET /models');
  assert(requests.every(request => request.body.max_tokens !== 1), 'Saved profiles must not run max_tokens:1 generation probes');
  assert.deepEqual(requests.map(request => request.url), expectedTokens.map(() => '/v1/chat/completions'));
  assert.deepEqual(requests.map(request => request.headers.authorization), expectedTokens.map(token => 'Bearer ' + token));
  assert.deepEqual(requests.map(request => request.body.model), expectedTokens.map(() => expectedModel));
  assert(requests.every(request => request.body.max_tokens === maxTokens));
}

const respond = (request, res) => reply(request, res, completion({ role: 'assistant', content: 'Private fixture reply.' }));

test('native CLI restores a configured private default and resumes an RPC-selected private profile without model flags or paid probes', { timeout: 60000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const configured = connection('configured-default', baseUrl);
    const selected = connection('session-selected', baseUrl);
    await withSavedPi(configured, [[configured, '!configured-literal-token'], [selected, '$selected-literal-token']], async (pi, restart) => {
      await assertSelected(pi, configured);
      assertGenerationsOnly(requests, []);
      await assertSuccessfulPrompt(pi, configured, 'Use the configured private default.');
      assertGenerationsOnly(requests, ['!configured-literal-token']);

      const changed = await pi.command('set_model', { provider: selected.id, modelId });
      assert.equal(changed.success, true, changed.error);
      await assertSelected(pi, selected);
      assertGenerationsOnly(requests, ['!configured-literal-token']);
      await assertSuccessfulPrompt(pi, selected, 'Remember PRIVATE-RESUME-42 using this private profile.');
      assertGenerationsOnly(requests, ['!configured-literal-token', '$selected-literal-token']);

      // RPC set_model saves the transcript, not global defaults. The resumed
      // profile must win over the independently configured first connection.
      pi = await restart();
      await assertSelected(pi, selected);
      assertGenerationsOnly(requests, ['!configured-literal-token', '$selected-literal-token']);
      const messages = await pi.command('get_messages');
      assert.equal(messages.success, true, messages.error);
      assert(messages.data.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('PRIVATE-RESUME-42'))));
      await assertSuccessfulPrompt(pi, selected, 'Continue the resumed private conversation.');
      assertGenerationsOnly(requests, ['!configured-literal-token', '$selected-literal-token', '$selected-literal-token']);
      assert(requests.at(-1).body.messages.some(message => message.role === 'user' && message.content.includes('PRIVATE-RESUME-42')));
    });
  }, respond);
});

test('an open native Pi refuses a changed saved connection before HTTP and restart adopts the current server and token', { timeout: 60000 }, async () => {
  await withServer(async originalServer => withServer(async currentServer => {
    const original = connection('externally-edited', originalServer.baseUrl);
    const updated = connection('externally-edited', currentServer.baseUrl, {
      revision: 'changed-revision', name: 'Updated private server',
      models: [{ ...original.models[0], maxTokens: 32000 }],
    });
    await withSavedPi(original, [[original, 'original-private-token']], async (pi, restart, authPath) => {
      await assertSelected(pi, original);
      assertGenerationsOnly(originalServer.requests, []);
      assertGenerationsOnly(currentServer.requests, []);
      await assertSuccessfulPrompt(pi, original, 'Use the original private connection.');
      assertGenerationsOnly(originalServer.requests, ['original-private-token']);

      // A separate store/native runtime commits the same edit another Pi process
      // would make, while the first process retains its old provider revision.
      await saveConnection(authPath, updated, 'changed-private-token');
      const rejected = await pi.prompt('This stale provider must not contact either server.');
      if (rejected.assistant) assert.equal(rejected.assistant.stopReason, 'error');
      assert.match(rejected.error, /connection changed or was removed/i);
      assert.match(rejected.error, /\/gigachat.*restart/i);
      assert(!rejected.error.includes('original-private-token') && !rejected.error.includes('changed-private-token'));
      await assertSelected(pi, original);
      assertGenerationsOnly(originalServer.requests, ['original-private-token']);
      assertGenerationsOnly(currentServer.requests, []);

      pi = await restart();
      await assertSelected(pi, updated);
      assertGenerationsOnly(originalServer.requests, ['original-private-token']);
      assertGenerationsOnly(currentServer.requests, []);
      await assertSuccessfulPrompt(pi, updated, 'Use the current saved private connection after restart.');
      assertGenerationsOnly(originalServer.requests, ['original-private-token']);
      assertGenerationsOnly(currentServer.requests, ['changed-private-token'], 32000);
    });
  }, respond), respond);
});

test('resuming a real legacy GigaChat session does not switch to a newly saved private global default', { timeout: 60000 }, async () => {
  await withServer(async legacyServer => withServer(async privateServer => {
    const saved = connection('not-the-resumed-session', privateServer.baseUrl);
    const legacyModel = 'Qwen3.5-397b';
    const legacyToken = 'legacy-resumed-token';
    await withSavedPi(saved, [[saved, 'unused-private-default-token']], async (pi, restart) => {
      let state = await pi.command('get_state');
      assert.equal(state.data.model.provider, 'gigachat');
      assert.equal(state.data.model.id, legacyModel);
      const first = await pi.prompt('Remember LEGACY-RESUME-42 in this legacy conversation.');
      assert.equal(first.assistant?.stopReason, 'stop', first.error);
      assert.equal(first.assistant.provider, 'gigachat');
      assert.equal(first.assistant.model, legacyModel);
      assertGenerationsOnly(legacyServer.requests, [legacyToken], 32768, legacyModel);
      assertGenerationsOnly(privateServer.requests, []);

      // Only global settings change; the session is real CLI-generated history,
      // not a fabricated model_change transcript.
      const settingsPath = join(pi.agentDir, 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProvider: saved.id, defaultModel: modelId }));
      pi = await restart();
      state = await pi.command('get_state');
      assert.equal(state.success, true, state.error);
      assert.equal(state.data.model.provider, 'gigachat');
      assert.equal(state.data.model.id, legacyModel);
      assertGenerationsOnly(legacyServer.requests, [legacyToken], 32768, legacyModel);
      assertGenerationsOnly(privateServer.requests, []);
      const resumed = await pi.prompt('Continue the legacy session, not the new global default.');
      assert.equal(resumed.assistant?.stopReason, 'stop', resumed.error);
      assert.equal(resumed.assistant.provider, 'gigachat');
      assert.equal(resumed.assistant.model, legacyModel);
      assertGenerationsOnly(legacyServer.requests, [legacyToken, legacyToken], 32768, legacyModel);
      assertGenerationsOnly(privateServer.requests, []);
      assert(legacyServer.requests.at(-1).body.messages.some(message => message.role === 'user' && message.content.includes('LEGACY-RESUME-42')));
    }, {
      settings: { defaultProvider: 'gigachat', defaultModel: legacyModel },
      env: { GIGACHAT_BASE_URL: legacyServer.baseUrl, GIGACHAT_ACCESS_TOKEN: legacyToken },
    });
  }, respond), respond);
});

test('restarting a deleted private session refuses prompts and compaction until another model is explicitly selected', { timeout: 60000 }, async () => {
  await withServer(async privateServer => withServer(async fallbackServer => {
    const saved = connection('deleted-before-restart', privateServer.baseUrl);
    const privateToken = 'deleted-session-token';
    const fallbackToken = 'explicitly-selected-legacy-token';
    const legacyModel = 'Qwen3.5-397b';
    await withSavedPi(saved, [[saved, privateToken]], async (pi, restart, authPath) => {
      await assertSelected(pi, saved);
      await assertSuccessfulPrompt(pi, saved, 'Remember the first real history turn. ' + 'history '.repeat(512));
      await assertSuccessfulPrompt(pi, saved, 'Remember the second real history turn. ' + 'history '.repeat(512));
      assertGenerationsOnly(privateServer.requests, [privateToken, privateToken]);
      assertGenerationsOnly(fallbackServer.requests, []);
      await new ConnectionStore(authPath).remove(saved.id);
      pi = await restart();
      assertGenerationsOnly(privateServer.requests, [privateToken, privateToken]);
      assertGenerationsOnly(fallbackServer.requests, []);

      // A handled input produces an RPC acknowledgement and notification, not
      // agent_end. Waiting for agent_end would miss this intentional refusal.
      const offset = pi.events.length;
      const refused = await pi.command('prompt', { message: 'Do not silently use the native fallback.' });
      assert.equal(refused.success, true, refused.error);
      const notification = pi.events.slice(offset).find(event => event.type === 'extension_ui_request' && event.method === 'notify' && event.notifyType === 'error');
      assert(notification, 'Missing saved profile must surface an error notification for the refused prompt');
      assert.match(notification.message, /\/model/);
      const idle = await pi.command('get_state');
      assert.equal(idle.success, true, idle.error);
      assert.equal(idle.data.isStreaming, false);
      assert(!pi.events.slice(offset).some(event => event.type === 'agent_start'), 'Refused input must not start an agent turn');
      assertGenerationsOnly(privateServer.requests, [privateToken, privateToken]);
      assertGenerationsOnly(fallbackServer.requests, []);

      const compacted = await pi.command('compact');
      assert.equal(compacted.success, false, 'Missing profile must not compact using fallback authorization');
      assert.match(compacted.error, /compact|\/model|\/gigachat/i);
      assertGenerationsOnly(privateServer.requests, [privateToken, privateToken]);
      assertGenerationsOnly(fallbackServer.requests, []);

      const chosen = await pi.command('set_model', { provider: 'gigachat', modelId: legacyModel });
      assert.equal(chosen.success, true, chosen.error);
      assertGenerationsOnly(fallbackServer.requests, []);
      const state = await pi.command('get_state');
      assert.equal(state.data.model.provider, 'gigachat');
      assert.equal(state.data.model.id, legacyModel);
      const recovered = await pi.prompt('I explicitly selected the legacy connection; generate now.');
      assert.equal(recovered.assistant?.stopReason, 'stop', recovered.error);
      assert.equal(recovered.assistant.provider, 'gigachat');
      assert.equal(recovered.assistant.model, legacyModel);
      assertGenerationsOnly(privateServer.requests, [privateToken, privateToken]);
      assertGenerationsOnly(fallbackServer.requests, [fallbackToken], 32768, legacyModel);
    }, {
      settings: { compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 256 } },
      env: { GIGACHAT_BASE_URL: fallbackServer.baseUrl, GIGACHAT_ACCESS_TOKEN: fallbackToken },
    });
  }, respond), respond);
});
