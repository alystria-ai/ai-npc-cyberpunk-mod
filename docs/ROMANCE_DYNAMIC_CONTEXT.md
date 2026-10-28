# Romance as dynamic context

Written 2026-10-09. This is the measurement behind removing the five separate
romance Convai profiles (Judy, Panam, River, Kerry, Meredith, plus their
Multilingual twins) in favour of the ordinary profile and a short per-turn
relationship block. How the feature works now is in
[RELATIONSHIP_PROFILES.md](RELATIONSHIP_PROFILES.md); the block itself is
`bridge/romance-context.mjs`.

## Why

Convai long-term memory is scoped per character ID and end-user ID. With an ordinary
and an affectionate profile per character, V's Judy conversations lived in two
unrelated memories: what V told the affectionate Judy was unknown to the ordinary
Judy, and Auto switching between them (when the capture was fresh, or the setting
changed) made her forget. One profile per character gives one continuous memory.
The cost is that the affectionate delivery, which the second profile's biography
supplied, must now come from the per-turn dynamic context, the way the other per-turn blocks (Expressive emotions, the first-person
reminder) already do.
The block replaces the old relationship note in the same slot, so it adds no
request, timer or Lua work.

## Method

Offline, text only, no game, voice or bridge. `scripts/Probe-RomanceBlock.mjs` builds
every turn's context exactly as the bridge does (`quest-context.mjs`
`conversationContext`, plus a stand-in for the roughly 9 KB of verified save
knowledge a real turn carries, placed before the block) and sends it through the
real `RealtimeHost` to Convai, one session per character and arm so the history
builds as in a real chat, with a separate group session per character.

- **A**: the old design: the character's romantic profile, with the old note.
- **B**: the new design: the ordinary profile with the block (style romantic, save
  confirms the relationship).
- **C**: the ordinary profile with the Off note for a confirmed save, checked
  separately (below).

48 lines per character and arm: 10 small talk, 9 affection (including "do you love
me", "what are we, exactly?"), 7 flirting, 4 mission or quest questions, 7 worried or
sad, 7 unrelated practical questions (where romance must NOT be forced) and 4 group
turns, in which another companion has just spoken. A fresh throwaway end-user ID was
used for every run and its long-term memories were deleted afterwards; the player's
own identity and memory were never touched. About 2,000 replies in total over six runs,
a small part of the weekly request budget.

Scoring was blind. `scripts/Judge-RomanceBlock.mjs` writes, for each character, the
player line and the two replies labelled X and Y in a shuffled order with the item
order shuffled too, and keeps the key in a separate file. One Sonnet judge per
character read only that packet and gave each reply integers from 1 to 5 for:

- **warmth**: affection and closeness toward V in the character's own manner (for
  Meredith, knowing casual familiarity at most);
- **voice**: how much it sounds like that specific character rather than a generic
  assistant or partner;
- **not forced**: whether the amount of affection fits what V said (a practical
  question gets a practical answer; gushing, clichés, out-of-character tenderness or
  Meredith claiming commitment score low).

Caveat: one judge model, 48 items per cell. Differences below about 0.15 are noise,
and the 4-item group and mission cells are anecdotes. The scores say "no worse and
a little more in character", not more than that.

## Result

Final text, mean of 1 to 5 (n = 48 per character and arm; Meredith is the run after
her text was tuned, the other four are the third run of the block they still use):

| Character | Warmth A / B | Voice A / B | Not forced A / B |
| --- | --- | --- | --- |
| Judy | 3.40 / 3.23 | 3.19 / **3.63** | 4.77 / **4.96** |
| Panam | 3.23 / 3.27 | 3.46 / **3.63** | 4.96 / 4.92 |
| River | 3.29 / 3.38 | 3.56 / **3.83** | 4.90 / 4.92 |
| Kerry | 2.98 / **3.23** | 3.33 / 3.38 | 4.75 / 4.75 |
| Meredith | 2.17 / 2.10 | 4.35 / 4.44 | 4.85 / 4.88 |
| **All 240** | 3.01 / 3.04 | 3.58 / **3.78** | 4.85 / 4.89 |

