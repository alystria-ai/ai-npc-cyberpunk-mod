# Fully free cloud option: measurements and research

> Groq was removed as a conversation provider by the user on 2026-10-14 (route, key handling, prompt shaping, scripts). The Groq parts below are history and describe code that no longer exists.

Measured and researched on 2026-10-12 for the "fully free cloud" player option (TODO.md, "Requested 2026-10-12", option 3).
Nothing in the mod was changed. Throwaway probe scripts lived in the session scratchpad; no key was printed, logged or stored.
Limits quoted from provider documentation are marked (docs); limits read from response headers on the developer's own free keys are
marked (headers). Third-party figures are marked (unverified).

## Summary

| Question | Answer |
|---|---|
| Fastest text route | Groq. `qwen/qwen3.8-27b` answered in about 0.45 s, `openai/gpt-oss-20b` and `-120b` in about 0.7 s (Mistral `ministral-14b` is 1.8 s, `ministral-8b` 1.05 s). |
| Best free limits for many turns | Mistral. Groq's free token budget is small (8,000 tokens a minute, 200,000 a day per model) and a real turn for a named character is 4,300 to 4,700 tokens. |
| Recommended text route | Keep Mistral as the default; offer `ministral-8b-latest` as the fast model and `ministral-14b-latest` as the quality model. Groq `openai/gpt-oss-20b` is an optional faster route for a player who adds a Groq key. |
| Voice cloning | Both clone Judy from the OmniVoice "long" reference (13.4 s). Inworld: first audio 0.74 s, 70 free minutes a month (about 290 to 700 replies), saved voice persists, text steering works on the clone. Mistral Voxtral on the free key: first audio 1.2 s median, no published monthly cap (only 12,000 characters a minute), no saved voices on the free plan (reference sent every call), no emotion control, and its streaming PCM is already the format the bridge uses (24 kHz float32). |
| Prompt caching | Mistral: pass `prompt_cache_key`; 2,816 of 2,868 tokens cached and not counted against the token budget. Groq: automatic on `gpt-oss`, hits about half the time, cached tokens not counted. Real turns are 4,300 to 4,700 tokens for a named character, so Groq's 200,000 a day is only about 44 turns until the prompt is trimmed (section 3b). |
| Embeddings and vector store | Local beats cloud for players: no key, offline, no VRAM, about 10 ms per chunk, no monthly cap. Cloud keys are worth testing only as a fallback. |

## 1. Text latency: Mistral against Groq

Setup: the real `bridge/mistral-prompt.mjs` builds the messages (Judy Alvarez persona from `characters/roster.json`, the rules block, a
short live context, `V says: ...` and the closing reminder). Streaming, `max_tokens` 80, temperature 0.65, sequential requests with 2.5 s
gaps for Mistral and 9 s gaps for Groq (its token-per-minute limit). 10 runs per model on the trimmed prompt, 6 or 4 on the full one.
Time to first token (TTFT) is the first content delta; "total" is the end of the stream. Home connection, one location, one afternoon,
so treat differences under 100 ms as noise.

Trimmed prompt (1,121 prompt tokens on Mistral, about 1,165 on Groq; the rules block alone is about 550 tokens, so this is above the
requested 600-900):

| Provider | Model | TTFT median | TTFT p90 | Total median | Total p90 | Notes |
|---|---|---|---|---|---|---|
| Groq | `allam-2-7b` | 264 ms | 543 | 316 ms | 589 | quality poor, see below |
| Groq | `qwen/qwen3.8-27b` (reasoning off) | 378 ms | 546 | 467 ms | 611 | one 503 "over capacity" seen earlier |
| Mistral | `open-mistral-nemo` | 453 ms | 635 | 911 ms | 1,281 | |
| Mistral | `ministral-8b-latest` | 520 ms | 784 | 1,055 ms | 2,518 | |
| Mistral | `ministral-3b-latest` | 610 ms | 1,025 | 1,195 ms | 1,980 | |
| Groq | `openai/gpt-oss-120b` (effort low) | 610 ms | 927 | 687 ms | 1,013 | hidden reasoning, then the reply arrives almost at once |
| Groq | `openai/gpt-oss-20b` (effort low) | 633 ms | 961 | 700 ms | 1,008 | effort medium: 648 / 680 ms (3 runs) |
| Mistral | `ministral-14b-latest` | 825 ms | 1,268 | 1,770 ms | 3,041 | the model the bridge uses today |

