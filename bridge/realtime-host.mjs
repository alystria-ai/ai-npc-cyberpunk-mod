import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {TransportPool, abortable, cancelled, throwIfCancelled, transportKey, SessionBindings} from './transport-pool.mjs';
import {CONNECTION_LIMIT} from './party-connections.mjs';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {LocalPcmHost} from './local-pcm-host.mjs';
import {markStage} from './turn-clock.mjs';

const PCM_MODULES = Object.freeze([
  'continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs', 'continuous-pcm-core.mjs',
  'local-pcm-client.mjs',
]);

const pageKey = transportKey;
// This is the installed SDK 1.7 default, also used by the captured live trial.
// The documentation's example uses live.convai.com; do not redirect the SDK.
const CONVAI_CONNECT_URL = 'https://realtime-api.convai.com/connect';

// Source facial messages allow 120 seconds at 120 Hz, with 61 finite numbers
// per pose. Even 24-character JSON numbers fit below 24 MiB at that ceiling;
// 32 MiB leaves room for pose timestamps, metadata and bounded reply text.
// This is a transport ceiling, not a larger utterance/facial admission limit.
export const CONTINUOUS_SNAPSHOT_JSON_LIMIT = 32 * 1024 * 1024;

export async function continuousSnapshotForHost(page, token, signal, pcmFrom) {
  // Playwright recursively encodes every number in a returned object. Passing
  // the existing public snapshot as one JSON string avoids that cost without
  // changing a coefficient, PCM packet, device clock or ownership field.
  // pcmFrom optionally requests the facial model's next analysis PCM slice.
  if (pcmFrom !== undefined && (!Number.isSafeInteger(pcmFrom) || pcmFrom < 0)) pcmFrom = undefined;
  const raw = await abortable(page.evaluate(({token, pcmFrom}) => {
    const value = window.convaiRealtime.continuousSnapshot(token, pcmFrom);
    return value == null ? null : JSON.stringify(value);
  }, {token, pcmFrom}), signal);
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length > CONTINUOUS_SNAPSHOT_JSON_LIMIT
      || Buffer.byteLength(raw, 'utf8') > CONTINUOUS_SNAPSHOT_JSON_LIMIT)
    throw Error('Invalid continuous browser snapshot size');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw Error('Invalid continuous browser snapshot encoding'); }
  if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw Error('Invalid continuous browser snapshot shape');
  return value;
}

// SDK 1.7 does not serialize audio_config. Patch only its owned LiveKit connect
// request, leaving authentication, session and memory fields intact. Source
// PCM arrives before playback and is passed unchanged to one continuous sink.
// https://docs.convai.com/api-docs/api-reference/core-api-reference/live-apis-beta/audio-data-via-data-channel
export async function installConvaiAudioRoute(page, getOwner) {
  await page.route(CONVAI_CONNECT_URL, async route => {
    const request = route.request();
    if (request.url() !== CONVAI_CONNECT_URL || request.method() !== 'POST') {
      await route.continue(); return;
    }
    let postData;
    try {
      const owner = getOwner(), raw = request.postData();
      if (!owner || typeof owner.characterId !== 'string' || !owner.characterId
          || (owner.endUserId !== null && (typeof owner.endUserId !== 'string' || !owner.endUserId))
          || typeof owner.ttsEnabled !== 'boolean' || typeof raw !== 'string'
          || raw.length > 1048576) throw Error('Invalid owned connect request');
      const body = JSON.parse(raw), object = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!object(body) || body.character_id !== owner.characterId
          || (body.end_user_id ?? null) !== owner.endUserId || body.transport !== 'livekit'
          || body.default_tts_enabled !== owner.ttsEnabled
          || (body.audio_config !== undefined && !object(body.audio_config))
          || (body.audio_config?.output !== undefined && !object(body.audio_config.output)))
        throw Error('Invalid owned connect request');
      postData = JSON.stringify({...body, audio_config: {...body.audio_config,
        output: {...body.audio_config?.output, audio_routing: 'data_only',
          max_chunk_duration_ms: 100, add_wav_header: false}}});
    } catch {
      // Never echo the request body, API key, user identity or session ID.
      // The SDK sees a fetch failure, and the failed lease is discarded.
      await route.abort('failed').catch(() => {}); return;
    }
    await route.continue({postData});
  });
}