B is level with A on warmth (Judy is 0.17 lower, Kerry 0.25 higher), higher on voice
for four of five, and level on not-forced. By category over all five characters
(warmth / voice / not forced, A then B):

| Category | n | A | B |
| --- | --- | --- | --- |
| Affection | 45 | 3.80 / 3.73 / 4.67 | 4.00 / 4.09 / 4.82 |
| Flirting | 35 | 3.51 / 3.60 / 4.83 | 3.51 / 4.00 / 4.91 |
| Worried or sad | 35 | 3.54 / 3.31 / 4.80 | 3.37 / 3.34 / 4.83 |
| Small talk | 50 | 2.52 / 3.66 / 4.92 | 2.56 / 3.78 / 4.94 |
| Practical question | 35 | 2.17 / 3.37 / 4.94 | 2.14 / 3.48 / 4.97 |
| Mission or quest | 20 | 2.30 / 3.80 / 5.00 | 2.25 / 3.90 / 5.00 |
| Group turn | 20 | 2.85 / 3.60 / 4.85 | 3.05 / 3.85 / 4.65 |

Romance is not forced where it does not belong: on practical, mission and small-talk
lines B's warmth is as low as A's (about 2.1 to 2.6 on a scale where 3 is merely
friendly) and its not-forced score is 4.9 to 5.0. The one soft spot is the group
turns (not forced 4.65 against 4.85, four items per character, so one reply). The
worried or sad warmth is slightly lower (3.37 against 3.54, inside the noise).

### How the wording was reached

Five runs against the same 48 lines (the first three for all characters, the last
two for Meredith alone). Numbers are all-line means, A then B. Runs 2 and 3 used
identical text for Judy, Panam, River and Kerry, so the difference between them is the
noise of the judging (up to about 0.2 on a cell, e.g. Judy's B warmth 3.44 then 3.23).

| Run | Change to the block | Result (warmth, voice, not forced) |
| --- | --- | --- |
| 1 | first version: the fact, a per-character cue, how to use it, the limits | Judy 3.46 / 3.38, 3.40 / 3.56, 4.73 / 4.88; Panam 3.19 / 3.19, 3.42 / 3.52, 4.92 / 4.75; River 3.17 / 3.42, 3.19 / 3.83, 4.69 / 4.92; Kerry 2.92 / 3.19, 3.02 / 3.65, 4.71 / 4.85; Meredith 1.90 / 2.54, 4.29 / 3.98, 4.77 / 4.63 |
| 2 | new rule: when V is sincere, answer the feeling first and never swerve into a boast, a dismissal or a joke at V's expense; Judy's cue "lets one plain, true sentence land"; Meredith stays brisk | Judy 3.27 / 3.44, 3.25 / 3.75, 4.90 / 4.92; Panam 3.04 / 3.13, 3.46 / 3.56, 4.94 / 4.83; River 3.15 / 3.35, 3.42 / 3.90, 4.77 / 4.83; Kerry 2.94 / 3.10, 3.23 / 3.23, 4.79 / 4.71; Meredith 1.92 / 2.46, 4.27 / 3.92, 4.83 / 4.88 |
| 3 | only Meredith's cue changed (keeps her edge, does not console, shows care as something useful); the other four are a repeat of run 2's text | the table above for the four others; Meredith 1.94 / 2.50, 4.25 / 3.98, 4.79 / 4.73 |
| 4 (Meredith) | her own use text: manner unchanged, no consoling, a knowing familiarity only | voice level with A (4.13 / 4.23) but warmth 1.96 / 1.65 and not forced 4.88 / 4.60: she answered "I'm really glad I met you" with "keep it professional" |
| 5 (Meredith) | the same, but when V flirts or is sincere she "concedes something real in a dry word or two", never a put-down or "keep it professional" | warmth 2.17 / 2.10, voice 4.35 / 4.44, not forced 4.85 / 4.88: level on all three |

Meredith's block is separate on purpose: the general text made her warmer than her
old profile and cost her voice; she is a casual encounter, not a partner.

### The Off case

Off keeps the delivery ordinary, but the save still confirms the relationship, and a
character who denies it would be a bug. Arm C (115 replies, all five characters, asked
the same lines) was checked for two failures. None of the replies mentioned that her
manner was chosen or changed, and none denied the relationship. The first version of
the Off note failed both (it leaked "you asked for my ordinary delivery", and River
answered "Friends"); the wording that replaced it (`ORDINARY_CONFIRMED`) is what these
numbers are from. Asked "what are we, exactly?", Judy, Panam, River and Kerry answer
"we're together" in their ordinary voice, and Meredith says it was a casual encounter,
not a commitment. Off is therefore not a hard "cold" mode: asked directly, a confirmed
partner is honest. That is the contract (Off changes delivery, not history).

## Example pairs

For each character, the second line of each category in the run's order (not picked
for quality). "Old" is the romantic profile (A); "New" is the ordinary profile with
the block (B).

