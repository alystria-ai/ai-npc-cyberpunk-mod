# Dynamic info (Settings > Conversations > Dynamic info)

Added 2026-10-22 from a player report: NPCs said V was "standing in the middle of Little China" while V was inside the H10 apartment, and they
tended to mention where V was even when the talk had nothing to do with it. This page lists what the mod tells a character about the moment, lets
the player turn each kind off, and says how the place is worded. The audit of what is fed to a turn is `docs/DYNAMIC_CONTEXT_AUDIT.md`.

## What the player sees

**Settings > Conversations > Dynamic info (Open)** opens a page with twelve switches, all on by default except **Other mods' state**, which is off by default (a missing or malformed saved value takes the default, in the game and in the bridge). An off kind is left out of every conversation
provider (Convai, Mistral, Local AI and Custom) and the mod stops reading it from the game. The page has the usual Back row and takes part in
Restore defaults (Native Settings UI's own button, and the Defaults footer button in Mod Configuration Menu).

| Switch (row id) | Saved key | What it covers | Dropped from the prompt | No longer read from the game |
| --- | --- | --- | --- | --- |
| Location (`dynamic:location`) | `dynamicInfo.location` | the district, V's apartment or the named place, indoors or outdoors; an ordinary NPC's "where you are now" | the place sentence of the right-now block (every form), `archetypeContext` | `currentDistrict()`, the indoors read, Johnny's arrival-at-a-place sampling. Not covered: the picture Convai gets of what V sees, and an add-on's own text |
| Time and weather (`dynamic:time`) | `dynamicInfo.time` | the hour and the weather | the Background line (and the clock in the block) | the game clock, the weather |
| Company and vehicle (`dynamic:company`) | `dynamicInfo.company` | who is with V, in a vehicle, driving, V's motion, what a companion is doing, which weapon she carries, by its display name: drawn ("You are holding Satara."), holstered ("You carry Satara (holstered).") or none ("You carry no weapon."). The hand is read each turn; when it is empty, her inventory list is read (kept 5 s per copy) and, if that holds no weapon, the primary equipment of her character record, because the game adds a copy's weapon to its inventory only when it is first equipped, so a copy that has not drawn yet can have none listed. "No weapon" is said only when the record was read and holds none; a failed or unresolved read says nothing (`Companion recovery carried-weapon {...}` in probe.log, once per change: `result`, `via` list or record, `list` items, `weapons` among them, `record` weapon, none, unresolved or failed) and whether she wears other clothes than her appearance text (docs/COMPANION_OUTFITS.md) | "Also with V", "V is in a vehicle / driving / walking" and the companion's own activity | the party read, the activity inputs, the vehicle read |
| Health, heat and fights (`dynamic:condition`) | `dynamicInfo.condition` | V's health band, the police heat, the last fight | "V is hurt", the heat sentence, the battle block of a manual turn | the health and heat reads, and the fight read of a manual turn (`battles.captureManual`: group, phone, microphone and typed text). The battle module's own capture is never gated: battle reactions carry their own fight whatever the switch says |
| V's money (`dynamic:money`) | `dynamicInfo.money` | a rough band: nearly broke ... rich | the money sentence | the money read |
| V's gear and clothes (`dynamic:gear`) | `dynamicInfo.gear` | clothes, weapons, cyberware | the gear block (and what a bystander can see) | `playerGear:capture()` |
| V's gender and lifepath (`dynamic:about`) | `dynamicInfo.about` | V's gender and lifepath | "V is a woman ..., lifepath ..." | the gender and lifepath reads for the turn (the world facts of the story may still reflect the lifepath) |
| Quest and journal (`dynamic:quest`) | `dynamicInfo.quest` | the tracked quest and objectives, open jobs, the journal history, the job briefing a quest giver gives when V asks about their job ([QUEST_BRIEFINGS.md](QUEST_BRIEFINGS.md)) | the journal, jobs, history and job-briefing blocks (not even the "history is unavailable" line) | `questContext.capture()`, and the journal-history scan is not stepped, asked for or sent (unless Johnny's remarks need it) |
| Recent game dialogue (`dynamic:dialogue`) | `dynamicInfo.dialogue` | the last lines of scenes and V's chosen replies | the game-dialogue block | `gameDialogue:capture()` (the recorder stays: Johnny's remarks and the add-ons hear the game's lines through it, and it only works when the game shows a line) |
| Time since last talk (`dynamic:lastTalk`) | `dynamicInfo.lastTalk` | how long since V last talked to this character, in the game and in real days | the Background line "You last talked with V ..." (and nothing is stored for the character) | the game clock in seconds (one read inside the turn-context snapshot) |
| Music and TV (`dynamic:media`) | `dynamicInfo.media` | the song on the car radio while V rides in a car, or on V's pocket radio on foot; a TV that is on near V (its channel and what it just said) | the Background line's radio and TV sentences, for a companion in person and for Johnny in V's head | `mod/media-context.lua` (the radio and TV reads), `mod/media-song.lua` (the game's song-change events, hooked only while on) and the TV line ring in `mod/game-dialogue.lua` |
| Other mods' state (`dynamic:mods`) | `dynamicInfo.mods` | V's thirst, hunger, tiredness, nerve, withdrawal, humanity and lasting injuries, from the Dark Future mod when it is installed | the "V is exhausted and parched" sentences of the Background line | `mod/mod-state.lua` is not loaded and Dark Future's classes are not asked, and `mod/equipment-ex.lua` is not loaded and Equipment-EX is not asked (with the switch off nothing at all is read from other mods and no probe line is logged; with the switch on and the mod absent: one failed lookup a minute at most, while a turn is built) |

What is deliberately not a switch: what each character knows about the story (the world facts and the recent shared events, they are the character's own
knowledge and the bridge binds a conversation to the save with them), a fight reaction's own subject (battle reactions have their own setting), the pickups
of a loot reaction, the relationship style (Relationships page), the vision picture (Convai only, always on since the Companions can see setting was retired,
and it follows the same place rule: indoors or outdoors only from the text, else the picture), V's voice gender and the dialogue volume for V's typed-line
voice (they are no part of the words the model reads; they keep working with every switch off).

## Where it is applied

Both halves follow the same saved table (`runtime/settings.json`, `"dynamicInfo": {"location": true, ...}`; a missing or non-boolean value is on, a key that
is not a kind is dropped on load; the table is also in the support report's settings section, with a `dynamicInfoOff` list of the kinds that are off).

- **Game side** (`mod/manager.lua`: `dynamicInfoKinds`, `M.dynamicInfo(kind)`, `applySettings` key `dynamicInfo`, `convaiDynamicInfo` global published on load and
  on save; `mod/manager-ui.lua`: the page and the `dynamic:<kind>` rows; `mod/turn-context.lua`: `options.enabled(kind)`; `mod/init.lua`: `convaiGateCapture`,
  `convaiHistoryWanted`). All reads happen when a turn is built, never per frame. The only per-frame addition is one table read (`convaiDynamicInfo.quest`)
  in front of the journal scan, which an off switch removes. A cached turn-context snapshot is not reused under other switches.
- **Bridge side** (`bridge/dynamic-info.mjs`, followed from `runtime/settings.json` by the settings poll): every provider builds a turn's context in one place,
  `conversationContextBlocks` in `bridge/quest-context.mjs` (and `voiceConversationBlocks` for an add-on voice, `archetypeContext` in `bridge/protocol.mjs`).
  Convai sends that string as its dynamic info; Mistral, Local AI and Custom lay the same blocks out as `contextParts` for `buildMessages`. So an off kind is absent
  from all four even when an older request still carries it. `stripSnapshot` removes a kind's fields from the turn-context snapshot before it is worded.

## Where V is, in words

The district and the specific record come from `PreventionSystem:GetCurrentDistrict` (`mod/init.lua` `currentDistrict`), and whether V is in a building from
`IsEntityInInteriorArea`. `bridge/place-names.mjs` words them, `bridge/turn-context.mjs` `whereSentence` says them:

- The place is no longer part of the first sentence ("You are with V in person, standing near V."), because the Mistral and Local AI prompt repeats that sentence right
  before V's words (`[YOU, RIGHT NOW: ...]`) and a place there was worked into every reply. The place is its own second sentence.
- V's apartment or a named interior: "You are inside V's apartment in Megabuilding H10." / "You are inside Lizzie's Bar, Watson."
- The Badlands: "You are outdoors in ..., out in open country."
- A plain district with the game's own indoors reading: "You are indoors, in a building in Little China, Watson; which building is not given." or
  "You are outdoors in Little China, Watson, in the open air, not inside a building."
- Nothing says: "You are somewhere in Little China, Watson; exactly where is not given."
- A phone chat, a call and Johnny get the same sentence about V ("V is ..."). Never "standing in" or "in the middle of" a district.
- In a vehicle the interior flag says nothing about the air around the car, so a companion riding along gets the "somewhere in" form, never "in the open air".
- The guidance at the end of every form now ends "Do not recite it, and mention a place or the time only if it matters to what V says." (an ordinary NPC: "bring it up
  only when it matters to what V says"), and an ordinary NPC's district block says "Mention it only when it matters to what V says" (it used to say "let the place flavor
  what you say"). One short sentence each: prompts stay short.

Limits: the game's record for the H10 hallways or a megabuilding lobby may be a plain `LittleChina` record, in which case the sentence is the indoors / somewhere-in
form above, not the apartment. Only V's own apartment records (`HOME_PLACES` in `bridge/place-names.mjs`) and the named interiors are said by name.

## Tests

`bridge/dynamic-info.test.mjs` (every kind off, for Convai, Mistral, Local AI and Custom, with every other kind still present; the Lua reads; the location
wording), and the Dynamic info and Forget cases in `bridge/manager.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/mcm-host.test.mjs`,
`bridge/settings-file-lua.test.mjs` and `bridge/support-report*.test.mjs`, plus `bridge/nsui-labels.test.mjs` (every label of the page fits, in all 16 languages).

## Money talk (2026-10-26)

The mod detects no payment: nothing moves eddies between V and a character, and the turn context carries only V's money band. A player report ("I gave you eddies to do a task"
answered "I'm not going to give you eddies") came from the model reading a bare "eddies" the wrong way round. So when V's own words speak of eddies, cash, paying or a tip
(`MONEY_TALK` in bridge/turn-context.mjs), the volatile tail of every provider's context (Convai dynamic info, Mistral, Local AI, Custom) gets one `Money:` note: V is the one
paying the character, and what V says they gave or paid is received. It is not live game info, so no Dynamic info switch turns it off, and it is absent from turns that are
not about money and from automatic reactions. Nearby strangers are not read anywhere (no scan was added); a companion knows only V and the party.

## Other mods' state: Equipment-EX outfits

Added 2026-10-25. The same switch also lets **V's gear and clothes** follow the Equipment-EX wardrobe: while one of its outfits is active, the gear block lists the
outfit's items instead of the equipped clothes that the outfit hides (docs/PLAYER_GEAR_CONTEXT.md, "Wardrobe outfits"). `mod/equipment-ex.lua` is loaded the first time a
gear block is built with the switch On, reads on demand only (inside the gear's 5 second cache), and logs `equipment-ex outfit=<name> parts=N` once per change.
With the switch Off nothing is read from Equipment-EX and the gear block is what the equipment system says, as before.

## Other mods' state: Dark Future

Added 2026-10-25. With **Other mods' state** turned on (it is the one kind that is off by default) and the Dark Future mod installed, a character is told how V is doing in the plain words of
body language: "V is exhausted and parched." / "V is badly on edge and in withdrawal from alcohol." Without Dark Future nothing changes and nothing is loaded.

**How it is read** (`mod/mod-state.lua`, called from `mod/init.lua` inside `turn-context.lua`'s 5 second snapshot, so at most once per turn window and never per
frame). Dark Future has no API for other mods, so the state is read the way its own scripts read it: its state classes are scriptable systems, fetched with
`Game.GetScriptableSystemsContainer():Get(CName.new('<Module>.<Class>'))`. Read from its source (version 2.0.3, the build for game 2.31, and the unreleased
`main` branch of 2026-10-24, version 3.0, which has the same class names and getters):

| What | Class (module `DarkFuture.<Module>`) | Getter | Meaning |
| --- | --- | --- | --- |
| thirst, hunger, tiredness, nerve | `Needs.DFHydrationSystem`, `DFNutritionSystem`, `DFEnergySystem`, `DFNerveSystem` | `GetNeedStage()` | 0 fine to 4 worst (by default the stages start at a value of 85, 75, 50 and 25 of 100); -1 when the system is not running |
| alcohol, nicotine, narcotics | `Addictions.DFAlcoholAddictionSystem`, `DFNicotineAddictionSystem`, `DFNarcoticAddictionSystem` | `GetWithdrawalLevel()`, `GetAddictionStage()` | withdrawal 0 to 5 (5 is cessation), addiction stage 0 to 4; 0 when not running |
| lasting injuries, humanity loss | `Conditions.DFInjuryConditionSystem`, `DFHumanityLossConditionSystem` | `GetConditionLevel()` | 0 to 4; 0 when not running |

A system that is not running (before its start, after V's death, the mod or the feature switched off in Dark Future's own settings) answers -1 or 0, which is
read as "nothing to say", never as a state. Every lookup and call is a `pcall`; a missing class, a raising getter or an answer out of range drops that one
system and leaves the others; nothing breaks a turn. Each system has a short list of candidate class names (the qualified name, then the bare name), the one
that answered is tried first next time. A reading is at most 9 lookups and 9 calls (12 with every substance in withdrawal; 18 and 0 with nothing there).
The Lua side sends only what is worth saying (need and condition stages 3 and 4, a withdrawal level of 3 or more).

**Is Dark Future there?** `mods` in `mod/init.lua` first looks up `DarkFuture.Main.DFMainSystem` (then `DarkFuture.Needs.DFHydrationSystem`) before it reads
`mod-state.lua` from disk. Absent: the file is never loaded, and the lookup is repeated at most once a minute (the systems may not exist yet during a loading
screen, so a first miss is not remembered for the session; a mod added while the game runs is found within a minute of the next turn). Present: the module is
loaded once, and a module that fails to load is not retried.

**What is said** (`bridge/mod-state.mjs`). Hunger, thirst and tiredness from stage 1 (Dark Future itself starts a status effect on V there: a live test of
2026-10-26 read nutrition=1 while the owner was hungry, and the old bar of stage 3 said nothing); nerve, injuries and humanity from stage 3 (nerve sits at 1 all
day); withdrawal from level 3. The words: energy "a little tired" / "tired" / "worn out" / "exhausted", thirst "a little thirsty" / "thirsty" / "parched" /
"badly dehydrated", hunger "a little hungry" / "hungry" / "very hungry" / "starving" (stages 1 to 4), nerve "badly on edge" / "at the end of their nerve",
humanity "losing their grip on their humanity" / "close to cyberpsychosis", injuries "worn down by lasting injuries" / "badly battered by lasting injuries",
withdrawal "in withdrawal from alcohol" (nicotine, narcotics; several are one phrase). At most two sentences (the body, then the rest), three phrases each,
the worst first. Never the mod's name, a stage, a number, or a verdict on an addiction. A steady stage is told once (below), not recited, so the mild
words do not make a topic of it.

| Form | What it gets |
| --- | --- |
| a companion in person, Johnny in V's head | both sentences (the same wording: Johnny feels it from inside V, a companion sees and hears it) |
| a stranger (an ordinary NPC) | one sentence of what shows on a body, from stage 3 only: "V looks exhausted and parched." Never nerve, withdrawal, injuries or humanity |
| a phone chat, a call, an add-on voice | nothing |

The sentences ride the **Background** line with the weather and the time, and are told when the conversation has not heard them: the first turn, a change (a
stage that moves, a new state, a substance added), or after a long silence (`bridge/scenery-memory.mjs` with `modsSignature`). A steady state is not repeated on
every turn, and a change below the bar (stage 1 for the body, 3 for the rest) changes nothing.

**When V asks about themself** (added 2026-10-26). A live test (game 2.31, Dark Future, Convai): V hungry, the probe log read `nutrition=1` and `hydration=1`, the turn
context reached the bridge with `mods: {darkFuture: {nutrition: 1, hydration: 1}}`, the first turn's Background line said "V is a little hungry." and the second's
"V is a little thirsty and a little hungry.", and the third turn had no Background line at all (`background=none`, the steady-state rule). Convai's dynamic info is
replaced on every turn (`updateContext`, mode `replace`), so a fact told once is simply gone from the next turn, and a companion asked "how do I look?" or "do I
seem okay?" had nothing to say: she did not mention it. Now, when V's words ask about themself (how they look, seem or sound, "am I okay", a bodily need: hungry,
thirsty, tired, eat, drink, sleep; the English phrases and the stems of the 14 other menu languages, `asksAboutSelf` in `bridge/scenery-memory.mjs`; in doubt it says
yes, since it costs one sentence and only when there is a state to tell), the scenery memory returns `modsAsked`, and `bridge/turn-context.mjs` puts the state in the
right-now block itself, right after who she is and where (the same spot as an appointment, so a budget cut never reaches it), not in the Background line that says
"mention only if it matters": "V is a little thirsty and a little hungry. V is asking how they look or how they are, and this is plain to see on V (no scan or
reading needed): say it in your own words." (`modsAskedSentences` in `bridge/mod-state.mjs`; the "plain to see" half was added on 2026-10-26 after a companion
answered "I'm not a med-scanner"). The same forms get it as before (a companion, Johnny in V's head, a stranger's visible half); a phone chat, a call
and an add-on voice still get nothing; with nothing to tell, nothing is said however V asks. The next plain turn is quiet again.

