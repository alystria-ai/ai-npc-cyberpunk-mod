# Natural speech, block v3 (2026-10-08)

Decision from `docs/NATURAL_SPEECH_CLONES.md`: no clones. The per-turn dynamic block was improved instead. Everything below
is on **offered turns only** (the turns on which the bridge's dice offer the devices). With the setting off, and on every
turn that is not offered, the context sent to Convai is byte for byte what it was.

Status: built and tested, measured offline against real Convai (text only). **Not installed:** the bridge needs a restart.
**No OmniVoice was rendered** (the laptop is on Silent and the game is running), so the new `[question-ah]`,
`[question-oh]` and the four Chinese/Japanese sounds still need a listening test when the GPU is free.

## What changed

1. **A "how they talk" line per character** (`bridge/natural-speech-talk.mjs`), placed after the tag list and before the rules.
   - Judy, Panam, Johnny and the street local: their own line, taken from the "HOW X TALKS" paragraphs of
     `characters/natural-speech/`. Judy: soft sighs, a short nervous laugh, a grunt at corporate talk, the odd "uh". Panam: a
     short laugh at someone's stupidity, an impatient sigh when tired, a surprised "oh", a "well...", almost never "uh".
     Johnny: fluent, never "uh", never giggly; a dry scoff, a grunt, very rarely a tired sigh. The local: a sigh about rent, a
     laugh at her own bad luck, a "well...".
   - Every other profile: a line from its trait (`traitFor`), written without pronouns so it fits any gender: warm, neutral,
     dry or cold. October 10: every line now starts "How you talk:" (it was "How <name> talks:" for named profiles, a narrator's
     third-person description of the speaker; docs/FIRST_PERSON_RULE.md). The bridge passes the profile key and trait.
   - OmniVoice only. Pocket's block is unchanged (no sounds there).
2. **Placement wording and a per-turn spot.**
   - The wording says a sound can come wherever a real person would make it: before a sentence, right after one ends, or in the
     middle of a sentence at a natural break (after a comma, between two clauses, before "but" or "and"), varied from reply to
     reply, never splitting a tight phrase (adjective and noun, a name, verb and object).
   - Wording alone was not enough: with it, **0 of 37 sounds** landed mid-sentence (the model put everything between two
     sentences). So the bridge now also picks the spot per offered turn with the same dice that decide the rate:
     mid-sentence 40%, between sentences 35%, end of the reply 15%, start of the reply 10% (`PLACES`). The block says "if you
     use a sound, place it exactly here: ...". The decision is made once per turn like the offer. The model still decides
     whether a sound fits and which one.
   - **No bridge-side relocation of tags.** An earlier plan moved a mid-clause tag to a sentence boundary; the user dropped
     it, since a mid-sentence sound is often more natural. A helper `splitsWord` and a test check only that a tag is never
     inside a word. (A tag is always its own token; `Wel[sigh]l` shows as `Wel l` in the display text.)
3. **Variety for ellipses.** The wording asks for variety ("not every touch is a trailing '...'") and at most one "..." in a
   reply. **No bridge cap was added:** in this study Judy used "..." in 0 to 1 lines in 40 with the new block (and 1 in the
   HEAD baseline of the same day), so the probe shows no overuse to cap. (Round 2 had measured 10 in 40; this did not
   reproduce, so treat the old figure as noise or as an effect of the old wording.)
4. **Per-profile offer rates** (`OFFER_RATE_BY_PROFILE`): Judy .5, Panam .35, Johnny .42 (traits give .6, .6, .35). After the
   line and the exact spot, the model takes nearly every offer (Judy 14 of 15), where HEAD took about half; so Panam, who was
   too low before, now needs a *lower* offer rate to land near 30%, and Judy a little lower to stay at about 40%. Pity (every
   fourth turn for warm and neutral) still follows the trait.
5. **New OmniVoice tags.**
   - `[question-ah]` and `[question-oh]` (a short rising "ah?" or "oh?" of doubt or curiosity) are in `OMNI_TAGS` for all
     languages and described in the block.
   - `[surprise-wa]`, `[surprise-yo]`, `[question-ei]`, `[question-yi]` (`CJK_TAGS`) are described, and allowed to be voiced,
     only when the turn's language is Chinese or Japanese: the context gets them when the turn's expected language
     (`turnVoice(input).language`) is `zh` or `ja`, and `omniTagsFor(language)` lets them through to OmniVoice only when the
     reply's detected language is `zh` or `ja`. On any other turn they are treated like an unknown tag: dropped from every
     display text and never voiced (same for the final check in `voice-selection.mjs`). Pocket never speaks tags.

Files: `bridge/natural-speech.mjs`, `bridge/natural-speech-talk.mjs` (new), `bridge/convai-bridge.mjs` (three one-line hunks:
import, the context call passes profile, name and language, the Omni phrase call uses `omniTagsFor(language)`),
`bridge/voice-selection.mjs`, tests in `bridge/natural-speech.test.mjs` and `bridge/voice-routing.test.mjs`,
`scripts/Probe-NaturalSpeech.mjs` (`--block head`, `--lang ja|zh`, position and ellipsis statistics).

Tests: `bridge/natural-speech.test.mjs` (29), `voice-selection`, `voice-routing`, `expressive-emotions`, `multilingual`,
`subtitles`: all pass.

## Measurement

Offline, text only: `scripts/Probe-NaturalSpeech.mjs`, real Convai, a throwaway test identity (`runtime/natural-speech-probe.json`,
never the player's), memories cleared after every run (accepted for each character). Judy, Panam, Johnny and the street local
(`npc-street-resident-female`), OmniVoice, the same 40 prompts as round 2, one Convai session per run. HEAD = the block at
`a47fed8` (re-run today with the same dice). About 1,250 requests in all, including the tuning runs below. Noise is about
+/-8 points per cell.

"Sound" = lines with a bracketed OmniVoice tag. "Positions" count every tag in the 40 lines: **start** = nothing before it,
**between** = right after a sentence ends, **mid** = inside a sentence (after a comma or a conjunction), **end** = nothing
after it. "Offered" = offered turns, and how many of them got a sound.

| Character | Block | Sound | Any device | Tag kinds | Positions (start / between / mid / end) | Ellipsis lines | question-ah/oh | Offered (used) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Judy | HEAD | 20% | 28% | 6 | 4 / 4 / 0 / 0 | 1 | 0 | 15 (8) |
| | v3 | **40%** | 40% | 5 | 2 / 10 / 4 / 0 | 0 | 1 | 15 (14) |
| Panam | HEAD | 18% | 23% | 6 | 0 / 4 / 3 / 0 | 2 | 0 | 18 (7) |
| | v3 | **30%** | 30% | 5 | 0 / 4 / 5 / 3 | 0 | 1 | 12 (12) |
| Johnny | HEAD | 10% | 10% | 4 | 0 / 4 / 0 / 0 | 0 | 0 | 9 (4) |
| | v3, run 1 | 35% | 35% | 4 | 2 / 12 / 0 / 0 | 0 | 0 | 12 (12) |
| | v3, run 2 | 18% | 18% | 3 | 0 / 3 / 2 / 2 | 0 | 0 | 9 (7) |
| Street local | HEAD | 18% | 20% | 5 | 4 / 3 / 0 / 0 | 2 | 0 | 17 (7) |
| | v3 | **40%** | 40% | 4 | 0 / 12 / 4 / 0 | 0 | 0 | 15 (15) |

Round 2's HEAD figures for the same prompts were 38 / 23 / 23 / 28% (any device, Judy / Panam / Johnny / local), so today's
HEAD baseline came out lower on Judy by chance; the v3 numbers should be read against both.

- **Pooled position mix** (65 tags over the v3 runs above, Johnny's two runs counted): start 6%, between 63%, mid 23%, end 8%.
  HEAD (26 tags): start 31%, between 58%, mid 12%, end 0%. So the sounds no longer pile up at the first word, there are
  mid-sentence and end-of-reply sounds, but most still sit between two sentences, often after a short fragment ("Six hours?
  [laughter] ..."). That is where the model puts them when it is free to choose; the dice moved it off that spot about half the
  time (see the next point).
- **How well the model follows the spot it is given** (final runs): between to between 22, mid to mid 14 (mid to between 10),
  end to end 4, start to start 3.
- **Sound tags never split a word** (0 in all runs). One tight split of a conjunction ("But [laughter] the alternative...")
  and a handful of "In this city, [hnn] the only thing..." clause breaks showed up; nothing between an adjective and its noun,
  inside a name, or between a verb and its object.
- **The rate** over the five stages below (each changed something, so this is a trail, not a spread): Judy 30, 48, 48, 38 and
  40%; Panam 20, 43, 50, 35 and 30%; the local 28, 23, 33, 38 and 40%. At the final settings: Judy 40%, Panam 30%, local 40%
  and Johnny 18-35% (mean 26% over 80 lines).
- **Johnny** swings most. With the line he takes only about 60% of offers: at the trait's rate (.35) three runs gave 15, 15 and
  13%; at .42 35% and 18%; at .45 30% and 15%; at .5 38%; at .6 28%. The final .42 averages in the wanted 20-25% band, but
  one 40-line run can be anywhere from 15 to 35%.
- **The street local** came out at 40% (28% at HEAD). That is the top of the wanted 30-45% band; the neutral rate was not
  touched because it applies to 52 characters. If the user finds archetypes too chatty, lower `OFFER_RATE.neutral`.
- **Distinct kinds:** Judy 5, Panam 5, Johnny 3-4, local 4 sound tags per 40 lines (HEAD 4-6).
  Over all 960 v3 replies of the tuning and final runs the tags were: laughter 107, sigh 77, confirmation-en 53,
  dissatisfaction-hnn 36, question-oh 17, surprise-oh 3, question-en 3, question-ah 2, surprise-ah 0, plus 2 invented
  `[pause]`. So `[question-oh]` is the new sound the model reaches for (its "oh?" of doubt), `[question-ah]` hardly ever, and
  the two surprise tags nearly vanished (HEAD: 5 in 160 lines): `[surprise-oh]` is crowded out by
  `[question-oh]`, and `[confirmation-en]` is now 18% of all sounds, which is the "mm" tic the clones also showed. Worth a
  listen and, if it grates, a line in the block that asks for it only for agreement.
- **Ellipsis for Judy:** 0 lines with "..." in the final run (HEAD 1). No cap needed.
- Invented tags: Johnny wrote `[pause]` twice (dropped, as always; it has no OmniVoice sound).

### Sample lines (v3, final settings; the prompt number in brackets)

Judy:
- [6] I'm sorry. Sometimes the head just keeps looping the same parts, [sigh] and it's hard to find the off switch.
- [22] Probably taking a corporate contract early on. I thought the money would buy me freedom, [laughter] but it just bought me a front row seat to how much they don't care about anyone.
- [26] Hope they're not trying to upsell you on some corporate gold-plated junk. [question-oh] Did they actually explain why the current one is failing?
- [39] Maybe. But in this city, [sigh] most of us are just trying to survive the mess we're already in.
- [40] Again? [dissatisfaction-hnn] You've gotta start putting a better lock on that thing, or just park it inside your living room.

Panam:
- [7] Some people in this city have completely lost their grip on reality, [laughter] and it sounds like that man was leading the way.
- [23] Stop looking at the whole mountain, [sigh] and just focus on the next step in front of you. That is how you get through it.
- [31] Quitting is an option, [question-oh] but you have to be sure you are walking toward something and not just running away.
- [35] Let me guess, [laughter] some street rat who thought you looked like an easy mark. I hope you gave them a piece of your mind instead of your eddies.
- [21] People change. Life has a way of stripping away the parts of you that do not survive the road. [confirmation-en]

Johnny:
- [2] Try me. [laughter] I've seen everything from orbital drops to corporate meltdowns. What's the damage?
- [16] A plush cat. [laughter] You've got a real eye for the high-end, V. Put it somewhere I don't have to look at it.
- [19] Memories are just ghosts, [dissatisfaction-hnn] and the neighborhood you remember probably doesn't even exist anymore.
- [29] Then don't. [sigh] But if you quit now, you're just giving the bastards exactly what they want. Get up and finish it.
- [39] [sigh] Probably. But in a city this fucked, making things worse is usually the only way to actually change something.

Street local:
- [1] Same as always. [sigh] Just trying to make it to the end of the week.
- [5] Sounds like a nightmare, [dissatisfaction-hnn] and I've got enough noise in my head already.
- [22] I once spent a whole weekend cleaning a basement full of old industrial sludge, [laughter] and the guy didn't even pay me half of what he promised.
- [33] Not bad. Most people just pay a tech to do it, [confirmation-en] but saving the eddies is the real win.
- [37] I sleep. [sigh] And I hope the neighbors stop screaming for a few hours.

HEAD, for contrast: Judy "[5] ...having a voice in your head that you can't just mute... [dissatisfaction-hnn] sounds like a
nightmare." and "[15] ...using a ten-thousand eddy piece of tech to look through garbage... [laughter] I couldn't help it."

### How the block got here (what each stage did)

| Stage | Change | Result |
| --- | --- | --- |
| 1 | line + new wording + new tags | Judy took 11 of 12 offers; **0 of 37 mid-sentence** |
| 2 | wording "quite often mid-sentence, with an example" | takes up to 94-100%; mid 6 of 57 |
| 3 | the spot picked by the dice, "if a sound fits, the natural spot is ..." | mid 14 of 58 (asked mid, got mid 5 of 20) |
| 4 | "place it exactly here" | asked mid, got mid 12 of 19; mid 12 of 52 tags |
| 5 | per-profile rates (Judy .5, Panam .35, Johnny .42) | 40 / 30 / 18-35 / 40% |

Lessons, in line with the earlier rounds: what the model does (and how often) follows the bridge's dice and a concrete
instruction far better than a description; an example sentence in the wording raised the take rate sharply.

## The Chinese and Japanese check

`--lang ja|zh`: ten prompts each in that language, the Multilingual twin of each character (the one the game uses with the
setting on), and the reply-language block, as in game. Judy, Panam and Johnny; first with the first wording of the four
sounds (Judy and Panam only: 12 offered turns, **0 of the four sounds used**, they chose the English tags), then with each sound
given a Chinese or Japanese example ("wa!", 哇, "ei?", 诶 ...):

- Japanese: 10 offered turns, the sounds used on 4 replies (`[question-ei]` four times: "音？ [question-ei] 何のこと？");
- Chinese: 12 offered turns, `[question-ei]` on 3 replies ("听起来像是在走廊那边，[question-ei] 你觉得那是谁？").
- `[surprise-wa]`, `[surprise-yo]` and `[question-yi]` were never chosen in the 22 offered turns.
- In all the English runs (960 replies) no Chinese/Japanese sound was written by the model, and the tests show
  that if it were, it is dropped from every display text and never voiced on a non-CJK turn.
- Unvoiced here: nothing was rendered. Whether OmniVoice's Chinese "ei" in a Japanese reply sounds right is not known.

## To do later

- **Listening test (when the GPU is free):** render `[question-ah]`, `[question-oh]` with Judy's and Johnny's references, and
  the four CJK sounds with a Japanese and a Chinese reference. Decide whether `[confirmation-en]` mid-sentence is a tic
  (it was the most used sound for Johnny and Panam in some runs).
- If archetypes sound too chatty, lower `OFFER_RATE.neutral`.
- The rates are in `OFFER_RATE_BY_PROFILE`; add a name there to tune a single character.

## Install

A **bridge restart** (`bridge/natural-speech.mjs`, `natural-speech-talk.mjs`, `voice-selection.mjs`, `convai-bridge.mjs`). No CET
reload, no game restart, no new setting; the Natural speech switch behaves as before.
