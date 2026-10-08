# Companion expressions

## October 9: blinking while speaking, and expressions that read during a reply

User report (recording Judy for the lip sync video): she never blinks while she talks, and her face barely changes
across a reply, even with Expressive emotions on.

**Blinks: root cause.** Our layer never wrote the eyelids, so nothing of ours froze them. The cause is where the
game's blinks come from. Cyberpunk's own dialogue lipsync animations carry a talking face's blinks on
`eye_l/r_blinkLipsyncPoseOutput`, the same tracks our ConvaiFace feature adds to: 800 extracted lines show about
19 blinks a minute, peak about .64 (up to .95), closed within about .07 s, open again over about .2 s, both eyes
together. Our speech replaces that animation. The face graph's only other blink source is the look-at controller
(`animLookAtAnimationDefinition` playing `additive__blink_fast/half/slow` on a gaze shift; Judy's
`player_woman_photomode_sermo` has no idle facial animation at all). While she talks she holds eye contact with V
(`attend`, a steady look-at), so no gaze shift happens and she never blinks. The same applies to every voice route
(Pocket, Omni, Convai), because they all share one face writer.

**Follow-up in game (same day):** with the fix installed she blinked a little while talking but never at idle. The
idle assumption was wrong. The prepared graphs keep the vanilla blink machinery intact (`FacialMixerSlot` with its
`lookAtDefinitions`, the `LookAtController`; our build only adds zero-default Add nodes just before the Sermo
solver, and the idle writer leaves the lids at 0). But that machinery has only two blink sources in every graph,
vanilla NPC graphs included: animations streamed into the mixer slot (scenes, workspots, dialogue lipsync; the
story Judy is always in one) and the look-at blinks, played only on a look-at transition. A companion copy idles
outside any scene or workspot and holds one steady look-at on V (or none), so neither ever fires. Restoring the
vanilla source would mean re-aiming the gaze every few seconds or streaming facial animations into the slot, with
no script input for the latter; so the writer blinks at idle too.

**Blinks: fix** (`mod/facial-playback.lua`). At all times for the copies this writer owns (managed companions, and
the current speaker while she talks), the writer adds its own blink on the eyelid tracks: every 2-6 s with jitter
(every 1.8-5.2 s while listening; first one 0.6-2.2 s in), now and then one at a phrase start (45 %,
from the expression track's phrase spans), same shape as the game's (smooth close over .07 s, exponential open,
peak .62-.95). It is additive and short, so a native gaze-shift blink on top only merges (the solver clamps at
1). Combat, scenes and native dialogue block it like every other optional delta (a scene streams its own). A
phrase of a phrase-streamed reply (Omni) never starts a blink in its last .35 s, since the face holds its last
frame until the next phrase plays. Cost: a few comparisons and at most one `exp` per write, no tables, no new
hooks; phrase starts are read once per timeline. Simulated over 15 replies: 18 blinks a minute.
`speech-state.json` → `face.blinks` counts the blinks started during replies, `face.restBlinks` the others
(in-game check). Crowd NPCs never reach this writer.

**Expressions: where the range collapsed** (15 replies for Judy, Panam and Johnny through the real selector, the
aligner and the Lua writer, on mouth curves from the game-trained model over real cloned-voice audio):
- *Expressive tags were a third of a pose and flat.* A subtle tag (.45) times a reserved manner (.8, Judy and
  Johnny) is .36, and poses were linear in the weight, so Judy's `{fear}` raised the brows .16. A tag also replaced
  the phrase's own text reading, so a reply with one tag sat at one level throughout ("Too late now" no sadder
  than "Every day").
- *Weak units.* Warm (Trust) smiled .25 × weight: .09-.12 on a tagged warm line, below the .15 a smile needs.
- *Mouth budget.* Speech keeps 85 % of the corners and closures/rounding cut them further: corners average
  about .7 of their target while talking. Kept (it is what stops a smile on "oo" and lip closures).
- Not the cause: the lip sync model writes none of these controls; the .18/.55 s smoothing is far shorter than a
  phrase; the neutral-while-speaking rule only affects phrases with no feeling (kept, it guards grief).

**Expressions: changes.**
- Frowns and brows follow w^.6 of their pose in a blend (`mixCurve`, Lua and `companion-expressions.mjs`); full
  feelings and the caps are unchanged. The smile stays linear: a curved smile made weak, misread joy visible on
  sad and calm replies in the labelled sets (it added two false smiles on negative replies).
- Trust (warm) smiles .35, was .25.
- Expressive tags: subtle .6, strong 1 (were .45/.8), and the phrase's own text can raise the tagged feeling.
- A reserved or cold manner also caps a phrase at .8/.6, so strong text no longer saturates Johnny to Panam's
  level.
- Kept: the idle light smile and its mood hold, the Evelyn grief rules, the mouth budget, the caps.

**Before → after**, peak (p90 within a phrase) of the main controls, written values after the mouth budget,
Expressive emotions on (one or two subtle/strong tags per reply):

| Feeling | Judy (reserved, corner gain 1.6) | Panam (expressive) | Johnny (reserved) |
| --- | --- | --- | --- |
| joy | corners up .39→.48, squint .28→.35 | up .35→.38, squint .25→.27 | up .14→.30, squint .10→.22 |
| warm | up .09→.15, squint .11→.17 | up .11→.20, squint .08→.14 | |
| sadness | corners down .35→.47, inner brows .29→.39 | down .18→.27, inner .23→.36 | down .12→.21, inner .16→.39 |
| anger | brows lower .29→.39, down .21→.29 | lower .41→.45, down .19→.21 | lower .29→.39, down .13→.18 |
| fear | inner brows .16→.39, outer .11→.26 | | |
| disgust | | | lower .13→.23, down .09→.16 |
| surprise | | outer brows .46→.50, inner .32→.35 | |
| neutral | 0 → 0 | | 0 → 0 |