**Why the second live test failed too** (fix/df-hunger-3, 2026-10-26 ~16:40 IST, build with merge 9dfbf8d6, game 2.31). The evidence, from the 2.31 copy's `probe.log`
and `runtime/last-input.json`: Dark Future was found and read (`Mod state: Dark Future found, reader loaded`, nine `... system found as DarkFuture.Needs.DFNutritionSystem`
and so on, `Mod state: dark-future hydration=0 nutrition=1 energy=0 nerve=1 ...` at 11:10:06Z), the switch was on (`[DynamicInfo] all on`; `dynamicInfo.mods` true in
`settings.json`), and the state reached the bridge (`turnContext.mods.darkFuture.nutrition` = 1 in `last-input.json`). What V typed was **"can you see information on the
state of my body"**, which is not "how do I look": `asksAboutSelf` had no word for the state or the body of V, so `modsAsked` was false, the state rode the Background line
only ("mention only if it matters or V asks": "V is a little hungry.") on that first turn, and Alex answered "I can see you're standing there, but I'm not a med-scanner."
So the read, the value and the switch were fine; the question was not recognised, and a state told only as background is not enough for a model that takes the question for
a technical one. Nothing was wrong with the thresholds either: in Dark Future 2.0.3 (`Needs/DFNeedSystemBase.reds`, `GetNeedStageImpl`) the stages split a need that runs
from 100 (fine) to 0 at the deficits 15, 25, 50 and 75 (settings `basicNeedThresholdValue1..4` = 85, 75, 50, 25), so stage 1 is a need between 75 and 85: the point where the mod
itself shows its first status effect, and where the owner was already hungry.

