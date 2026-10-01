import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Keep installation independent of Pi's optional, host-provided peer packages.
const configuredDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = configuredDir
  ? resolve(configuredDir.replace(/^~(?=$|\/)/, homedir()))
  : join(homedir(), '.pi', 'agent');
const settingsPath = join(agentDir, 'settings.json');
let settings = {};
let mode = 0o600;
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  mode = statSync(settingsPath).mode & 0o777;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  throw new Error(`Expected a settings object in ${settingsPath}`);
}
settings.defaultProvider = 'gigachat';
settings.defaultModel = 'Qwen3.5-397b';
mkdirSync(agentDir, { recursive: true });
const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
try {
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: 'wx' });
  renameSync(temporaryPath, settingsPath);
  writeFileSync(join(agentDir, '.pi-gigachat-default-model'), '0.4.0\n', { mode: 0o600 });
} finally {
  rmSync(temporaryPath, { force: true });
}
console.log('pi-gigachat: default model set to gigachat / Qwen3.5-397b');
