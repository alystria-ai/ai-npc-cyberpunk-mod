# Quest decisions: does a companion know which choice V made? (2026-10-13)

Research only. Nothing in the mod, the pack or the game folder was changed. Requested in `TODO.md` ("Later check: quest
decisions") and left open by `docs/DYNAMIC_CONTEXT_AUDIT.md` section 7.

## Answer

**Yes, for most of the decisions the reviewed pack covers, and the wording says what V chose, not only what happened.**
It is not complete, and it is not uniform: it depends on whether the game wrote a signal for the branch, on whether the
character is a declared speaker of that rule, and on an 8,000-character budget.

- Today the bridge evaluates **768 reviewed rules** against **355 quest facts and 638 journal entries** read from the game.
  On V's current save 347 of them are true. Examples of what a companion is told, reproduced offline from the live
  snapshot (section 1): "V rejected Maiko's arrangement and removed the Tyger bosses" (Judy), "V accepted Panam's
  invitation to share an intimate experience through the Basilisk's sensory link" (Panam), "V selected Denny when Denny
  and Henry refused to play together" (Kerry), "Evelyn privately offered V a fifty percent cut ... and V answered 'I'll think
  about it' instead of refusing outright" (Evelyn).
- It does not cover the rest. Of 1,162 researched outcomes, 749 are mapped and **413 are not**. Reasons, counted from
  `research/cyberpunk/native-reviews/*-20261005.md`: no native signal 97, no one who could know 95, told-by-V 76,
  ambiguous meaning 49, zero-only 45, shared writer 27, out of scope 12, transient 8.
- The "I did not do X" half is never told. `GetFactStr` returns 0 for an absent fact, so a zero is "unknown", never
  "refused". On this save 187 of the 355 facts are zero and unknown, for example `q003_deal_royce_shoot` and
  `q115_judy_romance_chosen`.
- The one signal for decisions the game does not record (the choice hook) has **never fired in a logged session**.

So the question has two parts. The cheap part is already built: the pack is the curated decision table (section 4.0).
What is missing is mostly ranking and wording (bridge only), a short list of additional facts that needs live
verification, a witness rule for spawned companions, and a ledger for the choices the game leaves no fact for.

## 1. What reaches the prompt today (evidence)

### 1.1 The path

```
mod/world-knowledge.lua   reads 355 facts (QuestsSystem:GetFactStr) + 638 journal entries, paced, rests between scans
mod/knowledge-parts.lua   writes runtime/knowledge-world.json | -active.json | -history.json once per revision
turn (sendRequest)        carries only { part, revision } refs; the bridge rebuilds the snapshot
bridge/world-knowledge.mjs resolveKnowledge: pack rules x snapshot -> true rules -> audience filter -> rank -> 8,000 chars
bridge/quest-context.mjs  puts the statements in the context string; Convai and Mistral get the same string
```

`last-input.json` is now small. The installed copy (2026-10-12 19:19Z, Judy, "is it") is **6 KB**, not the 796 KB the
audit measured: the world snapshot is a `{part: 'world', revision: 2}` reference, and `journalHistory` is lane ids only.
So the decision data is in `knowledge-world.json` (150 KB, 2026-10-13 00:48), not in `last-input.json`.

No file in `runtime/` stores the final prompt, so what a character was told is **reproduced, not read back**: I ran the
bridge's own `resolveKnowledge` (unchanged) over the installed `knowledge-world.json` and the shipped
`characters/world-knowledge.json`, per addressee, `maxChars` 8,000. The statuses match the live `knowledge-status.json`
(`rules: 768`, `currentWorld: true`) and the live `bridge-latency.json` shows `knowledgePreparedMs` 147 to 231 ms, so the
step runs on real turns.

### 1.2 What each character gets on V's save (game day about 108, mid-game, no ending reached)

| Character | True rules | Told (selected) | Kept out by audience | Dropped by budget |
|---|---:|---:|---:|---:|
| Judy | 347 | 15 | 330 | 0 |
| Panam | 347 | 21 | 324 | 0 |
| Johnny | 347 | 27 | 52 | 266 |
| Jackie | 347 | 14 | 331 | 0 |
| Takemura | 347 | 9 | 336 | 0 |
| Kerry | 347 | 7 | 338 | 0 |
| River | 347 | 4 | 341 | 0 |
| Evelyn | 347 | 1 | 344 | 0 |
| Hanako | 347 | 0 | 345 | 0 |
| Regina | 347 | 16 | 277 | 52 |

Choices that are in those statements: Judy 11 of 15 and Panam 9 of 21 belong to a decision point with two or more
researched outcomes (a rough test, section 4.1). Johnny's 27 are the ones that fit; 266 more are true and omitted.

### 1.3 How the rules are built

- A rule is `{condition, statement, audience, evidence}` (`characters/world-knowledge.json`, 9.3 MB). 769 carry a
  category: **decision 666, quest 71, relationship 32**. Conditions are facts (319 `gte`, 213 `eq`) or journal states
  (651 `succeeded`, 290 `active or succeeded`, 15 `failed`, 10 `active`). 189 rules are fact-only, 373 journal-only,
  207 both.
- The framing the model sees says "Missing information is unknown, not a rejected choice" and "Do not invent hidden
  stages, memories or future decisions" (`bridge/world-knowledge.mjs`, `FRAMING`).
- Audience: each rule names `speakers`, a `perspective` (participant 633, private 70, told-by-v 41, witnessed 24,
  public 1) and `recipients`. 70 characters speak at least one rule. Johnny hears V's participant, witnessed and private
  rules through `research/cyberpunk/native-cowitness.json` (except the early quests and the Devil, Star, Sun and 2079
  epilogues).
- **"Decision" is a category, not a test for a choice.** Many of the 666 are events ("V and Judy got Evelyn out of the
  scavenger braindance studio", "Mitch and Scorpion stayed at camp to repair the generators"). That is fine for
  continuity, but it means a 50-to-150 table of choices cannot be read off the category.

### 1.4 Does the journal already encode choices?

Partly, and the pack already uses it. A branch that has its own objective only succeeds on the route taken, so
`journal:<entry> eq succeeded` is a decision proof: "V and Takemura began cooperating" (`jt.takemura-alliance.agreed`,
`jt.resurrection.alliance`), "V took the shard and the money" (`ah5.corpo-rat.take-shard`, `take-money`), the Big Race
route (`jr5.big.route.pursuit` against `route.finish`), and 52 phone-reply entries
(`gameJournalPhoneChoiceEntry`, for example `cc5.the-distance.reply-yes` and `reply-no`, Regina's alive and dead
reports). Limits: a quest title or a succeeded quest proves no choice (the journal-history framing says so), a branch
that shares its objective with the other branch proves nothing, and `failed` is rare (2 of the 345 revealed entries on
this save).

### 1.5 The moment of choice

`mod/game-dialogue.lua` stores V's picked option for 180 seconds ("V chose the dialogue option '...'",
`bridge/game-dialogue.mjs`). It is the only text of an actual choice and it is never kept. The first-sighting log lines
added on 2026-10-12 show, in the installed `probe.log`, `hook show fired`, `hook event fired` and `hook hubs fired`
(2026-10-12 11:15Z and 19:14Z). **There is no `hook choice fired` line among the 14 `Game dialogue` lines**, and no
`game-dialogue-probe.json`. Either V picked no scripted option in those sessions or `PreventionSystem.OnPlayerChoice` is
not called for dialogue picks. That is unproven either way; it needs the probe in section 6.

### 1.6 Stored decisions: inactive

`quest-memory.mjs` and `knowledge-service.mjs` can store true rules as events and replay them as "historical" context
(8 events, 2,400 characters). It needs a verified save identity (`fact-identity.lua`, default off). The live
world snapshot carries `identity: unknown`, and `knowledge-status.json` shows `identifiedMemory: true` with
`memoryMode: natural-conversations`, which I did not trace further. Treat the ledger as inactive.

## 2. Where decision data comes from

| Source | What it gives | Confidence | Notes |
|---|---|---|---|
| The pack's `factAllowlist` (355) | Quest fact names with writer evidence (`writers[].jsonPath/jsonPointer`) from the installed 2.31 assets exported with WolvenKit, plus the sentence and audience | **High** (checked against 9 saves from 5 playthroughs, `QUEST_OUTCOME_COVERAGE_2026-10-05.md`) | 350 of 355 are used by a rule |
| The pack's `journalAllowlist` (638) | Journal paths of quests, objectives and phone entries (`nativePath`, `nativeClass`) | **High** | 295 objectives, 116 quests, 174 phone messages, 52 phone choices |
| Examples of verified decision facts | `q003_deal_royce_shoot`, `q003_deal_royce_knocked_out`, `q003_militech_chip`, `q003_militech_refused`, `q005_01_dex_knows`, `q005_01_dex_takes_60`, `q005_01_dex_takes_45`, `q005_jackie_to_mama`, `q005_14_body_at_victors`, `q110_08a_netwatch_deal` (1 refused, 2 accepted), `q112_oda_dead`, `q112_takemura_dead`, `q115_judy_romance_chosen`, `q115_panam_romance_chosen`, `q115_river_romance_chosen`, `q115_did_it_solo`, `q115_rogue_in_av`, `q116_saul_dead`, `q116_smasher_shot`, `q201_ice`, `q201_earth`, `q202_05_talked_about_plan`, `q203_fact_lover_says_goodbye`, `q204_done`, `q305_songbird_alive`, `q305_fact_songbird_dead`, `q306_reed_killed`, `q306_somi_betrayed`, `q306_train_reed_called` (1 and 2), `sq021_good_farm_chosen`, `sq029_river_shot_down`, `sq024_end_at_santo_domingo`, `sq012_fact_holt_killed_mayor`. All 33 are in the allowlist (checked) | **High** | Value semantics are in the rule conditions |
| Relationship receipts (`mod/relationship-state.lua`, 11 facts every 2 s) | Romance and relationship flags: `sq030_11_romance`, `sq030_judy_lover`, `sq030_friendship`, `sq027_panzer_sex`, `sq027_panam_lover`, `sq029_river_lover`, `sq028_kerry_relationship`, `sq028_kerry_dislike`, `q003_stout_sex_done` | **High** | A separate path (`romance-context.mjs`) |
| Fact dictionary (`research/cyberpunk/cache/game/index/facts-dictionary.json`, 10 MB, gitignored build input) | 13,805 fact names that appear in exported quest and journal resources, with counts of assignments and comparisons. Its own label: "Extracted names, not interpreted decisions" | **Low as meaning, high as a name list** | Quest graphs only: scene-written facts are missing (`q201_ice` is absent, `q115_judy_romance_chosen` has 14 reads and no graph writer). About 5,180 names with a quest-like prefix are read by a condition, 4,953 are not allowlisted, about 3,700 remain after a crude plumbing filter. Discovery is not the hard part, meaning is |
| Native review notes (`research/cyberpunk/native-reviews/*-20261005.md`, 413 unmapped outcomes) | Per outcome: why it has no rule | **High** | The to-do list for section 4.2 |
| Game API (`GAME_DATA_AUDIT.md`, pinned CDPR script docs) | `QuestsSystem.GetFact(CName)`, `GetFactStr(String)`, `RegisterListener(factName, listener, funcName)`, `OnFactChanged`. No list-all and no existence check | **High** | The 2.31 script cache holds `OnPlayerChoice`, `OnDialogsSelectIndex`, `OnDialogsActivateHub`, `OnDialogsData`, `OnFactChanged`, `RegisterListener` (string search; existence only, behaviour unproven) |
| Public wikis and guides | Consequences described in prose, no fact names | Not used | Never cite a fact name from prose |

No `tools/` folder exists. The fact list the pack uses is `characters/world-knowledge.json` plus the local index above.

## 3. Gaps, measured

1. **Branch points not fully mapped.** The research links each rule to a decision point (`narrativeLinks.decisionId`).
   231 decision points have two or more outcomes: **162 fully mapped, 45 partly, 24 not at all**. The 24 include
   `arasaka-heist.dex-betrayal`, `.frank-fate`, `.smasher-fate`, `.dumdum-fate`, `.placide-fate`, `.takemura-assistance`,
   `aldecaldos.pete.resolution`, `.mia.jason`, `city-contacts.bana.katya-fate`, `.reno.fate`.
2. **Real signal gaps (examples with the reason, from the review notes).** Oda's fate: only the positive `q112_oda_dead`
   exists, no alive marker. Pete's fate: `ina_02_big_pete_spared` is written by the paid and unpaid choices alike. Smasher
   (Aldecaldo route): one option, no fate fact. Frank: scene conditions combine killed, defeated and unconscious. Royce
   alive: `q003_royce_dead` has several writers. Those need a choice ledger or a save-diffed journal node, not a table row.
3. **Wrong audience.** `jt.report-evelyn.disclosed` ("V told Dex about Evelyn's proposal to cut him out") has
   `speakers: [jackie-welles]` only. Dex, who heard it, is not told, and Evelyn is told only her own offer. Dex has 6
   speaking rules, Evelyn 1. This is a pack fix, not a new mechanism.
4. **Spawned companion not at the scene's declared cast.** A mod-spawned Panam beside V during a vanilla scene learns
   nothing from it unless she is a declared speaker. Hanako has 12 speaking rules and none is true on this save.
5. **Budget.** Johnny: 266 true and allowed rules omitted. Regina: 52. Nothing marks a choice as more important than an
   event when the 8,000 characters run out.
6. **Kerry's rooftop romance.** `q115_judy_romance_chosen`, `q115_panam_romance_chosen` and `q115_river_romance_chosen`
   are allowlisted. `q115_kerry_romance_chosen` is in the dictionary with 11 reads and no graph writer, the same shape as
   its siblings (written by a scene), and is **not allowlisted**. Unverified (section 4.2).
7. **Small:** Jackie's 14 statements hold 3 exact duplicates (337 characters; two rules with the same text).

## 4. Design

### 4.0 Principle: extend the pack, do not build a parallel table

The user's idea (a curated table of 50 to 150 decision facts mapped to plain sentences, read on demand, filtered per
character) is what `characters/world-knowledge.json` already is, at a larger size and with evidence checks, tests and an
audience model (355 facts, 768 rules, 70 speakers). A second table would duplicate conditions and drift. So the work is
four small steps on top of it, cheapest first. Each step stands alone.

