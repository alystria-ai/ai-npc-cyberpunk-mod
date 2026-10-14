// A voice-key turn on a text route (Mistral, the local AI) voiced while its reply is still being written
// (docs/LATENCY_2026-10-13.md, 4.1).
//
// A typed turn already works this way (`respondStreamed` in bridge/convai-bridge.mjs): the text host feeds a ReplyStream, the voice
// starts on the first complete sentence, and the finished reply is merged in when the voice is done. A voice-key turn went through
// `MicrophoneSession.finish` instead: `finishVoice` recognised the speech, asked the model and returned only when the WHOLE reply
// was written, and only then did `onReply` start the voice. The model's time after its first sentence (0.17 to 0.45 s on Mistral,
// about 1.2 s on the local AI) was added to every such turn.
//
// A VoiceKeyStream is the missing hook. `prepareReply` creates one and returns `options`, which `finishVoice` hands to the text host
// (`options.stream` is the ReplyStream the host feeds; `options.onTranscript` tells us what the player said, which the first
// sentence's admission needs). `speak` runs at once, in the background: it waits for the head, voices it, and waits for `final`
// (the finished reply) only where it needs it. `onReply` then calls `finish(result)` with what `finishVoice` returned and awaits
// `spoken`, which is exactly what `synthesizeReply` returns for a typed turn. A failure, a cancel or a stale turn aborts the voice.
export function startVoiceKeyStream({stream, signal, speak}) {
  const own = new AbortController();
  const onAbort = () => own.abort(signal.reason);
  if (signal?.aborted) own.abort(signal.reason); else signal?.addEventListener('abort', onAbort, {once: true});
  let resolveFinal, rejectFinal, userText = '', ended = false;
  const final = new Promise((done, fail) => { resolveFinal = done; rejectFinal = fail; });
  final.catch(() => {});
  const spoken = Promise.resolve().then(() => speak({stream, final, signal: own.signal, userText: () => userText}));
  spoken.catch(() => {}).finally(() => signal?.removeEventListener('abort', onAbort));
  return {
    // What the text host's `reply(config, options)` takes beside the abort signal; spread into finishVoice's options.
    options: {stream, onTranscript: text => { if (typeof text === 'string') userText = text.trim(); }},
    spoken,
    /** The finished reply (what finishVoice returned). */
    finish(result) { if (!ended) { ended = true; resolveFinal(result); } },
    /** The turn failed: whatever has not been voiced is dropped. */
    fail(error) { if (!ended) { ended = true; rejectFinal(error); } own.abort(error); },
    /** The turn is stale or cancelled: the voice stops. */
    abort() { if (!ended) { ended = true; rejectFinal(Error('The voice turn was cancelled')); } own.abort(); },
  };
}
