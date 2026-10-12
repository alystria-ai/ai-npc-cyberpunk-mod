// The local voice's hidden browser after the realtime host was closed (a provider switch, a key switch, a world reset): the bridge
// opens it again at once, so the next voiced reply does not start Edge in front of its voice (2026-10-13 live record: browserReady
// came 770 ms after voiceStart on the turn after a provider switch).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RealtimeHost} from './realtime-host.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cyberpunk-rewarm-'));
  for (const name of ['realtime-client.js', 'continuous-pcm-player.mjs', 'continuous-pcm-core.mjs', 'continuous-pcm-worklet.mjs', 'local-pcm-client.mjs']) {
    await writeFile(join(directory, name), '// offline fixture\n');
  }
  const launches = [], pages = [];
  const host = new RealtimeHost({clientAssetsDirectory: directory, launchBrowser: async () => {
    const browser = {connected: true, isConnected() { return this.connected; }, async close() { this.connected = false; },
      async newPage() {
        const page = {closed: false, isClosed() { return this.closed; }, async route() {}, async goto() {}, async waitForFunction() {},
          async close() { this.closed = true; }, context: () => ({close: async () => {}})};
        pages.push(page); return page;
      }};
    launches.push(browser); return browser;
  }});
  t.after(async () => { await host.close(); await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); });
  return {host, launches, pages};
}

test('prewarmLocal after close() starts a new browser and keeps a warm renderer page', async t => {
  const {host, launches, pages} = await fixture(t);
  assert.equal(await host.prewarmLocal(), true);
  assert.equal(launches.length, 1);
  assert.equal(pages.length, 1);
  await host.close();
  assert.equal(launches[0].connected, false, 'close() ends the browser');
  assert.equal(await host.prewarmLocal(), true, 'the host starts again after a close');
  assert.equal(launches.length, 2);
  assert.equal(pages.length, 2);
  assert.equal(await host.prewarmLocal(), true);
  assert.equal(launches.length, 2, 'a warm browser is not started twice');
  assert.equal(pages.length, 2, 'nor is a warm page opened twice');
});

test('the bridge opens the local voice again after a world reset, a key switch and a provider switch', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /function rewarmLocalVoice\(\) \{\s*if \(mistral\.active && localVoice\.playbackEnabled !== false && !stopped\) void realtime\.prewarmLocal\(\);/);
  const sites = [/partyObserved = ''; prewarmObserved = ''; prefetchObserved = '';\s*rewarmLocalVoice\(\);/,
    /Conversation key: [^\n]*\n\s*rewarmLocalVoice\(\);/, /Conversation provider: \$\{mistral\.applied\}`\);\s*rewarmLocalVoice\(\);/];
  for (const site of sites) assert.match(source, site);
});
