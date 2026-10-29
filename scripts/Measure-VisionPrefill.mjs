// Measures what a picture adds to a Local AI turn (docs/COMPANION_VISION.md, "Measured"): llama-server is started on a loopback port with a model and its vision projector, and the
// same turn is asked with and without a 768 px picture, alternating, behind a warm system prompt so the persona prefix is cached as it is in the game. It reports, per turn, the
// time to the first word, the prompt tokens the server read (`prompt_n`, which includes the picture's tokens), the cached tokens (`cache_n`) and the prompt time the server counted
// (`prompt_ms`, which includes the image encoder). It stops only the server it started. It needs a model and ITS projector (nothing is downloaded here) and uses the graphics card for
// a minute, so run it when nothing else needs the card.
//
//   node scripts/Measure-VisionPrefill.mjs --model <chat.gguf> --mmproj <projector.gguf> --picture <file.jpg> [--server <llama-server.exe>] [--runs 8] [--image-max-tokens 320]
//     [--context 8192] [--device Vulkan0]
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {withImages} from '../bridge/vision-message.mjs';
import {LOCAL_VISION} from '../bridge/local-vision.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const model = value('--model'), mmproj = value('--mmproj'), pictureFile = value('--picture');
const server = value('--server', 'E:/CyberpunkConvai-offload/work/local-llm/llama-vulkan/llama-server.exe');
const runs = Number(value('--runs', 8)), imageMaxTokens = Number(value('--image-max-tokens', LOCAL_VISION.imageMaxTokens)), context = value('--context', '8192'), device = value('--device');
if (!model || !mmproj || !pictureFile || !existsSync(model) || !existsSync(mmproj) || !existsSync(pictureFile)) { console.error('Give --model, --mmproj (the projector made for that model) and --picture (a JPEG, for example one saved by scripts/Measure-VisionPicture.mjs --save-dir), all files that exist.'); process.exit(2); }
if (!existsSync(server)) { console.error(`llama-server not found at ${server}; name one with --server.`); process.exit(2); }

const freePort = () => new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolve(port)); }); });
const port = await freePort();
const serverArgs = ['-m', model, '--mmproj', mmproj, '--image-max-tokens', String(imageMaxTokens), '-ngl', '99', '-fa', 'on', '-c', context, '-np', '1', '--reasoning', 'off',
  '--cache-ram', '1024', '--host', '127.0.0.1', '--port', String(port), '--no-webui', ...(device ? ['--device', device] : [])];
const child = spawn(server, serverArgs, {windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']});
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on('exit', stop);
try {
  for (let waited = 0; ; waited += 500) {
    if (waited > 180_000) throw Error('the server did not come up in 3 minutes');
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not yet */ }
    await new Promise(done => setTimeout(done, 500));
  }
  const picture = {mime: 'image/jpeg', base64: (await readFile(pictureFile)).toString('base64')};
  const persona = 'You are Judy Alvarez, a braindance editor in Night City, talking with V. Answer in one or two short spoken sentences, in character. '.repeat(40);
  const turn = text => ([{role: 'system', content: persona}, {role: 'user', content: `V says: ${text}`}]);
  const ask = async (text, withPicture) => {
    const messages = withPicture ? withImages(turn(text), [picture]) : turn(text);
    const began = performance.now();
    let first = null, timings = null;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'local', messages, stream: true, max_tokens: 24, temperature: 0.7, stop: ['<turn|>']})});
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const part of response.body) {
      buffer += decoder.decode(part, {stream: true});
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const data = event.startsWith('data: ') ? event.slice(6) : '';
        if (!data || data === '[DONE]') continue;
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        if (first === null && chunk.choices?.[0]?.delta?.content) first = performance.now() - began;
        if (chunk.timings) timings = chunk.timings;
      }
    }
    return {firstMs: Math.round(first ?? -1), promptTokens: timings?.prompt_n ?? null, cachedTokens: timings?.cache_n ?? null, promptMs: Math.round(timings?.prompt_ms ?? -1)};
  };
  await ask('warm up', false);
  const rows = {without: [], with: []};
  for (let run = 0; run < runs; run++) {
    for (const mode of run % 2 ? ['with', 'without'] : ['without', 'with']) rows[mode].push(await ask(`what do you see, round ${run}?`, mode === 'with'));
  }
  const median = values => { const sorted = values.filter(v => v >= 0).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? null; };
  for (const mode of ['without', 'with']) {
    console.log(JSON.stringify({mode, turns: rows[mode].length, firstWordMsMedian: median(rows[mode].map(r => r.firstMs)), promptMsMedian: median(rows[mode].map(r => r.promptMs)),
      promptTokensMedian: median(rows[mode].map(r => r.promptTokens ?? -1)), cachedTokensMedian: median(rows[mode].map(r => r.cachedTokens ?? -1))}));
  }
  const delta = (name) => { const a = median(rows.with.map(r => r[name])), b = median(rows.without.map(r => r[name])); return a !== null && b !== null ? a - b : null; };
  console.log(JSON.stringify({picturecost: {firstWordMs: delta('firstMs'), promptMs: delta('promptMs'), promptTokens: delta('promptTokens')}}));
} finally { stop(); }
