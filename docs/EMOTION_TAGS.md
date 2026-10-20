# Inline emotion tags ("Expressive emotions")

October 9, 2026. How the character tells the face what it feels, how that was measured against real Convai characters, and
what the block now says.

## What exists

The feature was the **Expressive emotions** setting (Settings > Voices; off by default until October 11, 2026, then on). **It was removed
on October 20, 2026: it is always on and has no row**, and a saved `expressiveEmotions` key is ignored and dropped from the file once
(`ExpressiveEmotions.update()` ignores settings). Where the voice cannot use it (the Convai cloud voice) the bridge sends no block, as below. On a spoken turn the dynamic context carries a short block that asks the character
to write feeling tags inline; the bridge removes them from every text a player or an engine sees and keeps only where each one
sits, and the face follows those marks.

| Piece | Where |
|---|---|
| The syntax (names, aliases, streaming parser, spans) | `bridge/emotion-tags.mjs` |
| The words of the block | `EMOTION_TAG_BLOCK` in `bridge/emotion-tags.mjs`; `EXPRESSIVE_TEXT` in `bridge/expressive-emotions.mjs` is that same string |
| Gate (setting, engine, spoken turn) | `ExpressiveEmotions.contextFor` |
| Stripping and the marks `{at, name, strength}` | `bridge/natural-speech.mjs` `parseTagged` (uses the grammar above) |
| Marks into the face plan | `bridge/emotion-selector.mjs` `selectEmotion({marks})` |
| Last-line strip in the subtitles | `mod/subtitles.lua` |

### Format

```
{joy} {warm} {interest} {surprise} {sadness} {fear} {anger} {disgust} {calm}      a feeling, right before the words it applies to
{anger:strong}                                                                      a real outburst (the default is subtle)
```

A tag stays in force until the next one. Curly braces are feelings for the face; square brackets (`[sigh]`, `[laughter]`) are
sounds for OmniVoice (Natural speech). OmniVoice only treats `[name]` from its own list and `<|...|>` control tokens as special,
so braces are inert there and the two syntaxes cannot collide. Angle brackets were rejected for that reason (`<|...|>`).
The parser is lenient about what a model writes: aliases (`{angry}`, `{Joy}`, `{ anger : 2 }`) and a bracketed emotion word
(`[surprise]`, which is never a voice sound) are read as feelings; any other braces (`{choomba}`, `{42}`) stay ordinary text.

### Gating

The block is sent only when **both** of these hold: the turn is spoken (not phone chat, not silent
playback), and the voice that will speak it is a local one (OmniVoice or Pocket). With the Convai cloud voice nothing is sent,
because Convai would read the braces aloud. There is no setting and no pairing rule in the manager since 2026-10-20: the bridge
decides per turn from the engine that speaks (`contextFor({engine})`), so a fallback to text (or to the cloud voice the player chose) mid-session sends no block.
(Natural speech, which writes square-bracket sounds, still excludes the Convai cloud voice where Convai is the provider: `docs/MANAGER_UI.md`.)

Mid-session safety (a character that wrote tags for a while, then the voice switches to Convai and the block stops): in a
test of 3 characters, 12 turns with the block and then 18 without, every one of the 36 turns with the block carried tags and
**none of the 54 turns after it was dropped did** (`--hangover 12`). The model does not keep the habit once the block is gone,
so a voice switch does not leak braces into the cloud voice (short horizon: 18 turns).

## The problem the first block had

The October 7 block ("mark a feeling where it really shifts ... a plain, even reply needs few or none", `scripts/emotion-block-october7.txt`)
produced, on 320 replies from 8 characters:

- `{calm}` on 41 % of the tags and `{interest}` on 29 %, whatever the line;
- 27 % of replies opened with a tag and then went straight to `{calm}` for the rest;
- measured against blind per-segment labels, the tag in force matched the label on 36 % of segments (acceptable: 60 %); a
  `{calm}` was exactly right 32 % of the time, an `{interest}` 14 %.

The picker therefore stopped trusting `{calm}` and `{interest}` (commit `3c916b6`). This work fixes the cause, the wording.

## The block (final)

