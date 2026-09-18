import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { cleanEnv, token } from './helpers.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
export const cliPath = process.env.PI_TEST_CLI ?? join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
export const piRoot = resolve(dirname(cliPath), '..');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function withPi(baseUrl, run, settings = {}, runtime = {}) {
  const modelId = runtime.model ?? 'GigaChat-3-Ultra';
  const dir = await mkdtemp(join(tmpdir(), 'pi-gigachat-test-'));
  const agentDir = join(dir, 'agent');
  const sessionFile = join(dir, 'session.jsonl');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [repo], retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 256 }, ...settings,
  }));
  let current;
  async function start() {
    const events = [];
    const pending = new Map();
    let counter = 0;
    let stderr = '';
    const child = spawn(process.execPath, [cliPath, '--mode', 'rpc', '--session', sessionFile,
      '--provider', 'gigachat', '--model', modelId, ...(runtime.tools ? ['--tools', runtime.tools] : ['--no-tools']), '--no-skills', '--no-prompt-templates'], {
      cwd: dir, env: { ...cleanEnv(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
        GIGACHAT_ACCESS_TOKEN: token, GIGACHAT_BASE_URL: baseUrl, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', data => { stderr += data; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      events.push(event);
      if (event.type === 'response' && pending.has(event.id)) {
        pending.get(event.id)(event); pending.delete(event.id);
      } else if (event.type === 'response' && event.command === 'parse' && !event.success && pending.size === 1) {
        // pi 0.58 reports exceptions without the original command id.
        const [id, resolve] = pending.entries().next().value;
        resolve(event); pending.delete(id);
      }
    });
    const command = async (type, args = {}) => {
      const id = String(++counter);
      let timer;
      const response = await Promise.race([
        new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC ${type} timed out; ${stderr.slice(-1500)}`)), runtime.timeout ?? 20000); }),
      ]).finally(() => clearTimeout(timer));
      return response;
    };
    current = {
      events, command, sessionFile,
      async entries() { return (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse); },
      async prompt(message) {
        const startIndex = events.length;
        const response = await command('prompt', { message });
        if (!response.success) throw new Error(response.error);
        await until(() => events.slice(startIndex).some(e => e.type === 'agent_end'), 'agent_end', runtime.timeout ?? 15000);
        await until(async () => {
          const state = await command('get_state');
          return !state.data.isStreaming && !state.data.isCompacting;
        }, 'idle');
      },
      async stop() {
        if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
        lines.close();
      },
    };
    const response = await command('get_state');
    if (!response.success || response.data.model?.id !== modelId) throw new Error('Provider did not load');
    return current;
  }
  try { await run(await start(), async () => { await current.stop(); return start(); }); }
  finally { await current?.stop(); await rm(dir, { recursive: true, force: true }); }
}
