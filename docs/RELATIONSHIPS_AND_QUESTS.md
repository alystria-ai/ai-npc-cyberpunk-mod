# Relationships and quests: bonds, story packs, favours and recruits

Status (2026-10-30): design, with **phases 1 and 2 built on branch `feat/bonds`** (worktree `../wt-bonds`, not merged, not pushed, nothing seen in the game).
Phase 1 is the bond tracker (sections 3 to 5), its prompt line, its level notice and the story-pack format with a validator and gate (section 7).
Phase 2 runs the packs (section 17: what it does, what is unverified, the live checks). Phases 3 and 4 are design.

Asked for by players on Nexus Mods: AetherAmoris (27 Oct, a relationship tracker and threshold story packs), FOGH0RN (28 Oct, Parley for RDR2 and AI
Influence for Bannerlord: quests from talk, barter, recruiting pedestrians, consequences). The owner's list of 29 Oct: (1) quests generated from
conversations, (2) a relationship meter per character after Attack on Titan 2, closer characters offering more personal jobs, favours and packs,
(3) ordinary pedestrians recruited through dialogue may follow V.

## 0. The design on one screen

* **Bond**: every named character has a bond with V, **level 1 to 10** with a title (Acquaintance ... Ride or die). It is the sum of two parts:
  * the **story part**, worked out fresh on every turn from what the save already tells the mod (the character's own quests finished, a romance the
    save confirms, V's money record with them). It follows the save: load an earlier save and it is earlier.
  * the **shared part**, what V and the character said to each other: a few points per heard exchange, a capped amount per game day and per real
    day, and points lost for threats and insults. It follows the **memory** (the character remembers those talks whichever save is loaded), and
    Forget clears it with the memory.
  * Warmth never decays. Hurt (from threats and insults) fades with a half-life of 10 game days. A level can go down.
* **Shown** as one notice when a level changes ("Bond with Judy: level 5, Good friend"), and from phase 2 as a column on the Companion Manager's
  Characters page. No HUD element, nothing per frame.
* **In the prompt** as one short world-tier line on every private turn with a named character, on every provider: what this closeness means for
  how they treat V. Never a number.
* **Closeness unlocks things** the way AoT2's friendship ranks unlock skills and episodes: more generous loans, personal favours, and at the
  thresholds the **story packs**.
* **Story packs** are data files (JSON): a short arc per character with stages, conditions (bond level, finished quests, time, place, channel),
  what the character knows and wants at each stage, fixed lines for the shared Convai key, choices, timers and an ending. Packs drive the systems
  the mod already has (Eddies, Immersive invitations, Phone Chat, holocalls, companion cars) and never the game's quest system.
* **Plot safety**: a pack starts only when every quest of that character it names is finished, none of the character's quests is active, the
  journal inventory is complete, the main story is not at its end, and V is talking to one of the mod's own copies or channels.
* **Generated favours** ("quests from talk") pick from a closed list of templates the game can check (meet me at, drive me to, lend me, bring me,
  go ask, come by tonight); the model words them, the bridge chooses and the game verifies. No new journal entries, scenes, quest markers or quest
  facts.
* **Recruits**: an ordinary pedestrian talked into helping follows V for a while as a temporary party member (the stand-in copy the mod already has
  in `mod/companion-adoption.lua`), never a story, quest or vendor character, never during quests or scenes.
* **Cost**: nothing per frame. A turn pays a Map lookup and one short line; the record is made after the reply is published; the shared Convai key
  is never used for anything the player did not start.

## 1. What the owner's rules allow

| Rule | What it means here |
|---|---|
| FPS first, latency as important | No tick work for bonds or packs beyond a 1 Hz read of one small file for at most 30 s after a turn (the level notice). Bond and gate are computed in the bridge from data the turn already carries. The record happens after the reply is published, never in front of it. |
| Game-placed characters: talk, face and audio only | A bond line is talk, so the game's own Judy gets it too. Every pack stage, favour, money move and world effect needs one of the mod's own copies (party, invited visitor, housemate) or one of the mod's own channels (Phone Chat, the mod's holocall). The game's Judy in her flat only talks. |
| Recruited pedestrians may follow (29 Oct) | Ordinary pedestrians only; never story, quest or needed vendor/fixer characters; never in quests or scenes (section 10). |
| No new content restrictions | Bonds change warmth and willingness, never what may be said. A Ride or die character can still refuse V; a level 1 stranger can still flirt if that is who they are. |
| Unload what is unused | Setting off: no module loaded, no file read, no block sent. |
| Off-by-default settings in Settings > Companions | **Character bonds** (phase 1). Story packs and recruits are later rows on the same page. |
| One Convai cap, 500 a day | Nothing generates a model turn the player did not start while the shared key is in use: a pack's phone text uses its fixed line there; only V's own talk moves a pack. |
| Never name the other spawner mod; "I" in player-facing text | Kept. |

## 2. What to take from Attack on Titan 2 (and from Parley and AI Influence)