### 4.1 Step A: bridge only, no CET reload (hours)

1. **Mark choices.** At pack load, flag a rule `branch: true` when any of its `narrativeLinks.decisionId` has two or more
   outcome keys (428 of 769 rules today; a crude test, because "completed against skipped" counts). No change to the
   file; derive it in `preparePack`.
2. **Rank and word them.** In `rank()` give `branch` rules a bonus and render them in their own heading in the context
   ("Choices V made" before "Things that happened"). Keep the existing framing. Reserve about 40 percent of the 8,000
   characters for the first group so Johnny and Regina keep their choices when events crowd them out.
3. **Drop exact duplicate statements** per addressee (Jackie: 3, 337 characters).
4. **Profile `resolveKnowledge`.** Live `knowledgePreparedMs` is 147 to 231 ms per turn; offline it is 190 to 230 ms for
   768 rules. A CPU profile of my offline loop put the largest self time in `decoded()` (re-measuring the whole snapshot
   with `JSON.stringify` and parsing it), not in rule evaluation (`evaluate` and `serialize` are small). Fixing that is
   latency work, independent of this feature, and keeps adding rules cheap.

### 4.2 Step B: more decision rows in the pack (days, needs a CET reload for new fact names)

Add only what survives verification; do not trust a name:

1. **Pick the targets** from the 24 unmapped and 45 partly mapped branch points, by who is likely to be asked
   (Takemura, Oda, Dex, Smasher, Kerry, the Devil route) and by reason code: zero-only (45) and ambiguous (49) are the
   solvable ones; shared-writer (27), no-speaker (95) and out-of-scope (12) are not.
