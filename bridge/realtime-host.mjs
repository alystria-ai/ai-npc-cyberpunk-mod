import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

export class RealtimeHost {
  constructor() { this.epoch = 0; }
  async start() {
    if (this.page) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    this.starting = this.initialize(epoch);
    try { await this.starting; } finally { this.starting = null; }
  }
  async initialize(epoch) {
    // No key endpoint, no microphone permission, no user profile, no visible UI.
    const bundle = await readFile(new URL('../runtime/realtime-client.js', import.meta.url));
    const capture = await readFile(new URL('./capture-worklet.js', import.meta.url));
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
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => !!window.convaiRealtime);
      if (epoch !== this.epoch) throw Error('Conversation startup cancelled');
      this.page = page; this.browser = browser; this.server = server;
    } catch (error) { await browser?.close(); server.close(); throw error; }
  }
  async reply(config) {
    await this.start();
    return this.page.evaluate(config => window.convaiRealtime.reply(config), config);
  }
  async beginVoice(config) {
    await this.start();
    await this.page.context().grantPermissions(['microphone'], {origin: new URL(this.page.url()).origin});
    return this.page.evaluate(config => window.convaiRealtime.beginVoice(config), config);
  }
  async finishVoice() {
    if (!this.page) throw Error('Microphone connection is not running');
    try { return await this.page.evaluate(() => window.convaiRealtime.finishVoice()); }
    finally { await this.page?.context().clearPermissions(); }
  }
  async close() {
    this.epoch++;
    await this.starting?.catch(() => {});
    await this.page?.evaluate(() => window.convaiRealtime?.close()).catch(() => {});
    await this.browser?.close().catch(() => {});
    this.server?.close();
    this.page = this.browser = this.server = null;
  }
}
