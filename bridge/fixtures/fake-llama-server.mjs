// A stand-in for llama-server.exe used by the local-llm-server and local-embed tests. Run with `node`.
//
// Parses the arguments the bridge passes (--host --port --api-key-file -m --device --embedding --list-devices ...),
// serves /health, /v1/chat/completions (stream and non-stream), /v1/embeddings (8 dimensions from a hash) and the
// test-only /__stats. Behaviour is steered by environment variables:
//   FAKE_LLAMA_DELAY_MS        /health answers 503 until this long after start
//   FAKE_LLAMA_NEVER_HEALTHY   /health always answers 503
//   FAKE_LLAMA_EXIT_AT_START   exit at once with this code
//   FAKE_LLAMA_EXIT_FOR_MODEL  exit(1) at once when the -m file path contains this text (a model llama.cpp cannot load)
//   FAKE_LLAMA_CRASH_AFTER     exit(7) right after answering this many /v1 requests
//   FAKE_LLAMA_REPLY           the chat reply text (default: an echo of the last user message)
//   FAKE_LLAMA_DEVICES         the device lines printed by --list-devices
//   FAKE_LLAMA_PRINT_KEY       print the API key to stderr (to test redaction)
//   FAKE_LLAMA_ARGS_FILE       write the received argv (JSON) here
//   FAKE_LLAMA_CTX             the n_ctx /props reports (default: the -c argument, else 4096)
//   FAKE_LLAMA_CHARS_PER_TOKEN characters per token for /tokenize, the prompt count and the context check (default 4)
//   FAKE_LLAMA_TEMPLATE        the chat_template text /props reports (default: none); FAKE_LLAMA_EOS / FAKE_LLAMA_BOS the tokens, FAKE_LLAMA_BUILD the build_info
//   FAKE_LLAMA_FIRST_TOKEN_MS  wait this long before the first piece of a streamed reply
//   FAKE_LLAMA_STALL           'role': send the opening role chunk of a streamed reply and then nothing, until the client goes away;
//                              'progress': send prompt_progress chunks up to half the prompt, then nothing;
//                              'mid': send two pieces of the reply and then nothing
//   FAKE_LLAMA_THINK           this many reasoning_content pieces and no reply text, then finish_reason stop
//   FAKE_LLAMA_BODIES_FILE     append each streamed chat request body (JSON, one per line) to this file
// A request whose prompt is longer than the context is refused like the real server does (400, exceed_context_size_error).
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';

const argv = process.argv.slice(2);
const booleans = new Set(['--embedding', '--embeddings', '--no-webui', '--list-devices']);
const options = {};
for (let index = 0; index < argv.length; index++) {
  const flag = argv[index];
  if (!flag.startsWith('-')) continue;
  if (booleans.has(flag)) options[flag] = true;
  else options[flag] = argv[++index];
}
if (process.env.FAKE_LLAMA_ARGS_FILE) writeFileSync(process.env.FAKE_LLAMA_ARGS_FILE, JSON.stringify(argv));

if (options['--list-devices']) {
  const lines = process.env.FAKE_LLAMA_DEVICES
    ?? '  Vulkan0: Intel(R) UHD Graphics (16000 MiB, 15000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)';
  process.stdout.write('Available devices:\n' + lines + '\n');
  process.exit(0);
}
if (process.env.FAKE_LLAMA_EXIT_AT_START) {
  process.stderr.write('fake-llama: exiting at start\n');
  process.exit(Number(process.env.FAKE_LLAMA_EXIT_AT_START));
}

if (process.env.FAKE_LLAMA_EXIT_FOR_MODEL && String(options['-m'] ?? '').includes(process.env.FAKE_LLAMA_EXIT_FOR_MODEL)) {
  process.stderr.write('fake-llama: cannot load this model\n');
  process.exit(1);
}

