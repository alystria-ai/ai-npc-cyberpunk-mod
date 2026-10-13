// V speaking to an add-on speaker (the voice keys F7 and F10; docs/ADDON_API.md, "Talk and group conversation").
//
// Convai recognises speech inside its own session, which an add-on speaker never opens. So the recording is recognised on this computer
// by the recogniser the Mistral route already uses (bridge/local-stt.mjs through bridge/local-stt-capture.mjs, `speech`), whatever
// the player's conversation provider is, and the words go to the add-on turn route (`runTurn`: Mistral or the local AI). No Convai
// connection, memory or warm-up is ever involved, and the main mod's voice path is untouched for every other speaker.
//
//   isSpeaker(profileKey)      true for an add-on speaker (always false with no add-on installed)
//   speech                     createLocalSpeech(...): voiceChannel({reply}) returns a channel like RealtimeHost.voiceChannel()
//   currentFor(id, signal)     the turn's "is this still the live recording" check, {async fn, .sync}
//   runTurn({input, signal, current, userText})   runs the add-on turn (and publishes it)
//   answerError({input, signal, current, error})  tells the game the service could not reply
// The channel's reply step runs the whole turn, publishing included; the microphone session's own reply step has nothing left to do.

/** The microphone session's route for such a recording: no Convai character, no Convai end user, no cloud voice. */
export const addonVoiceConfig = input => ({requestId: input.requestId, profileKey: input.profileKey,
  scope: input.group ? 'group' : 'private', ttsEnabled: false, addonInput: input});

export function createAddonVoice({isSpeaker, speech, currentFor, runTurn, answerError}) {
  const voice = input => isSpeaker(input?.profileKey) === true;
  async function reply(config, {signal} = {}) {
    // The input the game sent at finish (config.addonInput) with the recognised words in place of the "[Microphone]" placeholder.
    const input = {...config.addonInput, text: config.text}, spoken = {text: '', userText: config.text, published: true};
    const current = currentFor(input.requestId, signal);
    try { await runTurn({input, signal, current, userText: config.text}); }
    catch (error) {
      // A cancelled recording says nothing; any other failure is about the service, not about the microphone.
      if (signal?.aborted || !await current()) return spoken;
      await answerError({input, signal, current, error});
    }
    return spoken;
  }
  const channel = () => speech.voiceChannel({reply});
  return {voice, channel, reply, config: addonVoiceConfig,
    // The microphone session's host factory: an add-on speaker's recording gets the local channel, every other one `fallback(input, config)`.
    hostFactory: fallback => (input, config) => voice(input) ? channel() : fallback(input, config)};
}