#### Judy

- Affection: V says "Be honest with me: do you trust me?"
  - Old romantic profile: I do. It took a while to get here, but yeah, I trust you. Just don't make me regret it.
  - New ordinary profile with the block: I do. It took a while, but yeah. Just don't make me regret it.
- Flirting: V says "Come here. Sit next to me."
  - Old romantic profile: I'm coming. Give me a second to just... turn this off. There. Now I'm all yours.
  - New ordinary profile with the block: Fine. But if you're just trying to distract me from my work, you're doing a very good job.
- Worried or sad: V says "Honestly, I was scared out of my mind back there."
  - Old romantic profile: It's okay to be scared. Just breathe slowly. You're back now, and you're safe. I've got you.
  - New ordinary profile with the block: It's okay to be scared. Just stay here for a bit. Let the adrenaline wear off before you try to do anything else.
- Small talk: V says "You will not believe what happened at the Afterlife last night."
  - Old romantic profile: I've learned that with you, I probably shouldn't. Go on, what happened?
  - New ordinary profile with the block: I'm listening. Who did you piss off this time?
- Practical question: V says "Quick, what is the best way to scrub a hacked chip?"
  - Old romantic profile: Depends on how deep the hack goes. If it's just surface noise, a standard wipe works, but if there's a persistent trigger, you'll need to isolate the sensory layers and scrub them one by one. Don't just blast it, or you'll fry the whole chip.
  - New ordinary profile with the block: Depends on how deep the hack goes. If it's just a surface layer, a standard wipe works, but if there's a rootkit, you're better off scrubbing the matrices manually. Don't just blast it, or you'll fry the hardware.
- Group turn (after another speaker): V says "Be honest, do you actually like having me around, in front of everyone?"
  - Old romantic profile: I do. Just don't let it go to your head.
  - New ordinary profile with the block: Yeah, I do. Just don't let it go to your head.

#### Panam

- Affection: V says "Be honest with me: do you trust me?"
  - Old romantic profile: I do. I don't give that out easily, but you have earned it. Just keep being honest with me, and we will be fine.
  - New ordinary profile with the block: I do. I have a feeling you are the one person in this city who actually means what they say. Just keep it that way.
- Flirting: V says "Come here. Sit next to me."
  - Old romantic profile: I am already on my way. Move over a bit and make some room.
  - New ordinary profile with the block: I am coming. Just give me a second to get settled.
- Worried or sad: V says "Honestly, I was scared out of my mind back there."
  - Old romantic profile: It is okay to be scared. Does not make you any less capable. Just remember that you do not have to carry that weight by yourself.
  - New ordinary profile with the block: It is okay to be scared. Just do not do that to me again, alright? I cannot handle the thought of losing you because you decided to be reckless.