The fix: (1) `asksAboutSelf` now also knows "the state / condition / shape / status / health / vitals of my ...", "my body / state / condition / stomach / energy ...", a
perception verb with V as its object ("can you see me", "do you notice anything wrong with me", "check me out"), "what's wrong with me", "how do you find me", "I feel
dizzy / rough / drained", meals and "I need a coffee", and the matching stems for the 14 other menu languages and the CJK scripts (`bridge/mod-state.test.mjs`: 36 asking
phrases and 29 ordinary ones that must not match: "can you see the car", "check the door", "what is the status of the job", "state your name"); (2) the answer sentence says the
state is plain to see; (3) one probe line per turn explains what happened (below).

**The probe line** (`df:`). Every typed turn whose snapshot carries the game side's note gets one line in `probe.log`, next to `Conversation result`, and in the bridge log
as `[DarkFuture] df: ...`:

```
df: installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1 switch=on asked=yes sent=right-now
```

| Field | Meaning |
| --- | --- |
| `installed=` | the game side found Dark Future (`yes`); `read=` `ok` (some system answered), `none` (installed but none of the nine state systems could be found: names changed), `failed` (no scriptable-systems container), `load-failed` (`mod-state.lua` did not load) |
| `stage=` | the raw stages the game side read: the four needs always (`?` unknown or not running, `-` system not found), an addiction (its withdrawal level) or a condition only while it is not 0 |
| `switch=` | Settings > Conversations > Dynamic info > Other mods' state, as the bridge sees it |
| `asked=` | V's words asked about themself (`asksAboutSelf`), whatever the state |
| `sent=` | `right-now` (in the block, worded as the answer), `background` (the Background line), or `none(reason)`: `told earlier in this talk, V did not ask`, `no stage worth saying`, `this stage is below the bar for this form` (a stranger under stage 3, or nerve under 3), `a phone gets none` (a call, a voice), `switch off` |

