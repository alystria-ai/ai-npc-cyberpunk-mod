// A mock OpenAI-compatible chat-completions server on a loopback port, for the tests of the custom provider (bridge/custom-endpoint.mjs,
// docs/CUSTOM_PROVIDER.md). Test-only: nothing in the mod uses it, and it never leaves this computer (127.0.0.1, a port the system picks).
//
//   const mock = await startOpenAiMock();                  // mock.url is 'http://127.0.0.1:<port>/v1'
//   mock.behave(request => ({status: 429, headers: {'retry-after': '2'}, body: {error: {message: 'slow down'}}}));
//   ...                                                    // mock.requests: [{method, url, headers, body}] in arrival order
//   await mock.close();
//
// `behave(handler)`: handler(request, index) returns what to answer:
//   {sse: ['Hello', ' there.'], model, finish: 'stop'}   a streamed reply, one delta per text, then the finish chunk and [DONE]
//   {sse: [{reasoning: 'hmm'}, 'Hello'], usage}          an item that is an object is the delta as it is (reasoning fields, a role, tool calls...)
//   {sse: [...], cut: true}                              the stream ends after the deltas with no finish and no [DONE]
//   {json: {...}}                                        a plain JSON body (status 200 unless `status` is set)
//   {status, headers, body}                              an error answer (body is an object, or a string sent as it is)
//   {redirect: 'http://elsewhere/...'}                   a 307 to another address
//   {hang: true}                                         never answers (until the server is closed)
// Without a handler the answer is the streamed reply "Hello from the mock." (or the same as plain JSON when the request asked for `stream: false`).
import {createServer} from 'node:http';

export const MOCK_REPLY = 'Hello from the mock.';

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({id: 'mock', object: 'chat.completion.chunk', model: extra.model ?? 'mock-model', choices: [{index: 0, delta, finish_reason: extra.finish ?? null}], ...(extra.usage ? {usage: extra.usage} : {})})}\n\n`;

export async function startOpenAiMock({host = '127.0.0.1'} = {}) {
  const requests = [];
  const sockets = new Set();
  let handler = null;
  const server = createServer((request, response) => {
    const parts = [];
    request.on('data', part => parts.push(part));
    request.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const record = {method: request.method, url: request.url, headers: {...request.headers}, body};
      requests.push(record);
      const plan = (handler ? handler(record, requests.length - 1) : null) ?? (body?.stream === false ? {json: completion(MOCK_REPLY)} : {sse: [MOCK_REPLY]});
      respond(response, plan);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

  function completion(text, model = 'mock-model') {
    return {id: 'mock', object: 'chat.completion', model, choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}], usage: {prompt_tokens: 5, completion_tokens: 5, total_tokens: 10}};
  }

  function respond(response, plan) {
    if (plan.hang) return;   // closed with the server
    if (plan.redirect) { response.writeHead(307, {location: plan.redirect}); response.end(); return; }
    if (plan.sse) {
      response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...plan.headers});
      response.write(': keep-alive\n\n');
      for (const [index, item] of plan.sse.entries()) {
        const delta = typeof item === 'string' ? (index === 0 ? {role: 'assistant', content: item} : {content: item}) : item;
        response.write(chunk(delta, {model: plan.model}));
      }
      if (plan.cut) { response.end(); return; }
      response.write(chunk({}, {finish: plan.finish ?? 'stop', model: plan.model, usage: plan.usage}));
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    if (plan.json) {
      response.writeHead(plan.status ?? 200, {'content-type': 'application/json', ...plan.headers});
      response.end(JSON.stringify(plan.json));
      return;
    }
    const status = plan.status ?? 500;
    const isText = typeof plan.body === 'string';
    response.writeHead(status, {'content-type': isText ? 'text/plain' : 'application/json', ...plan.headers});
    response.end(isText ? plan.body : JSON.stringify(plan.body ?? {error: {message: `HTTP ${status}`}}));
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const {port} = server.address();
  return {
    port, host, url: `http://${host}:${port}/v1`, origin: `http://${host}:${port}`, requests,
    behave(next) { handler = next; },
    completion,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