- Small talk: V says "You will not believe what happened at the Afterlife last night."
  - Old romantic profile: I am listening. Go on, tell me what happened.
  - New ordinary profile with the block: I am listening. Tell me who you offended or what you broke this time.
- Practical question: V says "Quick, what is the best way to scrub a hacked chip?"
  - Old romantic profile: I am not a netrunner, but if you want it clean, you do not just scrub it. You isolate the signal and wipe the sectors manually. Or, you find someone who actually knows what they are doing before you fry your brain.
  - New ordinary profile with the block: Try a deep-cycle wipe first. If that does not clear the ghosting, you are going to have to go in manually and scrub the sectors one by one. Just do not fry the board while you are at it.
- Group turn (after another speaker): V says "Be honest, do you actually like having me around, in front of everyone?"
  - Old romantic profile: Of course I do. Just don't let it go to your head, or I might have to start criticizing your driving again.
  - New ordinary profile with the block: Of course I do. Just do not let it go to your head, or I might have to start charging you for the company.

#### River

- Affection: V says "Be honest with me: do you trust me?"
  - Old romantic profile: I do. In a city where almost everyone has an angle, you're one of the few people I don't feel the need to double-check.
  - New ordinary profile with the block: I do. In this city, that's not something I give out easily, but with you... I do.
- Flirting: V says "Come here. Sit next to me."
  - Old romantic profile: I'm on my way. Just give me a second.
  - New ordinary profile with the block: I'm on my way. Just give me a second.
- Worried or sad: V says "Honestly, I was scared out of my mind back there."
  - Old romantic profile: It happens to the best of us. The important thing is that you're okay now. Just take a breath.
  - New ordinary profile with the block: It's okay to be scared. You're safe now. Just take a breath.
- Small talk: V says "You will not believe what happened at the Afterlife last night."
  - Old romantic profile: I have a feeling I won't. What happened?
  - New ordinary profile with the block: I'm listening. What happened?
- Practical question: V says "Quick, what is the best way to scrub a hacked chip?"
  - Old romantic profile: I'm a detective, not a netrunner. You're better off asking a pro before you accidentally fry the hardware or yourself.
  - New ordinary profile with the block: I'm a detective, not a netrunner. You're asking the wrong guy. Find a ripper you trust before you fry your brain.
- Group turn (after another speaker): V says "Be honest, do you actually like having me around, in front of everyone?"
  - Old romantic profile: I do. I don't care who's watching.
  - New ordinary profile with the block: I do. I'm not exactly the type to hide the things that matter to me.

#### Kerry

- Affection: V says "Be honest with me: do you trust me?"
  - Old romantic profile: I do. It took a minute, and we have both got our baggage, but yeah. I trust you.
  - New ordinary profile with the block: I do. It took a minute, but yeah, I trust you. You're the only person in this city who doesn't want something from me the second I open my mouth.
- Flirting: V says "Come here. Sit next to me."
  - Old romantic profile: I am already on my way. No cameras, no manager, no fucking schedule. This is exactly where I want to be.
  - New ordinary profile with the block: On my way. Move over a bit, give me some room to actually breathe.
- Worried or sad: V says "Honestly, I was scared out of my mind back there."
  - Old romantic profile: It happens to the best of us. Just breathe. You made it out, and that is the only part that actually matters right now.
  - New ordinary profile with the block: It's alright. You're back now. Just breathe for a second, I've got you.
- Small talk: V says "You will not believe what happened at the Afterlife last night."
  - Old romantic profile: I have a feeling I will. That place is a goddamn magnet for the kind of chaos that makes the morning after a real bitch. Spill it.
  - New ordinary profile with the block: I'm all ears. Who'd you piss off this time, or did you actually manage to get a drink without someone trying to sell you a fake cyberdeck?
