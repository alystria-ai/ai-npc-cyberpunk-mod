// Hardware operations are serialized. A finish/cancel arriving while the
// device is opening is applied immediately after open completes.
export class MicrophoneSession {
  constructor({hostFactory, onState, onReply, onError}) {
    Object.assign(this, {hostFactory, onState, onReply, onError});
    this.current = null;
    this.revision = 0;
  }
  async start(input, config) {
    const revision = ++this.revision;
    await this.release();
    if (revision !== this.revision) return;
    const session = this.current = {input, host: this.hostFactory(), intent: 'record', opened: 0};
    await this.onState('starting', input);
    session.opening = session.host.beginVoice(config);
    try {
      await session.opening;
      if (this.current !== session || session.intent === 'cancel') { await session.host.close(); return; }
      session.opened = Date.now();
      if (session.intent === 'finish') return this.finish(input.requestId);
      await this.onState('recording', input);
    } catch (error) {
      if (this.current === session) { this.current = null; await session.host.close(); await this.onError(input, error); }
    }
  }
  async finish(requestId) {
    const session = this.current;
    if (!session || session.input.requestId !== requestId || session.finishing) return;
    session.intent = 'finish';
    if (!session.opened) return;
    session.finishing = true;
    await this.onState('reply', session.input);
    try {
      const result = await session.host.finishVoice();
      if (this.current === session && session.intent !== 'cancel') await this.onReply(session.input, result);
    } catch (error) {
      if (this.current === session && session.intent !== 'cancel') await this.onError(session.input, error);
    } finally {
      await session.host.close();
      if (this.current === session) { this.current = null; await this.onState('off', session.input); }
    }
  }
  async cancel() {
    ++this.revision;
    await this.release();
  }
  async release() {
    const session = this.current;
    if (!session) return;
    session.intent = 'cancel'; this.current = null;
    await session.host.close();
    await this.onState('off', session.input);
  }
  async tick(alive) {
    const session = this.current;
    if (!session) return;
    if (!alive) { await this.cancel(); return; }
    if (session.opened && Date.now() - session.opened >= 30000) await this.finish(session.input.requestId);
  }
}
