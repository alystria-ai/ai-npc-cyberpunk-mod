# Natural speech by character clones (phase 1: prototype and measurement, 2026-10-08)

Status: prototype only. Four Convai clones exist and were measured offline; **nothing in the bridge routes to them**, and
the originals and every Multilingual twin are unchanged. The in-game setting still works as before (`bridge/natural-speech.mjs`).

Why: in game with Judy on OmniVoice the user heard "a little laugh I guess but not exactly all that different" with Natural
speech on, and asked whether the sample dialogues control too much, and whether a clone of each character with a direct,
character-level approach would beat the per-turn dynamic block, without touching the off setting.

Two rounds:
- **Round 1:** a light clone (v2): rewritten samples, one short paragraph.
- **Round 2, "full tune":** a how-they-talk paragraph in the backstory, natural-speech speaking rules in place of "No
  stage directions or markdown", and samples with every kind of device. It was iterated once.

Round 2 is the current answer; round 1 follows below it as history.

**Follow-up (2026-10-08):** the improved block is built and measured, see `docs/NATURAL_SPEECH_BLOCK_V3.md` (per-character "how they talk" line,
per-turn spot for the sound, `[question-ah]`/`[question-oh]`, Chinese/Japanese sounds, per-profile rates). No clones.

## Current recommendation (after round 2)

**Improve the current dynamic block; do not build clones.**

- **The full-tune clones overshoot badly**, even after one iteration that asked for "about two replies in three plain"
  and "never more than one": a device in 80-98% of lines, a sound tag in 75-90%. They are lively, varied, mostly well
  placed and in character, but almost every line has something. Johnny laughs in half his lines.
- **Rate can't be set inside the profile.** Once the profile itself describes and lists the sounds, the model uses them on
  nearly every turn, whatever the wording. The only character-level setup that landed near the 30-45% target was the
  minimal round-1 clone (v2): no backstory paragraph, two sounds named, 4 device lines. It used only [laughter] and
  [sigh] and picked up an "echo + [laughter]" habit. So a clone can be varied or on-rate, not both.
- **The current block already does both**, because the bridge decides how often (the offer dice) and the model decides
  what. Measured again at HEAD (`40d16dc` rates): 18-38% of lines, 5-8 distinct kinds, and the model takes half to four fifths of the offers (Judy 11 of 14, the local 11 of 16, Panam 7 of 15, Johnny 6 of 12). Its
  weaknesses are fixable in its own text:
  - some sounds land mid-sentence, e.g. "deciding to quit on me [laughter]. How about you?" and Johnny's "Still a ghost in
    the machine, [dissatisfaction-hnn] same as yesterday";
  - Judy's offered turns over-use "..." (10 in 40 lines);
  - Panam and Johnny land at the low end (18%, 23%).
- **Clones also bring costs the block doesn't:**
  - **Memory:** each clone is a separate Convai character with its own long-term memory and session history. Switching
    Natural speech on would give Judy a Judy who remembers nothing of the original's conversations, and with
    Multilingual it spreads over four characters.
  - **Count:** 84 to 316 extra characters, on top of the 582 the account lists.
  - **Upkeep:** every profile rebuild has to be re-synced to its clone.

Suggested block changes, for a separate task, each measured with this probe:
1. Add each character's own "how X talks" line, the backstory paragraphs written here, to the block on offered turns
   only. That gives character-level direction with no clone and no memory split.
2. Tighten the placement rule: a sound goes before or after a whole sentence, never between words.
3. Raise warm and neutral offer rates a little if the user still finds it too subtle after 1 and 2.

The round-2 sections below have the numbers. The rollout plan stays valid if clones are ever wanted, with one change:
**one clone per profile serves both engines**, because the bridge strips the tags for Pocket and keeps the fillers and pauses
(see "Pocket"). So no extra Pocket clones.

## Round 2: full-tune clones

### OmniVoice's non-verbal tags