Full-size Judy prompt (2,873 tokens, 6 runs; Groq 4 runs): `ministral-14b` TTFT 818 ms / total 2,117 ms; `ministral-8b` 609 / 1,413;
`ministral-3b` 677 / 1,158; Groq `gpt-oss-20b` 1,061 / 1,097. Prompt size costs Mistral little; Groq's budget is what it hurts.

Not reachable on these free keys: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` and `meta-llama/llama-4-scout...` answer 404 on the
Groq key (the account lists only `gpt-oss-20b/120b`, `gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b`, `allam-2-7b`, Whisper, Orpheus and two
prompt-guard models). On Mistral, `mistral-small`, `mistral-medium` and `magistral-small` answer 429 with a request allowance of 0,
`mistral-large` answers 403, and `ministral-3b/8b/14b` and `open-mistral-nemo` work. A 429 "backend_out_of_capacity" (code 3505) also
appeared once in about 25 `ministral-14b` requests; the bridge's retry already handles 429.

Mistral's catalogue also lists `voxtral-mini-latest` (speech to text), `voxtral-mini-tts-latest` (text to speech), `mistral-embed` and
`codestral-embed`, all on the same key.

### Reply quality (Judy, "Are you an AI?", "Want to grab a drink?")

| Model | In character | Short | "As an AI" | Notes |
|---|---|---|---|---|
| `ministral-14b` | yes, richest | often 3 sentences, sometimes longer | none | vivid, sometimes invents small details |
| `ministral-8b` | yes | yes | none | good balance; once appended an English translation in brackets to a Japanese reply |
| `ministral-3b` | mostly | yes | none | invents names and events (Maiko, Mox) |
| `open-mistral-nemo` | yes | yes | none | good voice, natural |
| `gpt-oss-20b` | okay | yes | none | plain, occasionally "human, a few circuits" slip |
| `gpt-oss-120b` | flat | very short | none | "No, just a flesh-and-blood braindance tech." |
| `qwen3.8-27b` | okay | yes | none | fast; a little generic ("Yeah, I'm sure.") |
| `allam-2-7b` | no | no | none | calls V by name constantly, invents a meeting time; do not use |

No reply from any model said it was an AI, and none leaked tags (my `breaksCharacter` check flagged 0 of 119 replies).

### Spanish and Japanese (one prompt each, 2 runs per model, no language note in the live context)

| Model | Spanish | Japanese |
|---|---|---|
| `ministral-14b` | answered in English both times | answered in English both times |
| `ministral-8b` | one English, one Spanish | Japanese, but one reply carried a bracketed English translation |
| `gpt-oss-20b` | one English, one Spanish | good natural Japanese |
| `gpt-oss-120b` | one English, one Spanish | good natural Japanese |

My probe did not send the bridge's real "language" line in the live context (the production prompt does, and rule 6 of the system prompt
asks for the player's language), so the English answers are a floor, not the shipped behaviour. The Multilingual setting is off while the
provider is Mistral today; if it is enabled later, test `ministral-8b` and `gpt-oss-20b` first and send the language line.

## 2. Free-tier limits

### Text models

| Provider and model | Requests per minute | Requests per day | Tokens per minute | Tokens per day or month | Source |
|---|---|---|---|---|---|
| Mistral `ministral-3b-latest` | 750 | none stated | 1,300,000 | about 1 billion a month (unverified) | headers |
| Mistral `ministral-8b-latest` | 188 | none stated | 625,000 | about 1 billion a month (unverified) | headers |
| Mistral `open-mistral-nemo` | 188 | none stated | 625,000 | same | headers |
| Mistral `ministral-14b-latest` | 30 | none stated | 937,500 | same | headers |
| Mistral small, medium, magistral, large | 0 or not allowed | | | | headers |
| Groq `openai/gpt-oss-20b`, `-120b` | 30 | 1,000 | 8,000 | 200,000 a day | headers and docs |
| Groq `qwen/qwen3.8-27b` | 30 | 1,000 | 8,000 | 200,000 a day | docs (the 503 hid the headers once; the same 1,000 / 8,000 appeared) |
| Groq `allam-2-7b` | not stated | 7,000 | 6,000 | not stated | headers |

Mistral's own help pages publish no numbers for the free plan ("Free mode"; limits are requests per second, tokens per minute and tokens per
month, shown in the console's Limits page). The figures above are what the developer's key reported; the monthly billion is a third-party
number. Groq's docs table is labelled Developer-plan base limits; the developer's free key reported identical values, and Groq says limits are
per organisation, so each player needs their own key. Groq counts cached tokens as free.

What this means per turn (about 1,200 tokens in and 100 out for a trimmed prompt, 3,000 for a full one):
- Groq: 8,000 tokens a minute allows about 6 trimmed turns or 2 full-prompt turns a minute; 200,000 a day allows about 150 trimmed turns or
  65 full-prompt turns a day. Hidden reasoning tokens of the gpt-oss models count too, so use effort `low`.
- Mistral: the per-minute token budgets are hundreds of thousands, so the only practical ceiling is 30 requests a minute on 14b (188 on 8b).
  Each model has its own bucket, so falling from 14b to 8b to nemo gives more headroom.

Other notes: Mistral's free plan needs phone verification and no card; its help pages say free-mode data may be used to improve models (an
opt-out toggle exists under Privacy). Groq needs no card for the free plan (not confirmed in docs).

## 3. Voice: caps, cloning tests, emotion control and pipeline fit

### Voice usage caps and what they mean in replies

Two reply sizes are used. "Assumed" is the brief's 90 characters and 6 s. "Measured" is from the 48 real replies in
`runtime/mistral-prompt-tests/` (Mistral `ministral-14b`): 207 characters on average (105 to 411), which at the measured speaking rate of
about 14 characters a second is about 14.5 s of audio. Real replies are therefore more than twice the assumed size unless the prompt is
tightened. Measured rates: Inworld 14.1 characters/s, Voxtral 13.3, local OmniVoice 14.5.

| Service | Free cap | Replies a month (assumed 6 s) | Replies a month (measured 14.5 s) | Cloning on the free plan | Notes |
|---|---|---|---|---|---|
| Inworld TTS-2 | 70 minutes of TTS a month (docs: "up to 70 minutes of TTS for free"); then $25 per million characters | about 700 (23 a day) | about 290 (10 a day) | yes, instant clone, 3 to 30 s, 100 stored voices | Whether cloning itself uses minutes is not stated in the docs and there is no usage endpoint to read; a clone call produces no audio, so it very likely costs nothing (unverified). Concurrency 5. |
| Mistral Voxtral TTS | no monthly or daily cap is published anywhere (see below); header limit 12,000 input characters a minute | nothing found limits it (133 replies a minute at 90 characters) | same | clone per call with `ref_audio`; saved voices need a paid plan | Paid price $16 per million characters (about $0.0014 a 90-character reply). |
| Cartesia Sonic | 20,000 credits a month (about one credit a character) | about 220 | about 95 | not on Free (Pro and above) | 2 concurrent requests. Credits per character for instant clones not stated. |
| ElevenLabs | 10,000 credits a month (about 10,000 characters) | about 110 | about 48 | no instant clone on Free (Starter and above); 3 custom voice slots | no commercial licence on Free |
| Fish Audio | 8,000 credits, about 7 minutes a month; 500 characters per generation | about 70 | about 29 | listed as 3 public voice slots | FAQ: Free is personal use only; API on Free not listed |
| Resemble AI | first clone free, later clones $2 (changelog, May 2026); free usage allowance not found | not found | not found | first clone free | |
| PlayHT | shut down (API July 2025, platform Dec 2025, per secondary sources) | none | none | none | |
| Local OmniVoice or Pocket | none | unlimited | unlimited | yes | the baseline |

#### Mistral Voxtral TTS: is there a monthly cap?

No cap is published, and none could be found by any route:
- **Headers.** A TTS call returns only `x-ratelimit-limit-input-characters-minute: 12000`, `x-ratelimit-remaining-input-characters-minute` and
  `x-ratelimit-input-characters-query-cost` (the request's character count). No monthly or daily header, no usage header.
- **Docs.** The TTS page, the audio overview, the model card for `voxtral-mini-tts-2603` ($16 per million characters, no free allowance
  mentioned), the pricing page, the free-mode help articles and the OpenAPI file (`docs.mistral.ai/openapi.yaml`) contain no TTS quota.
  Mistral says free-mode limits are "requests per second, tokens per minute and tokens per month" and are shown only in the console's Limits
  page; the numbers are not published. The tier page returns 404.
- **API.** No usage or limits endpoint exists for the key (`/v1/usage`, `/v1/billing/usage`, `/v1/organization/usage` and `/v1/me` all return
  404). The OpenAPI file has workspace billing endpoints with a monthly spending limit, which concern paid plans.
- **Does the plan's token cap apply?** Unknown. The stream's closing event reports `usage.completion_tokens` equal to 24,000 per second of
  audio (144,000 for a 6 s reply) and `prompt_tokens` about 200. If Mistral metered TTS in tokens against the free plan's roughly one billion
  a month, that would be about 6,900 six-second replies (about 2,900 at the measured length). This is speculation; the console Limits page
  (admin.mistral.ai) is the only place that can settle it, and the developer should read it once.
- **Custom voices.** `POST /v1/audio/voices` answers 403 "Custom voices require an active paid plan." on the free key, so a saved voice is
  not possible and the reference clip is sent in every request. The OpenAPI file shows what a paid plan gets: a saved voice with a
  `retention_notice` of 1 to 365 days (default 30), referenced by `voice_id`. Stock preset voices (30 on the first page, each in several
  emotions) work on the free key.

### Voice cloning tests

The reference is the one OmniVoice "long" uses for Judy: `runtime/voice-references/picked/autobest/omni-long/judy-alvarez.wav`
(`runtime/local-voices.autobest-long.json`, 13.38 s, 24 kHz mono, two clips concatenated: `judy-alvarez/1948788320102998016` and
`judy-alvarez/1793688605125373952`), with its transcript. Both providers accept 13 s, so no trimming was needed. Test sentence (81
characters): "Hey V. I was just tinkering with a braindance, but it can wait. What do you need?" Each result was transcribed with the project's
offline Whisper small.en as an intelligibility check (likeness has to be judged by ear).

| Engine | Setup | First audio | Total | Audio | Transcript check |
|---|---|---|---|---|---|
| Inworld `inworld-tts-2`, streaming PCM 24 kHz | one new clone (4.8 s, no warnings) | 744 ms | 1.61 s | 5.74 s | "brain dance, but they can wait" (one word off) |
| Mistral Voxtral, streaming PCM | `ref_audio` in the request, no setup | median 1.24 s over 6 warm runs (0.98 to 1.56 s); one 11 s spike; first call 1.78 s | median 2.28 s | 5.4 to 6.2 s | exact ("brain dance") |
| Mistral Voxtral, stock preset voice, streaming PCM | `voice_id` only | 0.58 to 0.76 s | 1.2 to 1.4 s | 5.7 s | exact |
| Local OmniVoice long (32 steps, GPU) | cold load 108 s, then warm | not streamed in this test | 3.4 s warm (8.1 s first run) | 5.6 s | exact |

The local run used the project's VoiceStudio backend directly (`vendor/reference-voicestudio/.venv`, the same code
`runtime/Measure-OmniResources.py` uses), offline, with no bridge or game. The GPU was shared with other jobs at the time (about 80% busy),
so treat 3.4 s as an upper bound. The old test clone `cp2077-test-judy-ref` was deleted through the API (`DELETE
/voices/v1/voices/<voiceId>` returned 200). The new clone `cp2077-test-judy-omnilong` is in the Inworld workspace.

Audio files (scratchpad `C:\Users\akshi\AppData\Local\Temp\claude\C--Users-akshi-Desktop-Code-Palace-Cyberpunk-Mod\e879aa3d-18fe-4a80-bd5a-b3a10be47999\scratchpad`):
- `local-omnivoice-long-judy.wav`: local OmniVoice long, the baseline
- `inworld-omnilong-judy.wav`: Inworld clone of the omni-long reference
- `voxtral-omnilong-judy.wav`: Voxtral with the omni-long reference
- Earlier, from the single 8 s clip `runtime/voice-references/extracted/judy-alvarez/1947721441586405376.wav`: `inworld-stream-judy.wav`,
  `inworld-nonstream-judy.mp3` (the first Inworld clone, since deleted) and `mistral-voxtral-judy.wav`.

Streaming `pcm` from Voxtral is raw 32-bit float little-endian, not 16-bit. My first conversion decoded it as 16-bit and produced
garbled audio; after the fix every Voxtral render transcribed correctly. The same format is what the bridge's local voices use (see
"Plugging into the pipeline").

### Inworld details

| Step | Result |
|---|---|
| Clone: `POST https://api.inworld.ai/voices/v1/voices:clone` | Body: `displayName`, `languageCode`, `voiceSamples:[{audioData: base64 wav, transcription}]`, optional `description`, `audioProcessingConfig.removeBackgroundNoise`. Returns `voice.voiceId` (`<workspace>__<name>`), `source: IVC`. |
| Auth | `Authorization: Basic <key as shown in the Portal>` (already Base64; do not encode again). |
| Streaming: `POST https://api.inworld.ai/tts/v1/voice:stream` | NDJSON lines `{"result":{"audioContent":"<base64>"}}`; `PCM` is raw 16-bit mono, `LINEAR16` has a WAV header in every chunk, `WAV` in the first only. Encodings MP3 (default), LINEAR16, PCM, WAV, FLAC, OGG_OPUS, ALAW, MULAW; 8 to 48 kHz. Text up to 4,000 characters (2,000 non-streaming). Errors can arrive mid-stream after HTTP 200. |
| Persistence | The clone persists in the workspace and shows in `GET /voices/v1/voices`; no re-upload. The plan caps stored voices (100 on the free plan). Delete with `DELETE /voices/v1/voices/<voiceId>`. |
| Models | `inworld-tts-2` (steering, cloning) and `inworld-tts-2-flash` (faster, no steering). `inworld-tts-1` and `-1-max` were discontinued 15 June 2026. |
| Shipping terms | The licence is "internal business purposes" and non-sublicensable; one developer key in a shipped game is probably not allowed without Inworld's written consent. Safest: each player's own Inworld key. |

