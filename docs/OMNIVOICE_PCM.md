# OmniVoice on the mod's own audio path

2026-10-22. Audioware is no longer a requirement. OmniVoice, which used to be the one voice played through Audioware, is now played by the
same renderer as Pocket, Voxtral and Convai.

## What changed

| | Before | Now |
| --- | --- | --- |
| Where a phrase went | A WAV in one of 8 slot files under `r6/audioware/CyberpunkConvai`, plus `speech.yml` and a `speech-stream.json` manifest | Float32 24 kHz PCM packets into the hidden browser renderer (`bridge/local-pcm-host.mjs`), one page, its own Windows audio session |
| Who played it | Audioware (Kira) from `Speech.reds` (`DynamicEmitterEvent`, `DynamicSoundEvent` on V for holocalls) | The renderer, under the game's lease (`mod/continuous-speech.lua`): volume, camera-relative pan, distance gain |
| Level | `storeSpeech` wrote the dialogue makeup and Voice volume into each slot WAV | The same makeup and Voice volume as sample gain behind the limiter in the renderer, for every voice |
| Face | Per phrase, analysed whole (`jaliFace.analyseWav`) before the phrase could be published | The streaming face model (`PocketFacialStream`), as for Pocket; it covers the first half second about 80 ms after the phrase is rendered |
| Clock for face and subtitles | The Audioware cursor | The renderer's heard cursor, reported every 40 ms |
| Holocall, Johnny in V's head | `ConvaiSpeechStartOnV` (Audioware's V track) | The lease flag `holocall` / `head`: full level, centred, no distance (same as Pocket) |

## The pieces

- `bridge/omni-pcm.mjs`: `createOmniPcmVoice({synthesize, voicedPhrases, steps})` has the contract of the Pocket worker's `synthesizeStream`, so
  `deliverPocketSpeech` (`bridge/pocket-speech.mjs`) and the group look-ahead buffer (`BufferedPcm`) take it unchanged. The reply is cut
  into phrases (`bridge/speech-phrases.mjs`); phrase 1 is rendered at once and phrase 2 is queued behind it on the worker (one job at a time),
  never more than 2 phrases beyond the one being sent and never more than 14 s of audio beyond what has been heard (a paused game does not
  render a long reply to its end). Each finished phrase is decoded (`wavToPcm`) and sent in packets of at most 2 s.
- A reply that is voiced while it is still being written (typed turn on Mistral / Local AI, the Convai text route, the voice key) sends its first
  sentence to the renderer at once, as Pocket does (OmniVoice used to wait for the finished reply). Voice tags of Natural speech are written into the
  rest of such a reply, not into its first sentence.
- `bridge/convai-bridge.mjs` `omniVoiceFor`: the per-reply adapter (tags, Developer-mode capture, the worker's job count that keeps memory maintenance
  and a held look-ahead off the GPU). `continuousSpeech(..., {engine: 'omni'})` gives OmniVoice its own `SpeechPace` (a line that broke makes the
  next ones buffer a little first), the Pocket expression planner and face builder.
- A game session whose Lua adapter does not advertise continuous playback (scripts not loaded yet, adapter failed) cannot play any voice: the
  reply is asked as text, with no audio requested, and shown with the notice "Local streaming is unavailable". The complete-WAV Convai route
  (ttsEnabled with a collected WAV) is gone with the slots.
- `mod/speech.lua` has only the continuous path. `Speech.reds` is an empty file with a comment: it stays so that installing over an older
  version replaces the old file (an old one would still import Audioware and break the compile when Audioware does not match the game).
- The bridge removes what older versions left under `r6/audioware/CyberpunkConvai` (`removeAudioDepot`, only files of exactly our names), and
  `packaging/runtime-removals.json` declares them for Runtime updates.

## Joins between phrases (28 Oct 2026, branch `feat/voice-034`)