Text only (no tags): sadness and anger rise by .03-.09 (Judy sadness down .22→.31), smiles are unchanged, and the
strongest phrases of reserved characters are capped (Johnny joy .33→.27, Judy's strongest fear brows .45→.39).
Labelled sets (`scripts/Evaluate-EmotionSelector.mjs`): labels unchanged; one more calm reply shows a soft smile
(dev d038, a misread warm phrase at .18); no new false smile on a negative reply.

**Tests** (`companion-expression-playback.test.mjs`): blinks through a 20 s reply on each source (local-jali,
convai-arkit61, local-phonetic, audio-envelope): 4-11 blinks, gaps .55-6.3 s, game-shaped peaks, both eyes,
speech fields untouched; idle blinks every 1.9-6.1 s and listening more often, thinking blinks, blocked faces
never blink; phrase
boundary blinks and the Omni phrase tail; per-feeling minimum visible deltas on Judy; a reply changes face between
tags and the text deepens a tag; Johnny below Panam on the same words but at least 60 % of her; grief never smiles
through the writer (with or without a tag) and still reads sad. All seven fail on the previous code.

**In game** (needs a CET reload or game restart for the Lua and a bridge restart for the selector): Judy blinks
every few seconds at all times, while she stands idle, talks, listens or thinks, about as often as in a story scene, with no double or stuck
half-closed lids between Omni phrases; `face.blinks` in `speech-state.json` climbs during replies. Tagged
feelings show clearly on brows and corners and change between phrases; Evelyn still never smiles; Johnny moves
his face less than Panam on similar lines.

## October 8 (later): the light idle smile is back, held off after sad turns

In game the user missed Judy's light resting smile while she is not talking; the objection was only to smiling
on sad topics. `mod/facial-playback.lua` (mirrored in `companion-expressions.mjs`, `restSmile .12`):
- **Idle only:** a light resting smile by manner, slightly below the October 7 levels: warm characters .18,
  default .12, dry .05, cold 0; Judy .12 with her corner gain 1.6 (about .19 on her rig).
- **While speaking:** no resting smile at all; the context selector below decides the whole face (the idle
  smile releases into speech over about half a second).
- **After a sad, angry, scared or disgusted turn** (any negative weight .2 or more in that turn's track or
  label): the idle face stays neutral for 60 s of game time, or 10 s after a later calm turn ends, then the
  smile eases back over 5 s. A further negative turn restarts the minute.
- Tests: `companion-expression-playback.test.mjs` "idle smile: present at rest, absent during and after the
  Evelyn reply, back after the mood decays" (real selector plan, real Lua writer).

## October 8: neutral rest, a context-aware emotion selector, and Convai's own label for local voices

**The problem (user, in game).** Judy smiled when V asked her a sad question about Evelyn. With Expressive
emotions on it was "a little better".

**Root cause (measured on the labelled sets below).**
- *Resting smile.* Lua rested every non-negative face at a smile (Judy .14 × gain 1.6 ≈ .22 corner-up; warm
  characters .22). The text plan then added a resting Trust baseline (.67 for warm characters, ≈ .27 on Judy
  with gain) under every sentence. A reply with no feeling at all therefore smiled while speaking.
- *Pleasant words as smiles.* The lexicon scored "love", "family", "glad", "thanks", "beautiful", "laughed",
  "friend", "sister" and forms of address ("V", "choom") as Joy/Trust, so grief told through fond memories
  ("She was beautiful, V. I loved her so much") smiled harder (.65) than a neutral line.
- *No conversation context.* Only the reply was read, never the player's question, so a sad question answered
  briefly ("Thanks for asking. Some days are easier") had nothing sad in it.
- *Weak negative cues.* "Sorry" was .35; regret, counterfactuals ("if I'd picked up"), "since she's gone" and
  most concern phrases scored nothing. The baseline smile only yielded to a negative weight of .2 or more.
- *Two bugs.* A segment starting with "V" read `tokens[-1]` and threw, so the whole plan fell back to
  `text-emotion.mjs`, whose default is a Trust scale-2 smile for warm characters. Lexicon phrases stored
  without apostrophes ("dont like this", "cant believe") never matched real text. Both are fixed in
  `emotion-analysis.mjs`.
- Negation, sentence segmentation and intensity mapping were not the cause; the joy bias was (above).

**Convai's own emotion (research and live probes, `@convai/web-sdk` 1.7.0).**
- The REST `POST /character/getResponse` and the beta `live.convai.com/connect/stream` SSE return no emotion
  field (docs.convai.com interaction API pages). "State of Mind" is a Playground view (an emotion wheel) with
  no read API. The SDK's `stateOfMind` / `updateEmotion()` *sets* the character's mood as an input
  (`state_of_mind` on connect, `update-emotion` message); it is not an output.
- The realtime SDK sends `bot-emotion` (`{type, emotion, scale}`, scale 1-3, Plutchik-style labels: Joy,
  Serenity, Ecstasy, Trust, Acceptance, Sadness, Pensiveness, Grief, Anger, Fear, Surprise, Interest,
  Anticipation, Disgust, Boredom, neutral) when `enableEmotion` is on, one per turn with
  `emotionConfig.provider: 'llm'` (ours). `provider: 'nrclex'` streams several per reply (one per text chunk)
  but is a word lexicon: Judy's grief reply came back neutral, then Pensiveness/1.
- **Text-only turns (Pocket and Omni) do get it**, contrary to the October 5 note: it arrives 291-620 ms
  (median about 480 ms) after `bot-llm-stopped`, after `reply()` had already returned, which is why it was
  never seen. 43 of 43 live text-only turns on five characters carried one (fresh test end-user IDs; evidence
  in `assets/emotion/exchanges-real.json`, scratch probes not committed).
- Quality on those 43 real replies (blind labels): Convai's label alone is acceptable for 90.7 % (exact
  51.2 %), with no false smiles. It is per turn, not per sentence.