### Voxtral details

| Item | Result |
|---|---|
| Endpoint | `POST https://api.mistral.ai/v1/audio/speech`, `model: voxtral-mini-tts-latest` (alias of `voxtral-mini-tts-2603`, context 4,096), JSON body `input`, `ref_audio` (base64 audio) or `voice_id`, `response_format`, `stream`. With neither voice field: 400 "Either ref_audio or voice must be provided." |
| Formats | `pcm` (raw float32 little-endian), `wav` (RIFF, 24 kHz mono), `mp3`, `opus` (Ogg), `flac`. Default `mp3`. The sample rate is 24 kHz. MP3 streaming is slow to first audio (4.5 s); use `pcm`. |
| Streaming | SSE: `event: speech.audio.delta` with `data: {"type":"speech.audio.delta","audio_data":"<base64>"}`, ending in `speech.audio.done` with a `usage` object. A 6 s reply arrives in 7 to 8 events of about 0.75 s each. |
| Latency | With `ref_audio`: median 1.24 s to first audio. With a stock `voice_id`: 0.6 to 0.76 s, so most of the clone cost is the reference upload and encoding. Occasional spikes of about 11 s (3 of about 30 calls, including the first call of a session). No parameter exists for a smaller first chunk or lower latency, and the SSE chunk size is fixed. A very short first sentence ("Hey V.") did not start earlier in one test (2.2 s), so splitting the reply is not an obvious win. |
| Reference size | The 13.4 s 24 kHz WAV is about 0.86 MB as base64 per request; a compressed reference would be smaller (not tested). A transcript is not needed. Shorter references were not compared with the full one after the decoding fix. |
| Languages | English, French, Spanish, Portuguese, Italian, Dutch, German, Hindi, Arabic. The Spanish line rendered (8.2 s for 95 characters); judge by ear, the English-only check cannot score it. |
| Licence | The open weights are CC BY-NC 4.0; the hosted API is the commercial route. |
| Persistence | A cloned voice is not stored on the free plan: the reference is re-sent on every call. Saved voices need a paid plan (403 on the free key). |

