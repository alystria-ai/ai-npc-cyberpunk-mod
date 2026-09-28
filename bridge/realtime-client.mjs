import {ConvaiClient} from '@convai/web-sdk/vanilla';

let client, identity, context, source, capture, prime, remote, turn, micTimer;
const sessions = new Map();
const waitFor = (condition, timeout, message) => new Promise((resolve, reject) => {
  const start = performance.now();
  const timer = setInterval(() => {
    try {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (performance.now() - start > timeout) { clearInterval(timer); reject(Error(message)); }
    } catch (error) { clearInterval(timer); reject(error); }
  }, 50);
});

async function close() {
  clearTimeout(micTimer);
  if (client) await disableMic().catch(() => {});
  if (turn) { turn.error = 'Conversation cancelled'; turn = null; }
  source?.disconnect(); capture?.disconnect();
  if (prime) { remote?.detach(prime); prime.pause(); prime.srcObject = null; prime.remove(); }
  if (context) await context.close().catch(() => {});
  if (client) {
    if (client.characterSessionId) sessions.set(identity, client.characterSessionId);
    await client.disconnect().catch(() => {});
  }
  client = context = source = capture = prime = remote = identity = null;
}

async function connect(config) {
  const desired = config.characterId + ':' + (config.scope || 'private');
  if (identity === desired && client?.isBotReady) return;
  await close();
  identity = desired;
  client = new ConvaiClient({apiKey: config.key, characterId: config.characterId,
    characterSessionId: sessions.get(identity) || config.sessionId, transport: 'livekit', startWithAudioOn: false,
    enableVideo: false, enableLipsync: true, logRtviMessages: false,
    blendshapeConfig: {format: 'arkit', output_fps: 30}});
  context = new AudioContext({sampleRate: 48000});
  await context.audioWorklet.addModule('/capture.js');
  await context.resume();
  capture = new AudioWorkletNode(context, 'convai-capture');
  capture.connect(context.destination); // Processor emits silence, only captures remote NPC audio.
  capture.port.onmessage = ({data}) => {
    if (!turn) return;
    if (data.pcm.some(x => Math.abs(x) > 0.00015)) turn.lastSignal = performance.now();
    if (!turn.origin) {
      if (!turn.lastSignal) return;
      turn.origin = data.at;
    }
    if (data.at - turn.origin > 120) { turn.error = 'Voice exceeded two minutes'; return; }
    turn.chunks.push(data);
  };
  const attach = track => {
    if (track.kind !== 'audio' || source) return;
    remote = track;
    prime = document.createElement('audio'); prime.autoplay = true;
    track.attach(prime); prime.muted = true; prime.volume = 0; document.body.append(prime);
    void prime.play().catch(() => { if (turn) turn.error = 'Remote audio decoder could not start'; });
    source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    source.connect(capture);
  };
  client.room.on('trackSubscribed', attach);
  client.on('error', () => { if (turn) turn.error = 'Convai realtime connection failed'; });
  client.on('disconnect', () => { if (turn) turn.error = 'Convai realtime connection closed'; });
  client.on('messagesChange', messages => {
    if (!turn) return;
    const fresh = messages.filter(m => !turn.before.has(m.id));
    const llm = fresh.filter(m => ['bot-llm-text', 'convai'].includes(m.type) && m.content?.trim());
    const rows = llm.length ? llm : fresh.filter(m => m.type === 'bot-output' && m.content?.trim());
    turn.text = rows.map(m => m.content).join(' ').trim();
  });
  client.on('botOutput', data => {
    if (turn && data.text && (data.spoken || ['in-progress', 'completed'].includes(data.spokenStatus))) {
      turn.captions.push({at: context.currentTime, text: data.text});
    }
  });
  await client.connect();
  await waitFor(() => client?.isBotReady, 20000, 'Convai character did not become ready');
  await client.room.startAudio();
  if (prime) { prime.muted = true; prime.volume = 0; }
  client.room.remoteParticipants.forEach(p => p.audioTrackPublications.forEach(pub => { if (pub.track) attach(pub.track); }));
  client.updateDynamicInfo('You are speaking to V in Night City. Reply briefly in one or two spoken sentences without stage directions. No quest or relationship state has been supplied; do not invent it.');
}