```
Facial emotions are on. Your face is animated from emotion tags you write inline, in curly braces, right before the words they
apply to: {joy} (amused, delighted, proud, playful), {warm} (affection, care, comfort, gentle teasing, flirting), {interest}
(really intrigued, listening hard), {surprise}, {sadness} (grief, regret, weariness), {fear} (worry, alarm), {anger} (annoyance,
irritation, rage, a defensive bite), {disgust} (revulsion, scorn; not mere dryness), {calm} (a flat, plain, businesslike face).
Most lines are neither {disgust} nor {interest}. A tag stays in force until the next one, so it covers every sentence after it.
Begin the reply with ONE tag for the feeling that runs through most of it, and add a second only where a later sentence clearly
turns (a punchline, a softening, a flash of anger): one or two tags, three at most, and never a short reaction followed by
{calm} for the rest ("Scared?" said in annoyance is all {anger}). Be true to who you are: if you are guarded, dry or controlled,
show less. Use :strong (for example {anger:strong}) only for a real outburst. Example: "{sadness}I am sorry, V. I
really am. {warm}But you are not doing this alone." The tags are for the face only: never mention a feeling because of them,
use curly braces for nothing else (square brackets are a different thing), and keep the same length and content you would give
otherwise.
```

1,400 characters. Each tag has a meaning, the opener carries the dominant feeling, one or two tags a reply, `{calm}` and
`{interest}` are explicitly not defaults.

## Method

Fresh throwaway Convai end-user per run (never the player), real tier-1 characters (Judy, Panam, Johnny, Jackie, River, Rogue,
Kerry, Evelyn), 40 player lines in 7 kinds (provocation, sad news, teasing, flirting, surprise, mission, small talk), one
session per character so the history builds like a chat. The context is assembled the way the bridge does (conversation
context, Follow-up, Natural speech, then the block), and every reply goes through the real cleaning. 320 replies per condition.
`scripts/Probe-EmotionTags.mjs` collects; `scripts/Judge-EmotionTags.mjs` audits and builds the blind packets;
labels for appropriateness come from `Build-EmotionSegmentSet.mjs` (segments exactly as the bridge cuts them for OmniVoice)
and blind writers who see only the clean text (no tags, no Convai label, not which block wrote it) and the evaluator
`Evaluate-EmotionSegments.mjs` (`--gold`, new `spans-*` conditions). Labels: `assets/emotion/segments-gold-tags.json`
(2,600 segments from the October 7 block, variant 3 and variant 5).

### Compliance (valid = every tag a known feeling in the right place, no brace text left, no stage directions)

| Block | Valid | Opens with a tag | Tags / reply | `{calm}` share | `{interest}` share | Opener then `{calm}` | Words / reply |
|---|---|---|---|---|---|---|---|
| none (control) | 100 % (0 tagged, no spontaneous braces) | n/a | 0 | n/a | n/a | n/a | 27.0 |
| October 7 | 100 % | 100 % | 2.05 | 41 % | 29 % | 27 % | 27.5 |
| variant 3 (1,866 chars) | 100 % | 100 % | 2.18 | 28 % | 10 % | 21 % | 25.7 |
| **variant 5 (final, 1,400 chars)** | **100 %** | **100 %** | **2.06** | **32 %** | **9 %** | **22 %** | **25.2** |

Zero tags beyond three a reply, zero leaked feeling words, one reply in 320 with an empty stretch (a tag with no words, harmless).
`:strong` is 0.4-1 % of tags. Tags sit at the start of the reply or of a sentence (one at a clause in 660).

### Appropriateness against blind labels (the same 40 prompts x 8 characters, ~840 segments per block)

| | October 7 | variant 3 | **variant 5** |
|---|---|---|---|
| tag in force equals the label (exact) | 36.2 % | 53.6 % | 53.1 % |
| ... or an acceptable alternate | 59.7 % | 78.0 % | **80.0 %** |
| `{calm}` exactly right | 32 % | 45 % | 40 % |
| `{interest}` exactly right | 14 % | 39 % | 31 % |
| face as the player sees it (marks through the current picker): exact | 48.3 % | 51.4 % | **56.5 %** |
| ... acceptable | 72.1 % | 77.2 % | **80.3 %** |
| ... a segment the labels expect to emote shows nothing | 20.1 % | 9.8 % | 10.6 % |

For reference on the same segments: the picker alone with Convai's label (Expressive emotions off) 44-46 % exact / 68-72 %
acceptable, text alone 32-34 % / 55-57 %. So with the old block the tags added about 4 points over no tags; the new block adds
about 10.

Caveats: the labelling writers are the same model family as the character LLM; labels for two further variants came from a
cheaper writer that labels fewer lines calm, so those numbers are not comparable (see "Not better"). Two same-size runs of one
block differ by a few points through sampling alone (about 1.7 points standard error per condition on 840 segments).

### Voice quality (blind pairs, same player line with and without the block, tags removed)