### Emotion control

| Service | Emotion or style control | Works with a cloned voice | What I rendered |
|---|---|---|---|
| Inworld `inworld-tts-2` | Steering: free-text instructions in square brackets before the text, written in English even for other languages, for example `[speak as if barely holding back rage, forcing every word through gritted teeth]`; they stay active until `[reset]`. Categories: emotion, articulation, volume (`[very loud]`, `[very quiet]`), pitch, speed, style (`[whisper in a hushed style]`). Non-verbals inline: `[laugh]`, `[sigh]`, `[breathe]`, `[clear throat]`, `[cough]`, `[yawn]`, `[growl]`. A request-level `instruction` field does the same for the whole request (use one or the other). `deliveryMode` STABLE, BALANCED (default) or CREATIVE sets emotional range. A bare `[sad]` is allowed but the docs recommend a fuller phrase; `[happy]` is not listed. Ignored on `inworld-tts-2-flash` (non-verbals still work). SSML `<break time="1s"/>` for pauses. | The docs do not mention clones. Tested once: the tag is accepted on the cloned Judy voice and is not spoken. | `inworld-judy-angry-plain-then-steered.wav`: one request, the same angry line twice, first plain then after the steering tag. The steered version is slower (3.8 s against 2.9 s) at the same loudness; its emotional quality needs listening. |
| Mistral Voxtral | None documented: no tags, no instruction field, no style parameter. Mistral says the model reproduces the emotion and style of the reference audio. Stock preset voices come in emotional variants (for example `en_paul_angry`, `en_paul_sad`, `gb_jane_frustrated`, `gb_jane_sad`, `gb_jane_neutral`). | Only by choosing a reference clip that already has the wanted emotion; there is no control over a fixed clone. | `voxtral-judy-calm-clone.wav`, `voxtral-judy-angry-clone.wav`, `voxtral-judy-sad-clone.wav`: the Judy clone, no control possible, so the three lines read plainly. `voxtral-preset-gb_jane_neutral-calm.wav`, `voxtral-preset-gb_jane_frustrated-angry.wav`, `voxtral-preset-gb_jane_sad-sad.wav`: stock emotion voices on the same three lines. `voxtral-judy-spanish-clone.wav`: Spanish line. |
| Local OmniVoice, for comparison | The mod's own emotion tags (docs/EMOTION_TAGS.md). | yes | |