The bridge writes it when a submitted turn starts (`logDarkFuture` in `bridge/convai-bridge.mjs`, never for a look-ahead, a reaction or an add-on voice), keeps the newest eight in
a map, and adds it to the turn's reply as the field `df` (both reply writers); the game's reply handler (`mod/init.lua`) writes it with `log()` before `Conversation result`. No new
file, no new poll, and nothing per frame. Without the note (Dark Future absent, or the switch off on the game side) there is no line.

**The switch is off by default, and a direct question does not override it.** The one thing the owner could not tell from the old log was whether the switch was on. With it off,
the game side does not read Dark Future, `mod-state.lua` is never loaded and the snapshot has no `mods`, however V asks ("do I look hungry?" included): the switch is the
player's own choice about what other mods may tell a character, and the page says the mod stops reading it. What changed is that the reason is visible: with the switch off and
Dark Future installed, the first turn built says so once per session, in one line (`modsOff` in `mod/init.lua`, a class lookup at most once a minute and three times a session,
none once the line is written, no state read):

```
df: installed=yes read=skipped stage=- switch=off asked=? sent=none(Other mods' state is off in Settings > Dynamic info: nothing is read or told, whatever V asks)
```

**Confirmed live on 2026-10-26 (game 2.31, Dark Future 2.0.3):** CET returns the system for `Get(CName.new('DarkFuture.Needs.DFNutritionSystem'))` and dispatches `:GetNeedStage()` on it
(the nine `system found as` lines and the raw stages in `probe.log`); `GetNeedStage` is a `final` method of the need base class and works all the same.

