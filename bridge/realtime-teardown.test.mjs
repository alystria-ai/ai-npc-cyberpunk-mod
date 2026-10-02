import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {request} from 'node:http';
import {runInNewContext} from 'node:vm';
import {RealtimeHost} from './realtime-host.mjs';
import {TransportPool, endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {PcmChunkStream} from './convai-audio-stream.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';
import {ConvaiEmotion} from './convai-emotion.mjs';
import {CompanionActionWindow, publishCompanionActionContext, chauffeurActionName} from './companion-actions.mjs';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const flush = () => new Promise(done => setImmediate(done));
const config = {key: 'test-key', characterId: 'judy', endUserId: 'test-save', scope: 'phone', ttsEnabled: false, text: 'Hello'};
const clientSource = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {drainBlendshapes} from './blendshape-capture.mjs';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '')
  .replace("import {PcmChunkStream} from './convai-audio-stream.mjs';", '')
  .replace("import {ConvaiDataAudio} from './convai-data-audio.mjs';", '')
  .replace("import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';", '')
  .replace("import {ConvaiEmotion} from './convai-emotion.mjs';", '')
  .replace("import {CompanionActionWindow, publishCompanionActionContext, chauffeurActionName} from './companion-actions.mjs';", '');

// Run the actual host and lease pool. Each page executes the host's browser
// callbacks against its own window, without launching a browser or SDK network.
function fixture(t, {disconnectTimeoutMs, realClient = false, onDisconnect, createError} = {}) {
  const events = [], pages = [], gates = [];
  const host = new RealtimeHost({disconnectTimeoutMs});
  const browser = {isConnected: () => true, async close() { events.push('browser-close'); }};
  const server = {close() { events.push('server-close'); }};
  host.browser = browser; host.server = server;
  host.start = async () => {};
  const gate = () => { const result = deferred(); gates.push(result); return result; };
  const pool = host.pool = new TransportPool({limit: 11,
    create: async key => {
      if (createError) throw createError;
      const label = 'page-' + pages.length;
      const page = {key, label, closed: false, calls: [], clients: [], closeOptions: [],
        isClosed() { return this.closed; },
        url: () => 'http://127.0.0.1:4321/',
        context: () => ({grantPermissions: async () => {}, clearPermissions: async () => {}}),
        async close(options) {
          this.closeOptions.push(options); events.push(label + ':page-close'); this.closed = true;
          if (this.failClose) throw Error('Page close failed');
        },
        async evaluate(fn, payload) {
          if (this.closed || this.failEvaluation) throw Error('Target page is closed');
          return runInNewContext('(' + fn.toString() + ')(payload)', {window: this.window, payload});
        }};
      const disconnect = async () => {
        events.push(label + ':sdk-disconnect:start');
        await onDisconnect?.(page);
        events.push(label + ':sdk-disconnect:done');
      };
      page.api = {
        warm: async request => { page.calls.push({method: 'warm', config: request}); return {sessionID: label + '-session'}; },
        reply: async request => { page.calls.push({method: 'reply', config: request}); return {text: 'Reply', sessionID: label + '-session', timing: {}}; },
        beginVoice: async request => { page.calls.push({method: 'beginVoice', config: request}); return {sessionID: label + '-voice-session'}; },
        finishVoice: async request => { page.calls.push({method: 'finishVoice', config: request}); return {text: 'Voice reply', sessionID: label + '-voice-session', timing: {}}; },
        close: async reason => { page.calls.push({method: 'close', reason}); await disconnect(); },
      };
      page.window = {convaiRealtime: page.api};
      if (realClient) {
        class Client {
          constructor(options) {
            this.options = options; this.characterId = options.characterId;
            this.characterSessionId = options.characterSessionId === '-1' ? label + '-sdk-session' : options.characterSessionId;
            this.state = {endUserId: options.endUserId ?? null, isThinking: false};
            this.handlers = new Map(); this.chatMessages = [];
            this.room = {on() {}, remoteParticipants: new Map(), localParticipant: {audioTrackPublications: new Map()}};
            page.clients.push(this);
          }
          on(name, handler) { this.handlers.set(name, handler); }
          async connect() { this.isBotReady = true; }
          async disconnect() { this.isBotReady = false; await disconnect(); }
          updateContext() {}
          sendUserTextMessage(text) {
            page.calls.push({method: 'message', text});
            this.handlers.get('messagesChange')([{id: 'answer', type: 'bot-llm-text', content: 'SDK reply', isStreaming: false}]);
          }
        }
        runInNewContext(clientSource, {ConvaiClient: Client, window: page.window,
          endUserOptions, transportKey, SessionBindings, drainBlendshapes, PcmChunkStream, ConvaiDataAudio, ConvaiEmotion,
          CompanionActionWindow, publishCompanionActionContext, chauffeurActionName,
          TextDecoder, ArrayBuffer, Uint8Array,
          performance, setTimeout, clearTimeout, setInterval, clearInterval,
          btoa: data => Buffer.from(data, 'binary').toString('base64')});
        page.api = page.window.convaiRealtime;
      }
      pages.push(page); return page;
    },
    dispose: page => host.disposePage(page),
  });
  t.after(async () => {
    for (const pending of gates) pending.resolve();
    await host.close();
  });
  return {host, pool, browser, server, pages, events, gate};
}

