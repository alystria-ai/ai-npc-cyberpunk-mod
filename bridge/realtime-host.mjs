import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {TransportPool, abortable, cancelled, throwIfCancelled, transportKey, SessionBindings} from './transport-pool.mjs';
import {CONNECTION_LIMIT} from './party-connections.mjs';

const pageKey = transportKey;
// This is the installed SDK 1.7 default, also used by the captured live trial.
// The documentation's example uses live.convai.com; do not redirect the SDK.
const CONVAI_CONNECT_URL = 'https://realtime-api.convai.com/connect';

// SDK 1.7 does not serialize audio_config. Patch only its owned LiveKit connect
// request, leaving authentication, session and memory fields intact. Source
// PCM arrives before playback; the client returns one WAV without recapture.
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

export class RealtimeHost {
  constructor({disconnectTimeoutMs = 2500} = {}) {
    this.epoch = 0; this.sessions = new SessionBindings(); this.connectOwners = new WeakMap();
    this.disconnects = new WeakMap(); this.disconnectTimeoutMs = disconnectTimeoutMs;
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
    const previousPool = this.pool, previousBrowser = this.browser, previousServer = this.server;
    this.pool = this.browser = this.server = null;
    await Promise.allSettled([previousPool?.close(), previousBrowser?.close()]);
    previousServer?.close();
    // One hidden browser: eight party private pages plus three optional group
    // pages. No key endpoint, microphone permission or visible user profile.
    const bundle = await readFile(new URL('../runtime/realtime-client.js', import.meta.url));
    if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) { res.writeHead(403).end(); return; }
      if (req.url === '/client.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(bundle);
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/client.js"></script>');
      } else res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let browser;
    try {
      browser = await chromium.launch({channel: 'msedge', headless: true,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling']});
      if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
      this.browser = browser; this.server = server;
      this.pool = new TransportPool({limit: CONNECTION_LIMIT, create: async () => {
        const page = await browser.newPage();
        try {
          await installConvaiAudioRoute(page, () => this.connectOwners.get(page));
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.waitForFunction(() => !!window.convaiRealtime);
          return page;
        } catch (error) { await page.close().catch(() => {}); throw error; }
      }, dispose: page => this.disposePage(page)});
      if (this.retained) await this.pool.retain(this.retained.keys, this.retained.options);
    } catch (error) { await browser?.close(); server.close(); throw error; }
  }
  async run(config, method, {signal, discard = false, onAudioChunk} = {}) {
    throwIfCancelled(signal);
    config = {...config}; // Keep queued work bound to the identity admitted now.
    // Retire the old chunk capability. The reply now contains one source WAV.
    delete config.audioStreamToken;
    if (onAudioChunk !== undefined) throw Error('Chunked Convai playback is retired; use the complete reply audio');
    const key = pageKey(config);
    this.sessions.check(config);
    const started = performance.now();
    await this.start({signal});
    throwIfCancelled(signal);
    const startupMs = performance.now() - started, epoch = this.epoch;
    const waiting = performance.now(), lease = await this.pool.acquire(key, {signal});
    const poolWaitMs = performance.now() - waiting;
    const cancel = () => { this.connectOwners.delete(lease.value); void lease.release({discard: true}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    let failed = true;
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      this.connectOwners.set(lease.value, connectOwner(config));
      const result = await abortable(lease.value.evaluate(({config, method}) => window.convaiRealtime[method](config), {config, method}), signal);
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      this.sessions.accept(config);
      this.sessions.bind(config, result.sessionID);
      failed = false;
      const host = {browserStartupMs: startupMs, poolWaitMs, pageReused: lease.reused, pages: this.pool?.entries.size || 0};
      return method === 'warm' ? {...result, ...host} : {...result, timing: {...result.timing, ...host}};
    } finally {
      signal?.removeEventListener('abort', cancel);
      await lease.release({discard: discard || failed || signal?.aborted});
    }
  }
  reply(config, options) { return this.run(config, 'reply', options); }
  warm(config, options) { return this.run(config, 'warm', options); }
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
      finishVoice: config => this.finishVoice(owner, config),
      close: async () => { controller.abort(); await this.cancelVoice(owner); }};
  }
  async beginVoice(config, {signal, owner = this} = {}) {
    throwIfCancelled(signal);
    config = {...config};
    delete config.audioStreamToken;
    const key = pageKey(config);
    this.sessions.check(config);
    if (this.voiceLease) throw Error('Microphone connection is already running');
    await this.start({signal});
    const epoch = this.epoch;
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
      const result = await lease.value.evaluate(config => window.convaiRealtime.beginVoice(config), config);
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
  async finishVoice(owner = this, config) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) throw Error('Microphone connection is not running');
    let failed = true;
    try {
      if (lease.epoch !== this.epoch || this.closing) throw cancelled();
      if (config !== undefined) {
        config = {...config}; delete config.audioStreamToken;
        if (config.freshSession || transportKey(config) !== transportKey(lease.config)
            || (config.sessionId && config.sessionId !== lease.config.sessionId && config.sessionId !== lease.sessionID)) {
          throw Error('Microphone reply identity changed');
        }
        this.sessions.check(config);
      }
      const result = await lease.value.evaluate(config => window.convaiRealtime.finishVoice(config), config);
      if (lease.epoch !== this.epoch || this.voiceLease !== lease) throw cancelled();
      this.sessions.accept(config || lease.config);
      this.sessions.bind(lease.config, result.sessionID);
      failed = false; return result;
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
    const pool = this.pool, browser = this.browser, server = this.server, starting = this.starting;
    this.closing = (async () => {
      // Retire every ready page in parallel; total grace is one deadline, not
      // one deadline per companion. Closing the pool immediately fences leases.
      const grace = Promise.allSettled([...pool?.entries.values() || []]
        .map(entry => this.disconnectPage(entry.value)));
      const disposing = pool?.close();
      await grace;
      await Promise.allSettled([disposing, browser?.close(), starting]);
      server?.close();
      this.pool = this.browser = this.server = this.voiceLease = null;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}
