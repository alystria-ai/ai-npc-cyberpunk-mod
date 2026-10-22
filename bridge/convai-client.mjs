export async function requestReply({key, characterId, sessionId = '-1', text, audio, voice = false, signal}) {
  if (!!text === !!audio) throw Error('Provide text or microphone audio, not both');
  const body = new FormData();
  body.set('charID', characterId);
  body.set('sessionID', sessionId);
  body.set('voiceResponse', voice ? 'True' : 'False');
  if (audio) {
    body.set('file', new Blob([audio], {type: 'audio/wav'}), 'microphone.wav');
    body.set('sample_rate', '16000');
  } else body.set('userText', text);
  const response = await fetch('https://api.convai.com/character/getResponse', {
    // A redirect is an error: fetch would forward the CONVAI-API-KEY header (only Authorization is stripped) to another host.
    method: 'POST', redirect: 'error', headers: {'CONVAI-API-KEY': key}, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
  });
  if (!response.ok) throw Error(`Convai returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.text !== 'string' || !result.text.trim() || typeof result.sessionID !== 'string') {
    throw Error('Convai reply was missing text or a session ID');
  }
  return {text: result.text.trim().slice(0, 1200), sessionID: result.sessionID,
    audio: typeof result.audio === 'string' ? result.audio : null};
}