2. **Find a signal** with the existing offline tools: `research/cyberpunk/scripts/save_snapshot.mjs` and
   `evaluate_save_knowledge.mjs` on two saves that differ only in the branch, then export the scene or phase that writes
   it (`extract_scene_evidence.py`) so the pointer is hash-bound like the other rows. The pack's own rule is "a
   publishable rule needs a cited path" (`GAME_DATA_AUDIT.md` section 5).
3. **Candidates (all unverified):**

| Candidate | Where it appears | What is known | What is missing |
|---|---|---|---|
| `q115_kerry_romance_chosen` | facts dictionary: 11 reads, 0 graph writers | Siblings for Judy, Panam and River are allowlisted and written by q115 scenes | The scene export, a save with the choice made, and a save without |
| `dlc6_slept_with_kerry` (2 writers), `dlc6_kerry_sleep_hack_done` (1) | facts dictionary, assignments in quest graphs | Names only | Meaning, quest, and whether it overlaps `sq028_kerry_relationship` |
| `q113_atrium_takemura_talked`, `q113_hanako_jungle_talked`, `q113_ceo_floor_takemura_done` | facts dictionary, 1 assignment each | Names only; they sit in the Arasaka tower quest | Whether any is a branch marker or an unconditional beat (the review notes call such beats "not branches") |
| `q201_judy_call`, `q201_kerry_call`, `q201_panam_call`, `q201_river_call`, `q201_victor_call`, `q201_hanako_call` | facts dictionary, 0 writers | Names only | The pack already covers the Devil calls through journal entries (`endings.devil.judy-orbital-call`); likely redundant |

   Do not add a name from this list to the allowlist, or a sentence to a rule, until a save diff shows the value flips on
   the branch.