const keyFile = options['--api-key-file'];
if (!keyFile || !existsSync(keyFile)) { process.stderr.write('fake-llama: missing --api-key-file\n'); process.exit(2); }
const key = readFileSync(keyFile, 'utf8').split(/\r?\n/)[0].trim();
if (process.env.FAKE_LLAMA_PRINT_KEY) process.stderr.write('debug key=' + key + '\n');
const port = Number(options['--port']);
const host = options['--host'] ?? '127.0.0.1';
const startedAt = Date.now();
const delayMs = Number(process.env.FAKE_LLAMA_DELAY_MS || 0);
const crashAfter = Number(process.env.FAKE_LLAMA_CRASH_AFTER || 0);
const contextSize = Number(process.env.FAKE_LLAMA_CTX || options['-c'] || 4096);
const charsPerToken = Number(process.env.FAKE_LLAMA_CHARS_PER_TOKEN || 4);
const embedding = Boolean(options['--embedding'] || options['--embeddings']);
const requests = [];
let served = 0;

const vector = text => {
  const digest = createHash('sha256').update(String(text)).digest();
  return Array.from({length: 8}, (_, index) => (digest[index] - 127.5) / 32);   // not normalised on purpose
};

const send = (response, status, body, type = 'application/json') => {
  response.writeHead(status, {'content-type': type});
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = createServer((request, response) => {
  const url = request.url.split('?')[0];
  if (url === '/health') {
    const healthy = !process.env.FAKE_LLAMA_NEVER_HEALTHY && Date.now() - startedAt >= delayMs;
    return send(response, healthy ? 200 : 503, healthy ? {status: 'ok'} : {error: {code: 503, message: 'Loading model'}});
  }
  if (url === '/__stats') return send(response, 200, {pid: process.pid, argv, embedding, device: options['--device'] ?? null,
    model: options['-m'] ?? null, requests});
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    if (request.headers.authorization !== 'Bearer ' + key) return send(response, 401, {error: {message: 'Invalid API Key'}});
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch { return send(response, 400, {error: {message: 'bad json'}}); }
    served++;
    const finish = () => { if (crashAfter && served >= crashAfter) setTimeout(() => process.exit(7), 10); };
    if (url === '/v1/embeddings') {
      const inputs = Array.isArray(json.input) ? json.input : [json.input];
      requests.push({path: url, inputs: inputs.length, chars: inputs.map(text => String(text).length)});
      send(response, 200, {object: 'list', model: json.model, data: inputs.map((text, index) => ({object: 'embedding', index, embedding: vector(text)}))});
      return finish();
    }
    if (url === '/props') return send(response, 200, {default_generation_settings: {n_ctx: contextSize}, total_slots: 1,
      ...(process.env.FAKE_LLAMA_TEMPLATE ? {chat_template: process.env.FAKE_LLAMA_TEMPLATE} : {}), ...(process.env.FAKE_LLAMA_EOS ? {eos_token: process.env.FAKE_LLAMA_EOS} : {}),
      ...(process.env.FAKE_LLAMA_BOS ? {bos_token: process.env.FAKE_LLAMA_BOS} : {}), ...(process.env.FAKE_LLAMA_BUILD ? {build_info: process.env.FAKE_LLAMA_BUILD} : {}),
      model_path: String(options['-m'] ?? ''), model_ftype: 'Q4_K_M'});
    if (url === '/tokenize') {
      requests.push({path: url, chars: String(json.content ?? '').length});
      return send(response, 200, {tokens: Array.from({length: Math.ceil(String(json.content ?? '').length / charsPerToken)}, (_, index) => index)});
    }
    if (url === '/v1/chat/completions') {
      const messages = Array.isArray(json.messages) ? json.messages : [];
      const promptChars = messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0);
      const promptTokens = Math.ceil(promptChars / charsPerToken) + messages.length * 4;
      if (promptTokens > contextSize) {
        requests.push({path: url, refused: true, promptChars, promptTokens});
        return send(response, 400, {error: {code: 400, type: 'exceed_context_size_error', n_prompt_tokens: promptTokens, n_ctx: contextSize,
          message: `request (${promptTokens} tokens) exceeds the available context size (${contextSize} tokens), try increasing it`}});
      }
      requests.push({path: url, stream: Boolean(json.stream), maxTokens: json.max_tokens ?? null, promptChars, promptTokens,
        cachePrompt: json.cache_prompt ?? null, messages: messages.length});
      const last = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
      let reply = process.env.FAKE_LLAMA_REPLY ?? 'Echo: ' + String(last).slice(0, 40);
      if (json.max_tokens === 1) reply = reply.split(' ')[0];
      if (json.stream && process.env.FAKE_LLAMA_BODIES_FILE) appendFileSync(process.env.FAKE_LLAMA_BODIES_FILE, JSON.stringify(json) + '\n');
      if (json.stream && (process.env.FAKE_LLAMA_STALL || process.env.FAKE_LLAMA_THINK || process.env.FAKE_LLAMA_FIRST_TOKEN_MS)) {
        const write = chunk => { if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify(chunk) + '\n\n'); };
        const role = {choices: [{index: 0, delta: {role: 'assistant', content: null}, finish_reason: null}]};
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const stall = process.env.FAKE_LLAMA_STALL;
        if (stall === 'role') { write(role); return finish(); }   // and then silence until the client goes away
        if (stall === 'progress') {
          const total = promptTokens;
          for (const processed of [Math.ceil(total / 8), Math.ceil(total / 4), Math.ceil(total / 2)]) write({...role, prompt_progress: {total, cache: 0, processed, time_ms: processed}});
          return finish();
        }
        const think = Number(process.env.FAKE_LLAMA_THINK || 0);
        if (think > 0) {
          let sent = 0;
          const timer = setInterval(() => {
            if (response.destroyed || response.writableEnded) { clearInterval(timer); return; }
            if (sent++ < think) return write({choices: [{index: 0, delta: {reasoning_content: 'hmm '}, finish_reason: null}]});
            clearInterval(timer);
            write({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
            response.end('data: [DONE]\n\n');
          }, 5);
          return finish();
        }
        const pieces = reply.split(/(?<= )/);
        setTimeout(() => {
          write(role);
          pieces.slice(0, stall === 'mid' ? 2 : pieces.length).forEach(word => write({choices: [{index: 0, delta: {content: word}, finish_reason: null}]}));
          if (stall === 'mid') return;
          write({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
          write({choices: [], usage: {prompt_tokens: promptTokens, completion_tokens: pieces.length}, timings: {prompt_n: promptTokens, cache_n: 0, prompt_ms: 12, predicted_n: pieces.length, predicted_per_second: 50}});
          response.end('data: [DONE]\n\n');
        }, Number(process.env.FAKE_LLAMA_FIRST_TOKEN_MS || 0));
        return finish();
      }
      if (json.stream) {
        response.writeHead(200, {'content-type': 'text/event-stream'});
        for (const word of reply.split(/(?<= )/))
          response.write('data: ' + JSON.stringify({choices: [{index: 0, delta: {content: word}}]}) + '\n\n');
        response.write('data: ' + JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}) + '\n\n');
        if (json.stream_options?.include_usage) response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: promptTokens, completion_tokens: reply.split(' ').length}}) + '\n\n');
        response.end('data: [DONE]\n\n');
      } else {
        send(response, 200, {object: 'chat.completion', model: json.model, choices: [{index: 0, message: {role: 'assistant', content: reply}, finish_reason: 'stop'}],
          usage: {prompt_tokens: promptTokens, completion_tokens: 1}});
      }
      return finish();
    }
    send(response, 404, {error: {message: 'not found'}});
  });
});
server.listen(port, host, () => process.stdout.write('fake-llama: listening on ' + host + ':' + port + '\n'));
process.on('SIGTERM', () => process.exit(0));