Attack on Titan 2 (Koei Tecmo, 2018) gives each squad member a **friendship rank from 1 to 10**. It rises in the "town life" parts between
battles (talking to characters), by **gifts** (each character has items they like) and by taking them on **missions** (choosing who comes along
on a scout mission raises their friendship). **Each rank-up unlocks a skill** for the player's own character (Levi at rank 8 gives the chain
attack), and higher ranks release **character events and side stories**; there are trophies for raising ranks and for maxing everyone.
Sources: [Gameranx gift guide](https://gameranx.com/features/id/143858/article/attack-on-titan-2-how-to-level-up-relationships-fast-gift-giving-guide/),
[Gameranx skills guide](https://gameranx.com/features/id/143857/article/attack-on-titan-2-how-to-unlock-all-the-skills-skills-guide/),
[SegmentNext skills](https://segmentnext.com/attack-on-titan-2-skills/), [Siliconera on town life](https://siliconera.com/attack-titan-2-shows-jean-conny-sasha-marco-daz-character-editor-town-life),
[Steam discussion on chain attacks at rank 8](https://steamcommunity.com/app/601050/discussions/0/1697169163405336129). (The guides are fan
guides; the exact numbers were not checked against the game.)

Why that loop satisfies, and what carries over:

| AoT2 | Why it works | In this mod |
|---|---|---|
| A visible rank per character, 1 to 10 | Progress you can see and name | Bond level 1 to 10 with a title; a notice when it changes; a column on the Characters page |
| Every rank-up pays something concrete (a skill) | Each step is worth having | Each level changes what the character does for V: bigger loans (Eddies), favours, packs at 5 / 6 / 7 (section 6) |
| Character events at thresholds | Scripted payoffs the player looks forward to | Story packs, unlocked by level and by the character's finished quests |
| Raised by talk, gifts and missions together | Different ways to the same goal | Talk (capped per day), money given and paid back, time together and packs finished (phase 2) |
| Never goes down | No chore, no punishment for playing elsewhere | Warmth never decays; only hostility costs points, and hurt fades |
| A critic's complaint: daily life offers little beyond the stat bonus | Grinding talk for numbers is dull | Talk points are capped per day, so the levels come from playing with the character, not from spamming the talk key; the packs are the content |

What does not carry over: AoT2's events are fixed scenes with fixed lines. Here every line is generated, so a pack cannot be a script. A pack is
a **situation** (what happened, what the character wants, what V can do, what each answer leads to) that the character plays in their own words,
plus a few fixed lines for the moments no model may be called (the shared Convai key).

From Parley (RDR2) and AI Influence (Bannerlord), as FOGH0RN describes them: talk has to move something in the world, or it is just chat. The
answer here is the same principle Eddies already uses: **the bridge proposes from V's words and the data, the game checks and acts, the model
only performs**. That keeps every consequence real and every provider equal.

## 3. The bond model

### 3.1 Points and levels

A bond is 0 to 1,000 points. Levels and titles (`bridge/bonds.mjs` `LEVELS`):

| Level | From | Title | How the character treats V (the prompt line, shortened) |
|---|---|---|---|
| 1 | 0 | Acquaintance | polite but guarded, personal matters kept back |
| 2 | 30 | Familiar face | friendly enough, careful about what they share |
| 3 | 80 | Friendly | easy talk, small personal details |
| 4 | 150 | Friend | jokes and opinions, small favours either way |
| 5 | 240 | Good friend | what matters to them; would ask V for real help |
| 6 | 350 | Close friend | private worries; goes out of their way for V |
| 7 | 480 | Trusted | serious favours, help without asking why |
| 8 | 630 | Confidant | things they tell almost nobody |
| 9 | 800 | Family | real risks for V |
| 10 | 950 | Ride or die | nothing they would not share with V or do for V |

The curve is front-loaded (early levels come in an evening, the last ones take weeks of play) because a new friendship moves fastest, and
because the story part already places the characters V has done their quests with in the middle of the table.

### 3.2 The story part (worked out each turn, never stored)

| Source | Points | Read from |
|---|---|---|
| The character's own quests, finished (succeeded or failed) | their weights, together up to 350 (a whole arc: Close friend) | the journal inventory every turn already carries (`journalHistory`, `mod/journal-history.lua`), by quest path (`bridge/bond-arcs.mjs`) |
| A romance the save confirms | partner +150, casual +40 | the 11 relationship facts (`bridge/relationship-routing.mjs`, the turn's admitted selection) |
| Money (only while Eddies with characters is on) | V paid back a loan +30; gifts from V +1 per 200 eddies, at most +60; V owes them now -15 | the turn's `eddies` ledger row (the game's ledger, which already forgets what a load took back) |

The arcs data lists 12 characters for phase 1 (Judy, Panam, Kerry, River, Rogue, Johnny, Takemura, Jackie, Misty, Viktor, Claire, Alt), with paths
taken from `research/cyberpunk/quest-premises.json`, the same paths the quest briefings were checked against on the owner's save. A quest
that is not in the inventory counts nothing (a lower bond, never a higher one). An inventory that is not complete yet (the first turn after a game load or a Skip Time) says nothing
about the quests, so that turn falls back on the character's arc points from the last complete read, which are kept with the bond state (`arc` in `<state>/bonds.json`). The level
never drops because of an unfinished read, the Relationships page does not zero its quest counts, and the next complete read always wins, also when it is lower (an earlier save was loaded).
A turn with an unfinished read also starts no pack and spends no dice roll: the gate is shut while the inventory is incomplete. Every other named character
starts at 0 story points.

Because the story part comes from the save, a new playthrough starts every character back at 0 story points, and loading an earlier save gives
the bond V had then (minus nothing V said since: see 3.3).

### 3.3 The shared part (stored, follows the memory)

| Event | Points |
|---|---|
| An exchange heard to the end, in person with one of the mod's own copies | +4 |
| ... over the mod's holocall | +3 |
| ... with a game-placed story character (talk only) | +2 |
| A death threat at the character (V's typed or spoken words, `bridge/threat-screen.mjs`, 15 languages) | -25 (and nothing gained that turn) |
| A threat to hurt, a challenge | -15 |
| An insult | -8 |
| A pack finished (phase 2) | its reward, usually +40 to +80 |
| Met at an invitation +6, stood up -15 (phase 2) | |
| Time together in the party, +1 per 10 game minutes, at most +12 a game day (phase 2) | |

**Caps** (talk only): per character per game day, the first 6 exchanges count in full, the next 12 count half (at least 1), the rest nothing;
and at most 120 talk points per character per real day, so waiting or sleeping in the game cannot farm points. Without a game clock on the turn
the real day is used. Jokes, quotes, questions and refusals ("I won't hurt you") are not threats: the screen already drops them.

**Decay**: warmth (the positive total) never decays. **Hurt** (the negative total) fades with a half-life of 10 game days, by the game clock of
the turns (a clock that went backwards fades nothing). So a fight with Panam costs a level, and a week of play later most of it is forgiven.

The shared part is kept by the bridge per **memory key** (`<state>/bonds.json`, like `last-talk.json`), so a content pack with a separate memory has
bonds of its own. It is not rolled back by a load of an earlier save, on purpose: the character's memory (Convai's or the local store) is not
rolled back either, and a bond that says "stranger" while the memory holds months of talk would make the character contradict herself.
**Forget selected character** and **Forget all memories** clear it with the memory.

Floor and ceiling: the total is clamped to 0 to 1,000; the shared part alone is clamped to -300 to 1,000, so hostility can take a story-close
character down to Familiar face but not to below zero.

### 3.4 Not in the model

* The model never decides points. Nothing the character says raises or lowers the bond; only V's words, the save and what happened do. (A model
  that writes "I trust you completely" would otherwise farm its own meter.)
* No positive word screen. "Thanks", "you're great" and the like give nothing extra: they would be the cheapest way to grind, and the per-exchange
  points already reward talking.
* Ordinary NPCs have no bond (they are strangers with no memory of V; Street reputation covers them). A recruit has a session-only rapport
  (section 10).

## 4. How the player sees it

Phase 1:
* **One notice when a level changes**: "Bond with Judy: level 5, Good friend" (up) or "Bond with Panam fell: level 4, Friend" (down), in the
  menu language, through `mod/notices.lua` (`bond-level`, player class, 10 s repeat window). Shown after the reply, when the bridge's status
  file says so.
* The Settings > Companions row **Character bonds** (off by default) with its description.

Phase 2 (built):
* A **Relationships** page in the menu, right after the Model browser: only the characters V has actually interacted with, most recent first, each with
  the level and title and the progress to the next level, warmth (and hurt with the game days until it fades), the story part against the talk part,
  how many of their own quests are finished, and their story packs (the active one with its stage in one line, the finished ones). An empty state
  when nobody has been met, and one when Character bonds is off. Built when the page opens from `runtime/bonds-status.json`; no polling.
  This page replaces the earlier idea of a Bond column on the Characters page and of the Characters page listing active packs (no journal entries, decision 6).
* The Characters sidebar text of a character and the Memory page's picker carry one line "Bond: level 5, Good friend" (and "Story: title" while a pack runs),
  so Forget shows what it will reset.
* Not built: a "what they would do for you now" line (the level's perk, section 6).

Not planned: a HUD meter, a phone app of our own (the phone's Chat tab has no room for it and a redscript widget is a frame cost), numbers in the
character's mouth.

## 5. In the prompt

One line, world tier (it changes only when a level changes, so the Mistral and Local AI prefix caches keep working), on every private turn to a
named character: in person, holocall, typed or spoken; for the game's own story characters too. Not for group rounds in phase 1 (each speaker
would need its own; phase 2), not for automatic reactions, not for ordinary NPCs, add-on voices or Johnny in V's head.

> How close you are to V (a fact for you; never say it as a level or a number): a good friend. You talk with V about things that matter to you,
> and you would ask V for help with something real.

Plus, while hurt is notable (more than 20 points left):

> V threatened or insulted you recently, and it still stings: let it show in how you talk to V until it fades.

About 180 to 300 characters. Every provider gets it the same way: Convai in its dynamic info (one `world` block in `conversationBlocks`),
Mistral, Local AI and Custom in the world part of the shared prompt layout. With Relationship On or a confirmed romance the romance block still
says how affection sounds; the bond line says how much trust there is, so the two do not compete. The prompt budget trims world blocks last; the
line is short enough that it never matters.

## 6. What closeness unlocks (the "skills")

| Level | Unlocks | Phase |
|---|---|---|
| any | the prompt line | 1 |
| 3 | Eddies: trust counts the bond (each level above 3 +0.03, below 3 -0.05), so a friend lends more | 2 |
| 4 | small favours by talk (section 9: "can you grab me a drink", "meet me at Lizzie's") | 3 |
| 5 | the character's first story pack can start (if its quests are done) | 2 |
| 6 | personal favours (drive me home, come by tonight) and the character texts V first now and then about a pack | 3 |
| 7 | serious favours (lend a big sum, hide V at their place), the second pack | 2 / 3 |
| 8 | the character tells V one thing they tell almost nobody (a pack variant or a "confidence" beat, hand-written per character) | 3 |
| 10 | a keepsake: the character gives V an item that fits them (a hand-picked game item per character, once) | 3 |

The mod does not give V stat bonuses (perks, damage, armour): the game's stat system could do it, but it is balance work and a save-state change
the owner has not asked for. The unlocks are what the characters do, which is what the mod is about.

## 7. Story packs

### 7.1 What a pack is

A short arc of one character, three to six stages, that the character starts at a bond threshold once their own story is done, plays out in their
own words over a few game days, and resolves. Mostly talk and texts, with a few things the game really does (eddies move, a meeting happens at a
place, a car is unavailable, an item changes hands). One active pack per character, at most two active packs at a time, and a cooldown of 7 game
days per character after one ends.

### 7.2 The format (`characters/bond-packs/<pack id>.json`, or a content pack's `bond-packs/` folder)

```jsonc
{
  "format": 1,
  "id": "panam-truck-ransom",            // lowercase, digits, hyphens; unique
  "character": "panam-palmer",           // a roster profile key
  "title": "Ransom for the Mackinaw",     // for the manager list and logs, never said by the character
  "summary": "Panam's truck is stolen and held for ransom.",
  "requires": {                          // the gate (section 8); every field is optional except questsFinished for a story character
    "bond": 5,                           // the least level
    "questsFinished": ["quests/side_quest/sq027_02_raffen_shiv_attack"],   // journal paths, succeeded or failed
    "questsSucceeded": [],               // journal paths that must be succeeded
    "notActive": ["quests/side_quest/sq027", "quests/main_quest/act_01/q114"],   // path prefixes: no quest under them may be active
    "relationship": "any",               // "any" | "partner" | "not-partner"
    "eddies": true,                      // needs Eddies with characters on (a stage asks for money)
    "invitations": true,                 // uses Immersive invitations (a stage has a meet); off: that stage is played as talk
    "after": ["panam-..."]               // other packs of the character that must be finished first
  },
  "start": {                             // how it starts: on a private turn of V's (never in the background)
    "channels": ["own", "phone", "holocall"],   // own = one of V's own copies in person
    "chance": 0.35,                      // per eligible turn, at most once per game day
    "bringUp": "You have something on your mind ... bring it up in this reply, briefly, in your own way."
  },
  "stages": [
    {
      "id": "ask",
      "know": "What the character knows and feels at this stage (second person, for the prompt; at most 600 characters).",
      "wants": "What she wants from V now (at most 300 characters).",
      "say": {"en": "A fixed line she can send or say when no model may be called (the shared Convai key, a timer)."},
      "text": {"when": "start", "line": {"en": "fixed phone text"}},   // optional: a phone text at the stage start
      "ask": {"flow": "loanFromV", "amount": 6000, "reason": "the ransom"},   // optional: an Eddies ask with this pack as its story
      "meet": {"where": "here", "inGameHours": 2},                         // optional: an Immersive invitation she makes
      "effects": [{"kind": "vehicleBlocked"}],                           // optional, from a closed list (7.4)
      "choices": [                                                       // how the stage ends: one of these, or the timer
        {"id": "paid", "on": "eddies:loanFromV", "next": "repay"},
        {"id": "help", "on": "tag", "means": "V offers to get the truck back with her", "next": "recover"},
        {"id": "refuse", "on": "tag", "means": "V says no or tells her to handle it", "next": "alone"}
      ],
      "timeout": {"gameHours": 48, "next": "alone"}
    },
    {"id": "repay", "know": "...", "repay": {"part": 2000}, "choices": [{"id": "settled", "on": "eddies:repayToV", "next": "repaid"}],
     "timeout": {"gameHours": 168, "next": "repaid"}},
    {"id": "back", "know": "...", "next": "together"}       // a closing beat: straight on to an ending at the next turn
  ],
  "endings": {
    "repaid": {"memory": "One sentence the character keeps (for the prompt and the memory).", "bond": 60},
    "alone":  {"memory": "...", "bond": -10}
  }
}
```

Rules the validator enforces (`bridge/bond-packs.mjs` `validatePack`, phase 1):
* ids, a known character, at least one stage and one ending; every `next` names a stage or an ending; every stage is reachable from the first;
  no stage loops back without a timer (the arc always ends).
* `know` 600, `wants` 300, `bringUp` 400, `memory` 300 characters at most; a fixed line 240; at most 8 stages, 4 choices per stage.
* a story character (one with an arc in `bridge/bond-arcs.mjs`) must name at least one finished quest: no pack of a story character can start before its
  story is done.
* `ask` within the Eddies cap (1 to 100,000) and a known flow; a pack with an `ask` must require `eddies`.
* `effects` only from the closed list; `meet.where` only `here`, `home` or `waypoint`; `on` only `tag`, `eddies:<flow>`, `meet:met`, `meet:stood-up`.
* the fixed lines have English; other languages optional (the menu language is used when present, else English).

Added in phase 2 (all optional unless stated; the validator checks them):
* `kind` on every `tag` choice, required: `yes`, `no`, `honest` or `flatter`. V's words are read against the stage's kinds (bridge/bond-intent.mjs, 15
  languages); at most one choice per kind in a stage. `means` stays as the author's description of the choice.
* `label` on a stage: one English line (80 characters) for the Relationships page ("She wants your honest eye on the dress").
* `type` on a stage (default `talk`) and `params` (an object): the stage format is open. The runner plays `talk`; any other type is accepted by the
  validator (as a warning) and **skipped** by the runner (it follows the stage's `skip`, else `next`, else the timeout's `next`, else the first choice) and logged once per
  type. Gameplay stage types (enemies at a place, a drive, a hangout, a rescue, an escort) are added later without changing existing packs.
* `image` on a stage: `{"file": "images/<name>.png", "alt": "..."}`, a picture made ahead of time and shipped inside the pack (png, jpg or webp). Data only:
  nothing shows it and nothing is generated while playing. Where a stage "texts a photo" the description stays in `know`.

Packs can be written by hand or drafted with a model: the drafting script (phase 2, `scripts/Draft-BondPack.mjs`) gives the model the character's
profile text, the quest premises of their arc and this format, and runs the validator; a person reads every pack before it ships (the same rule as
the quest briefings and the decision rows).

### 7.3 How a pack runs (phase 2, as built)

Code: `bridge/bond-pack-runner.mjs` (the runner), `bridge/bond-intent.mjs` (V's words), `bridge/bond-packs.mjs` (format and gate), wired in
`bridge/convai-bridge.mjs`. Two settings: Character bonds and Story packs (both off by default).

* **Gate and start** on V's own private turn to the character (in person with one of V's own copies, Phone Chat, a holocall; never a group round, a reaction, a
  message the character starts, or the game's own placed character): the gate of section 8 from the turn's data (bond level, journal inventory, relationship,
  channel, the `busy` flag the game sends, the Eddies and Invitations settings), then the dice, thrown on an eligible turn, **every 2nd eligible turn and at most 5 times per game day per character** (raised by the owner on 31 Oct 2026 from every 3rd and 3 a day, which felt too rare), only when a
  pack could start. The turn's volatile note carries `start.bringUp`, the first stage's `know` and `wants`. The pack is recorded once the reply is
  published. At most 2 packs are active, one per character, with a cooldown of 7 game days after an ending.
* **State** in `<state>/bond-packs.json`: per pack the **trail** of steps (stage, game clock, the choice that led there). The state follows the save: a turn whose
  clock is earlier than steps of a pack rewinds it to the stage that clock had it at (a pack that had not started yet is forgotten); 120 game seconds of slack.
  A new playthrough whose clock passes an old entry's would inherit it: there is no save identity in the turn (the Eddies ledger has the same limit).
* **On the phone**: a stage that needs her in person (her own lines, a talk gap, a ride) cannot be played while she is only a voice on a Phone Chat or a holocall. Her note then tells V where to meet her, the gap's question is asked in her own words, V's answer on the same channel is read against the gap's tags, the stage clock gets a travel allowance and the play file gets a cast and a pin that stand down when she already has a copy of V's. All of it is in docs/QUEST_PRIMITIVES.md section 11.
* **Notes**: while a pack is active on a channel it allows, every turn carries one volatile note: the stage's `know` and `wants`, the meeting it hopes for, the
  money it needs, in the second person, with the instruction never to call it a story, a quest or a stage. It pauses (no note, no new stage, no timer)
  while a quest of the character is active, the main story is at its end, the journal is unknown, or the game is busy (a scene, a choice, a fight, a game call).
* **Choices** are decided on the bridge, after the reply is published, never by a tag in a reply. The first plan used "[pack:help]" tags; they were dropped because
  a tag in a spoken or streamed reply would be voiced, and stripping it everywhere would put work on the speech path. Instead:
  * a `tag` choice is taken from **V's words** (the typed line or the spoken transcript) by the stage's `kind`: yes, no, honest (a line with something to say),
    flatter (a short compliment or a bare "ok"). No kind found means the stage waits. V's words on the turn that brought a stage up do not answer it.
  * an `eddies:<flow>` choice is taken from the **ledger row** of the next turn: the pack's transfer is marked with the story (`pack:stage`) and the row's last entry says
    it was done. A turn that made such a proposal does not also answer by words. A repayment stage ends when the debt is clear.
  * `meet:met` / `meet:stood-up` come from the game's own appointment outcomes: a Phone Chat event (arrived, stood up) or the greeting at a meeting. Only while a turn
    has said Story packs is on.
  * the **timer** (`timeout`) is checked when a turn's context is built, never by a tick.
  * a closing beat (a stage with only `next`) is shown once, then ends at the next turn.
* **Effects for the game** (`runtime/bond-effects.json`, written when they change): `blocked` (a personal car not offered), `outfits`, `items`, each with the game clock they
  started at; the game ignores an entry from later than the loaded save. `bonds-status.json` carries `effectsRevision`, the active packs and the Relationships rows.
* **Endings**: the bond reward or penalty is an event on the shared part (no talk caps); the ending's `memory` goes into the character's next turns for 3 game days as a
  note. Not built: the synthetic exchange in the local memory store.
* **Cost**: nothing per frame. A turn pays a pass over a character's packs while the context is built (the test asserts under 1 ms) and one more volatile note of
  up to about 900 characters; the record happens after the reply is published.

### 7.4 What a stage can make the game do (closed list)

| Kind | What happens | Built on | Feasible |
|---|---|---|---|
| `ask` | the character asks V for eddies with the pack's reason; V's "here's 6,000" moves them | Eddies (`bridge/eddies.mjs` proposals, `mod/eddies.lua`) | yes, now |
| `repay` | the character pays V back in parts over game days | Eddies initiative, with the pack as reason | yes |
| `meet` | she sets a meeting: V's place, her home (a housemate), V's waypoint, in N game hours | Immersive invitations (`meet-here`, `meet-waypoint`) | yes, needs that setting on (the stage says so if it is off) |
| `text` | she texts V in Phone Chat | appointment events (`bridge/appointment-events.mjs`), the fixed line on the shared Convai key | yes |
| `call` | she asks V to call her | a stage note plus a text; V calls through the mod's holocall | yes (an incoming call started by the mod is not built and not verified) |
| `vehicleBlocked` | her own car (the companion car catalogue entry) is not offered: she arrives on foot, cannot drive V in it | `mod/companion-vehicle-catalog.lua` lookups in `companion-vehicles.lua` and `immersive-car.lua` | yes, a check at decision time |
| `vehicleReturned` | her car comes back (the block ends; in phase 4 it may be spawned at a place for V to find) | the same; spawning a parked car like the invitation car | yes / unverified |
| `outfit` | a party copy wears one of her appearances for the stage (the dress for the dinner) | Companions change outfits (`mod/companion-outfits.lua`) | yes for the appearances the character has; no new clothes |
| `giveItem` | she gives V an item from an allowlist (a keepsake, a bottle) | `TransactionSystem:GiveItem`, as Eddies gives money | yes, unverified for non-money items |
| `takeItem` | V gives her an item V has (barter) | `TransactionSystem:RemoveItem` after a `GetItemQuantity` check | yes, unverified |
| `pin` | a map pin at the meeting place | `MappinSystem` registration, which other script mods use | unverified; phase 4 at the earliest |
| `squad` | a few hostiles at a place (the people holding the truck) | the Revenge ambushes squad spawner (`mod/revenge-ambush-world.lua`) | possible, risky; phase 4, opt-in |

As built in phase 2: `ask` and `repay` (Eddies, with the story mark in the ledger), `vehicleBlocked` / `vehicleReturned` (the party car choice and the invited visitor's
car arrival check `bond-effects.json` when they decide), `outfit` (a stage acts as a temporary chosen look in `mod/companion-outfits.lua`: only out of view, never in a
fight or a ride, and only an appearance the character already has, so Judy, who has only her home clothes besides her base look, changes nothing), `giveItem` and
`takeItem` (one-shot, once per stage visit, a take only if V has the item). `meet` is **not started by the pack**: the stage tells the character what she hopes for and V
arranges it with the existing meeting flow (a holocall or Phone Chat message, `bridge/meet-requests.mjs`); the outcome moves the pack. `text` beats (a fixed phone text at the
stage start) and `call` are **not delivered**: the game has no way yet to push a message into the Chat thread, so they are data and the character brings the news up
the next time V talks to her. `pin` and `squad` are not built.

Never: quest facts, journal entries, the game's quest markers and objective tracker, the game's characters, scenes or dialogue choices.

### 7.5 How packs fit the other systems

* **Eddies**: the stage's `ask` becomes the turn's money note ("you need 6,000 for the ransom; if V offers it, take it"); V's words make the
  proposal as today; the ledger entry carries the story id, so Eddies' "owes" lines and the pack agree. The pack never moves money itself.
* **Invitations**: a `meet` is an ordinary appointment with a reason, so the travel, waiting, "stood up" and memory work as they do now, and the
  `meet:met` / `meet:stood-up` outcome moves the pack.
* **Phone**: `text` beats appear in the Chat thread; V's replies there are pack turns like any other (channel `phone`).
* **Holocalls**: a pack turn too (channel `holocall`); a stage can ask V to call.
* **Housemates**: a housemate is an own copy at home, so a pack can play out in V's apartment; `meet.where: home` means V's place where she lives.

## 8. The plot-safety gate

A pack (and from phase 3 any personal favour) may start only when all of these hold, checked in the bridge on the turn:

1. **The character's story is done.** Every path in `requires.questsFinished` is in the journal inventory with state `succeeded` or `failed`
   (`questsSucceeded`: `succeeded`), and the inventory's history and active lanes are `complete` (a partial or pending inventory: no start).
2. **None of their quests is active.** No quest whose path starts with a `notActive` prefix is `active`. Each character's arc data lists its own
   prefixes, and the validator adds them when the pack does not.
3. **The main story is not at its end.** No quest under `quests/main_quest/act_01/q114`, `q115`, `q116` (the point of no return and the endings)
   and none of the Phantom Liberty finale paths is active; after an ending (the post-credits reload) packs work again.
4. **Not now**: no scene, dialogue choice, combat, game call or vehicle chase (the turn's battle and frame flags, the same busy test Eddies uses
   before moving money).
5. **Ours**: V is talking to one of the mod's own copies or channels. The game's own story character never starts or moves a pack.
6. **Settings**: Story packs on (phase 2 row), Character bonds on; a pack with an `ask` needs Eddies with characters, a `meet` Immersive
   invitations (a stage whose system is off is played as talk: "she says she'll sort the meeting out herself").

A pack in progress pauses (no new stage, no timer runs out) while any of 2 to 4 is false, so a new quest of the character that starts later (a
DLC, a gig) never collides with it. Missing data always means no: a zero fact, an unknown quest, a missing inventory.

## 9. Generated favours: quests from conversation

### 9.1 What the engine can do, honestly

| Possible now, with systems the mod has | Possible, not yet tried by the mod | Not possible (or not allowed) |
|---|---|---|
| talk and text beats with memory and consequences in the character's later talk | map pins at a place (`MappinSystem`) | new journal quests with generated text: journal entries are cooked game resources with fixed localized text; an extra archive tool can merge new entries, but only fixed hand-written ones, it would add a requirement the mod dropped, and activating them means quest system calls the mod has never made |
| meet at a place and time (Immersive invitations) | giving and taking non-money items (`TransactionSystem`) | the game's objective tracker and quest markers (driven by the quest system and journal) |
| eddies both ways (Eddies) | a parked car spawned for V to find (the invitation car code) | new scenes, cinematics or voiced game lines |
| the character drives V somewhere (chauffeur) or rides with V | a small hostile group at a place (the ambush squad spawner) | changing the game's story characters or quest outcomes, writing quest facts |
| a companion's outfit from her own appearances | checking that V reached a district (`PreventionSystem` district, already read per turn) | photo mode results, new map areas, new interiors |
| talking to a kind of ordinary NPC in a district (the archetype route) | | anything that needs a model to judge whether V did it |

A favour the game cannot check is just talk; that is fine and still has memory, but it is not a quest. The rule: **a favour is a quest only when
the game can tell it is done.**

### 9.2 The favour templates (phase 3)

The bridge picks a template on a turn where the character, at bond 4 or more, has a reason to ask (the dice, at most one open favour per
character, none while a pack is active); the model only words the request and the thanks.

| Template | What she asks | Done when (the game checks) | Reward |
|---|---|---|---|
| `meet-me` | "come to Lizzie's at 22:00" | the invitation's `met` | bond +6, she remembers |
| `ride` | "drive me to the Afterlife" | she is in V's car and V's district is the named one, then she gets out | bond +8 |
| `lend` | "can you spot me 300?" | the Eddies proposal is done | Eddies' own record |
| `bring` | "grab me a bottle of Champaradise" | V gives her an allowlisted item V has (the turn's words plus `takeItem`) | bond +6, sometimes eddies back |
| `ask-around` | "ask a Valentino in Heywood about Jaime" | V talks to an ordinary NPC of that kind in that district (the archetype route reports kind and district) and tells her | bond +8 |
| `come-by` | "come by tonight" (a housemate or visitor) | V is at her place in the window | bond +6 |

Higher levels choose bigger versions (more eddies, farther places, the "serious favour" wording at 7). A refused favour costs nothing; an accepted
one that times out costs 5 points and she mentions it once. The templates and their words live in data; the 15-language screens of "yes / no /
never mind" from Immersive invitations and Eddies read V's answer.

### 9.3 What the model writes and what it does not

The model writes the request, the reaction and the thanks, in character, in V's language. It does not choose the template, the place, the sum,
the item or the reward, and nothing it writes completes a favour. That is what keeps it working the same on Convai, Mistral, Local AI and Custom,
and on small local models.

## 10. Recruiting pedestrians

The owner's exception of 2026-10-29: an ordinary pedestrian talked into it may follow V.

* **Who**: ordinary people only, the resident kinds (`npc-resident-*` and the two residents): street, corporate, nomad, homeless, nightlife,
  worker, Dogtown. Never a named, story or quest character, a vendor, a fixer, police or a faction soldier, a child or an android
  (`characterCatalog.protectedReason` and the archetype kinds already say which). Whether gang members and mercenaries may be hired too is an owner
  decision (section 16).
* **How**: V asks in plain words ("come with me", "I could use a hand", "want to make 200 eddies?"). The bridge reads it like the follow offer of
  companions (`followOffer`, extended to ordinary NPCs only while the setting is on), and decides from the person's kind (a homeless man comes for
  eddies, a corporate never), Street reputation in the district (respected: more willing), money offered (paid on joining through Eddies, the
  recruit counts as one of V's copies once joined), and threats (a frightened person complies with an order but does not follow). The model is
  told the decision, as for NPC reactions.
* **What happens**: the mod's existing world-character stand-in (`mod/companion-adoption.lua`, disabled today, "a managed stand-in copy from a
  non-crowd clone of the record, the original hidden, restored when V is far or looking away") is enabled for this one case. The recruit is a
  temporary party member: follows, talks with the archetype voice and a name from the NPC name pools, rides along, and in a fight does what their
  kind does (a resident hides, a street kind punches; no weapons handed out).
* **How long**: until V dismisses them, one game day, a load, a main or side quest becoming tracked, or a scene starting: then they say goodbye
  and walk off (the companion leave walk), and the original comes back where it was.
* **Limits**: at most 2 recruits at once, none during quests or scenes, none in combat, none while wanted (heat 2+). Recruits are not invitable
  later (no memory beyond the session in phase 4).
* **Cost**: a recruit is a party member, the same frame cost as a companion; nothing runs while the setting is off.

## 11. Every provider

| | Convai (shared key) | Convai (own key) | Mistral | Local AI | Custom |
|---|---|---|---|---|---|
| Bond line | dynamic info | dynamic info | world part | world part | world part |
| Talk points, threats | from V's words | same | same | same | same |
| Pack notes and choice tags | dynamic info, tags stripped | same | volatile notes | same (small models: notes kept short) | same |
| A pack's phone text at a stage start | **the fixed line, no model call** | generated in her voice | generated | generated | generated |
| Favour wording | the model, inside V's own turn | same | same | same | same |
| Memory of an ending | the note (Convai learns from real turns only) | same | note plus synthetic exchange | same | same |

The 500-a-day cap: everything here rides on turns V starts, except the stage-start phone text, which uses the pack's fixed line while the shared key
is in use. A pack never adds a second model call to a turn.

## 12. FPS and latency

| Work | Where | Cost | When |
|---|---|---|---|
| The bond block on a turn | Lua | one boolean (setting), one `ownCopy` lookup | per private turn, setting on |
| Bond and gate | bridge | a Map lookup, a pass over the turn's parsed journal rows for the character's arc (tens of paths, memoised per inventory revision) | while the context is built (well under 1 ms) |
| The bond line | bridge | one string | per turn |
| Recording the exchange | bridge | a threat screen of V's words (already run for ordinary NPCs), a few additions | after the reply is published, never in front of it |
| Saving | bridge | an atomic write, debounced 10 s | after changes |
| The level notice | Lua | a read of `runtime/bonds-status.json` (under 2 KB) at 1 Hz | only for 30 s after a turn to a named character, stops at the first change; none while off |
| Packs (phase 2) | bridge | the same kind of pass as the gate, plus a note | per pack turn, while the context is built |
| V's words as a choice (phase 2) | bridge | a few regular expressions over one line | after the reply is published |
| Pack effects (phase 2) | Lua | one small file read (a car decision), one read per status change (items, outfits) | at a car decision, or in the 30 s watch after a turn; not per frame |
| Relationships page (phase 2) | Lua | one cached read of the status file (5 s) | when the page opens |
| The status file (phase 2) | bridge | one atomic write of a few KB | after each recorded turn, after the reply |

No new stage on the turn stage clock: the work sits inside `promptBuilt` (the context build) and after `published`. Phase 2 was to measure
`promptBuilt` with and without a pack note on the Local AI route: **not measured** (no game or Local AI server in the build session). Offline, the pack decision of a turn
costs well under 1 ms (a test asserts it) and the note adds under 1,000 characters to one volatile block; measure on the Local AI route with the stage clock.

## 13. Files, saves and privacy

* `<state>/bonds.json` (bridge, per memory key: warmth, hurt with its game clock, the day counters). Cleared by Forget; kept across saves on purpose.
* `runtime/bonds-status.json` (bridge to game: revision, levels by profile, the last few changes for the notice).
* `runtime/settings.json` `characterBonds` (game, off by default).
* Phase 2: `<state>/bond-packs.json` (pack state, rollback-guarded), `runtime/bond-effects.json` (the effects for the game), `runtime/bond-effects-done.json` (the game's
  list of one-shot items already given, at most 60), `runtime/settings.json` `storyPacks` (off by default). `runtime/bonds-status.json` now also carries the
  characters V has met, the active packs and `effectsRevision`. The pack files ship in the Runtime (`characters/bond-packs/`).
* No player words are stored by bonds: only numbers and dates.

## 14. Phases

1. **Built on `feat/bonds` (this branch)**: the bond model (`bridge/bonds.mjs`, story part from the journal, romance and Eddies; shared part with
   caps, threats and fading hurt; the store with Forget), arcs for 12 characters (`bridge/bond-arcs.mjs`), the prompt line on every provider,
   the Companions setting **Character bonds** (off by default), the level notice (`mod/bonds.lua`, `bond-level`), the pack format, validator and gate
   (`bridge/bond-packs.mjs`) with the three example packs as data (`characters/bond-packs/`), validated by tests but not run in the game (neither
   ships in the Runtime yet: nothing imports them outside the tests). Ships: `bridge/bonds.mjs`, `bridge/bond-arcs.mjs`, `mod/bonds.lua`. Unit
   tests only; nothing seen in the game.
2. **Story packs run (built, section 17)**: the pack runner (start, notes, choices from V's words, ledger and meeting outcomes, timers, endings, state with the rollback
   guard), the Eddies `story` link, `vehicleBlocked`, `outfit` and `giveItem`, the Relationships page, Eddies trust from the bond, group turns get the speaker's own line, Phone
   Chat turns count. Settings > Companions > Story packs (off by default). The three example packs ship; more drafted per character and reviewed.
   Not built from the first plan: `meet` started by the pack, the `text` and `call` beats, the synthetic memory exchange of an ending, tags in replies (replaced by V's words).
3. **Favours** (section 9) and the higher-level unlocks (texts first at 6, confidences at 8, the keepsake at 10); time together and invitations as
   bond events; items (`giveItem`, `takeItem`) after a live check of the transaction calls with non-money items.
4. **Recruits** (section 10), then the riskier pack effects (`pin`, a spawned car to find, `squad`), each behind its own row.

## 15. Example packs

The three packs below are in `characters/bond-packs/` in the format of 7.2 and pass the validator. Their fixed lines are English; the menu
languages come in phase 2 with the runner.

### 15.1 Panam: "Ransom for the Mackinaw" (`panam-truck-ransom`)

Gate: bond 5, `sq027_02_raffen_shiv_attack` (Queen of the Highway) finished, no `sq027`, `sq004` or `q114` quest active, Eddies on. Channels: in
person (own copy), phone, holocall.

1. **`ask`** (start). Panam's truck was taken from outside a bar in the Badlands by a scav crew who know whose it is; they want 6,000 eddies or
   they strip it. She is furious and embarrassed (Aldecaldos do not lose their rides), and her pride makes her ask V sideways. She can tell V who
   took it (a scav crew working out of a junkyard near Rocky Ridge), why she will not go in shooting alone (they have her truck and the clan is
   away), and that she will pay V back. Effect: `vehicleBlocked` (she walks to meetings and cannot drive V in her truck). Choices: V lends the
   6,000 (`eddies:loanFromV`) -> `repay`; V offers to go get it back with her (tag) -> `recover`; V refuses or says to let the clan handle it (tag)
   -> `alone`. Timer 48 game hours -> `alone`.
2. **`recover`**. They plan it: she wants to meet V near the junkyard at night. `meet` at V's waypoint in 3 game hours (V sets it), wants:
   "meet me there, come armed". `meet:met` -> `back` (in phase 4 a `squad` could guard the truck; in phase 2 the scavs "scatter when they see two of
   you" and she drives it out); `meet:stood-up` -> `alone`.
3. **`repay`**. She paid the scavs; the truck is back (`vehicleReturned`). Over the next game days she pays V back in parts (an Eddies `repay` beat
   per day she is talked to, 2,000 each). Ends when the debt is clear -> ending `repaid`.
4. **`alone`**. She got it back her own way: traded a favour with a rival clan, which costs her. A little cool with V. `vehicleReturned` -> ending
   `alone-end`.
5. **`back`**: the truck is back and she is in a great mood -> ending `together`.

Endings: `repaid` (bond +60): "V lent you the 6,000 when the scavs took your truck, and you paid every eddie back." `together` (+80): "V went with
you to the junkyard and you took your truck back together." `alone-end` (-10): "When the scavs took your truck V would not help; you got it back yourself, and it cost you a
favour to a rival clan." (The file's wording is the reference; the sentences here are shortened.)

### 15.2 Judy: "Dressed for Dinner" (`judy-dinner-dress`)

Gate: bond 6, `sq030_judy_romance` (Pyramid Song) and `sq026_04_hiromi` (the last of the `sq026` chain) finished, no `sq026`, `sq030` or `q105`
quest active. Channels:
in person, phone, holocall. No money. Two variants by relationship: as V's partner it is their evening; as a friend she is back in the city for a
few days (if she left after Pyramid Song) and wants V's honest eye.

1. **`invite`** (start). Mox friends are throwing a small dinner party at Lizzie's back room; Judy has a dress she has never worn (she bought it
   for something that never happened) and is nervous about it, which annoys her. She asks V to come by and tell her honestly whether it works.
   `meet` here in 2 game hours ("at my place" when she is a housemate). Choices: V says yes (tag) -> `dress`; V can't (tag) -> `rain-check`;
   `meet:stood-up` -> `rain-check`. Timer 24 game hours -> `rain-check`.
2. **`dress`**. She shows V the dress (`outfit`: her party copy wears one of her other appearances for this stage, when the character has one;
   otherwise she describes it). What she wants: V's honest answer, not flattery; she can tell flattery. Choices: V is honest, kind or teasing
   (tag `honest`) -> `dinner`; V just flatters her (tag `flatter`) -> `dinner` with a note she half-believes it. Timer 6 game hours -> `dinner`.
3. **`dinner`**. She asks V to come along to the dinner itself (as a plus-one or "moral support"). `meet` here in 1 game hour. `meet:met` ->
   ending `together`; refusal or no show -> ending `dress-only`. Timer 8 game hours -> `dress-only`.
4. **`rain-check`**: she goes without V, texts a photo description and "you missed a hell of a night" -> ending `missed`.

Endings: `together` (+70): "You wore the dress to the dinner at Lizzie's, and V came with you." `dress-only` (+40): "V came over and told you what
they really thought of the dress." `missed` (-5): "V could not make it to the dinner; you went anyway."

### 15.3 Kerry: "Something New" (`kerry-new-song`)

Gate: bond 6, `sq028_kerry_romance` and `sq017_kerry` finished (his Holdin' On and A Like Supreme arc), no `sq011`, `sq017` or `sq028` quest
active. Channels: phone, holocall, in person. No money, no world effect: a pack that is only talk and a meeting, to show that shape.

1. **`text`** (start, by phone at 3 in the morning game time when allowed, else in his next talk): he wrote something, the first thing in years
   that is not a Samurai song, and he hates that he wants V to hear it first. `text` beat (fixed line on the shared key). Choices: V says come over /
   I'll come (tag) -> `listen` with `meet` at his villa or V's place; V says not now (tag) -> `later`. Timer 24 game hours -> `later`.
2. **`listen`**. He plays it (describes it: a slow, ugly-beautiful song about outliving everyone). He wants an honest opinion and will know if he
   doesn't get one. Choices: V is honest, critical or not (tag `honest`) -> `rework`; V is only nice (tag `nice`) -> `doubt`. Timer 6 game hours
   -> `doubt`.
3. **`rework`**: he takes the criticism badly for a minute, then he is grateful; over the next days he texts that he rewrote the bridge -> ending
   `setlist`.
4. **`doubt`**: "you're just being nice, V"; he plays it for nobody else -> ending `drawer`.
5. **`later`**: he sends it as a file with "whenever" -> ending `file`.

Endings: `setlist` (+80): "V was the first to hear your new song and told you the truth about it; it made the setlist." `drawer` (+20): "V heard
your new song and was only nice about it; it is still in a drawer." `file` (+10): "You sent V your new song; you never heard what they thought."

## 16. Decisions for the owner

Settled by the owner on 2026-10-29: all seven as recommended below (talk part from memory, story part from the save; warmth never decays, hurt fades over 10 game days; level notice on, with the number and title; residents only as recruits; no journal entries; squads later).

1. **Should the bond follow the memory or the save?** Recommended: as built, the talk part follows the memory (no contradiction with what the
   character remembers), the story part and packs follow the save.
2. **Decay**: recommended as built, warmth never decays and hurt fades (10 game days). The alternative (slow decay without contact) punishes a
   player who plays with other characters.
3. **The level notice**: recommended on. Alternative: silent, the Characters page only.
4. **Numbers**: recommended "level 5, Good friend" in the notice. Alternative: the title only.
5. **Recruits**: residents only (recommended for the first build), or gang members and mercenaries too, as hired help.
6. **Journal entries for hand-written packs**: recommended no (an extra requirement, fixed text only, quest system calls the mod has never made);
   the Characters page lists active packs instead.
7. **Squads in packs** (the people holding Panam's truck): recommended later and behind its own row; phase 2 resolves that stage by talk.

## 17. Phase 2 as built (2026-10-30)

### 17.1 What works, offline
Tested without the game (`bridge/bond-pack-runner.test.mjs`, `bridge/bonds.test.mjs`, `bridge/bonds-lua.test.mjs`, the Eddies, manager, companion and invitation tests):
the gate and the dice, notes, V's words as choices in several languages, the Eddies story link (ask, a tagged proposal, repay beats, the debt clearing the pack), meeting outcomes,
timers, endings with the bond reward and the 3-day memory note, the rollback of a pack to an earlier clock, the effects file and its revision, unknown stage types skipped
and logged once, state saved and read back, the status file with the Relationships rows, Eddies trust from the bond level, group speakers and Phone Chat turns in the bond,
the Lua side on a fake game (the block flags, the watch, `vehicleBlocked`, one-shot items, the outfit hooks, the page).

### 17.2 Unverified (needs the game)
* Everything in the game: no pack, effect or page was seen running.
* `GiveItem` / `RemoveItem` with non-money items. The car not offered: the party convoy choice and the invited visitor arriving on foot. The outfit change on a real copy.
* The `busy` flag from the battle sample in a real scene, and whether the journal inventory is complete in time at a turn.
* The Relationships page layout in Native Settings UI and MCM (description limits, the value column), and the sidebar and picker lines.
* The reading of V's words on real talk: the screens are short word lists; a line they cannot place leaves the stage waiting until its timer ends it.
* `promptBuilt` on the Local AI route with and without a pack note (section 12).
* A pack started on Phone Chat: the block reaches the phone request, the note reaches the model, `meet` outcomes arrive as events.

### 17.3 Live checks for the owner (each: do X, check Y)
1. Settings > Companions: turn on Character bonds and Story packs. Check both rows are there, off by default, and the Relationships button sits right after Model browser.
2. Open Relationships before talking to anyone. Check the empty state. Talk to an invited character twice, reopen it. Check one entry with level, progress, warmth, "From their story ... from talking ...".
3. On a save past Queen of the Highway with Eddies with characters on, and Panam as an invited party member at bond 5 or more: talk to her for a while (the dice roll on the first eligible turn of a game day and then every 2nd eligible turn, 5 rolls a day at most). Check the bridge log shows `[BondPacks] pack=panam-truck-ransom started`, and she brings up the stolen truck in that reply.
4. Tell Panam "I'll lend you 6000". Check the eddies move (6,000 leave your wallet), the next turn's log says `stage=repay`, and over the following game days she pays back 2,000 at a time.
5. While the truck is held, ask Panam to drive you, or call a car convoy with her in the party. Check her truck is not used (the fallback car or the next person's is).
6. Start the pack again (another save) and answer "no, sort it out yourself". Check the stage becomes "alone" and, at the ending, her bond falls by 10.
7. Judy (bond 6, Pyramid Song and the sq026 chain finished): when she asks you to see the dress, answer "sure, I'll come by", then give an honest opinion of two sentences. Check the log shows `dress` then `dinner`; check whether she changes clothes (she may have no other look).
8. Load an earlier save while a pack runs. Check the next turn's log rewinds or forgets it, and the held-truck effect is gone.
9. Turn Story packs off. Check no `[BondPacks]` line, no pack note, and the Relationships page shows the bonds without stories. Check the FPS in a crowd is the same with it on and off.
10. Phone Chat: message Judy or Panam once the gate is open. Check the bond log line shows `channel=phone` and a pack can start there.

### 17.4 Defaults picked (the owner may change them)
* Choices are read from V's words after the reply, not from a tag in the reply (reason in 7.3). English plus short lists for the 14 other languages; a line the screens cannot place does nothing.
* The dice are thrown at the pack's `chance` on the first eligible turn of a game day and every 2nd eligible turn after that, at most 5 times per game day per character; the cooldown is 7 game days; at most 2 packs run at once; an ending is remembered for 3 game days.
* A pack requires Character bonds and Story packs both on (Eddies and Invitations when the pack says so); money moves only in person.
* The Relationships page shows stories only while Story packs is on, lists at most 60 characters, and reads the status file the bridge rewrites after every recorded turn.
* Pack titles and stage labels are English data (shown as they are in every menu language). Translating them is a later job.
* Group rounds: every speaker gets its own bond line; only the first speaker records the exchange.
* Phone Chat and holocall exchanges count 3 points; a message the character starts counts none.
* `vehicleBlocked` and the outfit accessors also require Character bonds on.

### 17.5 Pieces the mod already has for the gameplay stages of docs/BOND_QUESTS.md
None of these is a pack stage yet. What exists to build on: **enemies at a place**: the Revenge ambush squad spawner (`mod/revenge-ambush.lua`, `mod/revenge-ambush-world.lua`,
`bridge/ambush-context.mjs`). **Driving a character somewhere**: the chauffeur (`mod/companion-chauffeur.lua`, `mod/companion-chauffeur-native.lua`, `bridge/companion-actions.mjs`),
the companion vehicles (`mod/companion-vehicles.lua`, `mod/companion-vehicle-catalog.lua`) and the invitation car (`mod/immersive-car.lua`). **Follow and escort**: the companion follow
and travel code (`mod/companions.lua`, `mod/companion-travel.lua`, `mod/companion-adoption.lua` for the stand-in copy, `mod/companion-tactics.lua`). **A walk or a hangout at a place**: Immersive
invitations (`mod/immersive-invitations.lua`, `mod/immersive-world.lua`, `bridge/meet-requests.mjs`) and the housemate spots (`mod/housemate-*.lua`). **A rescue**: a squad spawn plus a
follow; nothing spawns a hostage yet. A new stage `type` plus `params` (open in the format since phase 2) is the hook; the runner calls nothing for a type it does not know.