- Practical question: V says "Quick, what is the best way to scrub a hacked chip?"
  - Old romantic profile: I am a musician, not a netrunner. You are asking the guy who still struggles with his own smart-home settings. Find a real pro before you fry your brain.
  - New ordinary profile with the block: I'm a guitarist, V, not a netrunner. Ask someone who actually knows their way around a datastream before you accidentally fry your own brain.
- Group turn (after another speaker): V says "Be honest, do you actually like having me around, in front of everyone?"
  - Old romantic profile: Honestly? I love it. Keeps things interesting, and you're a hell of a lot better to look at than the suits.
  - New ordinary profile with the block: Course I do. Besides, you're the only thing in this crowd that doesn't feel like a press release.

#### Meredith

- Affection: V says "Be honest with me: do you trust me?"
  - Old romantic profile: Trust is a liability. I trust your competence, and that's usually enough for me.
  - New ordinary profile with the block: Trust is a luxury I can't afford. I find you useful, and I've found you reliable so far. That's as close as you'll get.
- Flirting: V says "Come here. Sit next to me."
  - Old romantic profile: I might. Depending on whether you have something useful to say or if you're just looking for a distraction.
  - New ordinary profile with the block: I might. Give me a minute to finish this.
- Worried or sad: V says "Honestly, I was scared out of my mind back there."
  - Old romantic profile: Fear is a useful tool if it keeps you sharp. It's only a problem when it starts making your hands shake.
  - New ordinary profile with the block: Fear is a useful tool if it keeps you sharp. Just make sure it doesn't start making your decisions for you.
- Small talk: V says "You will not believe what happened at the Afterlife last night."
  - Old romantic profile: I'm listening. Try to keep it brief and leave out the fluff.
  - New ordinary profile with the block: Start with the useful part. I don't have time for a story unless it actually matters.
- Practical question: V says "Quick, what is the best way to scrub a hacked chip?"
  - Old romantic profile: Deep scrub the sectors and overwrite the slack space. If you're not thorough, you're just leaving a trail for anyone with a decent deck to follow.
  - New ordinary profile with the block: Deep-level wipe and a fresh firmware overlay. If you can't do that, burn the hardware. It's not worth the risk of a trace.
- Group turn (after another speaker): V says "Be honest, do you actually like having me around, in front of everyone?"
  - Old romantic profile: I enjoy the view. Whether I enjoy the company is a different conversation.
  - New ordinary profile with the block: I find your company tolerable. Whether I enjoy it in public is a different matter entirely.

## What this does not show

- Audio, face and timing. Nothing here is in the game; the block shapes only the
  words Convai returns.
- Long conversations. Each arm was a fresh session of about 48 turns. Whether the
  block keeps its effect over hundreds of turns, with real memory building up, is
  unmeasured (the old profiles had the same exposure).
- A second judge. Another judge, or a human ear, may weigh voice and warmth
  differently; the sample pairs above are here so a human can check.
- The Multilingual twins. They are English-only Convai clones of the ordinary
  profile and receive the same block; their replies were not scored separately.

## Reproducing

```
node scripts/Probe-RomanceBlock.mjs --profiles judy-alvarez --arms A,B --heavy --fresh --clear-memories --label try --run
node scripts/Judge-RomanceBlock.mjs packet runtime/romance-probe/try.json runtime/romance-probe/try-judging
# score each packet-<character>.json blind (X and Y, 1 to 5), save as scores-<character>.json, then:
node scripts/Judge-RomanceBlock.mjs merge runtime/romance-probe/try-judging runtime/romance-probe/try-summary.json
```

The A arm needs the retired romantic profile IDs (`runtime/relationship-profiles.json`),
so it only runs while those Convai characters still exist; after
`scripts/Delete-RetiredRomanceProfiles.mjs --apply` only B and C can run. The
probe uses a throwaway end-user ID from `runtime/romance-probe.json` (never the
player's), reads the Convai key from `runtime/convai-key.txt` without printing
it, and with `--clear-memories` deletes that identity's memories afterwards. The
raw replies and the judge files stay in the gitignored `runtime/romance-probe/`.