| | voice | natural | quality | preferred (block / none / tie) |
|---|---|---|---|---|
| October 7 vs none (Sonnet judge) | 3.53 vs 3.46 | 4.18 vs 4.25 | 3.78 vs 3.75 | 122 / 112 / 86 |
| variant 3 vs none (Sonnet judge) | 3.64 vs 3.47 | 4.35 vs 4.26 | 3.95 vs 3.74 | 148 / 69 / 103 |
| variant 5 vs none (Haiku judge) | 3.88 vs 3.88 | 3.79 vs 3.78 | 3.93 vs 3.92 | 145 / 148 / 27 |

The block does not make replies worse; where there is a difference it is slightly better (a stated feeling gives the character
something to commit to). Reply length is unchanged within a word or two.

### Coexistence

Natural speech and Follow-up questions were on in every run, in the bridge's order (Follow-up, Natural speech, then the emotion
block). Bracketed voice tags and brace feeling tags coexisted with no collision (`[sigh]` next to `{sadness}`), zero
bracket confusion in the final block, whole context 3.3k characters against about 1.9k without the block. Pocket (2
characters x 20 prompts): 40 of 40 replies tagged.

### Timeline: tags against the picker (old picker, before `3c916b6`)

Blind per-sentence fit of the face labels (0-2), 320 replies, old picker vs tags alone vs tags with the picker filling the
untagged stretch: old picker 1.26, tags 1.61, tags + picker 1.60 (variant 3). The picker has since been rewritten (it reads
the player line, Convai's label, everyday cues), which is why the table above uses the current one.

### Not better

- **Wiring `selectEmotion({spans})`** (a tag wins exactly, `{calm}` an explicit neutral face). Measured with the current picker:
  tags as spans for the specific feelings only (`{calm}`/`{interest}` handed back to the picker) score the same as the marks
  path (51.4 vs 51.4 exact on variant 3, 56.9 vs 56.5 on variant 5); trusting every tag as a span is worse on the final block
  (52.0 / 78.6 vs 56.5 / 80.3) because `{calm}` is still about twice as frequent as a calm line really is (32 % of tags, about
  19 % of segments), and a span-calm kills the picker's reading of the line (21-26 % of the segments that should emote show
  nothing, against 10 % on the marks path). So the bridge keeps passing `marks`; nothing in the bridge or the selector changed.
  `emotionSpans` stays available (the evaluator uses it).
- **Variant 6** (no `{interest}` in the list, "`{calm}` never as a habit"): `{calm}` fell to 18 % and `{interest}` to 0, but the
  surplus went to `{joy}` (28 % of segments, right 38 % of the time) and fit dropped (46 / 70 against 52.5 / 75 and 56.6 / 79 for
  variants 3 and 5 on the same labeller).
- **Variant 4** (compact, 1,054 chars) put 30 % of the tags on `{interest}` and one `[surprise]` bracket slipped (99.7 % strict).
- Variants 1 and 2 let the model write "{emotion}short reaction {calm}rest".

## Parser and streaming

`bridge/emotion-tags.mjs` is pure. `parseEmotionText(raw)` returns the clean text, the tags with the character offset of the
word they precede, and the spans; `EmotionTagStream` keeps a tag split across chunks (`{sad` + `ness}`) out of the text and its
state after the last chunk equals the whole-text parse for every split (tested at every split point and with random chunking).
`natural-speech.mjs` uses the same grammar in its combined pass over voice and emotion tags (a test keeps the two identical).
Tags are removed from the display text, the text each engine reads, phone chat and memory. A tag with no word after it marks
nothing. A dangling `{ang` at the end of a reply is dropped, `I {think` stays.

## Restart

Bridge restart only (`bridge/`: `emotion-tags.mjs`, `expressive-emotions.mjs`, `natural-speech.mjs`). No Lua, no CET reload, no
new setting, no per-frame work: everything is on the reply path in the bridge. Check in game with Expressive emotions on: the
face changes at the tagged phrase, calm characters show little, no brace text in subtitles or phone chat, with Natural speech
and Follow-up on together.

## Reproducing

```
node scripts/Probe-EmotionTags.mjs --profiles judy-alvarez,panam-palmer --block off|v0|new|<file> --prompts 40 --label x --run
node scripts/Judge-EmotionTags.mjs stats x
node scripts/Build-EmotionSegmentSet.mjs --probe-dir <dir with x-*.json> --out <units.json> --followup 0
node scripts/Judge-EmotionTags.mjs packet-label <units.json> <dir>     # blind labelling packets, then merge-label
node scripts/Evaluate-EmotionSegments.mjs all --gold assets/emotion/segments-gold-tags.json
```

`PICKER_BRIDGE=<dir of an older bridge/>` points the judge scripts at another picker for before/after.
