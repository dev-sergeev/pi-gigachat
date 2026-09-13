import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { streamSimpleGigaChat } from '../dist/stream.js';
import { GIGACHAT_MODELS } from '../dist/models.js';

// All credentials are synthetic, and every request goes to loopback.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIGACHAT_')) delete process.env[key];
}
const token = 'test.synthetic.token';
const completion = (message = { role:'assistant', content:'Привет! 👋' }, reason = 'stop') => ({
  choices:[{index:0, message, finish_reason:reason}],
  created:1, model:'GigaChat-3-Ultra', object:'chat.completion',
  usage:{prompt_tokens:12, completion_tokens:4, total_tokens:16},
});
function json(res, body, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}
async function withServer(run, respond = (_request,res) => json(res,completion())) {
  const requests = [];
  const server = createServer(async (req,res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const raw = Buffer.concat(buffers).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const request = {url:req.url, headers:req.headers, body};
    requests.push(request);
    respond(request,res);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const model = {...GIGACHAT_MODELS.at(-1),provider:'gigachat',api:'gigachat-extension-api',baseUrl};
  try { await run({model,requests,baseUrl}); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function ask(model, options = {}, context = {messages:[{role:'user',content:'Привет',timestamp:0}]}) {
  const stream = streamSimpleGigaChat(model,context,{apiKey:token,...options});
  const events = [];
  for await (const event of stream) events.push(event);
  return {events,result:await stream.result()};
}

test('sends stream:false, accepts JSON, and emits complete pi text events with usage', async () => {
  await withServer(async ({model,requests}) => {
    const {events,result} = await ask(model);
    assert.equal(requests[0].body.stream,false);
    assert.equal(requests[0].headers.accept,'application/json');
    assert.equal(requests[0].headers.authorization,'Bearer '+token);
    assert.equal(result.stopReason,'stop');
    assert.equal(result.content[0].text,'Привет! 👋');
    assert.deepEqual(events.map(e=>e.type),['start','text_start','text_delta','text_end','done']);
    assert.deepEqual([result.usage.input,result.usage.output,result.usage.totalTokens],[12,4,16]);
  });
});

test('payload hooks cannot re-enable network streaming', async () => {
  await withServer(async ({model,requests}) => {
    const {result} = await ask(model,{onPayload(payload) { payload.stream=true; return payload; }});
    assert.equal(requests[0].body.stream,false);
    assert.equal(result.stopReason,'stop');
  });
});

test('complete JSON tool calls preserve arguments and close text before tool events', async () => {
  const args = {path:'demo.txt',content:'literal \\n and \\"quoted\\"; actual newline\n🙂'};
  await withServer(async ({model}) => {
    const {result,events} = await ask(model);
    assert.equal(result.stopReason,'toolUse');
    const call = result.content.find(c=>c.type==='toolCall');
    assert.equal(call.name,'write');
    assert.deepEqual(call.arguments,args);
    assert(call.id);
    assert(!('partialArgs' in call));
    assert.deepEqual(events.map(e=>e.type),['start','text_start','text_delta','text_end','toolcall_start','toolcall_delta','toolcall_end','done']);
  },(_req,res)=>json(res,completion({role:'assistant',content:'Запишу файл.',function_call:{name:'write',arguments:args}},'function_call')));
});

test('JSON length finish reason and empty text are valid terminal responses', async () => {
  await withServer(async ({model}) => {
    const {result,events}=await ask(model);
    assert.equal(result.stopReason,'length');
    assert.equal(events.at(-1).type,'done');
  },(_req,res)=>json(res,completion({role:'assistant',content:''},'length')));
});

for (const [name,body] of [
  ['empty choices',{choices:[]}],
  ['missing finish reason',{choices:[{message:{role:'assistant',content:'incomplete'}}]}],
  ['missing function call',completion({role:'assistant',content:''},'function_call')],
]) {
  test(`rejects ${name} instead of reporting successful completion`,async()=>{
    await withServer(async ({model})=>{
      const {result,events}=await ask(model);
      assert.equal(result.stopReason,'error');
      assert.equal(events.at(-1).type,'error');
      assert(!events.some(e=>e.type==='done'));
    },(_req,res)=>json(res,body));
  });
}

test('reports HTTP quota errors without treating JSON errors as model replies',async()=>{
  await withServer(async ({model})=>{
    const {result}=await ask(model);
    assert.equal(result.stopReason,'error');
    assert.match(result.errorMessage,/quota/i);
  },(_req,res)=>json(res,{message:'Quota exhausted'},402));
});

test('aborting while waiting for a JSON response terminates the pi event stream',async()=>{
  const controller = new AbortController();
  await withServer(async ({model})=>{
    const {result,events}=await ask(model,{signal:controller.signal});
    assert.equal(result.stopReason,'aborted');
    assert.equal(events.at(-1).type,'error');
    assert(!events.some(e=>e.type==='text_delta'));
  },()=>controller.abort());
});

test('a rejected access token produces an explicit HTTP 401 error', async () => {
  await withServer(async ({ model, requests }) => {
    const { result } = await ask(model);
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /401.*Expired/);
    assert.equal(requests.length, 1);
  }, (_req, res) => json(res, { message: 'Expired' }, 401));
});