test('explicitly discarded replies disconnect the SDK before closing and reconnect the retained session', async t => {
  const {host, pool, pages, events} = fixture(t, {realClient: true});
  const first = await host.reply(config, {discard: true});
  assert.equal(pool.entries.size, 0); assert.equal(pages[0].closed, true);
  assert(events.indexOf('page-0:sdk-disconnect:done') < events.indexOf('page-0:page-close'));
  assert.deepEqual(pages[0].closeOptions, [{runBeforeUnload: false}]);
  assert.equal(host.sessions.owners.has(first.sessionID), true);
  const second = await host.reply({...config, sessionId: first.sessionID}, {discard: true});
  assert.equal(pages.length, 2);
  assert.equal(pages[1].clients[0].options.characterSessionId, first.sessionID);
  assert.equal(second.sessionID, first.sessionID);
  assert.equal(pages[1].clients[0].options.endUserId, config.endUserId);
  assert.equal(host.sessions.owners.size, 1);
});

test('admitted phone replies reuse their scoped connection without waiting for teardown after every message', async t => {
  const {host, pool, pages, events} = fixture(t, {realClient: true});
  const first = await host.reply(config);
  assert.equal(pool.entries.size, 1); assert.equal(pages[0].closed, false);
  assert.equal(events.some(event => event.includes('sdk-disconnect')), false);
  const second = await host.reply({...config, sessionId: first.sessionID, text: 'And then?'});
  assert.equal(second.sessionID, first.sessionID);
  assert.equal(pages.length, 1); assert.equal(pages[0].clients.length, 1);
  assert.equal(second.timing.pageReused, true); assert.equal(second.timing.connectionReused, true);
  assert.equal(events.some(event => event.includes('sdk-disconnect')), false);
  await host.close();
  assert.equal(pages[0].closed, true);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:done')).length, 1);
});

test('retained phone sessions remain bound to their character, player and world/reset scope', async t => {
  const {host, pages} = fixture(t, {realClient: true});
  const first = await host.reply(config);
  for (const changed of [{characterId: 'panam'}, {endUserId: 'another-player'}, {scope: 'phone:next-world'}]) {
    await assert.rejects(host.reply({...config, ...changed, sessionId: first.sessionID}), /another user or scope/);
  }
  assert.equal(pages.length, 1, 'foreign session proposals never reach a new SDK connection');
  const other = await host.reply({...config, characterId: 'panam'});
  assert.equal(pages.length, 2); assert.notEqual(other.sessionID, first.sessionID);
  assert.equal((await host.reply({...config, sessionId: first.sessionID})).timing.connectionReused, true);
});

