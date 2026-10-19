import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {chromium} from 'playwright';
import {RealtimeHost} from './realtime-host.mjs';

test('isolated local headless renderer streams, drains during a pending game callback and publishes completion', {timeout: 180000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-local-pcm-'));
  const requests = [], frames = [], pages = [];
  const modules = ['continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs',
    'continuous-pcm-core.mjs', 'local-pcm-client.mjs'];
  for (const name of modules) await writeFile(join(root, name), await readFile(new URL(name, import.meta.url)));
  // The Convai route exists in the host, but this fixture must never load it.
  await writeFile(join(root, 'realtime-client.js'), 'throw Error("Convai must not run in the local PCM page");');
  const host = new RealtimeHost({clientAssetsDirectory: root, launchBrowser: async options => {
    // Zero source PCM plus explicit muting: no provider, microphone or audible
    // test sound. A real headless AudioContext/worklet still supplies its clock.
    const browser = await chromium.launch({...options, args: [...options.args, '--mute-audio']});
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      page.on('request', request => requests.push(request.url())); pages.push(page); return page;
    };
    return browser;
  }});
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 150000);
  let releaseProducer;
  const heardPrefix = new Promise(resolvePrefix => { releaseProducer = resolvePrefix; });
  let producerFinished = false, playedBeforeComplete = false, drainedDuringCallback = false;
  try {
    const reply = 'The whole original reply remains one utterance.';
    const makePacket = (index, offsetFrames, count) => ({version: 1, engine: 'pocket-tts',
      sampleRate: 24000, channels: 1, format: 'f32le', owner: '1'.repeat(32), id: 1,
      profile: 'johnny', modelSha256: '2'.repeat(64), index, offsetFrames, frames: count,
      pcm: new Float32Array(count)});
    const result = await host.playLocalPcm({token: 'offline-local-stream', text: reply}, async emit => {
      await emit(makePacket(1, 0, 9600));
      // Hold the producer until its first copied prefix really starts playing.
      await heardPrefix;
      await emit(makePacket(2, 9600, 9600)); producerFinished = true;
      return {timing: {voiceProvider: 'pocket'}};
    }, {signal: controller.signal, onFrame: async snapshot => {
      frames.push(snapshot);
      if (snapshot.positionSeconds > 0 && !producerFinished) {
        playedBeforeComplete = true; releaseProducer();
      }
      if (!drainedDuringCallback && snapshot.sourceComplete && !snapshot.ended && snapshot.positionSeconds >= .65) {
        // Native state publication is asynchronous. While this callback waits,
        // the real player timer completes and closes the AudioContext itself.
        await pages[0].waitForFunction(() => !!window.localPcm.active?.player.snapshot().ended,
          undefined, {timeout: 120000, polling: 10});
        drainedDuringCallback = true;
      }
      return {allow: true, paused: false, volume: 0, pan: 0};
    }});
    assert.equal(playedBeforeComplete, true, 'full-file generation must not gate local playback');
    assert.equal(drainedDuringCallback, true, 'the regression must cross the real device-drain/control boundary');
    assert.equal(result.frames, 19200); assert.equal(result.duration, .8);
    assert.equal(result.snapshot.ended, true); assert.equal(result.snapshot.positionSeconds, .8);
    assert.equal(frames.filter(value => value.ended).length, 1);
    assert.equal(result.snapshot.underruns, 0, JSON.stringify(result.snapshot));
    assert.equal(frames.every(value => value.text === reply && value.textComplete), true);
    assert.equal(frames.some(value => value.receivedFrames === 9600 && !value.sourceComplete && value.positionSeconds > 0), true);
    assert.equal(result.streamed, true); assert.equal(pages.length, 1); assert.equal(host.pool.entries.size, 0);
    assert.equal(host.sessions.owners.size, 0);
    const paths = requests.map(value => new URL(value).pathname);
    assert.equal(paths.includes('/local'), true); assert.equal(paths.includes('/local-pcm-client.mjs'), true);
    assert.equal(paths.includes('/client.js'), false, 'the local page has no Convai SDK capability');
    assert.equal(requests.every(value => new URL(value).hostname === '127.0.0.1'), true);
    assert.equal(await pages[0].evaluate(() => window.localPcm.active), null, 'the drained AudioContext owner must retire');
  } finally {
    clearTimeout(watchdog); controller.abort(); releaseProducer(); await host.close();
    // Delete only this test's validated, exact mkdtemp directory.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('cyberpunk-local-pcm-'));
    await rm(root, {recursive: true, force: true});
  }
});

// docs/perf LATENCY.md: the renderer's output device is opened at the turn start (RealtimeHost.standbyLocal) instead of after the voice
// was asked, so a turn's renderer is ready at once. Real headless renderer, muted, zero PCM.
test('a spare output device opened at the turn start is the device the next turn plays on (real headless renderer)', {timeout: 180000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-local-pcm-'));
  const modules = ['continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs', 'continuous-pcm-core.mjs', 'local-pcm-client.mjs'];
  for (const name of modules) await writeFile(join(root, name), await readFile(new URL(name, import.meta.url)));
  await writeFile(join(root, 'realtime-client.js'), 'throw Error("Convai must not run in the local PCM page");');
  const pages = [];
  const host = new RealtimeHost({clientAssetsDirectory: root, launchBrowser: async options => {
    const browser = await chromium.launch({...options, args: [...options.args, '--mute-audio']});
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => { const page = await newPage(...args); pages.push(page); return page; };
    return browser;
  }});
  const packet = (index, offsetFrames, count) => ({version: 1, engine: 'pocket-tts', sampleRate: 24000, channels: 1, format: 'f32le',
    owner: '1'.repeat(32), id: 1, profile: 'johnny', modelSha256: '2'.repeat(64), index, offsetFrames, frames: count, pcm: new Float32Array(count)});
  const turn = async token => {
    let device;
    const result = await host.playLocalPcm({token, text: 'One short reply.'}, async emit => {
      device = await pages[0].evaluate(() => window.localPcm.active?.player.token);
      await emit(packet(1, 0, 4800));
      return {timing: {voiceProvider: 'pocket'}};
    }, {onFrame: async () => ({allow: true, paused: false, volume: 0, pan: 0})});
    return {device, rendererReadyMs: result.timing.localPcmRendererReadyMs};
  };
  try {
    assert.equal(await host.prewarmLocal(), true);
    const ordinary = await turn('turn-without-spare');
    assert.equal(ordinary.device, 'turn-without-spare', 'without a spare the turn opens its own device');
    assert.equal(await host.standbyLocal(), true);
    assert.equal(await pages[0].evaluate(() => window.localPcm.spare?.standby === true && window.localPcm.spare.opened === true), true,
      'the spare device is running, silent, before the turn');
    const spared = await turn('turn-with-spare');
    assert.match(spared.device, /^spare-/, 'the turn played on the spare device');
    assert.equal(pages.length, 1);
    assert.equal(await pages[0].evaluate(() => window.localPcm.spare), null);
    console.log(`[standby] renderer ready ${ordinary.rendererReadyMs.toFixed(1)} ms without a spare, ${spared.rendererReadyMs.toFixed(1)} ms with one`);
  } finally {
    await host.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('cyberpunk-local-pcm-'));
    await rm(root, {recursive: true, force: true});
  }
});