**What changed.**
- `mod/facial-playback.lua`: resting warmth 0 for every character (Judy keeps corner gain 1.6). Mirrored
  in `companion-expressions.mjs` (`restSmile: 0`).
- `bridge/emotion-selector.mjs` (new): the selector. Inputs: the player's message, the reply, the previous
  turn's mood for this character (three minutes, in memory, fades instead of renewing itself), the
  character's manner (expressive, open, reserved, cold: intensity and how much evidence a smile needs),
  Convai's label, and the character's tags. It reuses the existing segmentation, lexicon scoring and the
  timeline aligner, adding conversation frames (grief and loss, sore questions, danger, conflict,
  celebration, humour; death idioms such as "over my dead body" removed), about 20 phrase patterns
  (empathy, regret, longing, concern, reassurance, hospitality, laughter, disbelief, scorn, threats),
  whole-reply sarcasm, contraction normalising ("I am sorry"), and gates: mild words never smile, a grief
  frame turns fond words into sadness, a clearly negative phrase leaves no smile under it. A reply with no
  feeling is calm: no reply-level cue, neutral face.
- Priority: the character's own tags (Expressive emotions) from the first tag on; then Convai's label as the
  reply prior (other families' text feelings × .7, joy damped under a negative label); then the text.
- Convai's late label: `realtime-client.mjs` keeps the one id-less `bot-emotion` that arrives between a
  text-only reply's end and the next reply's `bot-llm-started` (4 s limit; a second one is ambiguous and
  dropped) and returns `lateEmotionToken` with the reply; `RealtimeHost.lateEmotion()` reads it. The bridge
  polls it (80 ms, 1.5 s limit) alongside the voice: Omni re-plans before returning the first phrase if it is
  in (it usually is: phrase 1 takes longer to render), never waiting for it, and otherwise updates the plan
  its later phrases use; Pocket's stream planner picks it up at its next rebuild. Nothing waits on it, so no latency is added.
- Fallback setting: `"emotionSelector": "legacy"` in `runtime/settings.json` (no menu entry; the game keeps
  unknown keys) returns to the reply-only planner. The Lua rest stays neutral in both.
- Receipt: `runtime/expression-receipt.json` version 3 adds `selector`, `convai`, `convaiLate` (ms), and the
  plan's `evidence` and `summary`; a second receipt is written when Convai's late label arrives.

**Evaluation** (`node scripts/Evaluate-EmotionSelector.mjs all`; labelled sets in `assets/emotion/`, labels
by separate writers; "acceptable" counts the gold label or one listed as also reasonable; a false smile is a
visible corner-up ≥ .15 while speaking on a sad, afraid, angry or disgusted reply).

| Set | Previous exact / acceptable | False smiles (negative) | Smiles on calm | Selector exact / acceptable | False smiles | Smiles on calm |
| --- | --- | --- | --- | --- | --- | --- |
| dev, 130 (tuned on) | 27.7 % / 44.6 % | 45/59 | 13/20 | 84.6 % / 93.8 % | 0/59 | 0/20 |
| holdout, 80 (first look) | 37.5 % / 45.0 % | 25/36 | 8/12 | 75.0 % / 80.0 % | 2/36 | 0/12 |
| blind, 90 (first look) | 26.7 % / 38.9 % | 30/41 | 9/14 | 62.2 % / 74.4 % | 5/41 | 0/14 |
| real Convai replies, 43 (first look) | 39.5 % / 58.1 % | 13/16 | 10/14 | 37.2 % / 72.1 % | 0/16 | 0/14 |
| real, with Convai's label (first look) | | | | 46.5 % / 88.4 % | 0/16 | 1/14 |

Holdout, blind and real were then used for one round of general fixes each (now 91.2/96.3, 78.9/92.2 and,
with Convai's label, 51.2/90.7; 0, 2 and 0 false smiles); the first-look numbers above are the honest ones.
"Previous" is the installed code (`PREVIOUS_BRIDGE` pointed at the HEAD copy), including its crash fallback. Every Evelyn exchange in the four sets is
now sad or the accepted feeling, with no visible smile (it smiled in all seven of the dev ones before). The
real replies are terse and often calm, which is where the text alone is weakest and Convai's label helps most.
Cost: about 0.15 ms median, 0.4 ms p95 per reply in Node (the previous planner 0.07 ms), off the game's thread.

**A local model was not adopted.** A distilled RoBERTa emotion classifier (about 82 M weights, 7 classes, no
warm/interest) would need onnxruntime-node and about 80-330 MB of weights (int8/fp32) downloaded, typically
10-40 ms per sentence on one CPU core, more while the game runs, and still reads only text. Convai's label is
already context-aware (it saw the whole conversation), free, and arrives in time; the selector covers phrase
timing and the gaps. Not measured here (it would need the download).

**In-game checks.** See TODO "Context emotion selector".

## October 7: resting warmth, calm brows, and a multi-emotion timeline

**Live findings (screenshots of Judy via the face-test probe, installed `0d89060`).** Writer-mode
poses are all visible, and `face-test off` returns her to the same neutral idle as before (no stuck jaw,
brows or corners). Corners .45 read as a modest smile; adding the outer-eye squint (the closest control
the feature exposes to a cheek raise; there is no cheek-raise or lid-tighten track, only cheek puff and
suck) makes it read as warm; corners .65 + squint .35 is a clear friendly smile. Squint alone looks
stern, so it is only ever driven by the smile.

**Why the face looked flat/odd, from the code and the logs:** an Interest cue (a question tone) replaced the
resting smile (no corners, brows only), so Judy had no smile while speaking; the voice-synced brows
(model raise gain .65-.8, no dead zone) lifted the brows by roughly .1 almost constantly and
bobbed them alone on a static face; and any emotion's brows were held 4 s (8 s if negative) after the
voice stopped, which with a question cue on most replies reads as "brows always raised at idle". The current code
reproduces none of these (idle brows are exactly 0 five seconds after a reply in the simulation below).
Also fixed: a face-test `policy` run injected a feeling and marked the turn active, so it could leave the
actor in "thinking" (no resting smile) after `off`.

Changes (Lua `mod/facial-playback.lua`, mirrored in `bridge/companion-expressions.mjs`):

- Resting warmth is a **floor** under every non-negative intent (Interest, surprise, neutral tone),
  idle and speaking, combined by max with the emotion's own smile; sadness/anger/fear/disgust and unknown
  labels remove it. Per character (actor-row profile keys, Lua only): warm .22, default .15, dry .07,
  cold 0. Judy: warmth .14 with a corner gain of 1.6 (about .22 at rest), caps scaled by at most 1.3.
- Duchenne squint on `eye_l/r_oculi_squint_outer_lower`: .6 of the smile, capped .35, smoothed, not
  affected by mouth closure (eyes are not the mouth).
- Interest: brows .15 (was .30) plus the warmth smile. Surprise and Interest brows are a **flick**
  (full for 1 s, gone by 2 s). Other emotion brows hold through the phrase and **release within 1.5 s after
  speech** (corners keep the 4/8 s expiry).
- Voice-synced brows are rare emphasis: dead zone .25 on the model's raise, peak .15, and after one
  emphasis the next is held off 3 s.
- Brow/corner values over a 6 s reply plus 10 s (simulation through the real Lua writer, Judy, model raise
  mean .1 with two stresses): Interest speech corners .19-.20, brows raise_out .09-.10 for the first
  second then 0 by 4 s; idle after speech corners .224 (resting), brows 0.000. Sadness: raise_in .30 held
  through the reply and 1.5 s after, .12 at +2 s, 0.001 at +5 s.

### Multi-emotion timeline (local voices, and phrase variation on Convai)

- `bridge/emotion-lexicon.mjs` and `bridge/emotion-analysis.mjs`: a few-millisecond, LLM-free analysis
  splits the reply into segments (sentences, contrast clauses at "but/however...", long clauses, and forced
  edges such as Omni phrase boundaries) and scores 8 families with intensities (about 640 words and phrases,
  inflections, intensifiers and diminishers, negation within 3 words, contrast, questions, exclamations,
  ellipsis hesitation, laughter, profanity as anger or emphasis, affectionate address, reliable sarcasm
  patterns), then merges a per-character baseline and range (warm, neutral, dry, cold). A Convai
  reply-level label (basis ordered/response-id, never our own cue) becomes the baseline at 60 %, and the
  phrase analysis varies it. The reply-level receipt cue is derived from the plan.
- `bridge/expression-timeline.mjs` aligns segments to REAL audio time: Omni phrases are their own audio
  files (each phrase timeline starts at its own audio start); Pocket and Convai streams use pauses in the
  mouth timeline (jaw/lip aperture of the game-trained model or the provider's poses) snapped to the text's
  sentence boundaries, with a syllable/punctuation duration estimate rescaled to the audio received so
  far; the estimate only fills boundaries not yet heard. No recognizer. Each change starts 200 ms before
  the phrase's audio, blends over 300 ms, holds through the phrase, and the last phrase decays to
  baseline.
- Lua applies the track at the heard position (`expressionTrack`, format `emotion-mix-v1`, validated,
  ignored if malformed), blending families with a soft sum inside the caps (bittersweet = a slight smile with
  sad brows); corners cross-fade on one signed axis, so a smile turning into a frown passes through
  neutral. Mouth priority is unchanged and tested: closures/rounding zero the corners and leave every speech
  field identical. Between Omni phrases the last mix is held.
- Diagnostics: `runtime/expression-receipt.json` (version 2) lists per-segment offsets, weights, tags
  and phrase spans (no dialogue); each timeline's `expressionTrack.segments` (in `reply.json`,
  `speech-stream.json`) carries the aligned audio times; `speech-state.json`
  `face.expressions.lastSpeech` has `mix`/`mixPeak` per family and the peak pose.
- Tuning is data: caps, strengths, warmth/gain table (Lua) and lexicon weights; `LEAD_SECONDS`,
  `BLEND_SECONDS` in `expression-timeline.mjs`.

## October 6 (later): live face-test, second recalibration

`mod/face-test.lua` (driven by the facial writer; `scripts/Send-FaceTest.ps1`) pushed
extreme poses on Judy while the user watched. Writer mode showed the full smile,
frown, brows and jaw clearly, so the write path works; the strengths were the
problem. Ramp-smile: a smile reads clearly at about .35-.5 on Judy and 1.0 is an
exaggerated grin. The first recalibration (peaks <= .20, rest .06) was therefore
still invisible, because the game's authored .10/.20 offsets are not what reads
on this rig. The probe also left `jaw_mid_open` .5 after the sweep (the writer
keeps its idle feature between frames); it now zeroes probe-written fields when a
step, run or "off" ends.

Policy v2 (Lua and `companion-expressions.mjs` identical): scale strength .4 / .67 / 1;
joy corners .45 (.30 at scale 2) with brow raise-out .20; trust .25; sadness corners
down .40 with raise-in .45; anger lower .45 with corners down .25; fear down .15,
raise-in .45, raise-out .30; disgust down .30, lower .35; surprise raise-in .35 and
raise-out .50; interest .30. Caps: corners .50, brows .55. Resting smile .10 (idle
and speech). The warm default cue (Trust scale 2) is .167, about .14 while speaking;
other characters get scale 1 (.10); cold characters get a flat Interest cue while
speaking. Provider (Convai) multipliers: corners .30, brows .55/.45/.40. Model brow
gain .8. Unchanged: 85 % of mouth emotion kept while speaking, smoothing (.18 s
attack, .55 s release), and mouth priority. Closures (P/B/M) and rounding (O/U) still
remove corner emotion after smoothing, tested for seven emotions at scale 3, and
jaw/closure/rounding fields are bit-identical with or without an expression.
Known limit: the idle resting smile is one value for every character; "cold" is
expressed through the cue while they speak, not in the idle pose.

## October 6: why the face looked blank on local voices, and the recalibration

User report (Omni 32, Judy): lip sync good, "I don't see any expression ever".
Traced from the installed runtime and the code, not guessed:

1. **The wiring was fine.** An October 5 `companion-systems.json` capture shows the
   native writer applying the idle pose to every managed copy (about 24,000
   `ConvaiFaceApply` calls, `lips_*_corner_up = 0.025`), and the current
   `reply.json` of a Judy Omni turn carries `jali-audio-v1` frames plus
   `modelExpressions` (`jali-upper-v1`). The Omni route copies the bridge's
   `expressionSignal` onto every phrase, and `ownedExpressionReceipt` binds it
   to the request. Nothing dropped the field.
2. **No cue was produced.** That reply ("... I'm just glad I've got someone I can
   actually trust ...") scored one Joy hit; the cue needed two (score >= 1.5 and
   a margin), so the turn had no `expression` receipt at all, as most ordinary
   replies would not.
3. **Even a cue was nearly invisible.** Joy scale 2 wrote .085 x .65 = .055, then
   speech kept 60 % = .033; the voice-time resting smile did not exist at all
   (it was idle-only) and idle was .025.
4. **The calibration target was misread.** The earlier note "the game holds
   corners at about .10" is true but means something specific. Across 6938
   extracted dialogue lines, the game's lipsync does not animate these controls
   smoothly. Each line holds one constant mood offset: smile = corner up .10 with
   brows raise .10 (39 % of lines), frown = corner down .20 with brows lower .324
   (20 %); nothing else (values are exactly those constants, 500-line sample).
   Our caps (.12 up, .10 down, .20 brows) sat at or below that, frowns at half the
   game's own, and every emotion was then scaled down again by 35-65 % and by the
   speech factor.

Changes (Lua `mod/facial-playback.lua` and the mirrored pure policy in
`bridge/companion-expressions.mjs`):

- Strength by scale (1..3): .5 / .8 / 1 (was .35 / .65 / 1). Joy corners up
  .20 x strength, Trust .12, Sadness down .12 with brows raise-in .16, Anger down
  .08 with brows lower .20, Fear down .05 with raise-in .15 and raise-out .10,
  Disgust down .10 with lower .14, Surprise raise-in .08 and raise-out .16,
  Interest/anticipation raise-out .08. Caps: corners up .20, corners down .20
  (the game's frown), brows raise .25, brows lower .32 (the game's .324).
- Speaking keeps 85 % of mouth emotion (was 60 %); closed lips and rounded
  O/U still remove it after smoothing, so visemes keep the mouth.
- Resting smile .06 (was .025), shown while idle **and while speaking** when no
  emotion is known. It is roughly 60 % of the game's own authored smile.
- Model brows from the audio use gain .65 (was .35). The model output is already
  a regressed, shrunk estimate; the extra .35 shrank it twice. Still max-combined
  with the emotion pose, cap .25, predicted lowering still ignored.
- Convai provider pose multipliers raised in step (brows .25/.20/.18, corners
  .14) because they were chosen against the old invisible caps.
- Local voices: `bridge/text-emotion.mjs` now **always** returns a cue. Order: a
  lexicon feeling when one clearly leads (one clear word is enough, weighted
  cues, Joy and Trust reinforce each other, negated positives cancel); else the
  tone (a question lifts the brows with Interest, an exclamation smiles, a
  refused positive such as "not happy" stays flat); else the character's resting
  warmth (Trust scale 2 for warm companions such as Judy, Jackie, Panam, Kerry,
  scale 1 for everyone else, flat Interest for cold ones such as Adam Smasher or
  Yorinobu). It is a local heuristic with no model or network request and still
  one cue per reply.
- Diagnostics: the bridge writes `runtime/expression-receipt.json` per local
  turn (request, profile, provider, emotion, scale, basis, delivered; no
  dialogue), and `speech-state.json` face.expressions.lastSpeech now holds the
  emotion label, family, scale, frame count and the peak pose written to the rig
  during that turn. Both are readable after one in-game reply.

Not verified in game: whether .10-.20 reads as natural on Judy's graph (it does
not use the game's authored mood animation, so these offsets are all there is).
If it looks too strong or too weak, only the numbers above change.

## October 5: what Convai actually sends, game-informed ranges, all routes

**Live probe** (`scripts/lipsync/probe_convai_emotion.mjs`, four short turns as
the existing test end user on Alex): every *voiced* turn carried exactly one
`bot-emotion` server message (label + scale, e.g. `Interest`/1), on the pinned
provider's reliable channel, after the reply's LLM text and before the first
audio packet. Neither its inner nor outer envelope has a `response_id`,
`turn_id` or epoch, so the previous receiver rejected **every** live emotion
(`missing-or-invalid-event-owner`); this is why no correlated emotion had ever
been seen. *Text-only* turns (the ones Pocket and Omni voice) carried **no**
emotion at all.

Changes:

- `ConvaiEmotion.acceptOrdered` admits one id-less label per response when it
  arrives on that ordered channel after the response's own audio owner *or*
  its reply text, and before its terminal; a second id-less label makes the
  response ambiguous (no expression). Events with ids keep the strict match.
  The label therefore reaches the face before the first spoken syllable.
- Local voices: `bridge/text-emotion.mjs` derives a cue from the reply's own
  text (small lexicon, negation, intensity); it fires only when one feeling
  clearly dominates and otherwise leaves the face neutral. Ownership is exact
  (it is that reply's text). Same receipt path as Convai.
- Voice-synchronous upper face: the game's dialogue lipsync animates brows
  with the voice (raise in/out together: speech mean .10, p95 .44; lower: p95
  .16). The game-trained model learns brow raise/lower from audio and
  timelines carry them (`modelExpressions`, `jali-upper-v1`, same frame times
  as the mouth). On held-out game lines audio predicts brow raises only loosely
  (r .29; lowering r .13), so the single writer uses raises at 35 % (cap .20),
  ignores predicted lowering, combines by **max** with the smoothed emotional
  pose (never summed), and reduces raises in anger/disgust. Mouth expression still
  yields to lip contact and rounding after smoothing; visemes keep the mouth.
- Ranges now follow the game more closely: corner up .12 (game dialogue holds
  ~.10), corner down .10, brows .20; speech keeps 60 % of mouth emotion (was 30 %).

What the native rig/animation system offers: the 414-track face rig has the
full expression set (corners, brows, squints, sneer, cheeks), all reachable
through our 50-control feature for corners and brows. The game also has an
authored crowd mood layer, `AnimFeature_FacialReaction {category, idle}`
(e.g. 3/5 joy, 3/3 sad, 3/1 aggressive, 3/7 disgust, 3/8 surprise, 3/10 fear,
1/3 curiosity, 2/2 neutral; `reactionComponent.script`). It is consumed by
`man_average_sermo`/`woman_average_sermo` but **not** by
`player_woman_photomode_sermo` (Judy's graph), is tied to crowd look-at
reactions and graph states, and would change base mouth tracks under the
lipsync; it is documented here but not used.

Verification: CPU/fixture tests cover ordered admission (before owner, after
text, duplicate, after terminal), text cues, local routing, the brow curve
through the real Lua writer, misaligned curves and caps. Rendered strength on
Judy/Johnny remains the in-game check.

## Product behavior and current scope

Managed companions should have a small relaxed smile at rest by default.
Explicit Convai emotional intent may change that expression. Anger, sadness,
fear and disgust suppress the friendly smile; unfamiliar labels use a neutral
expression. The user requested this as default behavior, with no extra toggle.

`bridge/companion-expressions.mjs` defines the pure policy. The same bounded
policy now runs in the single native writer in `mod/facial-playback.lua`.
`speech.update(delta, expressionContext)` brackets the existing speech update
with a gameplay expression clock and the idle-copy pass. The context supplies
current actor rows, pause/block state and any thinking/listening entity; these
actor rows are consumed immediately and never retained by the face coordinator.
No new redscript or facial archive is required. The expression strengths below
are conservative starting values, not visually qualified calibration results.
The integration's CPU tests make no game, GPU or Convai request.

## Actual Convai surface

The installed package is `@convai/web-sdk` 1.7.0. Its `ConvaiClient` sends emotion
configuration only when `enableEmotion: true`; the realtime client now supplies that option.
The documented `emotionChange` body is `{emotion: string, scale?: number}` or
`null` on reset. Scale is an integer from 1 to 3. Documentation places the event
after each character turn. Supported detection providers are `llm` and `nrclex`;
the latter uses word-level lexicon matching. The connection configuration uses
the default contextual `llm` provider. These are response metadata, not an
audio-time expression curve. [Official emotion guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/emotions).

`updateEmotion()` / `stateOfMind` are outgoing generation-mood controls. Forcing
them to “happy” would change conversation generation rather than merely add a
resting face. They are not part of this rendering feature. The installed source
also confirms that the SDK's convenient `emotionChange` callback retains only
the label and scale; it drops the original transport envelope. See
`node_modules/@convai/web-sdk/dist/core/MessageHandler.js` and
`dist/core/ConvaiClient.js`.

`bridge/convai-emotion.mjs` validates the original reliable `bot-emotion` frame
from the pinned current provider participant. The realtime client returns an
optional `expressionSignal` only after response correlation. Enabling the
connection option is not proof that a particular server response contains a
correctly correlated emotion. The diagnostics expose admitted/skipped counts
and ownership booleans, without dialogue, labels or remote identifiers.

### Ownership and arrival timing

An emotion callback must not be stamped with whichever request happens to be
active when it arrives. A late label could otherwise cross a cancelled turn,
a reused connection or two copies of the same character.

The transport adapter establishes the verified connection, remote participant
and response correlation. Convai voice uses the existing accepted audio owner;
TTS-disabled Omni generation needs an explicitly owned raw `bot-llm-started`
event. The emotion's response/turn owner must match, including any shared epoch.
Conflicting text response owners make the optional signal ambiguous. Retired
owners, missing/foreign participants and unreliable packets cannot acquire a
new expression lease. Only then does `ownedExpressionReceipt` bind the existing
game `entity`, `requestId` and `generation`. Uncorrelated events are skipped;
SDK `state.emotion` and `emotionChange` never establish ownership. The documented
body alone lacks response identity. Actual server payload qualification remains
a live verification task.

`OwnedExpressionSignal` accepts only an already correlated game owner and an
increasing producer sequence. It rejects missing owners, another copy, stale
generations, duplicates and events after audible completion. Cancellation,
despawn, save/load and connection retirement call `clear()`. Normal completion
may retain a known positive expression for four gameplay seconds or a negative
one for eight, then discard it. A post-speech clock earlier than completion
also discards it. Beginning
a new turn clears the previous turn's intent. The caller supplies a monotonic
gameplay clock that stops while paused; this module has no timers or global
actor registry.

Emotion is optional. Audio/text playback must neither wait for detection nor
fail when metadata is absent, late, unknown or malformed. If a label arrives
while already generated audio is still draining, the actor may show a short
reaction then. The documented API cannot promise the appropriate label at the
start of every spoken sentence.

## Available facial channels

Convai's SDK supplies ARKit61 and MetaHuman251 streams. The mod already validates
and uses the provider's timed custom ARKit61 layout. The order is taken from
the installed `dist/lipsync-helpers/arkitOrder61.js`, not guessed from array
length. [Official SDK overview](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk).

Relevant custom-order channels are:

| Provider signal | Indices | Proposed treatment |
| --- | --- | --- |
| MouthSmile left/right | 23 / 24 | Extra positive intent only with an explicit positive label; these also occur in “ee” speech shapes |
| MouthFrown left/right | 25 / 26 | Small direct corner-down physical pose; not independent proof of the dialogue's semantic emotion |
| BrowDown left/right | 41 / 42 | Small bounded brow-lowering delta |
| BrowInnerUp | 43 | Small symmetric inner-brow delta |
| BrowOuterUp left/right | 44 / 45 | Small independent outer-brow deltas |
| Blinks, eye directions, head/eye rotations | 0–13 / 52–60 | Excluded; native blinking and accepted gaze retain ownership |

No additional model is required. Omni's acoustic mouth cues do not themselves
supply these provider expression curves, but the optional Convai emotion
metadata can still guide the same expression targets. A missing expression
curve uses bounded presets; it does not trigger sentiment analysis, GPU work,
synthetic dialogue or another request.

## Native rig and single-writer integration

`assets/facial/controls.json`, generated `FaceFeature.reds`, and the installed
facial graph already contain ten suitable tracks:

- `lips_l/r_corner_up` and `lips_l/r_corner_dn`;
- `eye_l/r_brows_raise_in`, `eye_l/r_brows_raise_out`, `eye_l/r_brows_lower`.

These tracks are disjoint from the accepted speech track list. The generated
graph adds feature deltas before the native Sermo solver. Zero deltas preserve
the existing native animation. `ConvaiFaceApply` already checks readiness and
the managed-copy tag. Supported graphs/rigs need no new archive or redscript
for these controls; unsupported rigs should keep their native face.

The important constraint is `mod/facial-playback.lua`: it applies a **whole**
`ConvaiFaceFeature`, and `ConvaiFaceReset()` zeroes the whole feature. A second
independent resting-smile writer would erase speech tracks; a speech reset
would erase the smile. Appending another `ConvaiFaceApply` call is insufficient.

The implemented coordinator uses one final writer per actor:

1. Maintain expression metadata/smoothing state for each owned companion copy,
   using primitive owner data rather than retained world handles.
2. Leave the accepted speech timeline, interpolation and device clock intact.
   On a current speaker tick, use its existing interpolated speech feature.
   At rest, use zero speech deltas.
3. Obtain the expression-only target from a known label and, when available,
   the corresponding already validated timed ARKit61 pose. Start with the small
   default rest smile when no intent is known.
4. Smooth expression deltas with gameplay time. Then reapply mouth conflict
   budgets and negative-intent suppression **after** smoothing.
5. Write the ten expression fields into that same feature and call
   `ConvaiFaceApply` once. All speech field values remain exactly unchanged.
6. Route speech stop/reset through the coordinator. It either resumes the
   actor's bounded idle expression or clears the feature during teardown.

The coordinator yields to combat, injury status tags, scripted/native facial
ownership and unsupported/invalid actors. A blocked context produces zero
expression deltas immediately; it must not decay a previous smile through a
fight or let a stale actor acquire a new face. Native callbacks should merely
queue primitive state. Feature allocation/application belongs in the existing
top-level update path, avoiding the previously observed small native callback
allocation budget. The optional context is:

```lua
speech.update(delta, {
    actors = currentOwnedCandidates, -- {entity=string, npc=currentHandle}
    paused = not worldReady,
    blocked = unsafeGlobalContext,
    thinkingEntity = pendingEntity,
    thinkingRequestId = pendingRequestId,
    listeningEntity = recordingEntity,
})
```

`facial-timeline.mjs` preserves all existing speech weights and timestamps.
Validated provider samples add a separate `arkit61-expression9` companion curve
using the exact same frame times. The Lua adapter rejects malformed optional
curves without rejecting speech. It interpolates those nine source channels at
the existing heard cursor and writes only the ten owned expression controls.
Native Omni phrases carry their original Convai receipt through `SpeechStream`;
continuous Convai state can publish a later receipt even when the audio/facial
source is already complete. Neither route waits for emotion.

## Pure helper contract

| API | Responsibility |
| --- | --- |
| `normalizeConvaiEmotion(body)` | Validate bounded labels and categorical scale; unfamiliar labels remain explicitly unknown |
| `OwnedExpressionSignal` | Exact per-copy request/generation admission, sequence ordering, cancellation and bounded post-speech intent |
| `emotionSuppressesSmile(body)` | Suppress a previous smile for negative or unfamiliar intent |
| `expressionTarget(options)` | Build a complete ten-track pose, including optional physical provider deltas and phoneme conflict budgets |
| `ExpressionSmoother.update(target, delta, options)` | Pause-aware, frame-rate-independent approach/release without native handles |
| `composeExpressionPose(speech, expression, options)` | Immutable final pose; reapply hard mouth budgets after smoothing and preserve every other field exactly |

Initial rest smile is `.025` on each corner-up control. Positive expression
corner-up is capped at `.09`, corner-down at `.08`, and brow deltas at `.10`.
Speaking reduces additional mouth emotion to 30%; native lip contact and
rounding further suppress it. A pressed P/B/M or fully rounded O/U reduces
additional mouth corners to zero, including a previously smoothed smile.
Jaw opening, independent lip lift/contact, tongue controls, blinks and gaze
are never changed by this policy.

An unfamiliar valid label suppresses the smile rather than defaulting to joy.
Alias families are local rendering choices for explicit provider labels, not
a claim that Convai guarantees a fixed emotion catalog. The helper never
classifies user/character text. Malformed or ambiguous facial formats produce
no expression authority. New numeric gains require rendered qualification;
they must not be presented as accepted Cyberpunk calibration.

## Dawnwalker reference and verification

The reviewed Dawnwalker 0.5.5 code provides a useful ownership principle:
its engagement layer transfers its idle face lease to conversation ownership
and restores it on release. Its resting smile uses Unreal/JALI-specific
corner pull/up, dimples and cheek raising, and its ambient upper-face loop
supplies blinking. Those weights and blink behavior cannot be copied into
Cyberpunk's native Sermo controls. This feature keeps Cyberpunk's working
native blinking and eye contact.

`node --test bridge/companion-expressions.test.mjs` covers
actual native-schema track availability, accepted speech-field immutability,
strict categorical intensity, unfamiliar labels, negative transitions, timed
provider-only channels, malformed formats, closures/rounding after smoothing,
blocked contexts, paused and 10/30/60 FPS clocks, copy/generation/sequence
ownership, cancellation and post-speech expiry. These are CPU contract tests,
not evidence of a natural rendered smile or observed backend emotion delivery.

`companion-expression-playback.test.mjs` executes the real speech and facial Lua
adapters to verify one writer, separate copies, pause, teardown, exact speech
weights, optional curve rejection, negative suppression and native context
yielding. Realtime and stream tests verify transport qualification, retired
owners, unchanged PCM and timing, late metadata during audio drain, and Omni
phrase continuity. Rendered corner/brow strength and real backend emotion
envelopes still need a live check. No lip-sync, blink or eye-contact redesign
is part of this integration.

### October 4 source and running-service review

The current running bridge was sampled through its read-only diagnostic command:
four warmed local-TTS connections had no active response and had received no
emotion frames since startup. This is not evidence of working emotion playback.
The retained October 2 capture had four received/skipped emotion frames and zero
accepted frames; its aggregate counters cannot establish why they were skipped.

The receiver now records bounded skip reasons and booleans showing whether the
raw inner/outer envelope supplied response/turn IDs, whether the provider was
pinned, and whether a response owner was established. It stores no IDs, emotion
labels, utterances or raw packets in these diagnostics. This distinguishes an
ownerless event from a late event or a different response without guessing.

There is still a local-TTS lifecycle limitation: text collection retires its
Convai response before Pocket/Omni finishes local playback. An emotion arriving
after collection cannot currently update that reply. The pinned SDK's public
emotion body provides only a label and optional scale, and the reviewed
Dawnwalker engagement code establishes facial-layer ownership rather than a
backend response-correlation contract. Extending the local playback lease must
therefore use observed, matching raw response identity; borrowing whichever
request is active would be unsafe. No facial gains or speech timing were changed
by this review, and no sentiment-classification fallback was added.