The owner heard OmniVoice as "broken in phrases" at the joins and the ends. Measured on the CUDA model with the worker's own call (postprocess off): the model pads
every phrase with silence of its own, **150 to 900 ms before the first word (often 450 to 650) and 130 to 300 ms after the last**, so two phrases had 0.4 to 1.2 s of
dead air between them, a different length each time, even where the cut fell at a comma; the first word of a reply came about half a second late; phrases differ in
loudness by a few dB; and a phrase can end on the model's last frame with the voice still sounding. The cuts also fell at commas of a long sentence (the first
cut at the first comma after 12 words, later ones after 22), where the model ends its intonation as a finished sentence.

- `bridge/omni-join.mjs` (`PhraseJoiner`, used by `bridge/omni-pcm.mjs`): each phrase is cropped to its speech (30 ms of air before the first frame above -45 dB of the
  phrase's loudest, 80 ms after the last; 120 ms after the reply's last), faded (6 ms in where the crop began inside the padding, 30 ms raised-cosine out), set to the
  first phrase's loudness within +-3 dB (never past 0.98 peak; the first phrase is left as rendered) and followed by a pause of a speaker's length counted from sound to
  sound: 320 ms after a sentence, 140 ms after a comma or dash, 110 ms for a cut with no mark. A silence of more than 600 ms between two words inside a phrase (the model
  sometimes leaves 1.1 s between the sentences of one render) is cut to 450 ms, as the model's own post-processing (`mid_sil`, off in the worker) would. `createOmniPcmVoice({join: false})`
  sends phrases as rendered.
- `bridge/speech-phrases.mjs` (`PHRASE_LIMITS`): the first phrase ends at the first sentence end after 6 words (within 24; else the last comma within 24, else a sentence
  end within 32, else 24 words) so the first word is still early; the second, which renders while the first plays, ends at the last sentence end within 24 words
  (a longer sentence is not cut, it ends at its own end within 40); later phrases end at the LAST sentence end that fits 40 words (was a comma cut from 12 or 22 words
  on). A comma is a cut only when no sentence end can be reached. A render costs a fixed 1.4 to 1.7 s on a quiet RTX 4080 Laptop whatever its length up to about 5 s of
  speech (+0.1 s per further second), so longer later phrases are cheaper than two short ones.
- Cropping the model's lead is also the biggest first-sound gain: the first word starts 30 ms after the first packet instead of 450 to 900 ms.
- Measure: `node scripts/Measure-OmniJoins.mjs` (renders old and new cuts of four sample replies with `scripts/Render-OmniPhrases.py`, writes before/after WAVs and
  first-word / finished / join-silence numbers). Tests: `bridge/omni-join.test.mjs`, `bridge/speech-phrases.test.mjs`, `bridge/omni-pcm.test.mjs`.
- V's own OmniVoice line (`bridge/v-voice.mjs` `omniProducer`) is cropped the same way (`cropOmniPackets`), so the companion reply no longer waits behind the model's padding.

## Cost

- No per-frame work was added in the game: the Lua side lost code (the native phrase path, the manifest poll, the Audioware cursor read).
- Bridge side: decoding a phrase WAV to Float32 is a few milliseconds per phrase; the renderer converts to 16-bit as it does for Pocket.
- First sound, measured with `scripts/Measure-OmniFirstSound.mjs` (the same process runs the old and the new code alternately, real face model
  worker, real continuous-speech admission, offline renderer): from "first phrase rendered" to "reply published for the game", about 171 ms before
  (the face analysis is waited for) and about 80 ms after, in Silent power mode on the owner's laptop. The game's own half (the lease round
  trip and the renderer's first sample, about 135 to 140 ms from the first allowed lease on a warm page; before: Audioware's start) is a live check.

## Limits

- The renderer is a separate Windows audio session: no Wwise occlusion or reverb (Pocket and Convai never had them; Omni had Kira's).
- Natural speech tags are not written into the first sentence of a reply that is voiced while it is written.
- The OmniVoice worker still renders one phrase at a time (no streaming inside a phrase); a phrase longer than 22 or 34 words is split as before.