**Not verified** (the live check in the captain's log): that a build of Dark Future for game 2.5 exists and keeps these names (none was published on 2026-10-25:
the GitHub releases end at 2.0 for game 2.31, 2026-01-06; the Nexus page answered 403 to a plain fetch, but its Files tab, read in a browser on 2026-10-25 without logging in, lists one main file, 2.0.3-for-2.31 (20 January 2026), and the older 2.0.2, 2.0.1, 2.0.0, 1.4.2 and earlier: no build for game 2.5); that CET returns nil for a class name that does
not exist; that CET calls `:GetNeedStage()` on the handle `Get()` returns. The first reading writes one `probe.log` line per distinct reading:
`Mod state: dark-future hydration=3 nutrition=1 energy=4 nerve=? alcohol=3 nicotine=0 narcotic=0 injury=0 humanity=0` (the raw stages; `?` unknown or not running,
`-` the system was not found; the addictions show the withdrawal level), and one line per name that answered or failure kind. The status effects Dark Future applies
(a gameplay tag per need) were left out as a fallback: they go blank in cutscenes and menus, and no live read showed they are needed.

Tests: `bridge/mod-state.test.mjs` (parsing, wording per form, caps, signature, scenery memory, the self-question case of 2026-10-26 and its phrases in the menu languages, the owner's
live turn of 2026-10-26 rebuilt from `last-input.json`, the probe line in every case, hostile input), `bridge/mod-state-lua.test.mjs` (the reader with a
fake game: absent, partly present, -1, raising getters, moved class names, the lookup bound, the log lines, a strict fake that mirrors CET and Dark Future's real call shapes
(colon calls, CName arguments, nil for an unknown class, a missing getter is an error), the note, and the loader in `init.lua`: absent means never loaded, the switch-off line).

