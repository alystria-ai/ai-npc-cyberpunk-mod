// Measures what a picture adds to a Local AI turn (docs/COMPANION_VISION.md, "Measured"): llama-server is started on a loopback port with a model and its vision projector, and the
// same turn is asked with and without a 768 px picture, alternating, behind a warm system prompt so the persona prefix is cached as it is in the game. It reports, per turn, the
// time to the first word, the prompt tokens the server read (`prompt_n`, which includes the picture's tokens), the cached tokens (`cache_n`) and the prompt time the server counted
// (`prompt_ms`, which includes the image encoder). It stops only the server it started. It needs a model and ITS projector (nothing is downloaded here) and uses the graphics card for
// a minute, so run it when nothing else needs the card.
//
//   node scripts/Measure-VisionPrefill.mjs --model <chat.gguf> --mmproj <projector.gguf> --picture <file.jpg[,more.jpg,...]> [--server <llama-server.exe>] [--runs 8] [--image-max-tokens 320]
//     [--context 8192] [--device Vulkan0] [--no-projector] [--describe]
//   Give a different picture for every turn (a comma list, runs + 2 files): the same picture twice lets the server reuse the first one's tokens from its cache, which a game turn never can (every frame is new), and it
//   understates the cost. With fewer files the pictures are used round and round.
//   --no-projector starts the server without --mmproj and measures the text turns only (the baseline for load time and graphics memory). --describe also asks for one longer reply to the
//   picture and prints it, to show the model really reads it. The load line reports the time until /health answers and the graphics memory used (nvidia-smi, whole card, minus what was
//   in use before the server started), and the last line reports the card's clocks and power while the turns ran.
import {spawn, spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {withImages} from '../bridge/vision-message.mjs';
import {LOCAL_VISION} from '../bridge/local-vision.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const flag = name => args.includes(name);
const noProjector = flag('--no-projector'), describe = flag('--describe');
const model = value('--model'), mmproj = value('--mmproj'), pictureFiles = String(value('--picture', '')).split(',').filter(Boolean);
const server = value('--server', 'E:/CyberpunkConvai-offload/work/local-llm/llama-vulkan/llama-server.exe');
const runs = Number(value('--runs', 8)), imageMaxTokens = Number(value('--image-max-tokens', LOCAL_VISION.imageMaxTokens)), context = value('--context', '8192'), device = value('--device');
if (!model || !pictureFiles.length || !existsSync(model) || !pictureFiles.every(file => existsSync(file)) || (!noProjector && (!mmproj || !existsSync(mmproj)))) { console.error('Give --model, --mmproj (the projector made for that model) and --picture (a JPEG, for example one saved by scripts/Measure-VisionPicture.mjs --save-dir), all files that exist.'); process.exit(2); }
if (!existsSync(server)) { console.error(`llama-server not found at ${server}; name one with --server.`); process.exit(2); }

const freePort = () => new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolve(port)); }); });
const port = await freePort();
// nvidia-smi on the whole card (the card is shared with the desktop, so the number is the change from before the server started, read when the machine is otherwise idle).
const smi = fields => { try { const r = spawnSync('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], {encoding: 'utf8', windowsHide: true}); return r.stdout.trim().split(',').map(v => Number(v.trim()) || v.trim()); } catch { return []; } };
const usedBefore = smi('memory.used')[0];
const serverArgs = ['-m', model, ...(noProjector ? [] : ['--mmproj', mmproj, '--image-max-tokens', String(imageMaxTokens)]), '-ngl', '99', '-fa', 'on', '-c', context, '-np', '1', '--reasoning', 'off',
  '--cache-ram', '1024', '--host', '127.0.0.1', '--port', String(port), '--no-webui', ...(device ? ['--device', device] : [])];
const startedAt = performance.now();
const child = spawn(server, serverArgs, {windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']});
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on('exit', stop);
try {
  for (let waited = 0; ; waited += 500) {
    if (waited > 180_000) throw Error('the server did not come up in 3 minutes');
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not yet */ }
    await new Promise(done => setTimeout(done, 500));
  }
  const loadMs = Math.round(performance.now() - startedAt);
  const pictures = await Promise.all(pictureFiles.map(async file => ({mime: 'image/jpeg', base64: (await readFile(file)).toString('base64')})));
  let pictureIndex = 0;
  const nextPicture = () => pictures[pictureIndex++ % pictures.length];
  const persona = 'You are Judy Alvarez, a braindance editor in Night City, talking with V. Answer in one or two short spoken sentences, in character. '.repeat(40);
  const turn = text => ([{role: 'system', content: persona}, {role: 'user', content: `V says: ${text}`}]);
  const ask = async (text, withPicture) => {
    const messages = withPicture ? withImages(turn(text), [nextPicture()]) : turn(text);
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
  if (!noProjector) await ask('warm up with a picture', true);
  const memoryAfterWarm = smi('memory.used')[0];
  console.log(JSON.stringify({load: {projector: !noProjector, loadMs, gpuUsedMiBBefore: usedBefore, gpuUsedMiBAfterWarm: memoryAfterWarm, serverMiB: memoryAfterWarm - usedBefore}}));
  const rows = {without: [], with: []};
  const clockSamples = [];
  for (let run = 0; run < runs; run++) {
    for (const mode of (noProjector ? ['without'] : run % 2 ? ['with', 'without'] : ['without', 'with'])) rows[mode].push(await ask(`what do you see, round ${run}?`, mode === 'with'));
    clockSamples.push(smi('clocks.gr,clocks.max.gr,power.draw,pstate,memory.used'));
  }
  if (describe && !noProjector) {
    const reply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'local', messages: withImages(turn('what do you see?'), [nextPicture()]), stream: false, max_tokens: 90, temperature: 0.2})}).then(r => r.json());
    console.log(JSON.stringify({describe: reply.choices?.[0]?.message?.content ?? reply, promptTokens: reply.timings?.prompt_n}));
  }
  console.log(JSON.stringify({clocks: {samples: clockSamples.length, graphicsMHzMedian: clockSamples.map(s => s[0]).sort((a, b) => a - b)[Math.floor(clockSamples.length / 2)], maxGraphicsMHz: clockSamples[0]?.[1],
    powerWMedian: clockSamples.map(s => s[2]).sort((a, b) => a - b)[Math.floor(clockSamples.length / 2)], pstate: clockSamples.at(-1)?.[3], gpuUsedMiBDuringTurns: clockSamples.at(-1)?.[4]}}));
  const median = values => { const sorted = values.filter(v => v >= 0).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? null; };
  for (const mode of (noProjector ? ['without'] : ['without', 'with'])) {
    console.log(JSON.stringify({mode, turns: rows[mode].length, firstWordMsMedian: median(rows[mode].map(r => r.firstMs)), promptMsMedian: median(rows[mode].map(r => r.promptMs)),
      promptTokensMedian: median(rows[mode].map(r => r.promptTokens ?? -1)), cachedTokensMedian: median(rows[mode].map(r => r.cachedTokens ?? -1))}));
  }
  const delta = (name) => { const a = median(rows.with.map(r => r[name])), b = median(rows.without.map(r => r[name])); return a !== null && b !== null ? a - b : null; };
  if (!noProjector) console.log(JSON.stringify({picturecost: {firstWordMs: delta('firstMs'), promptMs: delta('promptMs'), promptTokens: delta('promptTokens')}}));
} finally { stop(); }