The lines were: calm "Take a breath, V. The night is long, and we have time. Just sit with me a moment."; angry "Back off! Touch her again and I
swear I will put you through that wall!"; sad "I miss him, you know. Some nights the whole city goes quiet, and all I hear is his voice."
For Voxtral, expressiveness on a clone would need a small bank of reference clips per character (neutral, angry, sad), picked by the
mod's existing emotion tag; Inworld gets it from the text.

### Plugging Voxtral (or Inworld) into the pipeline

Local voices stream into the game through one narrow interface. `bridge/pocket-speech.mjs` calls
`voice.synthesizeStream(voiceKey, text, {signal, onPcm})`, and `bridge/voice-selection.mjs` wraps each engine behind the same method
(`VOICE_FALLBACK_ORDER`: OmniVoice, Pocket, Convai). `PocketVoice` hands `onPcm` frames of 24 kHz, mono, `f32le`
(`bridge/pocket-voice.mjs` checks `sampleRate === 24000`, `channels === 1`, `format === 'f32le'`, at most 4 s a frame). Voxtral's
streaming `pcm` is exactly that format and rate, so an adapter needs little more than: read the SSE stream, base64-decode each
`speech.audio.delta`, re-slice into frames, call `onPcm`, honour `signal` by aborting the fetch, and send the profile's reference WAV
(`runtime/voice-references/picked/autobest/omni-long/<voice>.wav`, already used by OmniVoice) as `ref_audio`. Inworld's `PCM` is
16-bit, so it needs a conversion to float32; its voice is a saved `voiceId` per character, created once and kept. The engine would
join the fallback order ahead of Convai's own voice, with the same one-time notice when it fails. The 12,000 characters-a-minute
limit and the occasional 11 s spike mean the adapter needs a first-audio timeout (about 4 s) after which it falls back to Pocket.

