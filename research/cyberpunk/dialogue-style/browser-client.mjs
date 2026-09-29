import {ConvaiClient} from '@convai/web-sdk/vanilla';

let client, turn;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, milliseconds, code) {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > milliseconds) throw Error(code);
    await delay(25);
  }
}

async function close() {
  turn = null;
  if (client) await client.disconnect();
  client = null;
}

async function connect(config) {
  await close();
  const started = performance.now();
  client = new ConvaiClient({
    apiKey: config.key, characterId: config.characterId, endUserId: config.endUserId,
    characterSessionId: '-1', transport: 'livekit',
    startWithAudioOn: false, enableVideo: false, enableLipsync: false,
    ttsEnabled: false, logRtviMessages: false,
    respondModes: {contextUpdate: 'silent'},
  });
  client.on('messagesChange', messages => {
    if (!turn) return;
    const rows = messages.filter(m => !turn.before.has(m.id)
      && ['bot-llm-text', 'convai'].includes(m.type) && m.content?.trim());
    const text = rows.map(m => m.content).join(' ').trim();
    if (text) turn.firstTextMs ??= performance.now() - turn.started;
    turn.text = text;
    turn.complete = rows.length > 0 && rows.every(m => m.isStreaming === false);
  });
  client.on('error', () => { if (turn) turn.error = 'SDK_ERROR'; });
  client.on('disconnect', () => { if (turn) turn.error = 'SDK_DISCONNECTED'; });
  client.on('llmNoResponse', () => { if (turn) turn.error = 'SDK_NO_REPLY'; });
  try {
    await Promise.race([client.connect(), delay(35000).then(() => { throw Error('CONNECT_TIMEOUT'); })]);
    await until(() => client.isBotReady, 20000, 'BOT_READY_TIMEOUT');
    if (client.state.endUserId !== config.endUserId || client.characterId !== config.characterId)
      throw Error('SDK_IDENTITY_MISMATCH');
    if (client.chatMessages.some(m => ['bot-llm-text', 'convai'].includes(m.type) && m.content?.trim()))
      throw Error('UNEXPECTED_INITIAL_DIALOGUE');
    client.updateContext({mode: 'replace', run_llm: 'false', text: config.context});
    // Data-channel messages are ordered; let the silent context enqueue before
    // the first text turn. This delay is excluded from response latency.
    await delay(200);
    return {connectionMs: performance.now() - started, sessionId: client.characterSessionId,
      identityVerified: true, microphoneTracks: client.room.localParticipant.audioTrackPublications.size};
  } catch (error) {
    return {error: /^[A-Z_]+$/.test(error.message) ? error.message : 'SDK_CONNECT_FAILED'};
  }
}

async function reply(text) {
  if (!client?.isBotReady || turn) return {error: 'SDK_NOT_READY'};
  const current = turn = {started: performance.now(), before: new Set(client.chatMessages.map(m => m.id)),
    text: '', complete: false, firstTextMs: null};
  try {
    client.sendUserTextMessage(text);
    await until(() => {
      if (current.error) throw Error(current.error);
      return current.text && current.complete && !client.state.isThinking;
    }, 75000, 'REPLY_TIMEOUT');
    return {text: current.text, firstTextMs: current.firstTextMs,
      completeMs: performance.now() - current.started, sessionId: client.characterSessionId,
      textComplete: true};
  } catch (error) {
    return {error: /^[A-Z_]+$/.test(error.message) ? error.message : 'SDK_REPLY_FAILED',
      partialText: current.text, firstTextMs: current.firstTextMs,
      completeMs: performance.now() - current.started};
  } finally { turn = null; }
}

window.dialogueStyleProbe = {connect, reply, close, version: 1};
