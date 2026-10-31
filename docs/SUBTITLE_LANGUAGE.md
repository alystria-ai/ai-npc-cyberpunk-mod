# Subtitle language and Other language (2026-10-31)

Two requests from players on Nexus (31 October and 1 November 2026):

- **A. Subtitles in another language than the speech.** A Russian player wants the characters to speak English while the subtitles read Russian. Until now the language row changed both.
- **B. Any language.** A Finnish player patched the forced English out of the voice pipeline and then the 0.4.0 file check stopped the mod (correct, and the check is not weakened). He wants languages beyond the game's own list, with Voxtral, a cloud text model and the language on automatic.

Both are settings, both default to what the mod did before, and every current language works exactly as it did.

## Player controls

| Setting | Page | Values | Default |
|---|---|---|---|
| Voice language | Voice AI and microphone | English, Automatic, the 14 other game languages, **Other language** (last) | English |
| Other language | Voice AI and microphone, right under Voice language | Finnish, Swedish, Norwegian, Danish, Dutch, Greek, Romanian, Bulgarian, Croatian, Serbian, Slovak, Slovenian, Estonian, Latvian, Lithuanian, Hindi, Indonesian, Vietnamese, Hebrew | Finnish |
| Subtitle language | Interface, right under Subtitles | Same as speech, English, the 14 other game languages, the 19 Other languages | Same as speech |

The help of both rows is capped at 420 characters in every language, the limit of the Native Settings UI description box (`bridge/description-fit.test.mjs`), so it says only the essentials: what it does, that the voice never waits, that it needs Mistral, Gemini, Custom or Local AI and not Convai, and for Other language which voices speak it. The rest (Local AI stays on Local AI, the swap, the Phone Chat wait) is here.

The rows exist in every settings host because the hosts only draw the schema of `mod/manager-ui.lua`: the overlay Companion Manager, Mod Configuration Menu and the Native Settings UI fallback (tests: `bridge/manager.test.mjs` for the overlay and Native Settings, `bridge/mcm-host.test.mjs` for MCM). The Other language list is a list, not a text box, because the hosts have no free-text row and a typed name could not be matched to a voice. Czech, Hungarian and Ukrainian are on the Voice language row already, so they are not repeated.

The saved keys are `replyLanguage` (now also `other`), `replyLanguageOther` (a code, `fi` when missing or unknown) and `subtitleLanguage` (`same` when missing or unknown). An old file reads as it always did.

## A. Subtitle language

### Design

The reply is written and spoken as before. When `subtitleLanguage` is not `same`:

1. The moment the reply text is complete (`attachTextProvider` `onReplyText`, which runs when the text route's `reply()` resolves) the bridge starts **one extra short request** to the same text provider the player talks with (`TextProviderHost.translate`). It is not awaited by anything on the voice path.
2. **Spoken replies** (Pocket, Voxtral, OmniVoice): the subtitle is the **original text first**, and the **translation replaces it the moment it arrives**. `ConvaiContinuousSpeech` asks `subtitle(text, textComplete)` on every state poll (a lookup in a table, never a wait). Once the translation is there, the state document the game reads carries the translated `text`, and the caption cues are cut from it (`captionCues(drawn, ...)`). The game's existing revision path (`mod/subtitles.lua` `reviseTimed`) re-lays the page, so no Lua change was needed for the swap. The same document feeds the overhead subtitles and the cinematic dialogue subtitles.
3. **Written replies** (Phone Chat, a voice that cannot speak the language, Voice off): there is no sound to keep in step, so the reply waits for the translation for at most 3.5 s (7 s on Local AI) and is shown in the original if it is not there by then (`SubtitleTranslations.wait`).
4. The voice, the lip sync, the emotion plan, the memory and the next group speaker always use the **original** text. Only what is drawn as a subtitle or a chat line changes.

### Why swap instead of waiting

A spoken reply starts on its first sentence while the model is still writing the rest, so the whole text, and then the translation, arrive after the sound has started. Holding the subtitle back until the translation is there would leave the first sentences unread, and a subtitle that appears after its sentence was said is worse than one that changes language once. The swap happens once per reply, a second or so after the text is complete. Phone Chat has no sound, so there a short wait is cleaner than a flash of the wrong language.

### Latency effect

- **Voice:** none. The request is started after the text is complete and nothing on the voice path awaits it: the first-audio time, the lip sync and the lease are unchanged. A test proves the causal part: six state polls are published while the translator's answer is still withheld (`bridge/subtitle-language.test.mjs`, "a fake provider end to end").
- **Subtitle:** the translation shows about one request after the text is complete. That is expected to be 0.5 to 1.5 s on a cloud model (from the measured Mistral request times in the README, not measured for this call) and longer on Local AI. Until then the original shows.
- **Phone Chat and written replies:** up to 3.5 s later (7 s on Local AI), and only when the translation is slow. Normally one short request.
- **Provider load:** one extra request per spoken or written reply, with a few hundred output tokens at most. On the free Mistral plan (one request a second) it queues with the text priority like the reply. On Local AI it is background work, so it gives way to any turn (the same rule as the summary of older talk), and a turn that needs the model stops it.

### Local stays local

The translation uses `this.routes[this.provider.route]` and no other route (the rule of `#candidates`): with Local AI it runs on Local AI, with Mistral on Mistral. A failing Local AI never hands the text to Mistral, Gemini or Custom. Nothing about a local voice reaches the cloud, since the request holds only the finished reply text and the target language.

### What is sent and what is kept

The request is two messages: a system line (translate this into the language, keep the sentences, names and tone, answer with the translation only) and the reply. No persona, no history, no memory, no player name. The table holds a turn's entry until the turn ends: `release` at the end of the reply, `clear` on a world reset or when the setting changes, a 120 s age limit and a bound of 8 entries. Nothing is written to disk and the log carries a kind, never text.

### Convai

Convai returns text and audio together. With the **Convai conversation provider** there is no text provider, so no request is made and the subtitles stay in the speech language. The row's help says so ("Needs Mistral, Gemini, Custom or Local AI, not Convai") and the bridge log says it once (`[SubtitleLanguage] needs a text provider`). With any other provider the transcript is translated by that provider under the same rule, whichever voice speaks.

### Details worth knowing

- A reply already in the subtitle language is not translated. An answer that equals the original, is empty, is more than four times longer or has control characters is dropped and the original stays.
- With a subtitle language set and the Voice language fixed to English, the reply context says in English that the reply is to be written in English (`pinEnglish`). Without it, a message typed in the subtitle language, or a Phone Chat history shown in it, could be answered in that language and read by an English voice.
- Phone Chat history rows (the last six messages, `recentConversation`) are the lines the game shows, so they should be the translated ones. That would be the only place a translated line returns to the model, and the English instruction above covers it. To confirm in the live check.
- Add-on speakers answer through their own text hosts and are not translated.
- Subtitles in a script the game's font family lacks (for example Russian in an English game) use the same caption font handling as any reply in that script (`mod/ui-fonts.lua`). Scripts that handling does not know (Hebrew, Hindi) may show boxes in the game's font. That is a font limit, not a translation one.

## B. Other language

### Where English was enforced

The voice pipeline did not have one `if english` that a player could remove. English was the default of five places that all had to change:

1. `replyLanguageFrom` (`bridge/multilingual.mjs`): the Voice language could only be one of the game's 15 languages, and an unknown value read as English.
2. The prompt's language line: `LANGUAGE_NAMES` had no Finnish, Danish, Estonian and others, so a fixed language the game does not have would have said "that language". The base persona rule says "Answer in the language V writes in (English unless the context says otherwise)", so the context line is what decides.
3. The microphone: `SpeechLanguage.current` turned any language that was not one of the game's 15 into English.
4. The Lua lists (`mod/manager.lua` `replyLanguages`), which refused anything else at the setting.
5. The voice itself: Pocket speaks English only (plus the installed models of five game languages), and a reply in another language had only an unspecific "English only" reason.

### What changed

- `bridge/other-languages.mjs`: the list, the names, which voices and providers can do it. `replyLanguage: 'other'` plus `replyLanguageOther` make `replyLanguageFrom` return the language as `fixed`, so the rest of the pipeline sees it exactly like a fixed game language: the Convai twin route is not used (a text provider only), the prompt gets "write the whole reply in Finnish, whatever language the player's message is in", the voice plan and the voice request carry the code, and V's typed lines follow it.
- **Voxtral:** speaks the languages Voxtral TTS 3 lists. Of the 19, Serbian, Estonian, Lithuanian and Hebrew are not on that list, so those replies are shown as text with the existing "voice does not speak this language" reason. Mistral's API has no language field: the model speaks the language the text is written in, and the code picks the reference clip (the English clip when there is no pack, which is the case for every Other language).
- **OmniVoice:** is told the language by its code and speaks all of them.
- **Pocket:** never. A turn planned for Pocket gets the reason `other-language-pocket`, the reply is shown as text, its `audioError` reads "Pocket speaks English only, so the reply in Finnish is shown as text. Choose the Voxtral voice or OmniVoice to hear it.", the routing log and the silence report treat it as by design, and the game's one-time "Replies in some languages show as text" notice appears. `VoiceSelection.synthesizeStream` also refuses it by name, so a request that got past the plan is never read by the English student.
- **Text providers:** Mistral, Google Gemini and Custom write all of them. Local AI is allowed and depends on its model (the row's help says so). With the **Convai** conversation provider the choice is not applied (Convai's characters and its voice cannot be told a language the game does not have), the routing stays Automatic, and the bridge log says so once.
- **Microphone:** the chosen language is the recording's language until the recogniser reports another one. With Mistral transcription it goes to Voxtral as the hint.
- **Counts only with Voice playback on**, like every Voice language choice.
- **Automatic** still detects only the game's 15 languages (the detector's word lists and character models), so a Finnish player picks Other language > Finnish instead of Automatic. Extending the detector to Finnish is a separate job.

The 0.4.0 file check is untouched: all of this is shipped code, not a patch.

## Tests

`node --test bridge/subtitle-language.test.mjs` covers the settings and the lists (parity with the Lua lists), the translation path with a fake provider, the timing (the voice path is never behind), local stays local, Other language in the prompt and in the Voxtral request, Pocket refusing it and the microphone. `bridge/manager.test.mjs` and `bridge/mcm-host.test.mjs` cover the rows in the overlay, Native Settings and MCM. The existing tests of the Voice language row, the voice plan and the ordering of the Voices page were updated for the new row and the new last choice.

## Live check owed

See the 2026-10-31 entry of the captain's log in TODO.md.
