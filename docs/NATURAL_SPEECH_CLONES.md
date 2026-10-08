# Natural speech by character clones (phase 1: prototype and measurement, 2026-10-08)

Status: prototype only. Four Convai clones exist and were measured offline; **nothing in the bridge routes to them**, and
the originals and every Multilingual twin are unchanged. The in-game setting still works as before (`bridge/natural-speech.mjs`).

Why: in game with Judy on OmniVoice the user heard "a little laugh I guess but not exactly all that different" with Natural
speech on, and asked whether the sample dialogues control too much, and whether a clone of each character with a direct,
character-level approach would beat the per-turn dynamic block, without touching the off setting.

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

## The prototype clones

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

A clone is needed for each variant the router can choose while Natural speech is on:

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

### Lessons for the samples (for any v3)

- The share of device lines is the dial. 7 of 16 gave 100%, 4 of 16 gave 28-40%, and 3 of 16 gave 23-35% (Johnny, the
  local). Frequency wording in the style is ignored.
- Vary the position of the laugh. Every laughter sample here is "Short fragment. [laughter] ...", and the clones learned
  "echo the player's words. [laughter] quip". Put one laugh at the end of a line, one inside a sentence, and never
  directly after a two-word fragment.
- Name more than two sounds if variety matters (for example one `[surprise-oh]` sample for Judy). Fillers appear only when
  a sample has one ("uh"), and they should stay out of fluent speakers' samples (Johnny, Panam).
- Dry characters need fewer device lines than warm ones (Johnny's 3 of 16 still gave him 35%; 1-2 would match his trait).

## Recommendation

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
