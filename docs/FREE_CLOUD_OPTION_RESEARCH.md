# Fully free cloud option: measurements and research

Measured and researched on 2026-10-12 for the "fully free cloud" player option (TODO.md, "Requested 2026-10-12", option 3).
Nothing in the mod was changed. Throwaway probe scripts lived in the session scratchpad; no key was printed, logged or stored.
Limits quoted from provider documentation are marked (docs); limits read from response headers on the developer's own free keys are
marked (headers). Third-party figures are marked (unverified).

## Summary

| Question | Answer |
|---|---|
| Fastest text route | Groq. `qwen/qwen3.8-27b` answered in about 0.45 s, `openai/gpt-oss-20b` and `-120b` in about 0.7 s (Mistral `ministral-14b` is 1.8 s, `ministral-8b` 1.05 s). |
| Best free limits for many turns | Mistral. Groq's free token budget is small (8,000 tokens a minute, 200,000 a day per model) and a full-size character prompt is about 2,900 tokens. |
| Recommended text route | Keep Mistral as the default; offer `ministral-8b-latest` as the fast model and `ministral-14b-latest` as the quality model. Groq `openai/gpt-oss-20b` is an optional faster route for a player who adds a Groq key. |
| Voice cloning | Inworld works with the project's own reference clips: first audio in 0.83 s streaming. Mistral's own Voxtral TTS also cloned the same clip on the same free Mistral key (first audio 1.8 s), so a one-key route exists. |
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

### Voice

| Service | Item | Value |
|---|---|---|
| Inworld | Free allowance | about 70 minutes of TTS a month on On-Demand (docs); TTS-2 then $25 per million characters, TTS-2 Flash $15 (docs) |
| Inworld | Instant clone | 3 s minimum, up to 30 s for new clones, WAV or MP3, optional transcript; 100 custom voices on the free plan, about 2 clone calls a minute (docs, unverified) |
| Inworld | Concurrency | 5 on the free plan (docs) |
| Inworld | Shipping terms | The terms license is "internal business purposes" and non-sublicensable; one developer key in a shipped game is likely not allowed without Inworld's written consent. Safest reading: each player uses their own Inworld key. Confirm before relying on it. |
| Mistral Voxtral TTS | Limit on the free key | 12,000 input characters a minute (headers); no other number published |

## 3. Voice cloning

### Inworld (tested once, sparingly)

Reference: Judy's 8.06 s clip `runtime/voice-references/extracted/judy-alvarez/1947721441586405376.wav` (mono, 48 kHz) with its transcript.
Three billable calls in total (one clone, two syntheses of 82 and 56 characters).

| Step | Result |
|---|---|
| Clone: `POST https://api.inworld.ai/voices/v1/voices:clone` | 200 in 5.6 s. Body: `displayName`, `languageCode`, `voiceSamples:[{audioData: base64 wav, transcription}]`. Returns `voice.voiceId` (`<workspace>__<name>`), `source: IVC`, validated sample with no warnings. |
| Auth | `Authorization: Basic <key as shown in the Portal>` (the Portal key is already Base64; do not encode it again). |
| Streaming: `POST https://api.inworld.ai/tts/v1/voice:stream`, `modelId: inworld-tts-2` | 200; **first audio 829 ms**, total 1.57 s for 4.9 s of speech. Newline-delimited JSON, each line `{"result":{"audioContent":"<base64>"}}`; with `audioEncoding: PCM`, `sampleRateHertz: 24000` the bytes are raw 16-bit mono PCM (9 chunks). `LINEAR16` puts a WAV header in every chunk; `WAV` only in the first. Encodings: MP3 (default), LINEAR16, PCM, WAV, FLAC, OGG_OPUS, ALAW, MULAW; rates 8000 to 48000. |
| Non-streaming: `POST https://api.inworld.ai/tts/v1/voice` | 200 in 2.3 s for 56 characters, MP3 24 kHz, base64 in `audioContent`. Text limit 2,000 characters (4,000 when streaming). |
| Persistence | The clone persists in the workspace: `GET /voices/v1/voices` listed it (276 voices in total including system voices). No re-upload is needed; the plan caps stored custom voices (100 on the free plan). |
| Other | The synthesis response reports `usage.processedCharactersCount`; the streaming usage line showed 0, so count characters yourself. Clone and synthesis send no rate-limit headers. |

Files to listen to (scratchpad `C:\Users\akshi\AppData\Local\Temp\claude\C--Users-akshi-Desktop-Code-Palace-Cyberpunk-Mod\e879aa3d-18fe-4a80-bd5a-b3a10be47999\scratchpad`):
`inworld-stream-judy.wav` (4.9 s), `inworld-nonstream-judy.mp3` (3.5 s), compare with the reference clip above. The test clone
`cp2077-test-judy-ref` was left in the Inworld workspace; delete it in the Portal if you want the slot back.

### Mistral Voxtral TTS (found while checking the same key)

`POST https://api.mistral.ai/v1/audio/speech`, `model: voxtral-mini-tts-latest`, `ref_audio` = base64 of the same Judy WAV, no saved
voice needed. Worked on the free key on the first try.

| Mode | Result |
|---|---|
| Non-streaming WAV | 200 in 3.5 s, 24 kHz mono, 5.04 s of speech, base64 in `audio_data` |
| Streaming PCM (`stream: true`, SSE `speech.audio.delta` events) | headers 1.7 s, **first audio 1.86 s**, total 2.4 s |
| Streaming MP3 | first audio 4.5 s (use PCM) |

File: `mistral-voxtral-judy.wav` in the same scratchpad. Docs claim cloning from 2 to 3 s of audio, English, French, Spanish, Portuguese,
Italian, Dutch, German, Hindi and Arabic, and saved voices through a Voices service (not tested, so persistence is unconfirmed). The free
key's limit is 12,000 input characters a minute. Inworld is about 1 s faster to first audio and has a documented persistent voice; Mistral
needs no second key or terms question. Quality of both clones against the original should be judged by ear.

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
   0.45 s). Cap the prompt (the trimmed persona), expect about 150 turns a day, and handle the 8,000 tokens-per-minute limit by pacing
   turns. It is not worth the extra signup for the typical player.
3. Voice: Inworld for the fastest cloned voice (0.83 s to first audio) if the player supplies their own Inworld key and accepts the
   70-minute monthly allowance; Mistral Voxtral TTS (1.9 s) as the no-extra-key alternative. Both need to be judged by ear against Pocket.
4. Speech to text and memory stay local (`docs/LOCAL_STT.md`, local embeddings).
5. Terms to settle before shipping: Inworld's licence wording (one developer key for all players is likely not allowed) and Mistral's
   free-plan data-use clause.