4. **Fix audiences** that name too few speakers (gap 3, Dex), after checking each statement still reads right for the new
   speaker.
5. Limits: the allowlists stop at 1,024 per inventory (facts 355, journal 638), so there is room for about 669 more
   facts and 386 more journal entries. `npm run test:knowledge` and `npm run test:research` guard the pack.

### 4.3 Step C: who plausibly knows (audience), generalised

Today: declared speaker, plus Johnny's co-witness list. Proposed, in order of safety:

1. **Keep the declared audience as the floor.** Nothing below may remove it.
2. **Witness receipts for spawned companions** (optional, later). When a scan sees a decision rule newly true, record
   which spawned companions were within 15 m (`companions.conversationCandidates(player, 15)`, no engine query) in a
   small per-world table, and let those companions hear that rule. Constraints: the scan runs at most about 30 seconds
   late (a journal change triggers one within about 1 second), so the receipt is approximate; the table is keyed by
   world token, so a reload discards it and the character falls back to the floor (safe direction); and the sentence
   is written for its declared speaker ("Jackie and T-Bug heard the disclosure"), so a receipt may only widen a
   rule whose perspective is `witnessed` or that gets a neutral second wording. That is why it is optional.
3. **Hearsay** (`told-by-v`, 41 rules fire never, 76 outcomes unmapped) stays off until a transcript-based receipt exists.
   The honest alternative is the existing "V told" rule: if V says it in chat, the memory path records it.
