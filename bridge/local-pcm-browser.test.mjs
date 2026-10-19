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
