import {transportKey} from './transport-pool.mjs';
import {followUpsEnabled} from './conversation-style.mjs';

// Context can change while V speaks; the recording's recipient cannot. Keep
// this receipt separate from the caller's input object, which may be replaced
// by a freshly verified knowledge projection at finish. The bridge retains
// ownership of its original world/session guard across both projections.
const recordingIdentity = input => JSON.stringify([input?.requestId, input?.entity, input?.generation,
  input?.profileKey, input?.channel ?? 'private', followUpsEnabled(input?.followUpQuestions), input?.group ? [input.group.id, input.group.index,
    input.group.total, [...input.group.audience].sort()] : null]);

// Hardware operations are serialized. A finish/cancel arriving while the
// device is opening is applied immediately after open completes.
export class MicrophoneSession {
  constructor({hostFactory, onState, onReply, onError}) {
    Object.assign(this, {hostFactory, onState, onReply, onError});
    this.current = null;
    this.revision = 0;
  }
  async start(input, config) {
    config = {...config};
    const identity = recordingIdentity(input), route = transportKey(config);
    const revision = ++this.revision;
    await this.release();
    if (revision !== this.revision) return;
    const session = this.current = {input, requestId: input.requestId, identity, route,
      host: this.hostFactory(), intent: 'record', opened: 0, controller: new AbortController()};
    await this.onState('starting', input);
    if (this.current !== session || session.intent === 'cancel') return;
    session.opening = session.host.beginVoice(config);
    try {
      await session.opening;
      if (this.current !== session || session.intent === 'cancel') { await session.host.close(); return; }
      session.opened = Date.now();
      if (session.intent === 'finish') return this.finish(session.requestId);
      await this.onState('recording', input);
    } catch (error) {
      if (this.current === session && session.intent !== 'cancel') { this.current = null; await session.host.close(); await this.onError(session.input, error); }
    }
  }
  async finish(requestId, refresh) {
    const session = this.current;
    if (!session || session.requestId !== requestId || session.finishing || session.intent === 'cancel') return;
    try {
      if (recordingIdentity(refresh === undefined ? session.input : refresh?.input) !== session.identity) {
        throw Error('Microphone context no longer matches the recording');
      }
      if (refresh !== undefined) {
        if (!refresh || !refresh.input || !refresh.config || typeof refresh.config !== 'object'
            || Array.isArray(refresh.config)
            || transportKey(refresh.config) !== session.route || refresh.config.freshSession) {
          throw Error('Microphone context no longer matches the recording');
        }
        session.input = refresh.input;
        session.finishConfig = {...refresh.config};
      }
    } catch {
      // Retire the original utterance without sending it to another route.
      session.intent = 'cancel'; session.finishing = true;
      session.controller.abort();
      await session.host.close();
      if (this.current === session) {
        this.current = null;
        await this.onError(session.input, Error('Microphone context no longer matches the recording'));
        await this.onState('off', session.input);
      }
      return;
    }
    session.intent = 'finish';
    if (!session.opened) return;
    session.finishing = true;
    await this.onState('reply', session.input);
    try {
      if (this.current !== session || session.intent === 'cancel') return;
      const result = await session.host.finishVoice(session.finishConfig);
      if (this.current === session && session.intent !== 'cancel') await this.onReply(session.input, result, session.controller.signal);
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
    session.controller.abort();
    await session.host.close();
    await this.onState('off', session.input);
  }
  async tick(alive) {
    const session = this.current;
    if (!session) return;
    if (!alive) { await this.cancel(); return; }
    if (session.opened && Date.now() - session.opened >= 30000) await this.finish(session.requestId);
  }
}