function encodeWav(chunks, rate) {
  const length = chunks.reduce((sum, c) => sum + c.pcm.length, 0);
  const bytes = new Uint8Array(44 + length * 2), view = new DataView(bytes.buffer);
  const label = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, length * 2, true);
  let at = 44;
  for (const chunk of chunks) for (const sample of chunk.pcm) { view.setInt16(at, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true); at += 2; }
  let binary = '';
  for (let at = 0; at < bytes.length; at += 16384) binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
  return btoa(binary);
}

function beginTurn() {
  return turn = {before: new Set(client.chatMessages.map(m => m.id)), chunks: [], faces: [], captions: [], text: '', origin: 0, lastSignal: 0};
}

async function collect(current) {
  const started = performance.now();
  let previous = started, carry = 0;
  try {
    await waitFor(() => {
      if (current.error) throw Error(current.error);
      const now = performance.now(), q = client.blendshapeQueue;
      carry += Math.min((now - previous) / 1000, 0.25) * q.getPlaybackFps(); previous = now;
      const count = Math.min(Math.floor(carry), q.length); carry -= Math.floor(carry);
      if (count) {
        const frame = q.getFrameWithAlpha(count - 1); q.consumeFrames(count);
        if (frame) current.faces.push({at: context.currentTime, values: Array.from(frame)});
      }
      return current.text && current.chunks.length && q.isConversationEnded() && !q.length
        && !client.state.isSpeaking && !client.state.isThinking && now - current.lastSignal > 450;
    }, 60000, 'Convai did not finish the voiced reply');
    const result = {text: current.text, sessionID: client.characterSessionId,
      audio: encodeWav(current.chunks, context.sampleRate),
      faces: current.faces.map(f => ({at: Math.max(0, f.at - current.origin), values: f.values})),
      captions: current.captions.map(c => ({at: Math.max(0, c.at - current.origin), text: c.text}))};
    return result;
  } finally { if (turn === current) turn = null; }
}

async function reply(config) {
  await connect(config);
  client.updateDynamicInfo('You are speaking to V in Night City. Reply briefly without stage directions. No verified quest or relationship state is supplied. '
    + (config.context || 'This is a private conversation with V.'));
  const current = beginTurn();
  client.sendUserTextMessage(config.text);
  return collect(current);
}

async function disableMic() {
  clearTimeout(micTimer);
  if (!client) return;
  const pubs = [...client.room.localParticipant.audioTrackPublications.values()];
  try { await client.audioControls.disableAudio(); }
  finally {
    for (const pub of pubs) if (pub.source === 'microphone' && pub.track) {
      pub.track.mediaStreamTrack.stop();
      await client.room.localParticipant.unpublishTrack(pub.track, true).catch(() => {});
    }
  }
}

async function beginVoice(config) {
  await connect(config);
  beginTurn();
  client.toggleStt(true);
  try {
    await client.audioControls.enableAudio();
    const pub = [...client.room.localParticipant.audioTrackPublications.values()].find(p => p.source === 'microphone');
    if (!pub?.track || pub.isMuted || pub.track.mediaStreamTrack.readyState !== 'live') throw Error('No live microphone track');
    micTimer = setTimeout(() => { void disableMic(); }, 30000);
    return {device: pub.track.mediaStreamTrack.label};
  } catch (error) { await disableMic(); turn = null; throw error; }
}

async function finishVoice() {
  await disableMic();
  if (!turn) throw Error('No microphone conversation is active');
  return collect(turn);
}

window.convaiRealtime = {reply, beginVoice, finishVoice, close};
