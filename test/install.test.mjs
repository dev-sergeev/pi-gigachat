import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cleanEnv, withServer } from './helpers.mjs';
import { withPi } from './pi-rpc.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const modelSelection = state => state.model && { provider: state.model.provider, id: state.model.id };
const settingsCases = [
  ['fresh settings', {}],
  ['an existing other-provider default', {
    defaultProvider: 'openai', defaultModel: 'saved-consumer-model', theme: 'light',
    packages: [], retry: { enabled: false }, customPreference: { retain: true },
  }],
  ['old GigaChat defaults without migration', {
    defaultProvider: 'gigachat', defaultModel: 'Qwen3.5-397b', theme: 'light',
    packages: [], compaction: { enabled: false },
  }],
];

async function assertPassiveActivation(extensionPath, settings) {
  await withServer(async ({ baseUrl, requests }) => {
    const runtime = { packages: [], fixtureModels: false, modelFlags: false, sessionFlags: false };
    let nativeSelection;
    await withPi(baseUrl, async pi => {
      nativeSelection = modelSelection((await pi.command('get_state')).data);
    }, settings, runtime);
    await withPi(baseUrl, async (pi, restart) => {
      const assertUnchanged = async () => {
        assert.deepEqual(modelSelection((await pi.command('get_state')).data), nativeSelection,
          'Loading the extension must not change Pi\'s current model selection');
        assert.equal(await readFile(join(pi.agentDir, 'settings.json'), 'utf8'), pi.initialSettings,
          'Loading the extension must not rewrite settings, including obsolete defaults');
        const available = await pi.command('get_available_models');
        assert.equal(available.success, true, available.error);
        assert(!available.data.models.some(model => model.provider === 'gigachat' || model.provider.startsWith('gigachat-server-')),
          'No GigaChat models may be registered without an explicit saved connection');
        const commands = await pi.command('get_commands');
        assert.equal(commands.success, true, commands.error);
        assert(commands.data.commands.some(command => command.name === 'gigachat'),
          'The installed extension must activate its explicit connection command');
      };
      await assertUnchanged();
      for (const modelId of ['Qwen3.5-397b', 'glm-5.2']) {
        const selection = await pi.command('set_model', { provider: 'gigachat', modelId });
        assert.equal(selection.success, false, 'Former built-ins must not remain selectable');
      }
      await assertUnchanged();
      pi = await restart();
      await assertUnchanged();
      assert.equal(requests.length, 0, 'Installation and activation must not contact a GigaChat server');
    }, settings, { ...runtime, extensionPath });
  });
}

test('extension rejects unsupported host versions even with local Pi 0.85.1 peers', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-gigachat-host-version-'));
  try {
    const hostDir = join(dir, 'host');
    const installedHost = join(repo, 'node_modules/@earendil-works/pi-coding-agent');
    const hostPackage = JSON.parse(await readFile(join(installedHost, 'package.json'), 'utf8'));
    // A separate host tree exercises Pi's real aliases while native imports
    // from the extension still see the original local 0.85.1 peers.
    await cp(join(installedHost, 'dist'), join(hostDir, 'dist'), { recursive: true });
    await symlink(join(repo, 'node_modules'), join(hostDir, 'node_modules'), 'dir');
    const env = { ...cleanEnv(), HOME: dir, PI_CODING_AGENT_DIR: join(dir, 'agent') };
    delete env.PI_PACKAGE_DIR;
    for (const version of ['1.3.0', '0.85.0', '0.85.2', '0.85.1-rc.1']) {
      await writeFile(join(hostDir, 'package.json'), JSON.stringify({ ...hostPackage, version }));
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { VERSION as localVersion } from '@earendil-works/pi-coding-agent';
        import { pathToFileURL } from 'node:url';
        // Intentionally load the isolated host, not the extension's local peer.
        const { VERSION } = await import(pathToFileURL(process.argv[2] + '/dist/index.js'));
        const { loadExtensions } = await import(pathToFileURL(process.argv[2] + '/dist/core/extensions/loader.js'));
        const { extensions, errors } = await loadExtensions([process.argv[1]], process.cwd());
        console.log(JSON.stringify({ version: VERSION, localVersion, loaded: extensions.map(extension => extension.path), errors }));
      `, join(repo, 'extension.ts'), hostDir], {
        cwd: repo,
        env,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      }));
      assert.equal(result.version, version);
      assert.equal(result.localVersion, '0.85.1');
      assert.deepEqual(result.loaded, [], `Pi ${version} must not activate the extension`);
      assert.equal(result.errors.length, 1);
      assert(result.errors[0].error.includes(`Unsupported Pi version ${version}`), result.errors[0].error);
      assert.match(result.errors[0].error, /requires Pi 0\.85\.1/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [label, settings] of settingsCases) {
  test(`loading the local extension preserves ${label} and registers no built-ins`, { timeout: 30000 }, async () => {
    await assertPassiveActivation(join(repo, 'extension.ts'), settings);
  });
}

test('packed npm installation and activation leave fresh and existing Pi settings untouched', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-gigachat-install-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
      cwd: repo, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const archive = Object.values(packed)[0];
    for (const [index, [label, settings]] of settingsCases.entries()) {
      const home = join(dir, String(index));
      const agentDir = join(home, '.pi/agent');
      const installDir = join(home, 'npm');
      const settingsPath = join(agentDir, 'settings.json');
      await mkdir(installDir, { recursive: true });
      await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true }));
      const original = index === 0 ? undefined : JSON.stringify(settings, null, 2) + '\n';
      if (original !== undefined) {
        await mkdir(agentDir, { recursive: true });
        await writeFile(settingsPath, original);
      }
      const env = { ...cleanEnv(), HOME: home,
        npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm') };
      delete env.PI_CODING_AGENT_DIR;
      execFileSync('npm', ['install', join(dir, archive.filename), '--prefix', installDir,
        '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', '--ignore-scripts=false'], {
        env, stdio: 'pipe', timeout: 45000,
      });
      if (original === undefined) {
        await assert.rejects(readFile(settingsPath, 'utf8'), { code: 'ENOENT' },
          'Fresh npm installation must not create Pi settings');
      } else {
        assert.equal(await readFile(settingsPath, 'utf8'), original, `npm installation must preserve ${label}`);
      }
      const installed = join(installDir, 'node_modules/@dev-sergeev/pi-gigachat');
      await assertPassiveActivation(join(installed, 'extension.ts'), settings);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