## Time since last talk

Added 2026-10-25. With **Time since last talk** on (the default) a character knows how long it has been since V last talked to it, but only when the gap is
worth a word, and the model is told not to dwell on it: "You last talked with V last night. Mention it only if it fits; do not bring it up again."

**What is kept** (`bridge/last-talk.mjs`). One entry per memory key, `{gameSeconds, realMs}`: the game clock the game sent with that turn and the real time. The
key is the memory key (`memoryScopes(...).keyFor`, `bridge/memory-scope.mjs`), so `judy-alvarez` and `judy-alvarez@medieval` (a content pack with a separate
memory) never share an entry. The file is `last-talk.json` in the bridge's state folder (at most 512 characters, the least recently talked-to go first). It is
written a few seconds after a change, atomically, in the background: no turn waits for the disk, and it is written once more when the bridge stops. A missing
or damaged file starts empty. **Forget** clears the same entries it clears from the memory (one character, all of the normal memory, or all of one pack), so a
forgotten character does not remember when it last met V.

**Who counts.** A manual turn with a named character: a face to face talk, a group round (each speaker addressed), a phone chat, a holocall, Johnny in V's
head (under his own key). Not counted, and nothing stored: an automatic reaction (battle, loot, head remark, speak-up line), an ordinary NPC (resident,
archetype), an add-on speaker, a turn the game sent no clock with, and every turn while the switch is off.

**Decided once per turn.** A turn's context is built several times (the prepared reply, the look-ahead, the turn, the log line). The first build of a turn id
reads the previous entry, words the gap, records "now" and remembers the sentence for that turn (a ring of 64); the other builds return the same sentence.
Because every turn moves the entry to now, the next turn of the same conversation sees a gap of minutes and says nothing. That is what stops the model repeating it.

**The wording.** Nothing under about 3 game hours and 30 real minutes, and nothing on the first ever talk (the character is not told it is a first meeting
either). Otherwise:

| Gap | Said |
| --- | --- |
| 3 or more game hours, the same day | "earlier this morning / afternoon / evening / tonight", "around midday today", "in the small hours today" (the part of the day of the last talk, the boundaries of the clock sentence) |
| the day before | "last night", "yesterday morning / afternoon / evening", "around midday yesterday", "around this time yesterday" (the same part of the day), "yesterday in the small hours" |
| 2 to 6 days | "a couple of days ago in the game", "five days ago in the game" |
| a week and more | "over a week ago in the game", "about three weeks ago ...", "over a month ago ...", "about five months ago ...", "a very long time ago ..." |
| about a real day or more (20 hours), with a night or less in the game | "; in real time that was five days ago" added; with hardly any game time passed: "You last talked with V three days ago in real time, though hardly any time has passed in the game since: V has been away from the game." |
| days in the game and about as many real days | only the game gap (the real one is added from three real days) |
| under a real day, over 30 real minutes, under 3 game hours | "You last talked with V a little while ago." |
| the game clock went backwards (an older save) | nothing about the game; the real wording still applies |

**Not verified.** Offline only: the wording table, the idempotence and the file behaviour are tested with a fake clock and fake files (`bridge/last-talk.test.mjs`),
the Lua read with a fake game (`bridge/turn-context.test.mjs`). In the game: that `GameTime.seconds` and `GameTime.GetSeconds` both answer and agree (the
read mirrors the proven one of the world snapshot and refuses a disagreement), and that a character's reply does not dwell on the sentence.
A different save with a larger game clock is not told apart from the same save a long time later: the entry is per character, not per save.

## Music and TV

Added 2026-10-25 (on by default; Settings > Conversations > Dynamic info > Music and TV). A companion in person and Johnny in V's head hear what V hears, so
they are told, as background, what is playing: "You can hear the car radio: "<track>" on "<station>". If V asks what is on, answer from this." while V rides in a car with the radio on,
"You can hear V's pocket radio, playing nearby: ..." on foot, and "A TV nearby is on "<channel>"; it just said: "<line>"." beside a TV that is on. A stranger, a phone chat, a
holocall and an add-on voice get nothing of it (they are not in the car, and it is no business of theirs).

**Game side** (`mod/media-context.lua`, read when a turn is built, inside the 5 s turn-context snapshot, never per frame; loaded the first time a turn is built with the
switch on, through the `media` option in `mod/init.lua`; nothing is read or loaded while the switch is off). Everything is guarded, and each source costs a few natives:

- **Car**: `player:GetMountedVehicle()`, then `IsRadioReceiverActive()`, then `GetRadioReceiverStationName()` and `GetRadioReceiverTrackName()`. Both are localisation keys
  (CNames); the game's own now-playing toast runs them through `GetLocalizedTextByKey`, so they are resolved with `Game.GetLocalizedTextByKey`, then `Game.GetLocalizedText`,
  and an answer that is empty, equal to the key or still a `LocKey` is rejected. A receiver that names no station falls back to `GetRadioStationLocalizedName(index)`.
  The first live pass (2026-10-25) read the station on both radios but never the track (`track=none`). The track now has a second route: when the receiver's own track name is empty or raises,
  the station's current track by its index (`RadioStationDataProvider.GetStationNameByIndex`, then `GetRadioStationCurrentTrackName`, the pair the pocket radio's `GetTrackName` is made of), and the
  probe.log line carries `trackWhy=` (raised, or what the first read answered) while no track is read.
  **The song, second live pass (2026-10-25 11:33Z):** `track=none trackWhy=none:` with nothing after the colon. That empty text is the cause: the track CName is a real
  hash, but its text is not in CET's name pool, so `NameToString` and `tostring` both give '' and the resolver gave up before asking the game (a `None` name prints `None`).
  The game's own now-playing toast (`VehicleSummonWidgetGameController.TryShowVehicleRadioNotification`) does exactly `GetLocalizedTextByKey(vehicle.GetRadioReceiverTrackName())`,
  so a CName with a hash and no text is now localised by its hash (shown in probe.log as `track=[#<hash>]->[...](ByKey)`). A third route is the game's own song-change
  events (`mod/media-song.lua`, below), cached and read at the turn (`event/ByKey`). `trackWhy=` now has two codes: the first read (`none:nil`, `none:None`, `none:#<hash>`
  for a hash the game would not localise, `none:unnamed`, `error:...`) and the event cache (`event:off` not hooked, `event:none` no song change seen yet, `event:empty`,
  `event:old` over 6 minutes, `event:otherStation`, `event:unresolved`).
- **Song events** (`mod/media-song.lua`, loaded and hooked only while the switch is on: at start when it is on then, else at the first turn built with it on; with the switch
  off nothing is loaded or hooked, and once hooked a callback with the switch off returns after one boolean read). Three `ObserveAfter`s, each in its own `pcall`; one that
  does not exist logs once (`Media song: <class>.<method> could not be hooked`) and the others still work. probe.log says `Media song: N of 3 song events hooked`.
  Derived from the game's script cache (`vendor/compiler-cache/final.redscripts`, decoded definition by definition: class, method and parameter type):
  `VehicleSummonWidgetGameController.OnVehicleRadioSongChanged(evt: ref<VehicleRadioSongChanged>)` (the HUD toast), `VehicleRadioPopupGameController.OnVehicleRadioSongChanged`
  (the radio list while open; it calls `SetTrackName(evt.radioSongName)`) and `PlayerPuppet.OnVehicleRadioStationChanged(evt: ref<VehicleRadioStationChanged>)` (station and song).
  The event fields are in `vendor/reference-game-scripts/scripts/core/gameplay/vehicleRadio.script` lines 1-12. Each fires once per song or station change; the callback stores
  the song CName, the station tuned then (the same receiver or pocket-radio read) and the time, nothing else. The cached song counts while that station is still tuned and for
  6 minutes. Whether the game sends these for the pocket radio as well as the car is not known (no pocket-radio song event exists in the scripts).
  The line is told on the first turn and on a change, and again whenever V's words ask about music, the radio, a song or the TV (`MEDIA_ASK` in `bridge/scenery-memory.mjs`), so "what song is this?" always gets it.
  `said=no` in the probe.log line is only the TV's last spoken line, not the prompt.
  There is no separate artist field: the track's text may or may not include the artist. A radio that is on but whose names do not resolve reads as nothing, never as a key.