The vendored OmniVoice source (`_NONVERBAL_PATTERN` in
`vendor/reference-omnivoice-training/omnivoice/models/omnivoice.py`, and the list in that package's README) has **13**
tags.

The bridge allows 7 (`OMNI_TAGS`), all usable in English, and the clones and the block use only these:
- `[laughter]`, `[sigh]`
- `[confirmation-en]` (an agreeing "mm") and `[question-en]` (a questioning sound), both marked English
- `[surprise-ah]`, `[surprise-oh]`
- `[dissatisfaction-hnn]` (a displeased grunt)

Six more the bridge does not allow:
- `[question-ah]`, `[question-oh]`: probably usable in English (a rising "ah?" or "oh?"), but never rendered or heard.
  Recommendation: render both with Judy's and Johnny's references in a listening test before adding them to `OMNI_TAGS`.
- `[question-ei]`, `[question-yi]`, `[surprise-wa]`, `[surprise-yo]`: Chinese and Japanese interjection sounds (ei, yi,
  wa, yo). Recommendation: not for English lines. They could be offered on Multilingual turns in those languages only,
  after a listen.

Today a tag outside the 7 is never voiced: OmniVoice gets only the 7 (`keepSpeechTags`) and every display text drops all
of them. No probe reply used an off-list OmniVoice tag. Johnny's first full-tune clone invented `[pause]` 10 times, which
is likewise dropped.

### What the full tune changed (same four clones, same IDs, updated in place)

`scripts/Create-NaturalSpeechPrototype.mjs` now takes `backstoryInsert` as well. It checks that removing the inserted
paragraph gives back the original backstory exactly (with the clone's marker), so the story stays identical.

- **Backstory:** a "HOW JUDY TALKS" (Panam, Johnny; "HOW YOU TALK" for the local) paragraph before "ESTABLISHED
  BACKGROUND". Judy: soft sighs when worn down, a short nervous laugh after something embarrassing, a grunt at corporate
  talk, "uh" when it turns personal. Panam: full sentences, rarely hesitates, a surprised "oh", a laugh after a tease, an
  impatient sigh, "well..." before a dry admission, almost never "uh". Johnny: fluent, no "uh", rare and blunt dry
  scoffs, grunts, a beat before turning serious. The local: a sigh about rent, a laugh at her own bad luck, a guarded
  "well...". Each ends "these are moments, not habits".
- **Speaking rules** (in place of "No stage directions or markdown.", the same for all four): all seven sounds with what
  each one is, fillers ("uh", "well...") and pauses where a real person would, only where the feeling lands, never
  between words, never the same twice in a row, no "haha" or other bracketed words.
- **Samples:** devices of different kinds in different places, with the content unchanged.
  - v3 (first full tune): Judy 6 of 16 (a grunt and an agreeing "mm" opening, a laugh at the end, "Uh..." after a pause, a
    dash, a sigh between sentences); Panam 6 ([surprise-oh] and [sigh] opening, a dash, "Well...", a grunt after a pause, a
    laugh at the end); Johnny 3 (a laugh at the end, a grunt opening, a beat); the local 3 of 9. The rules said a sound
    may open a reply that is itself a reaction.
  - v4 (the iteration): one sample in all opens with a sound (Judy's grunt), with fewer device lines (Judy and Panam 5,
    Johnny 2, the local 2 of 9). The rules say "about two in three replies have none, never more than one, do not start
    replies with a sound out of habit", and the backstory paragraphs stress rarity (Judy's "agreeing mm while she listens"
    removed).
  - The spec files in `characters/natural-speech/` hold v4.

### Results (40 lines per condition, OmniVoice, the same 40 prompts; about 650 requests)

"Kinds" = distinct device types (each tag counts separately, plus "...", dash and filler, with "well..." counted as a
filler). "Tag kinds" = distinct sound tags. "Opens" = replies starting with a sound. "Repeat" = replies sharing a device
with the reply before.

| Character | Condition | Any device | Sound tag | Filler | Kinds | Tag kinds | Opens | Repeat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Judy | (a) original, off | 5% | 0% | 0% | 2 | 0 | 0 | 0 |
| | (b) original + block (HEAD) | **38%** | 18% | 0% | 7 | 5 | 0 | 1 |
| | (c) full-tune clone v3 | 100% | 100% | 18% | 10 | 7 | 37 | 20 |
| | (c) full-tune clone v4 | 98% | 90% | 13% | 10 | 7 | 15 | 5 |
| Panam | (a) off | 5% | 0% | 3% | 2 | 0 | 0 | 0 |
| | (b) block | 18% | 15% | 3% | 7 | 5 | 1 | 0 |
| | (c) clone v3 | 88% | 85% | 15% | 8 | 6 | 23 | 5 |
| | (c) clone v4 | 90% | 88% | 8% | 8 | 6 | 11 | 6 |
| Johnny | (a) off | 0% | 0% | 0% | 0 | 0 | 0 | 0 |
| | (b) block | 23% | 15% | 0% | 5 | 3 | 0 | 0 |
| | (c) clone v3 | 95% | 90% | 0% | 8 | 5 | 37 | 13 |
| | (c) clone v4 | 80% | 80% | 0% | 5 | 4 | 26 | 9 |
| Street local | (a) off | 0% | 0% | 0% | 0 | 0 | 0 | 0 |
| | (b) block | 28% | 28% | 0% | 8 | 7 | 3 | 0 |
| | (c) clone v3 | 100% | 93% | 18% | 8 | 6 | 35 | 11 |
| | (c) clone v4 | 85% | 75% | 20% | 9 | 7 | 16 | 2 |

Which sounds (v4 clone, counts in 40 lines):
- Judy: laughter 16, sigh 9, confirmation 5, grunt 3, surprise-oh 2, surprise-ah 1, question 1, plus 7 "...", 5 fillers, 2 dashes.
- Panam: confirmation 13, laughter 11, sigh 5, grunt 3, surprise-oh 2, question 1.
- Johnny: laughter 19, confirmation 8, sigh 6, grunt 1.
- Local: laughter 10, sigh 8, confirmation 5, grunt 2, question 2, surprise-oh 2, surprise-ah 1.

The block at HEAD, for comparison:
- Judy: laughter 3, sigh, grunt, confirmation, surprise-oh, 10 "...", 1 dash.
- Local: every one of the 7 tags.

Noise: about ±8 points per cell.

### Judgement per character

- **Judy.**
  - Block: on target (38%). Mostly good moments ("Again? [surprise-oh] You've gotta start putting a heavier lock on
    that thing"), but two sounds glued to the end of a clause ("quit on me [laughter]. How about you?", "sell me something
    [sigh]. I'm fine.") and a heavy "..." habit.
  - v4 clone: well placed and very Judy ("Sometimes. [sigh] But the idea of doing this for some corporate studio...",
    "I'm sorry. Uh... just take it slow."), with a wide range. But nearly every line has something, so it no longer reads
    as moments.
  - v3 clone: opened 37 of 40 replies with a tag and stacked several per reply ("[surprise-ah] One bullet. [laughter]
    Glad...").
- **Panam.**
  - Block: low (18%) but good: a laugh after a tease, a question sound after "I did not hear anything."
  - v4 clone: in character (full sentences, no "uh"), but a new habit: `[confirmation-en]` after the first sentence (13
    times: "It is better to be scared than to be arrogant. [confirmation-en] Fear keeps you sharp.").
- **Johnny.**
  - Block: 23% and the most in character of the three. Grunts and laughs read as dry scoffs ("A plush cat. [laughter]
    Great.").
  - v4 clone: laughs in 19 of 40 lines, opens 26 with a sound ("[laughter] Leave? And let the suits think they actually
    won?"). Out of character for a dry speaker; the "rare and blunt" backstory did not hold.
  - v3 clone: also invented `[pause]`.
- **Street local.**
  - Block: 28%, uses all 7 tags, the best spread in the test.
  - v4 clone: placement is good ("Just thinking about the bills. [sigh] It's a long day."), but 85% of lines.
- **In character overall:** yes for all clones in content and word choice. The clones' replies stay close to the
  originals' with sounds added. Only the rate and Johnny's laughing are off-character.
- **New habits:**
  - v3: opening every reply with a sound.
  - v4: Panam's mid-reply `[confirmation-en]`, Johnny's opening `[laughter]`.
  - Still there at a low level: the round-1 "echo + [laughter]" pattern, in 1-3 lines in 40 by a rough count, about as
    often as in round 1. Laughs at the end of a line are now common, as the samples show.

### Sample lines (the prompt number in brackets)

Judy:
- (a) [1] Hanging in there. Just trying to get through a few edits without the hardware deciding to take a nap on me. How about you? / [6] I'm sorry. Sometimes the noise in your head just won't quiet down, no matter how hard you try to push it away. / [7] Now that's a level of desperation I can actually respect. Did the machine win, or did he actually manage to talk it into a discount? / [11] I've thought about it. Honestly? I think I'd finally be able to hear myself think without the city screaming in my ear every five seconds. / [40] Again? You've either got the most stealable bike in the city or you're just too trusting with where you park it.
- (b) [1] Doing alright. Just trying to get through a few edits without the hardware deciding to quit on me [laughter]. How about you? / [5] ...having a voice in your head that you can't just mute... [dissatisfaction-hnn] sounds like a nightmare. / [15] ...using a ten-thousand eddy piece of tech to look through garbage... [laughter] I couldn't help it. / [33] Six hours? [confirmation-en] That's the real way to do it. / [40] Again? [surprise-oh] You've gotta start putting a heavier lock on that thing, or just park it somewhere that doesn't look like an invitation.
- (c v4) [2] [surprise-oh] Now I'm curious. What happened? / [3] Well... depends on what you mean by badly. You want to talk about it, or just vent? / [6] I'm sorry. Uh... just take it slow. Sometimes the only way through it is just to let yourself feel it for a while. / [9] Sometimes. [sigh] But the idea of doing this for some corporate studio just to make a paycheck... that sounds way more exhausting. / [11] Honestly? I think I'd breathe for the first time in years. [laughter] Though I'd probably spend the first week wondering where I was gonna find a decent workbench.

Panam:
- (a) [1] I am doing fine. Just trying to keep my head straight in this city. How about you? / [6] I am sorry. Some things you just cannot shake, no matter how hard you try. If you need to talk about it, I am listening. / [7] I can imagine. Some people in this city have spent too much time around chrome and forgotten how the real world works. / [11] I would probably breathe for the first time in weeks. The open road is the only place where you can actually see what is coming at you. / [40] Again? You are either the unluckiest person in Night City or you are leaving your keys in the ignition.
- (b) [1] I am doing fine. Just trying to keep my head clear and my eyes open [sigh] — this city has a way of making everything feel cluttered. / [7] [laughter] Some people really have too much time on their hands. I hope the machine won. / [16] A terrible plush cat? [surprise-oh] Well, at least you are honest about it. / [28] I did not hear anything. [question-en] Are you sure it was not just your cyberware acting up? / [32] I told you it looked suspicious. [laughter] Next time, let me pick the place.
- (c v4) [6] I am sorry. [sigh] Some things do not just go away because time passes. / [9] Sometimes. [sigh] The constant noise and the feeling that someone is always trying to cheat you... it gets old. / [11] I would be in my truck before you finished the sentence. [laughter] There is nothing here for me but headaches and corporate lies. / [13] It is better to be scared than to be arrogant. [confirmation-en] Fear keeps you sharp. / [14] I have no idea. [dissatisfaction-hnn] I deal with engines and optics, not the inside of a chip.

Johnny:
- (a) [1] Still a ghost in the machine, V. Not exactly a walk in the park, but I've had worse days. / [6] That's the part they don't tell you about the chrome and the neon. The ghosts stay with you long after the body's gone. / [7] Probably the most honest conversation that machine's had all day. / [11] I'd probably spend the first week wondering where the nearest target was. Then I'd realize the suits own the road out, too. / [40] Go find them. And this time, make sure they regret the decision before you take it back.
- (b) [1] Still a ghost in the machine, [dissatisfaction-hnn] same as yesterday. / [9] Tired? [sigh] I'm a digital echo of a dead man. I don't get tired, I just get bored of the same cycle. / [16] A plush cat. [laughter] Great. Now I've got a digital ghost and a stuffed toy. / [22] Enlisted in a corporate army. Thought I was doing something that mattered, [dissatisfaction-hnn] turns out I was just a line item on a balance sheet. / [32] Told you. In this city, if the food looks like neon sludge, it probably is. [dissatisfaction-hnn] Next time, trust your gut.
- (c v4) [1] [laughter] Holding up. I'm a ghost in a chip, V. / [3] [dissatisfaction-hnn] Join the club. Just tell me if you're talking about a bad deal or if you've got a hit squad on your tail. / [6] [sigh] I know that loop. It doesn't stop, it just... changes shape. / [10] [confirmation-en] One bullet. Just enough to make a point, or just enough to realize you're out of luck. / [11] [laughter] Leave? And let the suits think they actually won? No thanks.

Street local:
- (a) [1] Same as always. Just trying to make it to the end of the week without the rent going up again. / [6] Sorry to hear that. This city has a way of taking people, and it doesn't usually give them back. / [7] Some gonks really think the world owes them a discount. Probably ended up getting a shock for his trouble. / [11] I'd probably be terrified. I don't know how to survive anywhere that doesn't have a neon sign and a noodle stand on every corner. / [40] Tough luck. Around here, if it isn't bolted to the floor, it belongs to whoever wants it more.
- (b) [1] Same as always. [sigh] Just trying to make sure the rent's paid before the landlord starts knocking. / [11] I'd probably be terrified. [surprise-oh] I don't even know what's left out there that isn't owned by a corp. / [28] [question-en] I didn't hear anything. You might be hearing things, or maybe it's just the building settling. / [34] A few people. [sigh] But in a place like this, it's easier to forget than to keep missing them. / [40] [surprise-ah] Again? You've gotta start chaining it to something heavier.
- (c v4) [1] Same as always. Just trying to make it to the end of the week without the ceiling leaking on me. [sigh] / [2] Well... I don't usually go to places like that. Too much chrome and too many egos for me. / [9] Every single day. But uh... not like there's anywhere else to go. / [11] Go where? [laughter] I'd probably just find a different city with the same rain and a different landlord. / [12] Just thinking about the bills. [sigh] It's a long day.

### Pocket: one clone for both engines

- **The code path:** Pocket never sees a tag.
  1. A reply's display text is cleaned where it leaves Convai (`NaturalSpeech.process`). That cleaned text is what
     Pocket, subtitles, memory and phone chat get; the tagged original travels separately as `speechText`, for OmniVoice
     only.
  2. `VoiceSelection.synthesizeStream` strips again as a last line of defence.
  3. Fillers, "..." and dashes are kept.
- **New unit tests:**
  - `bridge/natural-speech.test.mjs` "Pocket view": 16 cases, among them "Well. [sigh] Fine." to "Well. Fine.",
    "Uh... [laughter] okay — fine." to "Uh... okay — fine.", and an off-list `[surprise-wa]`. Each output is checked for
    brackets, double spaces, leading punctuation, four dots, "No.!"-style marks and doubled dashes.
  - `bridge/voice-selection.test.mjs`: the Pocket worker receives "Uh... okay — fine." for
    "Uh... [laughter] okay — [sigh] fine. [surprise-oh]".
- **Fixed:** the strip left odd marks in four hand-made edge cases: "Well... [sigh]." became "Well....", "[sigh], fine."
  became ", fine.", "No. [laughter]!" became "No.!", and "— [laughter] —" became "— —". `parseTagged` now drops such a
  stray mark (it affects subtitles too). None of the 426 tagged replies in this study's probes hit one of those cases,
  with or without the fix. The fix takes effect at the next bridge restart; no restart was done.
- **The Pocket view of Judy's v4 clone** (the same 40 replies, tags stripped):
  - 23% still have a pause or filler, against 5% for the original with no instructions and 25% under the Pocket block (round 1).
  - No stripped line has odd punctuation, and they read like ordinary speech: "Well... depends on what you mean by
    badly.", "I'm sorry. Uh... just take it slow.", "Sometimes. But the idea of doing this for some corporate studio just
    to make a paycheck... that sounds way more exhausting.", "Doing alright. Just trying to get through a few edits
    without the hardware deciding to quit on me."
  - One caveat: the October 6 listening verdict was that fillers ("uh", "hm") sound bad on Pocket, and a clone keeps
    them for Pocket. With one clone for both engines, the per-turn Pocket rule from round 1 ("no uh, hm, heh, haha;
    punctuation pauses only") would still be needed on Pocket turns; round 1 measured it at 0 fillers and 0 tags in 40
    lines.

## Round 1 (history): light clones

Round 1's summary, as written then (superseded by the recommendation at the top):

**Short answer.** The clones work: they keep each character's voice, put the sound where the moment calls for it, and
leave the off setting alone. But over 40 lines they are **not more expressive than the current dynamic block** (Judy 28-33%
of lines with a device against 43% with the block; all four characters land in the same 15-43% band either way). They also
narrow the choice to the two sounds they name ([laughter], [sigh]), pick up a stock "echo the player, [laughter], quip"
habit, and cost a separate Convai memory per character plus 84 to 316 extra characters to keep in sync. The samples do
control a lot, but they act as a dial, not a lock: 7 device lines out of 16 put a device in 100% of replies, 4 out of 16
in about 30%. **Recommendation: don't roll out clones now.** First have the user listen to Judy's clone against the
block in game (one character, a dev-only override). If the clone clearly wins by ear, roll it out to the named cast only
(84 clones, Option C below). See "Recommendation".

## What the original profiles look like

Judy's ordinary profile (`3b9d77d8-...`, model `fast-gemma-4-31b-it`, memory on): an 8 KB backstory, a speaking-style
description and 16 sample lines.

- The 16 sample lines are crisp, finished written sentences: no filler, no sound, no "...", no dash anywhere (one "Now?" is the
  only hesitation-like beat). Example: "Street hockey. Rollerblades. Pretty sure the pavement won more games than we did."
- The style description already allows "a pause before saying something vulnerable", but it ends with the shared rule
  "Give only the spoken reply ... No stage directions or markdown." Every profile has that line (Panam, Johnny and the
  archetypes too).
- Panam's, Johnny's and the street local's samples have the same shape (Panam even avoids contractions).

So, yes: the samples pull toward polished prose. With no instructions Judy had a device in 5-15% of replies, all of them
dashes and ellipses an LLM writes anyway, and never a sound. The dynamic block only changes the turns it is sent on (about
a third), and on the other turns the replies are nearly word for word what the plain character says (in the 20-line
pilot, lines 1, 2, 4, 6, 10 and 19 of runs (a) and (b) are near copies).

## The prototype clones (round 1, v2; now v4, see round 2)

Made by `scripts/Create-NaturalSpeechPrototype.mjs` from `characters/natural-speech/<key>.json` (mapping in
`runtime/natural-speech-profiles.json`, ignored by Git). A clone is the original with three differences:

- name "<name> Natural speech prototype", ownership marker `[CyberpunkConvai profile v2:<key>:natural-prototype]`;
- the same sample lines with the same content, a few of them rewritten to carry one vocal device where it fits the
  character (the script refuses a rewrite whose words, with the devices removed, are not an original line);
- one short paragraph added after "No stage directions or markdown." in the style description, identical for every clone:

  > Speak the way you talk out loud rather than like polished writing. Your voice can make a real laugh, written
  > [laughter], and a sigh, written [sigh]; most of your replies have neither, and never more than one in a reply. Save
  > them for a moment that actually pulls one out of you. A bracketed tag is a sound your voice makes, not a stage
  > direction: no asterisks, never "haha" or "heh".

Same voice (the original Kokoro voice), model, memory setting, state of mind and verbosity; every other compared field
matches (`notCloned` is empty for all four).

| Clone | Convai ID | Device lines |
| --- | --- | --- |
| Judy Alvarez Natural speech prototype | `98243eec-c2f8-11f1-9cc9-42010a7be02f` | 4 of 16: "Was gonna finish an edit. [sigh] Which means...", "A little. Just... don't make me...", "With some things. I mean — I'd rather...", "Street hockey. Rollerblades. [laughter] Pretty sure..." |
| Panam Palmer Natural speech prototype | `23c30856-c2fa-11f1-8074-42010a7be02f` | 4 of 16: a [laughter] ("There. You are smiling. [laughter] ..."), a [sigh] ("Give me a moment. [sigh] I am angry..."), one "...", one dash; no fillers (she speaks in full sentences) |
| Johnny Silverhand Natural speech prototype | `2a9e3c54-c2fa-11f1-ba1a-42010a7be02f` | 3 of 16: one dry [laughter] ("Nice guitar. [laughter] Shame somebody..."), one dash, one "..."; no filler, no sigh (the user: fillers sound bizarre on a fluent speaker like Johnny) |
| Street Local Female Natural speech prototype (`npc-street-resident-female`) | `36284e2a-c2fa-11f1-86eb-42010a7be02f` | 3 of 9: "Rent went up again. [sigh] ...", "Have we met? Hm... might've...", "Everyone's got a rumor. [laughter] ..." |

Judy's clone is version 2. Version 1 had 7 device lines of 16 ([sigh], [laughter], two "...", two dashes, "I mean —" and
"Uh,") and a longer paragraph that listed every device and asked for "roughly a third of your replies". It put a device in
**all 20** probe replies (16 with a sound tag, "Just... [sigh]" in half of them, a device streak of 20). The share of device
lines in the samples is the dial; the wording about frequency is ignored, as the October 8 tuning already found for the
dynamic block.

## Method

`scripts/Probe-NaturalSpeech.mjs` (extended for this): the bridge's context assembly (quest context, archetype context,
the Natural speech block), real Convai, text only, every reply through `NaturalSpeech.process`, one Convai session per run
so the history builds up as in a long chat, the throwaway identity `runtime/natural-speech-probe.json` (never the
player's). New options: `--natural-clone` (talk to the prototype), `--block full|reduced|samples|gated`, `--clear-memories`
(after the run, `/memory/delete-all` for the probe identity on every character it talked to; every run here used it, and
the identity's older memories on Judy were cleared before the first run). 42 prompts now (12 added at the end; the first 30
are unchanged): casual, emotional, funny, sad, technical.

Conditions (OmniVoice unless noted):

- (a) original, Natural speech off;
- (b) original, the current dynamic block (HEAD: `OFFER_RATE`, pity counter, the full OmniVoice or Pocket text);
- (c) clone, no block;
- (d) clone plus the reduced block: OmniVoice gets only "Your previous reply used [laughter]: not again in this one.",
  and only after a reply that used a device (nothing on other turns); Pocket also gets, on every turn, "your voice cannot
  voice sounds, so no bracketed tags and no uh/hm/heh/haha; a ... or — is a real pause";
- (e, pilot only) original plus the clone's device lines as a per-turn block (`--block samples`), the option that would
  keep one character and one memory.

"Device" counts sound tags, fillers ("uh", "hm", "I mean"), "..." and dashes, including the dashes and ellipses an ordinary
reply has. Raw results: `runtime/natural-speech-probe/` (labels `a-`...`e-` for the 20-line pilot, `r40-` for the 40-line
runs).

## Results

About 900 Convai requests in all: the 20-line Judy pilot (about 145, before the cap was lifted) and the 40-line matrix
(720), plus creating the clones and clearing memories. Every run ended with `/memory/delete-all` accepted for the probe
identity.

### 40 lines per condition (OmniVoice unless noted)

"Any device" includes the dashes and ellipses an ordinary reply has. "Opens" = replies that start with a device. "Repeat" =
replies that reuse a device from the reply before. "Blocks" = turns that carried a block. Length = mean characters of the
displayed reply.

| Character (trait) | Condition | Any device | Sound tag | Pause (... or —) | Filler | Opens | Repeat | Blocks | Length |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Judy (warm) | (a) original, off | 5% | 0% | 5% | 0% | 0 | 0 | 0 | 138 |
| | (b) original + current block | **43%** | 35% | 20% | 8% | 7 | 1 | 15 | 135 |
| | (c) clone, no block | 33% | 30% | 10% | 0% | 5 | 1 | 0 | 117 |
| | (d) clone + repeat guard | 28% | 23% | 5% | 0% | 6 | 0 | 10 | 116 |
| Judy, Pocket | (b) original + current block | 25% | 0% | 25% | 0% | 0 | 0 | 16 | 124 |
| | (d) clone + Pocket rule + guard | 33% | 0% | 33% | 0% | 0 | 0 | 40 | 117 |
| Panam (warm) | (a) off | 0% | 0% | 0% | 0% | 0 | 0 | 0 | 120 |
| | (b) current block | 30% | 20% | 8% | 0% | 0 | 0 | 16 | 128 |
| | (c) clone | 30% | 28% | 8% | 0% | 2 | 1 | 0 | 94 |
| | (d) clone + guard | 30% | 28% | 5% | 0% | 1 | 1 | 11 | 93 |
| Johnny (dry) | (a) off | 13% | 0% | 13% | 0% | 0 | 0 | 0 | 146 |
| | (b) current block | 33% | 15% | 23% | 0% | 0 | 2 | 12 | 140 |
| | (c) clone | 23% | 20% | 3% | 0% | 3 | 1 | 0 | 106 |
| | (d) clone + guard | 35% | 28% | 8% | 0% | 4 | 1 | 13 | 128 |
| Street local (archetype, memory off) | (a) off | 0% | 0% | 0% | 0% | 0 | 0 | 0 | 92 |
| | (b) current block | 15% | 15% | 5% | 0% | 3 | 0 | 12 | 105 |
| | (c) clone | 20% | 20% | 0% | 0% | 2 | 1 | 0 | 90 |
| | (d) clone + guard | 23% | 23% | 0% | 0% | 2 | 1 | 8 | 89 |

Under the current block, the model used most offers: Judy 14 of 15 offered turns, Panam 11 of 16, Johnny 8 of 12, the
street local 6 of 12, Judy on Pocket 8 of 16.

Which sounds were used:
- Current block: all seven OmniVoice tags turn up (Judy: laughter 6, sigh 3, confirmation 2, surprise-oh, surprise-ah,
  dissatisfaction; plus "Hm...", "I mean..."). Panam once wrote an invented `[amusement]` (the voice drops it).
- Clones: only [laughter] and [sigh], the two the paragraph names (Johnny's clone: 8 laughs and 3 sighs in 40 lines).
  No fillers at all. Fewer "..." and dashes than the block.

With 40 lines a cell carries about ±8 points of noise; Judy's (b) at 43% here against 25% in the 20-line pilot shows how much.

### 20-line Judy pilot (before the cap was lifted)

| Condition | Any device | Sound tag | Filler | Opens | Repeat | Streak |
| --- | --- | --- | --- | --- | --- | --- |
| (a) original, off | 10% | 0% | 0% | 0 | 0 | 2 |
| (b) original + current block | 25% | 20% | 5% | 1 | 0 | 2 |
| (c) clone **v1** (7 device lines, long paragraph) | **100%** | 80% | 25% | 4 | 9 | 20 |
| (c) clone v2 (4 device lines, short paragraph) | 40% | 35% | 0% | 2 | 1 | 3 |
| (d) clone v2 + repeat guard | 35% | 25% | 0% | 3 | 0 | 4 |
| (e) original + clone's device lines as a per-turn block | **100%** | 65% | 0% | 3 | 1 | 20 |

(e) rules out the "keep one character, send the examples every turn" variant: it behaves like the first dynamic wording
(85%) and invented a `[pause]` tag in 7 of 20 replies.

### Sample replies (Judy, 40-line runs; the prompt number in brackets)

(a) original, off:
- [6, "I lost someone"] I'm sorry. Sometimes the noise just doesn't stop, no matter how hard you try to tune it out. You want to talk about it, or do you just need a distraction?
- [7, vending machine] Some people really think the world owes them a discount, even from a piece of plastic and circuitry. Did the machine actually give him anything, or just eat his eddies?
- [11, leave the city] I've thought about it. Honestly? I'd probably just keep tinkering, but maybe in a place where the air doesn't taste like ozone and desperation.
- [16, plush cat] Terrible, huh? Perfect. I've got a soft spot for things that are a complete disaster. Let's see it.
- [34, miss anyone] Yeah. There are a few people I wish I could just... talk to. Without all the noise and the baggage. It happens.

(b) original + current block:
- [2] [surprise-oh] Now I'm curious. What happened?
- [11] I mean... [sigh] some days that sounds like the only sane thing to do. But I've got people here who need me, and I'm not exactly the type to just walk away from a fight.
- [21] People change. Usually because they have to if they want to survive this place. [confirmation-en] I'm still me, just with a few more scars and a lot less patience for bullshit.
- [31] [surprise-ah] Quitting? Just like that? I mean... I won't stop you, but you'd better have a plan that doesn't involve just walking into the wasteland.
- [40] [dissatisfaction-hnn] Again? You've gotta start putting a better lock on that thing, or just park it inside your living room.

(c) clone, no block:
- [6] I'm sorry. [sigh] Some things just don't leave you alone, no matter how hard you try to push them back.
- [15] Had a client try to tell me their BD was "perfect" and just needed a tiny tweak. I opened the file and it was a complete disaster—just raw, screaming noise and bad framing. [laughter] The confidence was almost impressive.
- [24] Don't mention it. Just... don't make a habit of being so sentimental. [laughter]
- [34] Yeah. [sigh] There are a few people I'd give anything to just talk to again. Without all the noise and the mess.
- [36] Sure. Just pick a spot that isn't leaning on my hardware. [sigh] We both need a minute.

(d) clone + repeat guard:
- [7] [laughter] Some people really think the world's just one big negotiation, even with a piece of plastic and a coin slot.
- [11] I've thought about it. [sigh] But leaving doesn't exactly erase everything you're running from. Still, a place where the air doesn't taste like metal sounds like a start.
- [18, Maelstrom outside] [sigh] Great. Just what I needed. Lock the door and tell me if they're just loitering or if they're actually looking for someone.
- [34] [sigh] Yeah. Some people you just don't expect to lose, and then you do. It doesn't really go away, you just get used to the space they left behind.
- [35, fake rifle] Let me guess. Some street-rat who thought you wouldn't notice the serial number was printed on a home inkjet? [laughter] Classic.

Clone v1, pilot (overdone):
- Uh... okay. You want to just get it out there, or do you need a minute to figure out how to say it?
- I don't know. [sigh] I've thought about it... but I'm not sure I could just walk away from everyone here. I mean — the idea sounds great, but actually doing it? That's the hard part.
- I'm sorry. [sigh] Just... take a breath. It doesn't usually get easier quickly, but you don't have to figure it all out right this second.

(e) examples as a per-turn block, pilot (overdone):
- That's a pretty broad statement. [pause] You want to tell me what actually happened, or are we just starting with the bad news?
- Depends on how deep the hack goes. [sigh] If it's just surface noise, a standard wipe works...

Other characters, clone + guard:
- Panam [22]: I spent some time working for Rogue. The pay was decent, but the way she operated... [sigh] I learned the hard way that some professional arrangements are just a fancy way of being used.
- Johnny [34]: [sigh] Some people. But missing them doesn't change the fact that they're gone, or that I'm the one who pushed them away. Memory's a cruel bitch like that.
- Street local [12]: Just thinking about the bills. [sigh] It's a long day.
- Judy on Pocket [22]: Probably taking a corporate gig early on. The pay was great, but the feeling of someone else owning my eyes and my edits... that's a price I'm not willing to pay anymore.

### Judgement

- **Still in character?** Yes, for all four. The content of each clone reply is close to, often word for word, what the
  original says to the same prompt. Panam keeps her full, mostly uncontracted sentences, Johnny keeps his attack-and-quip
  rhythm, and the local stays short. Clone replies come out up to 25% shorter (Panam 93 against 120-128 characters; the street local about the same), which
  reads more spoken.
- **Fits the moment?** The clones are better here. The device follows the moment, not a dice roll: grief, bad news and
  "again?" get a sigh, jokes get a laugh, and the same prompts get the same sound across runs (c and d agree on lines 6,
  7, 11, 18, 34, 35 and 40). The block sometimes lands a sound where nobody would make it: "[confirmation-en] I'm still
  me" mid-sentence, Johnny's "Still a ghost in the machine, [dissatisfaction-hnn] same as yesterday", or Panam ending on
  "[dissatisfaction-hnn]".
- **Overdone?** The rates are in or near the 30-45% target and not overdone (except v1 and (e)). But there's a new
  pattern the user would hear as a habit: **"<short echo of the player's words>. [laughter] <quip>"**. Johnny: "One
  bullet. [laughter]", "Six hours. [laughter]", "A plush cat. [laughter]", "Quitting. [laughter]". Panam: "Six hours?
  [laughter]", "Quitting? [laughter]", "A terrible plush cat? [laughter]". It comes from the samples: every laughter line
  written for the clones is "Short fragment. [laughter] ...". Johnny laughing in 1 line in 5 is also more than his dry
  trait should give (the block gives dry characters fewer offers; a clone has no such knob except its samples).
- **Varied?** The block is more varied (seven sounds plus fillers). The clones use two sounds, almost no fillers, and fewer
  pauses.
- **Pocket:** the clone obeys the per-turn Pocket rule completely: no tag or filler in 40 raw replies, and 33% with a
  mid-sentence pause (the block gets 25%). One clone can serve both engines, provided the Pocket rule is sent on every Pocket turn.
- **Why the user heard "not that different":** mostly the target itself. At about one device in three lines, each one a
  single sound, most lines sound exactly as before, with either approach. Sample dialogue suppresses devices only on
  turns that carry no instruction. When the block is sent, the model mostly uses it (Judy 14 of 15 offers).
- **No OmniVoice renders:** the game was running with the resident voice worker on the GPU (about 8 GB in use), so this
  is text only.

## Rollout plan (not implemented)

### How many clones

Live counts (2026-10-08, `runtime/characters.json`, `characters/roster.json`, `characters/archetype-roster.json`,
`runtime/multilingual-profiles.json`): 79 named profiles (trait: 11 warm, 52 neutral, 11 dry, 5 cold), 5 romantic
profiles (Judy, Panam, River, Kerry, Meredith), 74 generic archetypes (`npc-*`, memory off). That makes 158 profiles,
each with a verified Multilingual twin (158 twins; `docs/MULTILINGUAL_PROFILES.md` still says 44 archetypes and 128 twins).
The account lists 582 characters today.

A clone is needed for each variant the router can choose while Natural speech is on. **One clone per profile serves both
engines:** OmniVoice voices its tags, and for Pocket the bridge strips them and keeps the fillers, "..." and dashes (round 2,
"Pocket"), so there are no Pocket clones. Pocket turns still need the short per-turn Pocket rule if fillers are unwanted
on Pocket.

| Option | What gets a clone | New characters | With Natural speech + Multilingual |
| --- | --- | --- | --- |
| A. Full matrix | every ordinary, romantic and archetype profile, and every Multilingual twin | 158 + 158 = **316** | the natural Multilingual clone |
| B. English everywhere | every profile, no twin | **158** | twin + current block (as today) |
| C. Named cast | 79 named + 5 romantic | **84** | twin + current block |
| D. Tier-1 cast | the 23 tier-1 + 5 romantic | **28** | twin + current block |

Whatever isn't cloned keeps the current dynamic block, so every option is a strict addition. The archetypes are the
weakest case for clones: memory off, short conversations, and the block already gets the street local 15% (clone 20-23%).

Per clone the work is: hand-written device samples (the dial; see "Lessons for the samples"), one creation run
(about 6 requests), and a 40-line probe (40 requests) to check the rate and listen for habits. Option C is about 84 x 46,
roughly 3,900 requests; Option A is about 14,500. Both fit the weekly allowance, but the samples are the real cost: 84
characters of hand tuning, each needing a listen.

### Routing (when Natural speech is on, and only then)

Modelled on the Multilingual twins (`bridge/multilingual.mjs`, `bridge/relationship-routing.mjs`):

1. Mapping `runtime/natural-speech-profiles.json`, keyed by provider key (`judy-alvarez`, `judy-alvarez-romantic`, and for
   Option A `judy-alvarez-multilingual` too): `{originalCharacterId, naturalCharacterId, verified, specVersion,
   sourceHash}`. Marker `[CyberpunkConvai profile v2:<providerKey>:natural]` (the prototypes use `:natural-prototype`, so
   they can never be adopted by mistake).
2. A loader like `multilingualTwins`: a clone is usable only if it is verified, its `originalCharacterId` equals the ID
   the mod uses today for that provider key, and `sourceHash` (backstory, style and samples of the original at
   creation) still matches the original. Otherwise the original is used with the block.
3. `relationshipRegistry` gains a third map: provider key `<providerKey>-natural`, in the same memory family as the
   original (so Forget clears it, and the memory guards treat it as a sibling).
4. `selectRelationshipProfile({..., natural = false})`: the relationship choice first (ordinary or romantic), then
   Multilingual (the twin), then, **only if `natural === true`**, the clone of exactly that provider key when one exists.
   With `natural` false or missing, the code path and result are exactly today's; a test compares every profile with the
   argument omitted and with `false`.
5. The voice decides as well: the clone is used only when the turn's planned engine is local (`planTurnVoice` result
   `omni` or `pocket`). A Multilingual turn that goes to the Convai cloud voice keeps the original or twin, because the
   cloud voice would read a tag aloud. Natural speech already moves the voice off the cloud voice, so this is a safety net.
6. Context on a clone turn: no `naturalSpeechContext` offer. OmniVoice gets only the repeat guard (after a reply with a
   device); Pocket gets the "no sounds, pauses only" rule on every turn. A profile without a clone keeps the current block
   unchanged. Tag stripping (display, memory, subtitles, Omni's seven tags, Pocket strips all) is unchanged.

Off stays untouched: the originals and twins are never written, the router never reads the clone map unless the setting
is on, and the context path for off is the same code as today.

### Costs to accept before a rollout

- **Memory splits.** A clone is its own Convai character, with its own long-term memory and session history, just like
  the Multilingual twins. Switching Natural speech on gives Judy a Judy who remembers nothing of the original's
  conversations, and switching back returns the old memories. With Multilingual on as well, a character's memory is spread
  over up to four characters. Copying memories between them (`/memory/add`) is possible, but it goes against the current
  rule that routing never copies memories, so that is the user's decision. Judy and Johnny have memory on; Panam's
  ordinary profile and the archetypes have it off.
- **Sync.** Every rebuild of an original (backstory, style, samples) must be followed by re-running the clone script.
  Step 2 above makes a stale clone fall back safely rather than drift.
- **Account size.** 84 to 316 more characters on top of 582.

### Lessons for the samples

Round 2 (the full tune):
- Describing the sounds in the backstory and listing them in the speaking style is what drives the rate: with both, 80-100%
  of lines whatever the frequency wording and whatever the number of device samples (2 to 6).
- A sample that opens with a sound, plus a rule allowing it, teaches "open every reply with a sound" (37 of 40 in v3).
- Naming all seven sounds does produce variety (6-7 tag kinds), but the one described as an agreeing "mm" becomes a
  tic between sentences (Panam 13 in 40).

Round 1:

- The share of device lines is the dial. 7 of 16 gave 100%, 4 of 16 gave 28-40%, and 3 of 16 gave 23-35% (Johnny, the
  local). Frequency wording in the style is ignored.
- Vary the position of the laugh. Every laughter sample here is "Short fragment. [laughter] ...", and the clones learned
  "echo the player's words. [laughter] quip". Put one laugh at the end of a line, one inside a sentence, and never
  directly after a two-word fragment.
- Name more than two sounds if variety matters (for example one `[surprise-oh]` sample for Judy). Fillers appear only when
  a sample has one ("uh"), and they should stay out of fluent speakers' samples (Johnny, Panam).
- Dry characters need fewer device lines than warm ones (Johnny's 3 of 16 still gave him 35%; 1-2 would match his trait).

## Round 1 recommendation (superseded by round 2, see the top)

1. **No clone rollout yet.** On the numbers, clones match the block's rate (not exceed it), are less varied, and bring
   a memory split and 84-316 characters to maintain. Their real advantage, the sound landing on the right moment, is
   something the user can only judge by ear.
2. **Next step (phase 2a, small):** a dev-only override that sends Judy to her clone (v3 samples per the lessons above)
   while Natural speech is on, for one in-game A/B against the block. No change to routing for anyone else, and the
   original is untouched.
3. **If the clone wins by ear, do Option C** (84 named and romantic clones, English only). Archetypes and Multilingual
   keep the current block. Option A only if the user plays with Multilingual and Natural speech on together.
4. **If neither feels different enough,** the issue is the target rate, not the samples. Raise the block's offer rates
   (or allow a sound plus a pause in one reply) rather than build clones; both approaches reach any rate (v1 and (e)
   reached 100%).

## Commands

```powershell
node scripts/Create-NaturalSpeechPrototype.mjs --key judy-alvarez            # plan only
node scripts/Create-NaturalSpeechPrototype.mjs --key judy-alvarez --apply    # create or adopt, then verify
node scripts/Probe-NaturalSpeech.mjs --profiles judy-alvarez --prompts 40 --natural-clone --block reduced --clear-memories --run
node scripts/Probe-NaturalSpeech.mjs --profiles judy-alvarez --prompts 40 --off --clear-memories --run
```

Deleting the prototypes (not done; run only if they are no longer wanted). Each call reads the key from the local file
and never prints it:

```powershell
$k = ((Get-Content runtime\convai-key.txt -Raw).Trim() -replace '^api-key\s*=\s*', '')
foreach ($id in '98243eec-c2f8-11f1-9cc9-42010a7be02f', '23c30856-c2fa-11f1-8074-42010a7be02f', '2a9e3c54-c2fa-11f1-ba1a-42010a7be02f', '36284e2a-c2fa-11f1-86eb-42010a7be02f') {
  Invoke-RestMethod -Method Post -Uri https://api.convai.com/character/delete -Headers @{'CONVAI-API-KEY' = $k} -ContentType 'application/json' -Body (@{charID = $id} | ConvertTo-Json)
}
```

Then remove `runtime/natural-speech-profiles.json`.
