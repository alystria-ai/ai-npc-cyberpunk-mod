import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('real muted headless worklet pauses, resumes, and drains one continuous source clock', {timeout: 180000}, async () => {
  const allowed = new Set(['/continuous-pcm-player.mjs', '/continuous-pcm-worklet.mjs', '/continuous-pcm-core.mjs']);
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Muted PCM test</title>'); return; }
    if (!allowed.has(request.url)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(new URL(`.${request.url}`, import.meta.url)));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    // Explicitly muted, and the source is all zero: this test never requests
    // microphone access, makes provider calls, or emits an audible test tone.
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const {ContinuousPcmPlayer} = await import('/continuous-pcm-player.mjs');
      const player = new ContinuousPcmPlayer();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async predicate => {
        const deadline = performance.now() + 3000;
        while (!predicate() && !player.snapshot().error && performance.now() < deadline) await delay(10);
      };
      let timer, paused = false;
      try {
        await player.open({sampleRate: 24000, channels: 1, token: 'muted-offline-test'});
        const gated = player.snapshot();
        await player.append(new Uint8Array(9600 * 2), 0);
        await delay(60);
        const withheld = player.snapshot();
        const refresh = () => player.control({allow: true, paused, volume: 1, pan: 0});
        refresh(); timer = setInterval(refresh, 80);
        await until(() => player.snapshot().playedFrames > 0);
        const first = player.snapshot();
        paused = true; refresh(); await until(() => player.snapshot().state === 'paused');
        const held = player.snapshot(); await delay(100);
        const stillHeld = player.snapshot();
        await player.append(new Uint8Array(14400 * 2), 9600);
        await player.end(24000);
        paused = false; refresh();
        const deadline = performance.now() + 5000;
        while (!player.snapshot().ended && !player.snapshot().error && performance.now() < deadline) await delay(20);
        return {gated, withheld, first, held, stillHeld, final: player.snapshot(),
          actualSampleRate: player.context.sampleRate, nodeCount: player.node ? 1 : 0};
      } finally { clearInterval(timer); await player.stop(); }
    });
    assert.equal(result.actualSampleRate, 24000);
    assert.equal(result.gated.playedFrames, 0); assert.equal(result.withheld.playedFrames, 0);
    assert.ok(result.first.playedFrames > 0, JSON.stringify(result));
    assert.equal(result.held.playedFrames, result.stillHeld.playedFrames, JSON.stringify(result));
    assert.equal(result.final.error, null, JSON.stringify(result));
    assert.equal(result.final.ended, true, JSON.stringify(result));
    assert.equal(result.final.playedFrames, 24000);
    assert.equal(result.final.positionSeconds, 1);
    assert.equal(result.final.underruns, 0);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});

test('real muted worklet: a standby device outlives the 2s lease, then arms and plays; the lease still expires after arming', {timeout: 180000}, async () => {
  const allowed = new Set(['/continuous-pcm-player.mjs', '/continuous-pcm-worklet.mjs', '/continuous-pcm-core.mjs']);
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Muted PCM standby test</title>'); return; }
    if (!allowed.has(request.url)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(new URL(`.${request.url}`, import.meta.url)));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    // Muted and all-zero source, as above: no tone, microphone or provider call.
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const {ContinuousPcmPlayer} = await import('/continuous-pcm-player.mjs');
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const player = new ContinuousPcmPlayer();
      await player.open({sampleRate: 24000, channels: 1, token: 'muted-standby-test', standby: true});
      // A slow provider: well past the 2 s lease and the 500 ms hold, with an
      // (ignored) allowing control and no game traffic at all.
      await delay(2600);
      player.control({allow: true, paused: false, volume: 1, pan: 0});
      const waiting = player.snapshot();
      await player.arm();
      await player.append(new Uint8Array(9600 * 2), 0);
      const armed = player.snapshot();
      player.control({allow: true, paused: false, volume: 1, pan: 0});
      const deadline = performance.now() + 3000;
      while (player.snapshot().playedFrames === 0 && !player.snapshot().error && performance.now() < deadline) await delay(5);
      const playing = player.snapshot();
      // After arming the lease is the ordinary one: no refresh, no sound.
      await delay(2300);
      const lapsed = player.snapshot();
      await player.stop();
      return {waiting, armed, playing, lapsed};
    });
    assert.equal(result.waiting.error, null, JSON.stringify(result)); assert.equal(result.waiting.state, 'standby');
    assert.equal(result.waiting.playedFrames, 0);
    assert.equal(result.armed.error, null, JSON.stringify(result)); assert.equal(result.armed.playedFrames, 0);
    assert.equal(result.playing.error, null, JSON.stringify(result));
    assert.ok(result.playing.playedFrames > 0, JSON.stringify(result));
    assert.match(result.lapsed.error, /expired/, JSON.stringify(result));
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});
