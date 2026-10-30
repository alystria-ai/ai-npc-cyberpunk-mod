# Inworld cloud voice

An optional Companion voice that speaks every reply with Inworld's text-to-speech, in a voice cloned from the character's own reference clip. It runs on the player's **own Inworld key**. It is a voice only: there is no Inworld text provider, so it works beside any conversation provider.

It came back on 2026-10-30. The first version was removed on 2026-10-20 (commit 7a317266). This version is smaller: one cheap fast model, no steering, no emotion mapping.

## For the player

- Settings > Voices > Custom voices, last section: **Inworld API key** (Add reads the clipboard once, checks the key with Inworld and saves it on this computer, Remove deletes it, only the last four characters are ever shown), **Test connection** and an **Inworld voice** line that says whether the voice can be chosen.
- Settings > Voices > Companion voices: **Inworld · Cloud voice** is the last entry. It is listed only once a key is saved (or while it is the saved voice, so the row never shows another voice than the saved one).
- Get a key at inworld.ai. Inworld's free plan is a one-time trial of about 70 minutes of speech, then you pay as you go. Cloning a character is a request of its own and is limited on the free plan (2 a minute).
- English only. A reply in another language is shown as text (never Pocket, never the Convai voice).
- Not used with Mature content, like the Mistral voice: with Mature content on, a saved Inworld choice reads as Pocket, the entry is greyed out and choosing it is refused. Turning Mature content on moves the voice to Pocket and turning it off puts it back (when the key is still saved).

## The rules it keeps

- **A cloud voice loads no local model.** With Inworld chosen no Pocket and no OmniVoice worker starts, not even as a backup. A reply it cannot deliver is asked again once with a longer wait (9 s for the first audio), then shown as written text. It never silently switches to another voice, and a reply that Inworld began is never continued by another engine (`bridge/voice-utterance.mjs`).
- **A local voice never goes cloud.** A failing Pocket or OmniVoice is never handed to Inworld (`bridge/voice-selection.mjs`: only the chosen cloud voice is ever asked).
- **Unload what is unused.** Nothing of it runs while it is not chosen: the key file is read at start-up and that is all. No request, no clip read and no voice list is made until a reply (or the warm-up of a chosen Inworld voice) needs one. Choosing another voice stops the warm-ups and the requests at the next idle moment.
- **Mature content bars it** (`cloudBarred`, owner decision of 2026-10-20 for all cloud voices).
- V's own voice engine stays Pocket, Voxtral or OmniVoice. Inworld is a companion voice only.

## How it works (`bridge/inworld-voice.mjs`)

- Speech: `POST https://api.inworld.ai/tts/v1/voice:stream`, `Authorization: Basic <key as the portal gives it>`, body `{text, voiceId, modelId: "inworld-tts-2-flash", audioConfig: {audioEncoding: "PCM", sampleRateHertz: 24000}}`. The answer is newline-delimited JSON with base64 16-bit PCM in `result.audioContent`. The adapter converts it to float32 and hands 100 ms packets to the same consumer Pocket and Voxtral use, so subtitles, lip sync and the facial model are unchanged.
- Model: **Realtime TTS-2 Flash** (`inworld-tts-2-flash`), the one Inworld lists with the lowest latency (about 20 ms server side) and the lowest cost per character. TTS-2 (`inworld-tts-2`) adds steering instructions and costs more, and Flash ignores steering, so the text goes out plain (the reply's tags are stripped before it arrives here).
- Cloning (instant voice cloning): `POST https://api.inworld.ai/voices/v1/voices:clone` with the character's reference clip (the same clips and the same choice of set as the Mistral voice: OmniVoice long, short, Pocket, a player's own clip, extracted clips). A character is cloned **once**: the answer is a voice id, kept in `player-inworld-voices.json` in the state folder, and every later reply sends only the id. The voice is named `cp2077-companion-<character>-<hash of the clip>`, so a lost file is rebuilt from the account's voice list (`GET /voices/v1/voices`, free) instead of cloning again, and an older voice of the same character is removed when the clip changes.
- Clones go one at a time and never faster than the plan allows (2 a minute on the free plan). The first reply of a character whose voice is not ready yet is written only (the voice is made in the background, and the warm-up starts it when the character is prepared).
- Limits: 4,000 characters per request (longer text is not spoken), 5 s to the first audio, 8 s of silence ends a running stream. A 429 pauses requests for the server's Retry-After, a refused key for 60 s, a used-up plan (402 or a quota message) for 30 minutes.
- The key goes only in the Authorization header of a request to api.inworld.ai. It is stored only in `player-inworld-key.txt` in the state folder (never in the game folder, `settings.json`, a status file or a log), pasted through `runtime/inworld-key-command.json` (the same file protocol as the Mistral key, `bridge/mistral-key.mjs` `MistralControl`) and scrubbed from support reports (`bridge/report-secrets.mjs`, `bridge/support-report.mjs`).
- The status the settings page reads (`runtime/mistral-state.json`, under `inworld`) holds `saved`, the last four characters and the latest Add, Remove or Test result, never the key.

## Measured (2026-10-30, one PC, the real API, `scripts/Measure-InworldVoice.mjs`)

Time from sending the request to the first PCM packet, for a 24 character line in a cloned voice: 431, 406 and 1253 ms (median 431 ms) for Judy, then 643 and 394 ms for Panam after a fresh clone. The clone itself took 6.3 s once. Inworld's own figure for the model is about 20 ms server side, so the rest is the network and the first connection.

The free plan allows about 70 minutes of speech once. The measurements above used about 15 seconds of it.

```
node scripts/Measure-InworldVoice.mjs --key-file <file with the key> --references <runtime folder> --latency 3 [--profile judy-alvarez] [--out <folder>] [--test-only]
```

## Tests

`bridge/inworld-voice.test.mjs` (the adapter against a local fake Inworld, the voice selection beside it), `bridge/inworld-failure-paths.test.mjs`, `bridge/inworld-key.test.mjs`, `bridge/inworld-voice-choice.test.mjs` (the cloud-voice rules, the key commands, packaging) and `bridge/inworld-settings-lua.test.mjs` (the rows and their place at the bottom of Custom voices). No test calls the real API.