- **Pocket radio**, only on foot: `player:GetPocketRadio()`, `IsActive()`, `GetStationName()`, `GetTrackName()` (the pocket track changes without a script event, so it is read at the turn).
- **TV**, only on foot and within 12 m: the object V is looking at (`GetLookAtObject`) if it is a `TV` that is on, else one `GetTargetParts` query (the pattern of the door
  search in `mod/companion-passage.lua`, with secondary targets too), the nearest `TV` that is on, with at most six asked. A TV is an entity of class `TV` (or any entity whose
  device controller is a `TVControllerPS`). Up to 400 target parts are looked at (the first version stopped at 40, in no order, and a companion's body brings many parts, so the
  apartment test of 2026-10-25 with Judy and Alex beside V read `query found 0 TVs` beside a TV that was on and talking). A query that finds no TV that is on is not asked again for 20 s
  while V stays within 3 m of where it was asked (`M.QUERY_REST`, `M.QUERY_MOVE`: in a street one query reads up to 400 parts, about ten native calls each, and every turn on foot paid it);
  the look-at TV and the TV that just spoke are tried first and never wait for it. "On" is `IsON()` and not unpowered or disabled; the channel (`GetActiveStationIndex`,
  read only for a TV that is already on, because it can initialise one that never was, then `GetChannelName`) is resolved like a radio name, with the channel's TweakDB record as the second try.
  The game exposes the channel, not the programme. What is on is told with the TV's own recent speech: `mod/game-dialogue.lua` keeps the last three lines of type `GlobalTV` /
  `GlobalTVAlwaysVisible` (160 characters each, with when they were heard) from the subtitle callbacks it already has, only while this switch is on. They are kept apart from
  the recorded game dialogue: nothing changes in what Recent game dialogue records or sends (those types are still skipped as before), Johnny's remarks and the add-ons never see them,
  and a car radio's DJ (type `Radio` from a vehicle) is not kept. A line heard in the last 20 s with no TV located stands for the TV ("A TV nearby is on; it just said ...").
  **The TV that spoke (2026-10-25):** the query works but does not list TVs (live: `why: parts=13 objects=3 seen=NPCPuppet:2,GenericDevice:1` beside a TV that was on and
  talking; the game has no other area search for devices: `DeviceSystem` only walks device links, and the `GetEntitiesInArea` methods belong to trigger volumes). A subtitle
  line carries its speaker (`scnDialogLineData.speaker: wref<GameObject>`), so for each TV line `mod/game-dialogue.lua` notes the speaker's class and, when it is a TV
  (class `TV` or a `TVControllerPS` controller), its EntityID. At the turn, after the look-at read, that TV is found with one `Game.FindEntityByID` (no search) for up to
  30 minutes after it last spoke, and used when it is still within 12 m and on (`tv=speaker`). The query stays as the last try. probe.log adds `heardTv=gone|farOrOff`
  and `tvSpeaker=<class>|none` (what spoke the newest TV line), so the next live pass says whether a TV line has a TV as its speaker at all.
- **The one log line**: each distinct reading writes one line to probe.log, for example
  `Media: radio=car station=[<raw key>]->[Growl FM](ByKey) track=[<raw key>]->[...](ByKey) tv=skipped(in a vehicle)`, with the raw key, the text and the resolver that worked
  (`ByKey`, `Text`, `raw`, `index/...`, `record/...`, or `unresolved`), at most 200 per game session. When nothing is read it says why (`radio=car:inactive`, `radio=pocket:inactive`,
  `tv=none(query found 0 TVs)`). A line with no TV found ends with `why: parts=37 objects=12 seen=Door:3,Light:2` (target parts looked at, `+` when the limit cut them, distinct objects,
  the commonest classes among them that are not TVs), `beyondRadius=N` (TVs found farther than 12 m), `notOn=N` (TVs found that were not on) and `lookedAtTvNotOn`, so the next
  live pass says which check turned the TV away. That tail is not part of the line's identity: a changed count alone writes no new line.

**Bridge side** (`bridge/media-context.mjs`): `parseMedia` validates the table (a source of `car` or `pocket`, text fields cleaned of tags, control characters and `LocKey#` leftovers, raw-looking
keys dropped, 40/80/40/120 characters), `mediaSignature` changes with the song, station or channel (not with the TV's last line), and `mediaSentences` words it for the person and head forms,
JSON-quoting every name so an odd or hostile title reads as a name, in at most 300 characters (the TV line is shortened first). The sentences go in the Background line, which the scenery
memory tells a conversation only when new: the first turn, a change of song, station or channel, and after a long silence (`bridge/scenery-memory.mjs` `signals.media`).

**Not verified in the game.** The names above exist in the game's script caches (2.5 and 2.31, the same on both), but the game cannot be driven offline: that CET can call them, what the
values look like, whether the localised track includes the artist, whether a TV shows up as a target part, and whether the TV line ring catches the lines that matter. Tests use fake natives
(`bridge/media-context-lua.test.mjs`, `bridge/media-context.test.mjs`, `bridge/media-song.test.mjs`). The live check is the probe.log line above plus the developer probe
`scripts/Send-JohnnyProbe.ps1 media read` (`mod/media-probe.lua`, Developer mode only, never loaded for players), which dumps the raw value of every candidate read into `runtime/johnny-probe.json`.
The live `why:` of 2026-10-25 11:41Z showed the query's objects without the TV, so the TV is now found through the speaker of its own subtitle line. Still only the game can say
whether a `GlobalTV` line names the TV as its speaker (`tvSpeaker=` answers it), whether `GetLocalizedTextByKey` answers for the song's unnamed CName, and whether the three
song events fire as the scripts suggest (the script cache read is of the cache the compile checks use; the 2.5 cache was not read offline for this change, since the game folder is off
limits while the game runs; the earlier reading of both caches found the radio API the same on both versions, but these three handlers were not part of it). In-world radios (`Radio`, `Jukebox`) are not read.