test('the admitted phone bridge route retains successful replies rather than discarding their connection', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const route = bridge.slice(bridge.indexOf('const result = await phoneRealtime.reply('), bridge.indexOf('stagedKnowledgeTurn(prepared);'));
  assert.match(route, /ttsEnabled: false/);
  assert.match(route, /signal: options\.signal/);
  assert.doesNotMatch(route, /discard\s*:\s*true/);
});

test('idle disposal awaits one SDK disconnect before page close', async t => {
  let disconnect;
  const {host, pool, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.warm(config);
  const page = pages[0];
  const disposing = host.refreshIdle(config);
  await flush();
  assert.equal(page.closed, false);
  assert.equal(pool.entries.size, 1, 'the retiring page remains counted until its disposal finishes');
  const first = host.disconnectPage(page), again = host.disconnectPage(page);
  assert.equal(first, again);
  assert.equal(page.calls.filter(call => call.method === 'close').length, 1);
  assert.equal(page.calls.find(call => call.method === 'close').reason, 'Conversation ended');
  disconnect.resolve();
  assert.equal(await disposing, true);
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(events, ['page-0:sdk-disconnect:start', 'page-0:sdk-disconnect:done', 'page-0:page-close']);
});

test('host shutdown starts all eleven disconnects in parallel and uses one 2.5-second grace', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let disconnect;
  const {host, pool, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  const party = Array.from({length: 11}, (_, index) => ({...config, characterId: 'companion-' + index}));
  for (const member of party) await host.warm(member);
  await host.retain(party, {protect: true});
  const waiting = assert.rejects(pool.acquire(transportKey({...config, characterId: 'queued'})), {name: 'AbortError'});
  await flush();
  const closing = host.close();
  assert.equal(host.close(), closing);
  assert.equal(pool.closed, true, 'shutdown fences acquisition before waiting for any SDK');
  await flush();
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:start')).length, 11);
  assert.equal(pages.filter(page => page.closed).length, 0);
  assert.equal(events.includes('browser-close'), false);
  t.mock.timers.tick(2499); await flush();
  assert.equal(pages.filter(page => page.closed).length, 0);
  t.mock.timers.tick(1); await closing; await waiting;
  assert.equal(pages.filter(page => page.closed).length, 11);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:done')).length, 0);
  assert.equal(events.includes('browser-close'), true);
  assert.equal(events.includes('server-close'), true);
  assert.equal(pool.entries.size, 0);
  assert.equal(host.pool, null); assert.equal(host.browser, null);
  assert(pages.every(page => page.closeOptions.length === 1));
});

test('a hanging SDK close falls back to forced page disposal at the deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let disconnect;
  const {host, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.warm(config);
  const disposing = host.refreshIdle(config);
  await flush();
  t.mock.timers.tick(2499); await flush();
  assert.equal(pages[0].closed, false);
  t.mock.timers.tick(1);
  assert.equal(await disposing, true);
  assert.equal(pages[0].closed, true);
  assert.deepEqual(events, ['page-0:sdk-disconnect:start', 'page-0:page-close']);
  disconnect.resolve(); await flush();
  assert.equal(pages[0].closeOptions.length, 1, 'a late SDK completion cannot dispose the page again');
});

test('failed evaluations, failed page close and already closed pages do not strand shutdown', async t => {
  const {host, pool, pages, events} = fixture(t, {onDisconnect: page => {
    if (page === pages[0]) throw Error('SDK disconnect failed');
  }});
  for (let index = 0; index < 3; index++) await host.warm({...config, characterId: 'companion-' + index});
  pages[0].failClose = true; pages[1].closed = true; pages[2].failEvaluation = true;
  await host.close();
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(pages.map(page => page.closeOptions.length), [1, 1, 1]);
  assert.equal(pages[1].calls.some(call => call.method === 'close'), false);
  assert.equal(pages[2].calls.some(call => call.method === 'close'), false);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:start')).length, 1);
  assert.equal(events.includes('browser-close'), true); assert.equal(events.includes('server-close'), true);
});

test('failed page creation retires its empty lease without invoking a missing page', async t => {
  const {host, pool, pages} = fixture(t, {createError: Error('Mock page creation failed')});
  await assert.rejects(host.warm({...config, sessionId: 'unverified-startup'}), /Mock page creation failed/);
  assert.equal(pool.entries.size, 0); assert.equal(pages.length, 0);
  assert.equal(host.sessions.owners.size, 0);
  await host.close();
});

for (const method of ['reply', 'warm']) {
  test('cancelled ' + method + ' evaluations cannot register supplied or late returned sessions', async t => {
    const {host, pool, pages, gate} = fixture(t);
    await host.warm(config);
    const owners = new Map(host.sessions.owners), started = gate(), response = gate();
    pages[0].api[method] = () => { started.resolve(); return response.promise; };
    const controller = new AbortController();
    const pending = host[method]({...config, sessionId: 'unverified-supplied'}, {signal: controller.signal});
    pending.catch(() => {});
    await started.promise; controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
    response.resolve({sessionID: 'late-returned', text: 'Obsolete reply', timing: {}}); await flush();
    assert.deepEqual(host.sessions.owners, owners);
    assert.equal(pool.entries.size, 0); assert.equal(pages[0].closed, true);
  });

  test('a ' + method + ' evaluation finishing after host shutdown cannot update session ownership', async t => {
    const {host, pages, gate} = fixture(t);
    await host.warm(config);
    const owners = new Map(host.sessions.owners), started = gate(), response = gate();
    pages[0].api[method] = () => { started.resolve(); return response.promise; };
    const pending = host[method]({...config, sessionId: 'unverified-supplied'}); pending.catch(() => {});
    await started.promise; await host.close();
    response.resolve({sessionID: 'late-returned', text: 'Obsolete reply', timing: {}});
    await assert.rejects(pending, {name: 'AbortError'});
    assert.deepEqual(host.sessions.owners, owners);
  });
}

test('cancelled voice startup cannot register its supplied or late returned session', async t => {
  const {host, pages, gate} = fixture(t);
  await host.warm(config);
  const owners = new Map(host.sessions.owners), started = gate(), response = gate();
  pages[0].api.beginVoice = () => { started.resolve(); return response.promise; };
  const channel = host.voiceChannel();
  const pending = channel.beginVoice({...config, sessionId: 'unverified-voice'}); pending.catch(() => {});
  await started.promise; await channel.close();
  response.resolve({sessionID: 'late-voice'});
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(host.sessions.owners, owners);
  assert.equal(host.voiceLease, null);
});

test('a voice finish completing during host disconnect grace cannot register a stale session', async t => {
  let disconnect;
  const {host, pages, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.beginVoice(config);
  const owners = new Map(host.sessions.owners), started = gate(), response = gate();
  pages[0].api.finishVoice = () => { started.resolve(); return response.promise; };
  const pending = host.finishVoice(); pending.catch(() => {});
  await started.promise;
  const closing = host.close();
  response.resolve({sessionID: 'stale-finished-voice', text: 'Obsolete reply', timing: {}});
  await flush();
  assert.deepEqual(host.sessions.owners, owners);
  disconnect.resolve(); await closing;
  await assert.rejects(pending, {name: 'AbortError'});
});

test('a voice finish requested after shutdown starts cannot invoke the page or register a session', async t => {
  let disconnect;
  const {host, pages, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.beginVoice(config);
  const owners = new Map(host.sessions.owners);
  let evaluated = false;
  pages[0].api.finishVoice = async () => {
    evaluated = true;
    return {sessionID: 'finish-after-shutdown', text: 'Obsolete reply', timing: {}};
  };
  const closing = host.close(), pending = host.finishVoice(); pending.catch(() => {});
  await flush();
  assert.equal(evaluated, false, 'the retired lease must be rejected before browser evaluation');
  assert.deepEqual(host.sessions.owners, owners);
  disconnect.resolve(); await closing;
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(host.sessions.owners, owners);
});

// Exercise the actual local asset server, with an injected browser that cannot
// create pages, make SDK requests or access audio/microphone devices.
async function assetFixture(t, {browserExecutable, onLaunch, omitAsset} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-host-assets-'));
  const directory = join(root, '预建 assets with spaces');
  await mkdir(directory);
  const assets = new Map(['realtime-client.js', 'continuous-pcm-player.mjs',
    'continuous-pcm-core.mjs', 'continuous-pcm-worklet.mjs']
    .map(name => [name, '// offline fixture: ' + name + '\n']));
  for (const [name, contents] of assets) if (name !== omitAsset)
    await writeFile(join(directory, name), contents);
  await writeFile(join(directory, 'convai-key.txt'), 'offline private fixture, never served');
  const launches = [];
  const browser = {closed: 0, isConnected: () => true,
    async close() { this.closed++; },
    async newPage() { assert.fail('asset tests must never create a conversation page'); }};
  const previousBrowser = process.env.CYBERPUNK_CONVAI_BROWSER;
  let host;
  try {
    delete process.env.CYBERPUNK_CONVAI_BROWSER;
    host = new RealtimeHost({browserExecutable, clientAssetsDirectory: directory,
      launchBrowser: async options => {
        launches.push(options);
        return onLaunch ? onLaunch(browser) : browser;
      }});
  } finally {
    if (previousBrowser === undefined) delete process.env.CYBERPUNK_CONVAI_BROWSER;
    else process.env.CYBERPUNK_CONVAI_BROWSER = previousBrowser;
  }
  t.after(async () => {
    await host.close();
    // Recursive cleanup is limited to this test's exact mkdtemp directory.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('cyberpunk-host-assets-'));
    await rm(root, {recursive: true, force: true});
  });
  return {host, browser, launches, assets, directory};
}

const assetRequest = (port, path, host = `127.0.0.1:${port}`) => new Promise((done, fail) => {
  const call = request({hostname: '127.0.0.1', port, path, method: 'GET',
    headers: {Host: host, Connection: 'close'}}, response => {
    let body = '';
    response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
    response.on('end', () => done({status: response.statusCode, headers: response.headers, body}));
  });
  call.on('error', fail); call.end();
});

test('absolute path overrides reject cwd/PATH lookup, malformed values and Windows drive-relative paths', () => {
  const name = 'CYBERPUNK_CONVAI_CLIENT_ASSETS';
  assert.equal(absoluteRuntimeOverride(undefined, name), undefined);
  const directory = resolve(process.cwd(), '资源 with spaces');
  assert.equal(absoluteRuntimeOverride(directory, name), directory);
  for (const value of ['', 'assets', '../private/assets', null, 5, Symbol('private'), {},
    ' ' + directory, directory + '\t', directory + '\0',
    ...(process.platform === 'win32' ? ['C:assets', '\\assets', '\\\\server'] : [])]) {
    assert.throws(() => absoluteRuntimeOverride(value, name),
      {message: name + ' must be an absolute filesystem path.'});
  }
  if (process.platform === 'win32') {
    assert.equal(absoluteRuntimeOverride('C:\\Packaged Runtime\\assets', name), 'C:\\Packaged Runtime\\assets');
    assert.equal(absoluteRuntimeOverride('\\\\server\\share\\assets', name), '\\\\server\\share\\assets');
  }
  for (const [option, variable] of [['browserExecutable', 'CYBERPUNK_CONVAI_BROWSER'],
    ['clientAssetsDirectory', name]]) {
    assert.throws(() => new RealtimeHost({[option]: 'relative/private/path',
      launchBrowser() { assert.fail('invalid overrides must never launch'); }}),
    {message: variable + ' must be an absolute filesystem path.'});
  }
});

test('browser executable and client asset environment choices are captured at construction', () => {
  const choices = {CYBERPUNK_CONVAI_BROWSER: resolve(process.cwd(), '浏览器/browser.exe'),
    CYBERPUNK_CONVAI_CLIENT_ASSETS: resolve(process.cwd(), '预建/assets')};
  const previous = Object.fromEntries(Object.keys(choices).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, choices);
    const host = new RealtimeHost();
    process.env.CYBERPUNK_CONVAI_BROWSER = 'changed relative value';
    process.env.CYBERPUNK_CONVAI_CLIENT_ASSETS = 'another relative value';
    assert.equal(host.browserExecutable, choices.CYBERPUNK_CONVAI_BROWSER);
    assert.equal(host.clientAssetsDirectory, choices.CYBERPUNK_CONVAI_CLIENT_ASSETS);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('packaged client assets preserve the four-file route allowlist and loopback Host guard', async t => {
  const executable = resolve(process.cwd(), 'packaged 浏览器/browser.exe');
  const {host, browser, launches, assets} = await assetFixture(t, {browserExecutable: executable});
  await host.start();
  assert.deepEqual(launches, [{executablePath: executable, headless: true,
    ignoreDefaultArgs: ['--mute-audio'],
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling']}]);
  const port = host.server.address().port;
  assert.equal(host.server.address().address, '127.0.0.1');
  for (const [name, contents] of assets) {
    const response = await assetRequest(port, name === 'realtime-client.js' ? '/client.js' : '/' + name);
    assert.equal(response.status, 200); assert.equal(response.body, contents);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-type'], 'text/javascript');
  }
  for (const path of ['/convai-key.txt', '/realtime-client.js', '/../convai-key.txt',
    '/%2e%2e/convai-key.txt', '/client.js?private=true', '/assets/continuous-pcm-core.mjs']) {
    const response = await assetRequest(port, path);
    assert.equal(response.status, 404); assert.equal(response.body, '');
  }
  const denied = await assetRequest(port, '/client.js', 'untrusted.invalid');
  assert.equal(denied.status, 403); assert.equal(denied.body, '');
  await host.close(); assert.equal(browser.closed, 1);
  assert.equal(host.pool, null); assert.equal(host.server, null);
});

test('absent browser executable override retains the installed Edge channel', async t => {
  const {host, launches} = await assetFixture(t);
  await host.start();
  assert.equal(launches[0].channel, 'msedge');
  assert.equal(Object.hasOwn(launches[0], 'executablePath'), false);
  assert.equal(launches[0].headless, true);
});

test('missing packaged PCM module fails before browser launch without using development assets', async t => {
  const {host, launches} = await assetFixture(t, {omitAsset: 'continuous-pcm-core.mjs'});
  await assert.rejects(host.start(), {code: 'ENOENT'});
  assert.equal(launches.length, 0); assert.equal(host.pool, null); assert.equal(host.server, null);
});

test('closing during overridden browser startup still retires the late owned browser', {timeout: 3000}, async t => {
  const entered = deferred(), ready = deferred();
  const {host, browser} = await assetFixture(t, {onLaunch: () => {
    entered.resolve(); return ready.promise;
  }});
  const starting = host.start(); starting.catch(() => {});
  await entered.promise;
  const closing = host.close(); ready.resolve(browser);
  await assert.rejects(starting, {name: 'AbortError'}); await closing;
  assert.equal(browser.closed, 1);
  assert.equal(host.pool, null); assert.equal(host.browser, null); assert.equal(host.server, null);
});
