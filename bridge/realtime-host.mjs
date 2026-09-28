import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {TransportPool, abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';
import {CONNECTION_LIMIT} from './party-connections.mjs';

const pageKey = config => JSON.stringify([config.characterId, config.scope || 'private']);

export class RealtimeHost {
  constructor() { this.epoch = 0; }
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
    const capture = await readFile(new URL('./capture-worklet.js', import.meta.url));
    if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) { res.writeHead(403).end(); return; }
      if (req.url === '/client.js' || req.url === '/capture.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(req.url === '/client.js' ? bundle : capture);
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
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.waitForFunction(() => !!window.convaiRealtime);
          return page;
        } catch (error) { await page.close().catch(() => {}); throw error; }
      }, dispose: async page => { await page?.close({runBeforeUnload: false}).catch(() => {}); }});
      if (this.retained) await this.pool.retain(this.retained.keys, this.retained.options);
    } catch (error) { await browser?.close(); server.close(); throw error; }
  }
  async run(config, method, {signal, discard = false} = {}) {
    throwIfCancelled(signal);
    const started = performance.now();
    await this.start({signal});
    throwIfCancelled(signal);
    const startupMs = performance.now() - started, epoch = this.epoch;
    const waiting = performance.now(), lease = await this.pool.acquire(pageKey(config), {signal});
    const poolWaitMs = performance.now() - waiting;
    const cancel = () => { void lease.release({discard: true}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    let failed = true;
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      const result = await abortable(lease.value.evaluate(({config, method}) => window.convaiRealtime[method](config), {config, method}), signal);
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
  voiceChannel() {
    const owner = {}, controller = new AbortController();
    return {beginVoice: config => this.beginVoice(config, {owner, signal: controller.signal}),
      finishVoice: () => this.finishVoice(owner),
      close: async () => { controller.abort(); await this.cancelVoice(owner); }};
  }
  async beginVoice(config, {signal, owner = this} = {}) {
    await this.start({signal});
    const lease = await this.pool.acquire(pageKey(config), {signal});
    try {
      throwIfCancelled(signal);
      lease.owner = owner; this.voiceLease = lease;
      // This is the only code path that grants microphone permission.
      await lease.value.context().grantPermissions(['microphone'], {origin: new URL(lease.value.url()).origin});
      return await lease.value.evaluate(config => window.convaiRealtime.beginVoice(config), config);
    } catch (error) {
      await lease.release({discard: true});
      if (this.voiceLease === lease) this.voiceLease = null;
      throw error;
    }
  }
  async finishVoice(owner = this) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) throw Error('Microphone connection is not running');
    let failed = true;
    try { const result = await lease.value.evaluate(() => window.convaiRealtime.finishVoice()); failed = false; return result; }
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
    const pool = this.pool, browser = this.browser, server = this.server, starting = this.starting;
    this.closing = (async () => {
      // Closing the browser immediately also cancels page evaluations and mic
      // acquisition; do not wait for a complete response before cancelling.
      await Promise.allSettled([pool?.close(), browser?.close(), starting]);
      server?.close();
      this.pool = this.browser = this.server = this.voiceLease = null;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}