## 3b. Prompt caching

Both providers can reuse a repeated prompt prefix, and the real turn is much bigger than my probes. `node scripts/Test-MistralPrompts.mjs
--dry` reports the real sizes: Judy's system message is 13,394 characters and the live context 5,066 (Johnny 11,548 and 5,063; Panam
12,243 and 2,095; a resident 6,276 and 3,826), plus up to 8 exchanges of history. That is roughly 4,300 to 4,700 prompt tokens for a named
character and 2,300 to 2,800 for an ordinary NPC, against 1,100 and 2,900 in the latency tests above.

Measured with the same prefix and a changing last user line (non-streaming so that `usage` is returned; the system and context come
before `V says: ...`, so the prefix is identical up to the last line):

| Provider and model | Prompt | Result | Cached tokens | Time | Rate-limit accounting |
|---|---|---|---|---|---|
| Groq `gpt-oss-20b` | 1,160 tokens, 4 spaced runs | no field | none | 540 to 740 ms | n/a |
| Groq `gpt-oss-20b` | 1,160 tokens, 6 rapid runs | `prompt_tokens_details.cached_tokens` on 3 of 6 | 1,024, 256 or 1,024 (otherwise absent) | 183 to 899 ms, no clear gain | cached tokens come back to the minute budget on the next response: the request after a 1,024-token hit showed a cost of about 58 tokens |
| Groq `gpt-oss-20b` | 2,870 tokens, 4 runs 20 s apart | one hit | 256 | 680 to 870 ms | |
| Mistral `ministral-14b` | 2,870 tokens, 5 runs, no key | `cached_tokens` 0 every time | 0 | 1.5 to 2.5 s, mean 1.9 s | `x-ratelimit-tokens-query-cost` 2,900 |
| Mistral `ministral-14b` | 2,870 tokens, 5 runs, `prompt_cache_key` set | from the second request | 2,816 of 2,868 (blocks of 64) | 1.05 to 2.1 s, mean 1.5 s (about 20% faster, noisy) | query cost fell to about 105: cached tokens do not count against the token budget |