const connectOwner = config => ({characterId: config.characterId,
  endUserId: config.endUserId ?? null, ttsEnabled: config.ttsEnabled !== false});

export async function installCompanionActionBinding(page, {isCurrent, onAction}) {
  if (typeof onAction !== 'function') return;
  await page.exposeBinding('__convaiCompanionAction', (source, message) => {
    if (!isCurrent() || source.page !== page || source.frame !== page.mainFrame() || page.isClosed()) return false;
    return onAction(message);
  });
}

export class RealtimeHost {
  // transformReply: optional, applied to every finished reply (Natural speech removes voice tags from the display text).
  // exclusive: {enabled(), peers(), retryMs}. While enabled the plan allows one conversation connection at a time (a
  // player's own free Convai key), so a request first closes every other idle connection, here and in the peer hosts,
  // and a "Concurrency limit reached" answer is retried once after retryMs while the old session is released.
  // onFailure(error) / onSuccess(): observers of a finished request (the bridge reads plan-limit failures from them).
  // recover(error, config): may return a changed config for one more attempt (a player's key whose plan has no room for
  // another memory user retries with the account's existing memory user, or without an identity), or nothing. It may be async.
  // guard: {check(), consume()} (bridge/shared-key-guard.mjs), the one place a turn is admitted before it reaches Convai: a
  // turn that may not run makes check() throw (the daily cap or the rate limit of the shared key). Opening or warming a
  // connection is not a turn. A microphone turn is checked when it begins and counted when it is finished.
  // credential(config): optional, may be async. Returns the config as it must be sent to Convai (an `authToken` from the
  // sign-in backend, or the `key`). Asked at the moment a page is called; the token is already in memory (bridge/convai-credential.mjs),
  // so a turn never waits on a network call for it. Absent: the config is sent as it is.
  // vision: optional "Companions can see" policy (bridge/companion-vision.mjs, docs/COMPANION_VISION.md):
  //   connectConfig() -> null | {transport}: whether pages connect with Convai's vision channel (read when a page is called);
  //   imagesForTurn(config, {phase: 'reply' | 'finish', heard}) -> images or null: the picture(s) for this turn, bounded in time.
  constructor({disconnectTimeoutMs = 2500, onCompanionAction, transformReply, exclusive, onFailure, onSuccess, recover, guard, credential, vision,
    browserExecutable = process.env.CYBERPUNK_CONVAI_BROWSER,
    clientAssetsDirectory = process.env.CYBERPUNK_CONVAI_CLIENT_ASSETS,
    // The hidden browser outputs real audio in the game. Under the Node test runner (NODE_TEST_CONTEXT is set in every
    // `node --test` child) or with CYBERPUNK_CONVAI_MUTE_BROWSER=1 it stays muted, so tests never reach the player's speakers.
    muteBrowser = process.env.CYBERPUNK_CONVAI_MUTE_BROWSER === '1' || !!process.env.NODE_TEST_CONTEXT,
    launchBrowser = options => chromium.launch(options)} = {}) {
    this.browserExecutable = absoluteRuntimeOverride(browserExecutable, 'CYBERPUNK_CONVAI_BROWSER');
    this.clientAssetsDirectory = absoluteRuntimeOverride(clientAssetsDirectory, 'CYBERPUNK_CONVAI_CLIENT_ASSETS');
    this.launchBrowser = launchBrowser; this.muteBrowser = !!muteBrowser;
    this.epoch = 0; this.sessions = new SessionBindings(); this.connectOwners = new WeakMap();
    this.disconnects = new WeakMap(); this.disconnectTimeoutMs = disconnectTimeoutMs;
    this.onCompanionAction = onCompanionAction;
    this.transformReply = typeof transformReply === 'function' ? transformReply : result => result;
    this.exclusive = exclusive; this.onFailure = onFailure; this.onSuccess = onSuccess; this.recover = recover;
    this.guard = guard;
    this.credential = typeof credential === 'function' ? credential : null;
    this.vision = vision && typeof vision === 'object' ? vision : null;
  }
  // The page config with the current vision setting applied (and any stale vision fields from the caller removed).
  withVision(config) {
    let settings = null;
    try { settings = this.vision?.connectConfig?.() ?? null; } catch { settings = null; }
    const {vision: _vision, visionTransport: _transport, ...rest} = config ?? {};
    return settings ? {...rest, vision: true, visionTransport: settings.transport === 'upload' ? 'upload' : 'video'} : rest;
  }
  // The picture(s) for one turn, or none. Never throws: a picture is never worth failing a turn for.
  async turnImages(config, phase, heard) {
    if (!this.vision?.imagesForTurn || config?.freshSession || config?.reaction) return null;
    try {
      const images = await this.vision.imagesForTurn(config, {phase, heard});
      return Array.isArray(images) && images.length ? images : null;
    } catch { return null; }
  }
  // Hands pictures to the running microphone turn while V is still talking ({staged, reason}); never throws.
  async stageVoiceVision(images, owner) {
    const lease = this.voiceLease;
    if (!lease || (owner !== undefined && lease.owner !== owner) || lease.value.isClosed()) return {staged: false, reason: 'no-recording'};
    try {
      return await lease.value.evaluate(images => window.convaiRealtime.stageVision
        ? window.convaiRealtime.stageVision(images) : {staged: false, reason: 'old-voice-client'}, images);
    } catch { return {staged: false, reason: 'failed'}; }
  }
  // Single-session plans: close the idle connections of this host (except `key`) and of its peers.
  async yieldOtherSessions(key) {
    if (!this.exclusive?.enabled?.()) return;
    for (const host of [this, ...(this.exclusive.peers?.() ?? [])]) {
      const pool = host?.pool;
      if (!pool) continue;
      for (const entry of [...pool.entries.values()]) {
        if (host === this && entry.key === key) continue;
        await pool.discardIdle(entry.key).catch(() => {});
      }
    }
  }
  // A finished reply proves the key works; opening a connection or a microphone does not (a used-up plan can still connect).
  observe(promise, completesReply = true) {
    return promise.then(value => { try { if (completesReply) this.onSuccess?.(); } catch { /* an observer never fails a reply */ } return value; },
      error => { try { this.onFailure?.(error); } catch { /* an observer never fails a reply */ } throw error; });
  }
  disconnectPage(page) {
    if (!page || page.isClosed?.()) return Promise.resolve();
    this.connectOwners.delete(page);
    if (this.disconnects.has(page)) return this.disconnects.get(page);
    const task = (async () => {
      let timer;
      try {
        // Give the official SDK its normal session-end path before destroying
        // the page. This is a bounded local disconnect, not a cloud flush ack.
        await Promise.race([
          Promise.resolve().then(() => page.evaluate(async () => {
            await window.convaiRealtime?.close('Conversation ended');
          })).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, this.disconnectTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    this.disconnects.set(page, task); return task;
  }
  async disposePage(page) {
    await this.disconnectPage(page);
    await page?.close({runBeforeUnload: false}).catch(() => {});
  }
  async start({signal} = {}) {
    throwIfCancelled(signal);
    this.lastUsedAt = Date.now();
    if (this.closing) await this.closing;
    throwIfCancelled(signal);
    if (this.browser?.isConnected()) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    this.starting = this.initialize(epoch);
    try { await this.starting; } finally { this.starting = null; }
  }
  async initialize(epoch) {
    // A crashed browser must not leave its local server or stale leases behind.
    const previousPool = this.pool, previousLocal = this.localPcm, previousVoiceLine = this.vPcm;
    const previousBrowser = this.browser, previousServer = this.server;
    this.pool = this.localPcm = this.vPcm = this.browser = this.server = null;
    await Promise.allSettled([previousPool?.close(), previousLocal?.close(), previousVoiceLine?.close(), previousBrowser?.close()]);
    previousServer?.close();
    // One hidden browser: eight party private pages plus three optional group
    // pages. No key endpoint, microphone permission or visible user profile.
    const [bundle, ...modules] = await Promise.all([
      readFile(this.clientAssetsDirectory ? resolve(this.clientAssetsDirectory, 'realtime-client.js')
        : new URL('../runtime/realtime-client.js', import.meta.url)),
      ...PCM_MODULES.map(name => readFile(this.clientAssetsDirectory
        ? resolve(this.clientAssetsDirectory, name) : new URL(name, import.meta.url))),
    ]);
    const audioModules = new Map(PCM_MODULES
      .map((name, index) => ['/' + name, modules[index]]));
    if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) { res.writeHead(403).end(); return; }
      if (req.url === '/client.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(bundle);
      } else if (audioModules.has(req.url)) {
        res.setHeader('Content-Type', 'text/javascript'); res.end(audioModules.get(req.url));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/client.js"></script>');
      } else if (req.url === '/local') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/local-pcm-client.mjs"></script>');
      } else res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let browser;
    try {
      browser = await this.launchBrowser({...(this.browserExecutable
        ? {executablePath: this.browserExecutable} : {channel: 'msedge'}), headless: true,
        ...(this.muteBrowser ? {} : {ignoreDefaultArgs: ['--mute-audio']}),
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
          ...(this.muteBrowser ? ['--mute-audio'] : [])]});
      if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
      this.browser = browser; this.server = server;
      const createLocalPage = async () => {
        if (epoch !== this.epoch || this.closing) throw cancelled();
        const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
        try {
          // This page has only local PCM modules. It cannot enter the SDK's
          // conversation routes, open a session or request microphone access.
          await page.route('**/*', async route => {
            const request = route.request(); let url;
            try { url = new URL(request.url()); } catch { await route.abort('failed'); return; }
            if (request.method() === 'GET' && url.origin === origin && !url.search
                && (url.pathname === '/local' || PCM_MODULES.includes(url.pathname.slice(1))))
              await route.continue();
            else await route.abort('failed');
          });
          if (epoch !== this.epoch || this.closing) throw cancelled();
          await page.goto(origin + '/local');
          await page.waitForFunction(() => !!window.localPcm, undefined, {timeout: 5000});
          if (epoch !== this.epoch || this.closing) throw cancelled();
          return page;
        } catch (error) { await page.close({runBeforeUnload: false}).catch(() => {}); throw error; }
      };
      this.localPcm = new LocalPcmHost({createPage: createLocalPage});
      // The player's own typed line (V's voice, bridge/v-voice.mjs) plays on a page of its own, so it never waits for, or takes
      // the place of, the companion's utterance. Nothing is opened until a V line is played or warmed.
      this.vPcm = new LocalPcmHost({createPage: createLocalPage});
      this.pool = new TransportPool({limit: CONNECTION_LIMIT, create: async () => {
        const page = await browser.newPage();
        try {
          await installCompanionActionBinding(page, {onAction: this.onCompanionAction,
            isCurrent: () => epoch === this.epoch && this.connectOwners.has(page)});
          await installConvaiAudioRoute(page, () => this.connectOwners.get(page));
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.waitForFunction(() => !!window.convaiRealtime);
          return page;
        } catch (error) { await page.close().catch(() => {}); throw error; }
      }, dispose: page => this.disposePage(page)});
      if (this.retained) await this.pool.retain(this.retained.keys, this.retained.options);
    } catch (error) { await browser?.close(); server.close(); throw error; }
  }
  async evaluateSpeech(page, method, config, {signal, liveSpeech, current = () => true} = {}) {
    if (this.credential) config = await abortable(Promise.resolve(this.credential(config)), signal);
    config = this.withVision(config);
    if (!liveSpeech || config?.ttsEnabled === false)
      return abortable(page.evaluate(({config, method}) => window.convaiRealtime[method](config), {config, method}), signal);
    const {token, onFrame} = liveSpeech;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token) || typeof onFrame !== 'function')
      throw Error('Invalid live speech admission');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const check = () => { throwIfCancelled(controller.signal); if (!current()) throw cancelled(); };
    let settled = false;
    const snapshot = () => continuousSnapshotForHost(page, token, controller.signal, liveSpeech.pcmCursor?.());
    const request = Promise.resolve().then(() => {
      check();
      return page.evaluate(({config, method}) => window.convaiRealtime[method](config),
        {config: {...config, liveSpeechToken: token}, method});
    }).finally(() => { settled = true; });
    const pump = (async () => {
      while (!settled) {
        check();
        const frame = await snapshot();
        check();
        if (frame?.token === token) {
          const control = await abortable(Promise.resolve().then(() => onFrame(frame)), controller.signal);
          check();
          if (!settled && control !== undefined)
            await abortable(page.evaluate(({token, control}) => window.convaiRealtime.continuousControl(token, control), {token, control}), controller.signal);
        }
        // A look-ahead turn that is only buffering polls less often.
        if (!settled) await abortable(new Promise(resolve => {
          const timer = setTimeout(resolve, liveSpeech.pollMs?.() ?? 40);
          // Released from its hold: poll at once instead of finishing the slow wait.
          liveSpeech.wake?.()?.then(() => { clearTimeout(timer); resolve(); });
        }), controller.signal);
      }
      return request;
    })();
    try {
      const result = await abortable(Promise.race([request, pump]), controller.signal);
      await abortable(pump, controller.signal);
      check();
      // Preserve the last drain acknowledgement before releasing this page.
      const final = await snapshot();
      check();
      if (final?.token === token) await abortable(Promise.resolve().then(() => onFrame(final)), controller.signal);
      check();
      return result;
    } finally {
      settled = true; controller.abort(); signal?.removeEventListener('abort', cancel);
      // Both promises remain observed even when a failed callback wins first.
      void pump.catch(() => {}); void request.catch(() => {});
    }
  }
  run(config, method, options = {}) {
    const attempt = async () => {
      // One admission per turn; the recovery retries below repeat the same turn.
      if (method !== 'warm' && this.guard) { this.guard.check(); this.guard.consume(); }
      let current = config, waited = false;
      for (let retries = 0; ; retries++) {
        try { return await this.runOnce(current, method, options); }
        catch (error) {
          if (retries >= 2 || options.signal?.aborted) throw error;
          if (!waited && this.exclusive?.enabled?.() && /concurrency limit/i.test(String(error?.message))) {
            waited = true;
            await abortable(new Promise(resolve => setTimeout(resolve, this.exclusive.retryMs ?? 1500)), options.signal);
            continue;
          }
          let changed; try { changed = await this.recover?.(error, current); } catch { changed = undefined; }
          if (!changed) throw error;
          current = changed;
        }
      }
    };
    return this.observe(attempt(), method !== 'warm');
  }
  async runOnce(config, method, {signal, discard = false, onAudioChunk, liveSpeech} = {}) {
    throwIfCancelled(signal);
    config = {...config}; // Keep queued work bound to the identity admitted now.
    // Retire the old per-file chunk capability. Only an explicit liveSpeech
    // admission can authorize the continuous renderer on this leased page.
    delete config.audioStreamToken;
    delete config.liveSpeechToken;
    if (onAudioChunk !== undefined) throw Error('Chunked Convai playback is retired; use liveSpeech or the complete reply audio');
    const key = pageKey(config);
    this.sessions.check(config);
    // A turn's picture is captured while the page is being acquired (bridge/companion-vision.mjs bounds the wait).
    const pictures = method === 'reply' ? this.turnImages(config, 'reply') : null;
    const started = performance.now();
    await this.start({signal});
    throwIfCancelled(signal);
    const startupMs = performance.now() - started, epoch = this.epoch;
    await this.yieldOtherSessions(key);
    throwIfCancelled(signal);
    const waiting = performance.now(), lease = await this.pool.acquire(key, {signal});
    const poolWaitMs = performance.now() - waiting;
    const cancel = () => { this.connectOwners.delete(lease.value); void lease.release({discard: true}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    let failed = true;
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      this.connectOwners.set(lease.value, connectOwner(config));
      const images = await pictures;
      throwIfCancelled(signal);
      if (images) config.visionImages = images;
      const result = await this.evaluateSpeech(lease.value, method, config, {signal, liveSpeech,
        current: () => epoch === this.epoch && !this.closing});
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      this.sessions.accept(config);
      this.sessions.bind(config, result.sessionID);
      failed = false;
      const host = {browserStartupMs: startupMs, poolWaitMs, pageReused: lease.reused, pages: this.pool?.entries.size || 0};
      return method === 'warm' ? {...result, ...host} : this.transformReply({...result, timing: {...result.timing, ...host}});
    } finally {
      signal?.removeEventListener('abort', cancel);
      await lease.release({discard: discard || failed || signal?.aborted});
    }
  }
  reply(config, options) { return this.run(config, 'reply', options); }
  warm(config, options) { return this.run(config, 'warm', options); }
  // True while a local PCM turn still owns the single renderer page, including
  // its drain and retirement after the audible end.
  get localPcmBusy() { return !!this.localPcm?.active; }
  // Starts the hidden browser and opens the local voice's renderer page before the first turn needs it (about a second on a cold
  // start, which a text route otherwise pays in front of its first reply). Never throws and never interrupts a turn.
  async prewarmLocal({signal} = {}) {
    try {
      await this.start({signal});
      return await (this.localPcm?.warm?.() ?? false);
    } catch { return false; }
  }
  async playLocalPcm(config, producer, options = {}) {
    const {signal, current = () => true} = options;
    throwIfCancelled(signal);
    await abortable(this.start({signal}), signal);
    markStage('browserReady');
    throwIfCancelled(signal);
    const epoch = this.epoch, local = this.localPcm;
    if (!local || this.closing) throw cancelled();
    // A page being released a moment ago (releaseRendererPages) finishes closing first; the turn then opens its own.
    if (local.closing) await abortable(local.closing.catch(() => {}), signal);
    try {
      return await local.play(config, producer, {...options,
        current: async () => epoch === this.epoch && local === this.localPcm && !this.closing && await current()});
    } finally { this.lastUsedAt = Date.now(); }
  }
  // V's voice for typed lines: the same renderer page and the same PCM format as a companion's local voice, on a second page. There
  // is no game utterance behind it (no face, lip sync or subtitle): the caller answers the renderer's clock with its own control.
  get voiceLineBusy() { return !!this.vPcm?.active; }
  async prewarmVoiceLine({signal} = {}) {
    try {
      await this.start({signal});
      return await (this.vPcm?.warm?.() ?? false);
    } catch { return false; }
  }
  async playVoiceLine(config, producer, options = {}) {
    const {signal, current = () => true} = options;
    throwIfCancelled(signal);
    await abortable(this.start({signal}), signal);
    markStage('browserReady');
    throwIfCancelled(signal);
    const epoch = this.epoch, host = this.vPcm;
    if (!host || this.closing) throw cancelled();
    if (host.closing) await abortable(host.closing.catch(() => {}), signal);
    try {
      return await host.play(config, producer, {...options,
        current: async () => epoch === this.epoch && host === this.vPcm && !this.closing && await current()});
    } finally { this.lastUsedAt = Date.now(); }
  }
  // ---- Releasing what nothing uses (docs/RESOURCE_LIFECYCLE.md) ----
  // Closes a local renderer page (a Chromium renderer, an AudioContext and its worklet) that no turn owns: V's line page (`line`, when
  // V's voice is off) and/or the companions' page (`companion`, when voice playback is off). A page that owns a turn is left alone and
  // the next call tries again. The next turn or warm-up opens a page again (about a second, overlapped with the voice's first packet).
  async releaseRendererPages({line = false, companion = false} = {}) {
    const closing = [];
    for (const [wanted, host] of [[companion, this.localPcm], [line, this.vPcm]]) {
      if (wanted && host && !host.active && !host.closing && (host.page || host.warming)) closing.push(host.close());
    }
    await Promise.allSettled(closing);
    return closing.length;
  }
  // Closes the whole hidden browser (Edge: a process tree of several hundred MB with a few pages) when nothing needs it: no Convai page open in
  // the pool (the keys the party retains are only permissions to keep one), no microphone lease, no renderer turn, and nothing used it for `idleMs`. `keepRenderer` is the
  // caller's wish to keep the local voice's renderer warm (a text provider with voice playback on); the browser then stays. The next
  // use starts it again (about 0.8 s for the browser and about 1 s for the page; a composer warm-up does it before the first reply).
  // Resolves true when the browser was closed.
  async releaseIfIdle({idleMs = 300_000, keepRenderer = false, now = Date.now()} = {}) {
    if (keepRenderer || this.closing || this.starting || !this.browser) return false;
    if (this.pool?.entries.size || this.voiceLease) return false;
    for (const host of [this.localPcm, this.vPcm]) if (host && (host.active || host.warming || host.closing)) return false;
    if (now - (this.lastUsedAt ?? 0) < idleMs) return false;
    await this.close();
    return true;
  }
  prepare(config, options) {
    // A speculative session is never written back by the page or retained in
    // the pool. Only the bridge can commit its result after exact submission.
    return this.run({...config, sessionId: '-1', freshSession: true}, 'reply', {...options, discard: true});
  }
  async retain(configs, options) {
    this.retained = {keys: configs.map(pageKey), options};
    await this.pool?.retain(this.retained.keys, options);
  }
  async readiness(config, {keepAlive = false} = {}) {
    const entry = this.pool?.entries.get(pageKey(config));
    if (!entry?.value || entry.value.isClosed()) return {present: false, ready: false};
    if (entry.busy) return {present: true, busy: true};
    return {present: true, ...await entry.value.evaluate(keepAlive => window.convaiRealtime.readiness(keepAlive), keepAlive)};
  }
  // Convai's emotion for a finished text-only reply (`lateEmotionToken` in that reply), which arrives about half a
  // second after its text. Reads the reply's own page only; never connects, waits or retains anything.
  async lateEmotion(config, token) {
    if (!Number.isSafeInteger(token) || token < 1) return {};
    const page = this.pool?.entries.get(pageKey(config))?.value;
    if (!page || page.isClosed()) return {};
    try { return await page.evaluate(token => window.convaiRealtime.lateEmotion?.(token) ?? {}, token) ?? {}; }
    catch { return {}; }
  }
  async refreshIdle(config) {
    // Reconnect only the exact idle transport after new memory is seeded.
    // SessionBindings and caller-owned session IDs retain their original
    // user/save/audience ownership; refreshing a page never resets history.
    const key = pageKey(config), pool = this.pool;
    return pool ? pool.discardIdle(key) : true;
  }
  voiceChannel() {
    const owner = {}, controller = new AbortController();
    return {beginVoice: config => this.beginVoice(config, {owner, signal: controller.signal}),
      finishVoice: (config, options) => this.finishVoice(owner, config, {...options, signal: controller.signal}),
      heard: () => this.voiceHeard(owner),
      close: async () => { controller.abort(); await this.cancelVoice(owner); }};
  }
  // The recognised words of the running microphone turn (empty when none): one cheap read of the voice page.
  async voiceHeard(owner = this) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner || lease.value.isClosed()) return '';
    try {
      const words = await lease.value.evaluate(() => window.convaiRealtime.heard ? window.convaiRealtime.heard() : null);
      // null: this page runs a voice client bundle older than the source (npm run build:voice); say so once.
      if (words === null && !this.heardBundleReported) {
        this.heardBundleReported = true;
        console.error('[CyberpunkConvai] Microphone: the voice client bundle has no live transcript yet; run npm run build:voice and restart the bridge');
      }
      return typeof words === 'string' ? words : '';
    }
    catch { return ''; }
  }
  beginVoice(config, options = {}) { return this.observe(this.beginVoiceOnce(config, options), false); }
  async beginVoiceOnce(config, {signal, owner = this} = {}) {
    throwIfCancelled(signal);
    this.guard?.check();
    config = {...config};
    delete config.audioStreamToken;
    delete config.liveSpeechToken;
    const key = pageKey(config);
    this.sessions.check(config);
    if (this.voiceLease) throw Error('Microphone connection is already running');
    await this.start({signal});
    const epoch = this.epoch;
    await this.yieldOtherSessions(key);
    throwIfCancelled(signal);
    const lease = await this.pool.acquire(key, {signal});
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      if (this.voiceLease) throw Error('Microphone connection is already running');
      lease.owner = owner; lease.config = config; lease.epoch = epoch; this.voiceLease = lease;
      this.connectOwners.set(lease.value, connectOwner(config));
      // This is the only code path that grants microphone permission.
      await lease.value.context().grantPermissions(['microphone'], {origin: new URL(lease.value.url()).origin});
      throwIfCancelled(signal);
      const credentialed = this.withVision(this.credential ? await abortable(Promise.resolve(this.credential(config)), signal) : config);
      throwIfCancelled(signal);
      const result = await lease.value.evaluate(config => window.convaiRealtime.beginVoice(config), credentialed);
      throwIfCancelled(signal);
      if (epoch !== this.epoch || this.voiceLease !== lease) throw cancelled();
      this.sessions.accept(config);
      this.sessions.bind(config, result.sessionID);
      lease.sessionID = result.sessionID;
      return result;
    } catch (error) {
      await lease.release({discard: true});
      if (this.voiceLease === lease) this.voiceLease = null;
      throw error;
    }
  }
  finishVoice(owner = this, config, options = {}) { return this.observe(this.finishVoiceOnce(owner, config, options)); }
  async finishVoiceOnce(owner = this, config, {signal, liveSpeech} = {}) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) throw Error('Microphone connection is not running');
    this.guard?.consume();
    let failed = true;
    try {
      if (lease.epoch !== this.epoch || this.closing) throw cancelled();
      if (config !== undefined) {
        config = {...config}; delete config.audioStreamToken; delete config.liveSpeechToken;
        if (config.freshSession || transportKey(config) !== transportKey(lease.config)
            || (config.sessionId && config.sessionId !== lease.config.sessionId && config.sessionId !== lease.sessionID)) {
          throw Error('Microphone reply identity changed');
        }
        this.sessions.check(config);
      }
      // "Companions can see": a picture staged while V talked is already on the page; one decided only now (V's last words
      // asked about something visible, or a queued picture) goes with the finish.
      let finishConfig = config || lease.config;
      const images = this.withVision(finishConfig).vision ? await this.turnImages(finishConfig, 'finish', await this.voiceHeard(owner)) : null;
      if (images) finishConfig = {...finishConfig, visionImages: images};
      const result = await this.evaluateSpeech(lease.value, 'finishVoice', finishConfig, {signal, liveSpeech,
        current: () => lease.epoch === this.epoch && this.voiceLease === lease && !this.closing});
      if (lease.epoch !== this.epoch || this.voiceLease !== lease) throw cancelled();
      this.sessions.accept(config || lease.config);
      this.sessions.bind(lease.config, result.sessionID);
      failed = false; return this.transformReply(result);
    }
    finally {
      await lease.value.context().clearPermissions().catch(() => {});
      await lease.release({discard: failed});
      if (this.voiceLease === lease) this.voiceLease = null;
    }
  }
  async cancelVoice(owner = this) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) return;
    this.voiceLease = null;
    await lease.value.context().clearPermissions().catch(() => {});
    await lease.release({discard: true});
  }
  close() {
    if (this.closing) return this.closing;
    this.epoch++;
    this.connectOwners = new WeakMap();
    const pool = this.pool, local = this.localPcm, voiceLine = this.vPcm, browser = this.browser, server = this.server, starting = this.starting;
    this.closing = (async () => {
      // Retire every ready page in parallel; total grace is one deadline, not
      // one deadline per companion. Closing the pool immediately fences leases.
      const grace = Promise.allSettled([...pool?.entries.values() || []]
        .map(entry => this.disconnectPage(entry.value)));
      const disposing = pool?.close();
      const localDisposing = local?.close(), voiceLineDisposing = voiceLine?.close();
      await grace;
      await Promise.allSettled([disposing, localDisposing, voiceLineDisposing, browser?.close(), starting]);
      server?.close();
      this.pool = this.localPcm = this.vPcm = this.browser = this.server = this.voiceLease = null;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  async diagnostics() {
    // Inspect existing pages only: no connection, microphone or conversation.
    // The browser getter enumerates booleans/counts and excludes all identities,
    // credentials and dialogue. Never serialize pool keys or SDK objects.
    const pages = [...this.pool?.entries.values() || []].map(entry => entry.value).slice(0, CONNECTION_LIMIT);
    return Promise.all(pages.map(async (page, index) => {
      let timer;
      try {
        const value = await Promise.race([
          page.evaluate(() => window.convaiRealtime.diagnostics()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 2000); }),
        ]);
        return {index, value};
      } catch { return {index, unavailable: true}; }
      finally { clearTimeout(timer); }
    }));
  }
}
