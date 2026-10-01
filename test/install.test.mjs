import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cleanEnv, withServer } from './helpers.mjs';
import { withPi } from './pi-rpc.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'scripts/postinstall.mjs');

test('first activation forces Qwen when install scripts did not run, then preserves a manual GLM selection', { timeout: 30000 }, async () => {
  await withServer(async ({ baseUrl, requests }) => {
    const runtime = { modelFlags: false, sessionFlags: false };
    await withPi(baseUrl, async (pi, restart) => {
      assert.equal((await pi.command('get_state')).data.model.id, 'Qwen3.5-397b');
      const settings = JSON.parse(await readFile(join(pi.agentDir, 'settings.json'), 'utf8'));
      assert.equal(settings.defaultProvider, 'gigachat');
      assert.equal(settings.defaultModel, 'Qwen3.5-397b');
      assert.equal(settings.theme, 'light');
      await pi.prompt('Use the default model.');
      assert.equal(requests[0].body.model, 'Qwen3.5-397b');
      const changed = await pi.command('set_model', { provider: 'gigachat', modelId: 'glm-5.2' });
      assert.equal(changed.success, true, changed.error);
      // RPC changes only the session model; simulate the saved interactive /model preference.
      await writeFile(join(pi.agentDir, 'settings.json'), JSON.stringify({ ...settings, defaultModel: 'glm-5.2' }));
      runtime.expectedModel = 'glm-5.2';
      pi = await restart();
      assert.equal((await pi.command('get_state')).data.model.id, 'glm-5.2');
    }, { defaultProvider: 'gigachat', defaultModel: 'glm-5.2', theme: 'light' }, runtime);
  });
});

test('postinstall creates default settings in the standard Pi directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-gigachat-home-'));
  const env = { ...cleanEnv(), HOME: home };
  delete env.PI_CODING_AGENT_DIR;
  try {
    execFileSync(process.execPath, [script], { env });
    assert.deepEqual(JSON.parse(await readFile(join(home, '.pi/agent/settings.json'), 'utf8')), {
      defaultProvider: 'gigachat', defaultModel: 'Qwen3.5-397b',
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('postinstall refuses to overwrite malformed settings', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-gigachat-invalid-'));
  const settingsPath = join(agentDir, 'settings.json');
  try {
    for (const original of ['{invalid', 'null', '[]', '"text"']) {
      await writeFile(settingsPath, original);
      assert.throws(() => execFileSync(process.execPath, [script], {
        env: { ...cleanEnv(), PI_CODING_AGENT_DIR: agentDir }, stdio: 'pipe',
      }));
      assert.equal(await readFile(settingsPath, 'utf8'), original);
    }
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test('packed npm installation forces Qwen over the saved default and Pi uses it without model flags', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-gigachat-install-'));
  const agentDir = join(dir, 'agent');
  const original = { defaultProvider: 'openai', defaultModel: 'old-model',
    theme: 'light', packages: ['other-extension'], retry: { enabled: false } };
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
    await mkdir(join(dir, 'npm'));
    const env = { ...cleanEnv(), PI_CODING_AGENT_DIR: agentDir };
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
      cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const archive = Object.values(packed)[0];
    assert(archive.files.some(file => file.path === 'scripts/postinstall.mjs'));
    await writeFile(join(dir, 'npm/package.json'), JSON.stringify({
      private: true, allowScripts: { [`file:${join(dir, archive.filename)}`]: true },
    }));
    execFileSync('npm', ['install', join(dir, archive.filename), '--prefix', join(dir, 'npm'),
      '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', '--ignore-scripts=false'], {
      env, stdio: 'pipe', timeout: 45000,
    });
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { ...original, defaultProvider: 'gigachat', defaultModel: 'Qwen3.5-397b' });
    await withServer(async ({ baseUrl, requests }) => {
      await withPi(baseUrl, async pi => {
        const state = await pi.command('get_state');
        assert.equal(state.data.model.provider, 'gigachat');
        assert.equal(state.data.model.id, 'Qwen3.5-397b');
        await pi.prompt('Say hello.');
        assert.equal(requests[0].body.model, 'Qwen3.5-397b');
        const changed = await pi.command('set_model', { provider: 'gigachat', modelId: 'glm-5.2' });
        assert.equal(changed.success, true, changed.error);
        assert.equal((await pi.command('get_state')).data.model.id, 'glm-5.2');
      }, { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel }, { modelFlags: false });
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