- **Mistral:** caching is not automatic on this key. Setting the same `prompt_cache_key` on every request of a conversation (it must not
  hold secrets; use something like `char:judy-alvarez`) made almost the whole prefix cached from the second request, and the token budget
  counted only the uncached part. Docs: cached prompt tokens are billed at 10% of the input price.
- **Groq:** caching is automatic, only on the `gpt-oss` models, cannot be disabled, and is probabilistic. About half of my requests hit,
  in blocks of 256 up to 1,024 tokens. Cached tokens are not counted against the rate limits (they are refunded after the response), and
  they get a 50% discount on paid plans. No clear time-to-first-token benefit showed up; the prefill is already tiny on Groq (about 60 to
  390 ms for a 1,100 to 2,900 token prompt).
- **What this means for Groq's 8,000 tokens a minute and 200,000 a day:** a 4,500-token Judy turn allows 1 to 2 turns a minute and about 44
  turns a day. A resident at about 2,500 tokens allows about 80.

What the mod could do to shrink the per-turn prompt (turns a day on Groq, estimated from a 200,000-token day and about 100 output tokens a
turn; these are estimates, not measurements):

| Change | Tokens saved per turn | Judy-sized turn (4,500 tokens) | Resident turn (2,500) |
|---|---|---|---|
| Baseline | | about 44 turns a day | about 80 |
| Stable prefix order for caching (static persona and rules first, any slowly changing context next, the latest message last; no timestamps or per-turn text before it) | cached share counted free on Groq: about 25 to 35% of the prompt in my sample | about 60 to 65 | about 105 to 120 |
| Send the world and quest context only when it changes, as a short "since last turn" line otherwise | about 800 to 1,000 | about 55 | about 100 |
| Shorter rules block (about 550 tokens to about 250) | about 300 | about 48 | about 90 |
| Trim the persona for the cloud route (distilled bio and 3 example lines instead of the full 13,000 characters) | about 1,800 to 2,200 | about 75 | not applicable |
| Fewer history exchanges (8 down to 4) | about 300 | about 48 | about 90 |
| All of the above | about 3,000 to 3,500 | about 120 to 150 | about 160 to 200 |

On Mistral none of this is needed for limits (the token budget is hundreds of thousands a minute); `prompt_cache_key` alone saves about
20% of the time and most of the billed tokens, and it is a one-line change in `bridge/mistral-client.mjs`. Caveat on dropping the
context between turns: with a stateless chat API the model only knows what is in the messages, so a changed-only context needs the last
full context kept as a fixed block after the persona (which also makes it cacheable) and a delta line in the user message.


## 4. Embeddings and vector store

Tiny calls, 4 repeats each, median round trip including TLS from this machine. Dimension is the vector length.

| Provider | Model | Dim | 1 text | 16 texts | Free limits | Verdict |
|---|---|---|---|---|---|---|
| Cohere (trial key, `cohere` line) | `embed-multilingual-light-v3.0` | 384 | 416 ms | 524 ms | 1,000 calls a month and 100 a minute per endpoint (headers: `x-endpoint-monthly-call-limit` 1000, `x-trial-endpoint-call-limit` 100); trial keys may not be used commercially | too small for many players |
| Cohere (`cohere_production` line) | `embed-multilingual-v3.0` | 1024 | 417 ms | 698 ms | paid production key; no trial headers; no free allowance | do not ship; bills the developer |
| Mistral | `mistral-embed` | 1024 | 381 ms | 1,109 ms | 60 requests a minute (headers); shares the free plan | usable, free-plan data may train models |
| Google (`googlegemini` line) | `gemini-embedding-001` | 3072 | 534 ms | 1,975 ms | free tier, limits not published (an unverified report says 100 requests a minute, 1,000 a day) | slow for batches, large vectors |
| Cloudflare Workers AI (`cloudfare_worker_*` lines) | `@cf/baai/bge-m3` | 1024 | 385 ms | not run | 10,000 neurons a day free (docs) | multilingual, workable |
| Cloudflare Workers AI | `@cf/baai/bge-small-en-v1.5` | 384 | 280 ms | not run | same | English only |
| Jina | `jina-embeddings-v3/v5` | 1024 | not run | | 1M free tokens on signup; free key 500 requests a minute, 2M tokens a minute (docs conflict: 100 / 100k on another page) | needs a new key |
| Voyage | `voyage-4`, `voyage-4-lite` | n/a | not run | | 200M free tokens per model; card needed above Tier 1 limits (unclear) | needs a new key |

Vector stores:

