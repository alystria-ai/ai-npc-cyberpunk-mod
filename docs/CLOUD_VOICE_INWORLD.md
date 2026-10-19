# Inworld cloud voice

Added 2026-10-13, on branch `inworld-voice` (not merged). An optional Companion voice that speaks a reply with Inworld's
text-to-speech (`inworld-tts-2`), cloned once per character from the character's own reference clip, on the player's own
Inworld key. It sits beside the Mistral cloud voice (Voxtral, `docs/CLOUD_VOICE_VOXTRAL.md`) and works the same way: any
conversation provider can write the replies. **No local voice model runs while it is chosen** (2026-10-13): no Pocket or OmniVoice worker is started, and a running one is retired when the choice is committed. A reply the cloud cannot deliver is asked once more with a longer wait (9 s to first audio), then shown as written text; a turn with no key goes to the Convai cloud voice. Only Pocket's route and audio packet format are borrowed (they drive the subtitles, lip sync and face), not its model.

Code: `bridge/inworld-voice.mjs` (the adapter), `bridge/inworld-key.mjs` (the player's key), `bridge/inworld-steering.mjs`
(emotion), `bridge/voice-utterance.mjs` (one voice per reply, shared with Voxtral), `bridge/voice-selection.mjs` (routing and fallback),
`bridge/voice-routing-log.mjs`, `bridge/mistral-key.mjs` (the key command and status), `mod/voice-preview.lua`, `mod/manager.lua`,
`mod/manager-ui.lua` (the menu). Tests: `bridge/inworld-voice.test.mjs`, `bridge/inworld-steering.test.mjs`,
`bridge/inworld-key.test.mjs`, `bridge/voice-utterance.test.mjs`, `bridge/manager.test.mjs`, `bridge/voice-preview-adapter.test.mjs`.
Measuring script: `scripts/Measure-InworldVoice.mjs`.

## What Inworld offers (read from its docs, 2026-10-13)

| Topic | Finding |
| --- | --- |
| Streaming speech | `POST https://api.inworld.ai/tts/v1/voice:stream`, `Authorization: Basic <the portal key, unchanged>`. Body `{text, voiceId, modelId, audioConfig:{audioEncoding, sampleRateHertz}}`. The answer is newline-delimited JSON, one `{"result":{"audioContent":"<base64>", ...}}` per chunk. |
| Formats | `PCM` is raw 16-bit little-endian with no header (checked live); also MP3, OGG_OPUS, LINEAR16 (WAV header), ALAW, MULAW, FLAC. This adapter asks for PCM at 24,000 Hz, the rate the rest of the bridge uses. |
| Errors | An error can arrive as a `{"error":{code,message}}` line after HTTP 200 (gRPC codes: 3 invalid, 5 not found, 7 permission, 8 exhausted, 14 unavailable, 16 unauthenticated). The adapter reads both forms. |
| Models | `inworld-tts-2` (steering, cloned voices, about 100 ms time to first byte at P90 by Inworld's numbers) and `inworld-tts-2-flash` (about 20 ms, no steering). `tts-1` and `tts-1-max` were discontinued on 2026-06-15. |
| Text limit | 4,000 characters per request. The whole text is counted when the first chunk is produced, so stopping early saves nothing. |
| Instant voice clone | `POST https://api.inworld.ai/voices/v1/voices:clone`, body `{displayName, languageCode, voiceSamples:[{audioData:<base64 wav or mp3>}], ...}`. Answers `voice.voiceId`. The clip must be 3 s at least; 10 to 30 s is best; 30 s is the limit for voices cloned after 2026-08-15; 12 MB at most. Cloning needs a key with write access. |
| Voice list and delete | `GET /voices/v1/voices` (paged), `DELETE /voices/v1/voices/<id>`. The account's list is the source of truth for what already exists. |
| Free plan | The official pricing, billing and Portal pages all say the On-Demand plan ($0) includes "up to 70 minutes of TTS" and give **no period**: no "per month", no reset, no "trial", and nothing on what happens afterwards (extra credits start at $10; paid plans' credits are described as monthly). Researched again 2026-10-15, see "Free minutes: monthly or once?" below. Paid price: $25 per million characters for TTS-2, $15 for Flash. A commercial licence is listed. 100 custom voices, 5 generations at once. |
| Rate limits | Cloning: 2 requests a minute on the free plan. Speech: HTTP 429 with no documented `Retry-After`. |
| Steering | `inworld-tts-2` only. Bracketed English instructions placed before the words they apply to, lower case and without punctuation; they last until the next one or `[reset]`. A separate request-level `instruction` field exists; this adapter uses the inline form only. |

### Free minutes: monthly or once? (researched 2026-10-15)

**Answer: not documented. Treat the 70 minutes as a one-time allowance and tell no player it renews.**

- Documented (official): the pricing page, the TTS billing page and the Portal billing page each say On-Demand includes up to 70 minutes of TTS (and 400 of STT) for free. None of them states a period or a reset. The pricing page frames it as "for testing" and as a way to "try every product before you pick a plan"; the only "each month" wording on those pages is about the paid plans' credits. The Portal billing page, which says what recurs each billing cycle, does not list the free minutes among them. That silence leans towards once, but it is not a statement.
- Conflicting secondary sources (inferred, not authoritative): an automated pricing-change tracker records the allowance rising from 40 to 70 minutes between its 8 and 15 June 2026 captures and words the new figure as "per month", but the official pages as fetched now do not say that, so the wording looks like the tracker's own summary. A May to August 2026 review calls the free allowance a one-time trial (it still quotes the older 40 minutes), an October 2026 review says there is no permanent free plan, and one aggregator says it "resets regularly" with no source. Nothing from Inworld backs either reading.
- Only Inworld can settle it (support, or the usage and billing view in a player's own Portal). Not tested live: the account would have to be run dry.
- Effect on the mod: the `quota` fallback (a written reply and one "unavailable" notice) covers either case; no code depends on the answer. The mod's own text names no minutes at all (checked 2026-10-15: no locale, Lua or README line mentions the free minutes), so no player text needed correcting, and none should promise a renewal.

### Terms for a game mod

Read 2026-10-13 and re-read 2026-10-15: the Terms of Service (last updated 2025-06-11), the Acceptable Use Policy (last updated 2025-06-11), the voice-cloning docs and landing page, and the launch blog. Documented points first, then what is inferred.

Documented:

- **Licence scope.** The Terms grant a limited, non-exclusive, non-transferable, non-sublicensable licence for "internal business purposes" and as the documentation permits. Nothing about non-commercial or hobby use, or about apps built on the API. A mod that ships one developer key, or sends every player's text through the developer's account, does not fit that. **So each player uses their own Inworld key and account**, exactly as for the Mistral key. Nothing here puts a key into the release.
- **Inputs.** The customer keeps whatever rights it holds in its inputs and warrants that it has the rights Inworld needs to process them; Inworld takes a non-exclusive licence to use them to run and improve the service, and assigns its rights in outputs to the customer, subject to the Terms.
- **Voice cloning gate.** The Portal makes the user confirm they have the rights to clone the voice before an instant clone is made (docs and landing page). The API pages show no such step, so a clone made by API call carries the same obligation but no prompt. The docs say nothing about consent from the person whose voice it is, permitted uses, or cloning someone else's voice.
- **Impersonation and consent.** The AUP says developers may not impersonate another individual or organisation without consent or legal right, and bars building voice or other biometric recognition databases without consent. Inworld's voice-cloning FAQ and launch post say cloning is for your own voice or one you are authorised to use, that impersonating someone without consent or legal right breaks the AUP, that generated audio carries an inaudible watermark, and that Inworld acts against malicious impersonation and fraud.
- **Disclosure.** The AUP wants AI use disclosed where a user could take it for a person. Every companion here is plainly an AI character in a game, and the voice setting is labelled as a cloud voice.
- **Not addressed at all:** who owns the reference audio, game or fan content, copyright in the source audio (the AUP does not mention IP infringement; the Terms and the Master Services Agreement, which were not available, may), non-commercial exemptions.

Inferred (not stated by Inworld):

- The reference clip is a voice actor's performance in a game owned by CD Projekt. The Inworld clauses that matter are "rights to clone the voice" and the no-impersonation rule. Whether a player has those rights for game audio is a legal question the terms do not answer. CD Projekt's fan-content guidelines allow game material in free fan content (stated by the project owner; not re-read in this pass), but they govern the fan content, not a third party's terms or the voice actor's own rights.
- The mod's use is a companion speaking in character, not passing a clone off as the real actor to deceive anyone, which is what the AUP names. A ban for that is unlikely in practice, but this is a judgement, not a permission.
- The risk sits with the player's account, not the mod: the clone is made on the player's own key, and the Portal tick box is theirs. The mod uploads a clip only after the player has chosen the Inworld voice and added their own key, and it deletes only voices it made.
- Enforcement would most likely be Inworld removing a voice or suspending the player's key. Nothing in the terms limits it to that.

Open for the project owner (not a blocker for the code): add one plain sentence to the Inworld key help or the pack notes saying the voices are cloned from the game's own audio on the player's own Inworld account, under Inworld's terms; or ask Inworld (the AUP gives support@inworld.ai for complaints) whether game-audio references for a free fan mod are fine. No player text was changed in this pass.

Limits above are as documented; they were not tested to exhaustion (free minutes are small).

## What the player sees

The Inworld voice is a developer-mode voice (2026-10-14). Settings > Voices > Companion voices lists it only while Developer mode is on, as the
last of eight entries: Pocket · Performance, four OmniVoice tiers, Voxtral · Mistral cloud, Convai · Cloud voice, **Inworld · Cloud voice**
(seven entries with Developer mode off). Without a key the entry reads "Inworld · needs key" and Apply
refuses it ("Requires an Inworld key (add it in Settings > Development)"). A saved Inworld voice reads as Pocket while Developer mode is off.
The Inworld sentences in the helps of Companion voices, Natural speech, Expressive emotions and Multilingual conversations show only in Developer mode.

The key has one row in Settings > Development, right after Developer mode, and the row is listed only in Developer mode. Its button reads
**Paste** while no key is saved and **Remove** once one is. **Paste** reads the clipboard once, checks
it with Inworld (a free request, the voice list) and saves it in the bridge's state folder as `player-inworld-key.txt`; the same
file can be written by hand. **Remove** deletes it. The status is in brackets in the row name: `Inworld key (...` plus the last four characters`)`,
`(Added)`, `(Checking...)` or `(Not added)`; a failed paste puts its message first in the row's help. Only the last four
characters are shown (`runtime/mistral-state.json`, `inworld.saved` and `inworld.tail`). The key never goes to a log, a status file or a
setting, and goes only to `api.inworld.ai`. Command file: `runtime/inworld-key-command.json` (ids `:ikey:`).

English only (it uses Pocket's English route), as with Voxtral: with Multilingual conversations on, the choice is
refused ("The Inworld cloud voice speaks only English here. Turn off Multilingual conversations to choose it.").

## How it speaks

`InworldVoice.synthesizeStream(voiceKey, text, {signal, onPcm, emotion})` has Pocket's interface and hands `onPcm` 24 kHz mono
float32 packets of 100 ms (the Pocket packet contract, `timing.voiceEngine: 'inworld'`). Subtitles, lip sync and the face are
driven by those packets exactly as with Pocket and Voxtral. Bytes may split anywhere, inside a sample too; the decoder carries the
odd byte over.

### Cloning: once per character

1. The reference clip comes from the same library as Voxtral's (OmniVoice long set first; the bridge's `VoxtralVoice` instance is
   used only as that library, so the two voices always clone the same clip).
2. The voice is named `cp2077-companion-<character>-<hash of the clip>`. The account's voice list is checked first: a voice with
   that name is adopted, not cloned again. Otherwise the clip is sent once to `voices:clone`.
3. The voice id is kept in memory and in `player-inworld-voices.json` in the state folder, so the next session needs no
   request at all before the first reply. A saved id Inworld says does not exist is dropped and made again. A changed key drops
   the saved ids (they belonged to the other account). An older voice of the same character (the clip changed) is deleted after
   the new one is made; no other voice of the account is ever touched.
4. Clones go one at a time and never more than 2 a minute (the free plan). Preparing a character starts its clone in the
   background. A reply waits at most 3 s for a voice still being made, otherwise **that reply is written only** (no local voice stands in), and the voice
   is there for the next one. The voice of a new character is therefore usually ready before the first reply (about 9 s with the
   clip read, in the live test).

### One voice per reply

A reply may be voiced in two parts (first sentence while the model is still writing, then the rest). `Utterance`
(`bridge/voice-utterance.mjs`) is shared by both parts and by both cloud voices (Voxtral and Inworld): the head decides
(`role: 'head'`), the tail waits for it and follows (`role: 'tail'`, `VoiceSelection.synthesizeRest`).

- Inworld produces the first packet: the reply is Inworld's. A later part that fails then **ends the reply early** (what was spoken
  stands); it is never handed to another voice.
- Inworld fails before any audio (no key, no voice yet, 4xx/5xx, no first audio in 5 s): a timeout, network error or refusal is asked once
  more with a longer wait (9 s); a reply that still has no audio is **written only**, both parts, and the second part does not try
  Inworld. No local voice is loaded to take it over.
- A cancelled reply or an error from the audio consumer is not a fallback and does not count against the service.

Voxtral and Inworld use the same lock (merged 2026-10-14; the former Inworld-only `ReplyVoice` is gone). The two differ only in how
the tail is asked for: Voxtral's tail request is sent at once and held until the head's engine is known
(`docs/CLOUD_VOICE_VOXTRAL.md`); Inworld's tail waits for the decision before it is sent.

### Fallbacks

| Cause | Kind | After it |
| --- | --- | --- |
| No Inworld key | `no-key` | the turn goes to the Convai cloud voice until a key appears |
| No clip for this character | `no-reference` | written reply for this character |
| Clone refused or still being made | `voice` | written reply for this reply; the clone is retried after 10 min (30 s after a network fault, 65 s after a limit) |
| Voice not found (404, code 5) | `voice-missing` | the voice is forgotten and made again; this reply is written only |
| No first audio in 5 s | `timeout` | next reply tries again |
| 429 or exhausted | `limit` | pause for `Retry-After` (20 s when none) |
| 401 / 403 | `key` | 60 s pause |
| Plan used up (402, or a quota message) | `quota` | 30 min pause; shown as "unavailable", not "not ready yet" |
| Network, 5xx, stalled stream (8 s) | `network` | next reply tries again |
| Refused request | `request` | next reply tries again |
| Text over 4,000 characters, or nothing speakable | `text` | written reply |

## Emotion

Expressive emotions gives each reply marks `{at, name, strength}` (`docs/EMOTION_TAGS.md`): a feeling in force from that word until
the next mark. Inworld steering is the same shape (an instruction in force until the next or `[reset]`), so it maps one to one and
cleanly: each mark becomes one bracketed instruction in front of its word (`bridge/inworld-steering.mjs`).

| Feeling | Subtle | Strong |
| --- | --- | --- |
| joy | say with warm amusement | say with delighted excitement |
| warm | say warmly and gently | say tenderly with deep affection in a soft voice |
| interest | sound curious and engaged | sound intensely curious and fascinated |
| surprise | sound surprised | sound shocked and astonished |
| sadness | say sadly in a quiet low voice | slow and hushed with every word weighted by grief |
| fear | sound worried and tense | sound frightened with a shaky breathless voice |
| anger | say with controlled irritation | speak as if barely holding back rage forcing every word through gritted teeth |
| disgust | say with scorn and disgust | say with open revulsion and contempt |
| calm | `[reset]` | `[reset]` |

- A `calm` mark with nothing in force, and the same instruction twice in a row, add nothing.
- A reply voiced in two parts: the second request starts with the feeling in force where it begins (a new request has no memory).
- Square and angle brackets in the text are replaced by spaces, so nothing the character wrote can be read as an instruction.
- The instruction text is not subtitled and is not metered as speech by the bridge; Inworld bills characters, so it costs a few
  extra characters.

### Emotion on every path (added 2026-10-13)

Whoever speaks with the Inworld voice gets the emotion, whatever the player's Expressive emotions setting says and whichever
provider writes the replies.

| Provider | How the marks get into the reply |
| --- | --- |
| Convai (free tier or the player's own Convai key) | The turn's dynamic context carries the emotion block (`EXPRESSIVE_TEXT`, `docs/EMOTION_TAGS.md`); Convai writes `{tags}` inline. Measured on real Convai characters: 100 % valid, every reply opens with a tag, about 2 tags a reply. |
| Mistral, Local AI | The same block, in the notes layer of the system message (`bridge/mistral-prompt.mjs`, one builder for both). |
| Any provider, a reply with no tag (the model forgot, a bark, a short line) | A fallback reads the words with the face's small lexicon (`bridge/text-emotion.mjs`): a clear feeling becomes one mark at the start of that request's text; a weak or unclear text is spoken plainly. No request, no model, well under a millisecond, once per reply part. |

How it is forced: `ExpressiveEmotions.active` is the player's setting **or** `forcedBy()`, which the bridge sets to "the chosen voice is
Inworld" (`localVoice.cloud === 'inworld'`). While it holds, the block is added to the turn (`contextFor`), the marks are kept
(`process`) and the streamed head's marks are kept. The player's setting itself is never changed. The marks also drive the face
(the same marks the face uses with the setting on), so a player with the setting off who picks Inworld gets mark-driven faces too.
Cost: the block is about 1,400 characters of prompt on turns where the setting was off (the notes layer is the stable, cached part
for Mistral); no extra request, no per-frame work, no new timer.

The Convai cloud voice is unchanged: it would read braces aloud, so it still gets no block.

### Non-verbal sounds (Natural speech)

Inworld's `inworld-tts-2` renders six bracketed sounds as audio events, not words (steering page and prompting guide): `[laugh]`,
`[sigh]`, `[clear throat]`, `[breathe]`, `[cough]`, `[yawn]`. They do not change the delivery.

| Our tag (OmniVoice's list, or Inworld's own) | Spoken as |
| --- | --- |
| `laughter`, `laugh` | `[laugh]` |
| `sigh` | `[sigh]` |
| `breathe`, `cough`, `yawn`, `clear-throat` | the same name in Inworld's form |
| `confirmation-en`, `question-en`, `question-ah`, `question-oh`, `surprise-ah`, `surprise-oh`, `dissatisfaction-hnn`, the Chinese and Japanese interjections | no match: removed, never spoken |

- The setting that governs it is Natural speech (off by default). With it on and Inworld speaking, the turn's block offers
  Inworld's own `[laugh]`, `[sigh]` and `[breathe]` (not OmniVoice's list, not Pocket's "pauses only" wording), on the same dice,
  places and rules as OmniVoice; the character's own "how they talk" line is reused.
- Every tag is removed from the subtitles, history and memory on every provider and voice, as before; nothing is ever read aloud.
- `NaturalSpeech.process` keeps where each sound sat (`voiceMarks`, only while Natural speech is on); the adapter puts the mapped
  sound at the same word, after the feeling instruction if both sit there, at most two a request, never the same twice in a row.
  A reply voiced in two parts keeps the head's sounds (`ReplyStream.headSounds`) and the tail's (from the finished reply, counted
  from where the tail begins).

## Measured

All on the test account, Judy's long reference, `inworld-tts-2`, 2026-10-13 (`scripts/Measure-InworldVoice.mjs`; samples and a README
in `E:\CyberpunkConvai-offload\work\inworld-2026-10-13\`).

- First audio, six runs of a 24-character line with the voice made: 429, 439, 585, 1229, 1337, 1344 ms. Two groups, about 0.4 to
  0.6 s and 1.2 to 1.35 s; the longer lines: 1274, 612, 419, 1266 ms. An earlier cold request took 2.06 s. Inworld's own figure
  is a P90 of 100 ms to the first byte; the rest is the network and the first PCM chunk. For comparison, Voxtral's median was 1.24 s
  with one 11 s spike in about ten calls (above).
- Making a voice (clip read, voice list, clone): 8.9 s through the adapter the first time; an existing voice is found by name in
  well under a second.
- The format is raw PCM16 with no header at 24 kHz: decoded and checked sample by sample in the tests.
- Steering is audible in the numbers: the same angry line was 4.32 s (RMS 0.067) plain and 5.74 s (RMS 0.081) with the anger
  instruction; the sad line came out slow and quiet (8.58 s, RMS 0.037). Whether it sounds right is for the user to listen to.
- A reply with no tag, steered from its words (the fallback): a sad line came out slow and quiet (11.26 s, RMS 0.027), an angry one
  fast and loud (4.38 s, RMS 0.073). A line with `{joy}` and a `[laughter]` mapped to `[laugh]`: 5.02 s; listen for a laugh.
- The whole live session spoke 456 + 174 characters of the account's free allowance, plus the earlier smoke runs.

## Limits and open points

- English only, like Pocket's route.
- Whether the free 70 minutes is monthly or once is not in Inworld's docs (researched 2026-10-15, see above; plan for once); what the player sees when it is gone is the `quota` fallback
  (a written reply, one "unavailable" notice) after Inworld answers 402 or a quota message. That answer was **not** seen live; the
  mapping follows the documented codes and is unit-tested only.
- A new character's first reply may be written only if its voice is not made yet (two clones a minute on the free plan; about 9 s for
  one). Warm-up at "prepare" makes this rare.
- Cloning game actors' voices is the player's own risk on their own account (terms above; the terms are silent on game audio, so this is a judgement, not a permission).
- The fallback reads a whole request text for one feeling; it cannot place a change of feeling inside a reply (only the character's own tags can).

## Live checks in game (user)

Install the committed `mod/` files and the bridge from this branch (never `mod/diagnostics.lua`), restart the bridge, reload CET.
1. Turn on Developer mode and Apply. In Settings > Development press **Paste** on the Inworld key row (key copied from Inworld's portal first): the row name reads "Inworld key (..." with the last four characters, and the button reads **Remove**.
2. Settings > Voices > Companion voices: the last entry is "Inworld · Cloud voice" (with Developer mode off it is not listed). Choose it, Apply.
3. Talk to a companion: the voice is hers, the lips and subtitles follow it. The first reply of a character not seen before may be
   written only while the voice is made; later replies are Inworld's.
4. `runtime/bridge.stderr.log`: `[Inworld] first audio ... ms` lines and `[VoiceRouting]` lines naming "Inworld cloud voice".
5. Press **Remove** on the key row: the entry reads "Inworld · needs key" and Apply refuses it. Turn Developer mode off and Apply: the entry is gone and a saved Inworld voice reads as Pocket.
6. Switch the network off mid-session: the next reply is written only (after the longer second ask), with one "not ready yet" notice; no reply changes voice
   in the middle.
7. Emotion: a reply with a strong feeling ({anger:strong}, {sadness}) sounds different from a plain one. Turn Expressive emotions
   OFF in Settings > Voices and talk again with the Inworld voice: the replies still carry emotion (`[Inworld] first audio ... 1 emotion
   tag` in the log), on Convai, Mistral and Local alike.
8. With Natural speech on: now and then a real laugh, sigh or breath (not the word) at a natural spot; none of it in the subtitles.

## Sources (read 2026-10-15 unless noted)

Official Inworld:

- Pricing: https://inworld.ai/pricing ("up to 70 min TTS included"; the FAQ and "Start building" text say the same; no period; On-Demand limits 100 custom voices, 5 concurrent requests, commercial licence listed)
- TTS billing: https://docs.inworld.ai/tts/resources/billing (70 minutes, no period; credits from $10)
- Portal billing: https://docs.inworld.ai/portal/billing (plans; paid credits monthly and rolling over 3 months; free minutes not listed as recurring)
- Terms of Service (last updated 2025-06-11): https://inworld.ai/terms-of-service
- Acceptable Use Policy (last updated 2025-06-11): https://inworld.ai/acceptable-use-policy
- Voice cloning docs (rights confirmation in the Portal upload): https://docs.inworld.ai/tts/voice-cloning (a mirror turned up in search: https://dev.docs.inworld.ai/docs/tts/voice-cloning)
- Voice cloning page (FAQ on consent and impersonation, as relayed by search; not fetched directly): https://inworld.ai/voice-cloning
- Launch post (watermark, safeguards, as relayed by search; not fetched directly): https://inworld.ai/blog/introducing-inworld-tts
- TTS release notes: https://docs.inworld.ai/release-notes/tts

Secondary (not authoritative, and they disagree):

- Pricing-change tracker, week 2026-W25 (40 to 70 minutes, worded "per month"): https://pricingsaas.com/companies/inworld/diffs/2026W25
- Review calling it a one-time 40-minute trial (published 2026-05-20, updated 2026-08-25, internal dates inconsistent): https://texttolab.com/blog/inworld-pricing
- Review saying there is no permanent free plan (Oct 2026): https://toolradar.com/tools/inworld-ai/pricing
- General guidance on voice-cloning consent, context only and not about Inworld: https://magichour.ai/blog/ai-voice-cloning-laws-and-ethics

Earlier pass (2026-10-13): the same terms read, plus the model cards and the safety page (not re-fetched on 2026-10-15; a search found no model-card page).
