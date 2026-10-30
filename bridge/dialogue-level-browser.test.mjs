import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// Real Edge, offline rendering only (nothing reaches an audio device): the
// limiter settings and their makeup cancellation must give exactly the
// requested level below the threshold, keep loud peaks under 0 dBFS, and delay
// audio by the look-ahead the player's lip-sync clock subtracts.
test('real Edge limiter: requested makeup below threshold, peaks held, known look-ahead', {timeout: 120000}, async t => {
  const allowed = new Set(['/continuous-pcm-player.mjs', '/continuous-pcm-core.mjs']);
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Level test</title>'); return; }
    if (!allowed.has(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/javascript');
    response.end(await readFile(new URL(`.${request.url}`, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--mute-audio']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const {LIMITER} = await import('/continuous-pcm-player.mjs');
      const rate = 24000;
      async function render(amplitude, makeupDb, {click = false, burst = false} = {}) {
        const context = new OfflineAudioContext({numberOfChannels: 2, length: rate * 2, sampleRate: rate});
        const buffer = context.createBuffer(1, rate * 2, rate), data = buffer.getChannelData(0);
        if (click) data[rate] = amplitude;
        else if (burst) for (let i = rate; i < data.length; i++) data[i] = amplitude * Math.sign(Math.sin(2 * Math.PI * 200 * i / rate) || 1);
        else for (let i = 0; i < data.length; i++) data[i] = amplitude * Math.sin(2 * Math.PI * 997 * i / rate);
        const source = context.createBufferSource(); source.buffer = buffer;
        const panner = context.createStereoPanner(), air = context.createBiquadFilter(), gain = context.createGain();
        air.type = 'lowpass'; air.Q.value = .7071; air.frequency.value = rate / 2;
        source.connect(panner); panner.connect(air); air.connect(gain);
        if (makeupDb !== 0) {
          const limiter = context.createDynamicsCompressor();
          limiter.threshold.value = LIMITER.threshold; limiter.knee.value = 0; limiter.ratio.value = LIMITER.ratio;
          limiter.attack.value = .001; limiter.release.value = .08;
          gain.gain.value = Math.pow(10, (makeupDb - LIMITER.makeupDb) / 20);
          gain.connect(limiter); limiter.connect(context.destination);
        } else gain.connect(context.destination);
        source.start();
        const out = (await context.startRendering()).getChannelData(0);
        let sum = 0, peak = 0, at = 0;
        for (let i = rate / 2; i < out.length; i++) { sum += out[i] * out[i]; if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); at = i; } }
        return {rms: Math.sqrt(sum / (out.length - rate / 2)), peak, at};
      }
      const unity = await render(.05, 0), boosted = await render(.05, 6), loud = await render(.9, 6);
      const plainClick = await render(.5, 0, {click: true}), limitedClick = await render(.05, 6, {click: true});
      // Voice volume (docs/DIALOGUE_LEVEL.md): the same graph with the dialogue level plus 300% (+15.54 dB), the most the file allows
      // plus 300% (+21.54 dB), full-scale speech, and 50% with matching off (-6.02 dB, a plain attenuation through the idle limiter).
      // V's voice at 300% alone (+9.54 dB), and the same speech arriving as a click or an abrupt burst (no ramp for the limiter to follow).
      const worst = [await render(.9, 15.54), await render(1, 15.54), await render(.9, 21.54), await render(1, 21.54), await render(1, 9.54),
        await render(1, 15.54, {burst: true}), await render(1, 21.54, {burst: true})];
      const clicks = [await render(1, 12.02, {click: true}), await render(1, 18.03, {click: true}), await render(1, 15.54, {click: true}), await render(1, 21.54, {click: true})];
      const attenuated = await render(.05, -6.0206);
      return {clickPeaks: clicks.map(item => item.peak), gainDb: 20 * Math.log10(boosted.rms / unity.rms), loudPeak: loud.peak,
        worstPeaks: worst.map(item => item.peak), halfDb: 20 * Math.log10(attenuated.rms / unity.rms),
        delayMs: (limitedClick.at - plainClick.at) / rate * 1000, expectedDelayMs: LIMITER.delaySeconds * 1000};
    });
    t.diagnostic(JSON.stringify(result));
    assert.ok(Math.abs(result.gainDb - 6) < .25, `level ${result.gainDb.toFixed(2)} dB`);
    assert.ok(result.loudPeak <= 1, `peak ${result.loudPeak}`);
    for (const peak of result.worstPeaks) assert.ok(peak < 1, `a boosted peak ${peak} must stay under full scale (no clipping)`);
    assert.ok(Math.abs(result.halfDb + 6.0206) < .25, `50% reads ${result.halfDb.toFixed(2)} dB`);
    assert.ok(Math.abs(result.delayMs - result.expectedDelayMs) <= 1, `delay ${result.delayMs} ms`);
  } finally { await browser?.close(); server.close(); }
});