| Store | Free tier | Fit |
|---|---|---|
| Pinecone Starter | 2 GB, 2M write units and 1M read units a month, 5 indexes, one region | fits, but one shared project cannot hold every player's data cleanly; a per-player key means every player signs up |
| Qdrant Cloud | 1 GB RAM / 4 GB disk, no card, suspended after 1 week unused, deleted after 4 weeks | inactivity deletion is a poor match for a game played in bursts |
| Turso | 100 databases, 5 GB, 500M rows read and 10M written a month, no card, libSQL vectors (`F32_BLOB`, `vector_top_k`) | best cloud fit: one database per player is easy |
| Cloudflare Vectorize | 100 indexes, 20M vectors per index, free plan | fits with Workers AI on one account |
| Supabase pgvector | 500 MB, paused after a week unused | same inactivity issue |

### Recommendation

1. **Local embeddings and an on-disk index.** A character remembers a few thousand short chunks at most. A 384-dimension model needs
   about 6 MB for 4,000 chunks, so a flat cosine scan is well under a millisecond and needs no index library. A small ONNX model
   (`multilingual-e5-small`, about 120 MB at int8, 100 languages; or `bge-small-en-v1.5`, about 35 MB, English only) runs on the CPU in
   roughly 5 to 20 ms per chunk, so it adds no VRAM and no frame work, works offline, and has no monthly cap. The bridge already ships
   `onnxruntime` for local speech recognition (`bridge/local-stt.mjs`), so the runtime is a known quantity. Cloud embeddings cost a
   350 to 500 ms round trip per recall and need a key per player; the only cloud route with generous limits and no card is Turso plus a
   hosted embedder, which adds two accounts for a memory feature a local file does better. The same local pick serves option 2 (fully
   local), so one memory system covers both.
2. If a cloud fallback is wanted anyway: Mistral `mistral-embed` (same key the player already pastes) with the memory file stored locally.
   Skip Cohere trial keys (1,000 calls a month) and do not ship the production key.

### Keys to add to the keys file for further testing

| Label | Why |
|---|---|
| `jina` | test the largest-free-allowance embedder and its real limits |
| `voyage` | test `voyage-4-lite` and confirm the free-token terms |
| `turso_url`, `turso_token` | test vector search in a per-player cloud database |
| `qdrant_url`, `qdrant_key` | confirm the 1 GB free cluster and the inactivity rule |
| `pinecone` | confirm Starter limits |
| `cerebras` (optional) | another very fast free chat host to compare with Groq; I did not check its limits |

Already in the file and not yet exploited: `googlegemini` (embeddings work, 3072 dimensions), `cloudfare_worker_*` (Workers AI embeddings
and Vectorize), `nvidia_nim`, `openrouter` (not tested here).

## 5. Recommendation for option 3

1. Text: Mistral stays the default route. Set the model order to `ministral-14b-latest` for quality, `ministral-8b-latest` as the fast
   or fallback model, then `open-mistral-nemo`. If a lower first-reply time matters more than quality, make `ministral-8b-latest` the
   first choice (1.05 s against 1.8 s, same prompt, no persona slips in 10 runs). Drop `mistral-small-latest` from the front of
   `DEFAULT_MODELS`; on a free key it always answers 429 with an allowance of 0 (the bridge skips it for ten minutes after the first, so the cost is one wasted request per ten minutes).
2. Groq as an optional "faster" provider: `openai/gpt-oss-20b` with `reasoning_effort: low` (about 0.7 s) or `qwen/qwen3.8-27b` (about
   0.45 s). Expect about 44 turns a day with today's full prompt and about 150 only after the prompt is trimmed (section 3b), and handle the 8,000 tokens-per-minute limit by pacing
   turns. It is not worth the extra signup for the typical player.
3. Voice: Inworld for the fastest cloned voice (0.74 s to first audio) and the only one with text emotion steering, if the player supplies their own Inworld key and accepts 70 minutes a month (about 290 replies at the real reply length, so shorter replies matter). Mistral Voxtral (1.2 s median) as the no-extra-key alternative with no published cap; it takes the same 24 kHz float32 PCM the bridge already streams, so the adapter is small. Both need a first-audio timeout and a fall back to Pocket. Both must be judged by ear against OmniVoice (rendered files in section 3).
4. Prompt: set `prompt_cache_key` on Mistral requests; for Groq, trim the persona, rules and repeated context first (section 3b).
5. Speech to text and memory stay local (`docs/LOCAL_STT.md`, local embeddings).
6. Terms to settle before shipping: Inworld's licence wording (one developer key for all players is likely not allowed) and Mistral's
   free-plan data-use clause.