4. Romance and relationship rules keep their relationship gate (`romance-context.mjs`).

### 4.4 Step D: a decision ledger for choices the game leaves no fact for

Use the choice hook already in `mod/game-dialogue.lua`, after it is proven (section 6, probe 1):

- **Record per choice (event, not per frame):** game time (`gameTimeSeconds`, already read per capture), tracked quest
  id and title (`questContext`), hub title, option text (localised, capped at 120 characters), option index, the
  `present` list the hook already builds. Cap 40 entries; write `runtime/decision-ledger.json` only when a choice is
  made, in place, in the style of `knowledge-parts.lua`.
- **Rollback guard:** drop entries whose game time is later than the current game time (loading an earlier save), and
  key the file by world token. No save identity needed for that case.
- **Render:** the bridge shows at most the last 5 choices relevant to the addressee ("V chose ..."), inside the same
  8,000-character budget, with the standing "missing is unknown" framing. Relevance: the addressee was in `present`, or
  is a declared speaker of the tracked quest's rules.
- **Do not store option text as fact.** It is a quote of an option V picked, not an outcome: say "V picked the option
  '...'", and let the other facts say what followed.

### 4.5 Not recommended: reading the table only at turn time

A turn-time read of 100 to 150 facts is real work in the frame V presses Enter (section 5), and the paced scan already has
the values ready. The scan is paced and rests (since `843a527`), so adding to it costs no per-frame work.

## 5. Cost

Assumed unit cost: **about 58 microseconds per read through CET**, from the 2026-10-12 whole-callback measurement
(`docs/PERFORMANCE_NATIVE_PLAN.md`, section 4: 58 ms/s over roughly 1,000 reads/s; it mixes fact and journal reads, so a
fact read is probably cheaper).

| Item | Calls | Time |
|---|---:|---|
| Today's scan | 993 reads (355 facts + 638 journal) | about 58 ms per scan, paced at up to 32 per frame or 2 ms; every 30 s idle, plus a journal change (1 s debounce), composer open, talk key, phone chat open |
| **+100 decision facts in the same scan** | +100 `GetFactStr` | **about +6 ms per scan** (+10 percent); 3 to 4 extra frames at the existing pace; about +0.2 ms/s averaged at one scan per 30 s |
| +150 | +150 | about +9 ms per scan |
| The same 100 at turn time instead | 100 | about 6 ms in one frame, every turn: avoid |
| Step D, per choice | 0 native reads beyond the hook | one small file write per choice |
| Bridge, per turn | 0 | `knowledgePreparedMs` 147 to 231 ms today; rule evaluation is linear, so +100 rules is roughly +25 ms by the 0.25 ms per rule average (an upper bound: the profile says most of the cost is snapshot decoding, section 4.1) |
| Pack size | none | about 12 KB per rule all-in (9.3 MB over about 770 rules), so +100 rules about +1.2 MB; the bridge parses the pack once (about 0.4 s) and warms it (about 0.3 s) |
| Prompt | none | the 8,000-character cap holds; a choice sentence is 100 to 250 characters |

