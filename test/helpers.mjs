import { createServer } from 'node:http';
import { createModels } from '@earendil-works/pi-ai';
import { gigachatProvider } from '../dist/index.js';
import { GIGACHAT_MODELS } from '../dist/models.js';

export const token = 'test.synthetic.token';
export const user = (content) => ({ role: 'user', content, timestamp: 0 });
export const completion = (message = { role: 'assistant', content: 'OK' }, reason = 'stop', usage) => ({
  choices: [{ index: 0, message, finish_reason: reason }],
  usage: usage ?? { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
});
export function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
export function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIGACHAT_|HTTPS?_PROXY$|ALL_PROXY$|https?_proxy$|all_proxy$)/.test(key)) delete env[key];
  }
  return env;
}
export async function withServer(run, respond = (_request, res) => json(res, completion())) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const raw = Buffer.concat(buffers).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const request = { url: req.url, headers: req.headers, body };
    requests.push(request);
    try { await respond(request, res, requests); }
    catch (error) { json(res, { message: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const model = { ...GIGACHAT_MODELS.find(model => model.id === 'GigaChat-3-Ultra'), provider: 'gigachat', api: 'gigachat-extension-api', baseUrl };
  try { return await run({ model, requests, baseUrl }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
export async function ask(model, context = { messages: [user('Hi')] }, options = {}) {
  const models = createModels();
  models.setProvider(gigachatProvider);
  return models.completeSimple(model, context, { ...options, env: { GIGACHAT_ACCESS_TOKEN: token, ...options.env } });
}

export function reply(req, res, result) {
  if (!req.body.stream) return json(res, result);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const choice = result.choices[0];
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: choice.message, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: result.usage }) + '\n\ndata: [DONE]\n\n');
}