Standing caution (FPS is the top priority): the latest `perf-probe.json` (150 windows of 2 s, game at 13 to 21 FPS in the
windows with spikes) shows `worldKnowledge.update` averaging 7 ms/s and `journalHistory.update` 18.7 ms/s, with single-call maxima of
46 ms and 61 ms. Those are scan windows, and the journal lane is the heavier of the two, so new reads should go in the
fact scan, paced, not in the journal lane. Check the maxima before and after (probe 3).

## 6. What needs a live probe in game

1. **Does the choice hook fire?** Install is already in place. In a session, stand with a vanilla NPC that offers
   scripted options (a vendor hub, a phone call with replies), pick one, and read `probe.log` for
   `Game dialogue: hook choice fired (PreventionSystem.OnPlayerChoice)`. Then send a companion a message within 180 s and
   check the context carries "V chose the dialogue option". Also check the index: `choiceIdx` is used as `index + 1`
   (`mod/game-dialogue.lua`, `Instance:choice`), which may be off by one. If it never fires, the alternatives
   `InteractionUIBase.OnDialogsSelectIndex` and `OnDialogsActivateHub` exist as names in the 2.31 script cache but are
   unproven, and the first may report highlight, not commitment.
2. **Fact meaning for each Step B candidate**, with a read-only probe (the style of `fact-identity-probe.lua`): read
   `q115_kerry_romance_chosen` and the others on one save where the choice was made and one where it was not.
   `GetFactStr` zero cannot separate "absent" from "0", so the proof is a nonzero value on the made branch and zero on
   the other.
3. **Cost.** Read `perf-probe.json` before and after adding the facts (`worldKnowledge.update` and `init:knowledge`
   `msPerSecond` and `maxMs`), and `knowledgePreparedMs` in `bridge-latency.json`.
4. **Wording.** With a throwaway identity (live talk tests store to the user's real Convai memory), ask Judy, Panam and Takemura "what did I choose about X" for three cases: a mapped choice, an unmapped
   one (should say it does not know) and a zero-only one (should not claim a refusal).
5. **Witness receipts** (only if Step C2 is built): does `conversationCandidates` return the companions who were with V at
   a vanilla scene, at the moment the fact first reads true.

## 7. Decisions for the user

1. Build Step A (bridge only, no reload) now? It makes choices outrank events at no game cost.
2. Which unmapped decisions matter? Suggested first batch: Kerry's rooftop romance, Takemura and Oda, Dex hearing V's
   disclosure (audience fix), Smasher, and the Devil-route markers.
3. Do you want the ledger (Step D)? It depends on probe 1.
4. Witness receipts for spawned companions (Step C2): worth the wording risk, or keep the declared audience?

## Method and files read

Read: `docs/DYNAMIC_CONTEXT_AUDIT.md`, `docs/QUEST_CONTEXT.md`, `docs/QUEST_OUTCOME_COVERAGE_2026-10-05.md`,
`docs/PERFORMANCE_NATIVE_PLAN.md` (knowledge sections), `research/cyberpunk/GAME_DATA_AUDIT.md`, `CAPTURE_CONTRACT.md`,
`native-reviews/*-20261005.md`; `mod/world-knowledge.lua`, `relationship-state.lua`, `game-dialogue.lua`;
`bridge/world-knowledge.mjs`; `characters/world-knowledge.json`; `research/cyberpunk/cache/game/index/facts-dictionary.json`
and `summary.json`; the installed `runtime/last-input.json`, `knowledge-world.json`, `knowledge-active.json`,
`knowledge-status.json`, `memory-status.json`, `bridge-latency.json`, `perf-probe.json`, `probe.log`; the installed
`r6/cache/final.redscripts` (a string search for names only). Nothing in the game folder was modified. The numbers in
section 1.2 and 4.1 come from throwaway scripts run outside the repo (the bridge's `resolveKnowledge` over the installed
snapshot, no changes).

Not verified: that the live bridge prompt is byte-identical to my reproduction; any fact meaning in 4.2 beyond what
the pack's own evidence states; the cost of a fact read separately from a journal read; anything about hooks beyond the
log lines quoted.
