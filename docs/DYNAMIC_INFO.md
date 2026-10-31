# Dynamic info (Settings > Conversations > Dynamic info)

Added 2026-10-22 from a player report: NPCs said V was "standing in the middle of Little China" while V was inside the H10 apartment, and they
tended to mention where V was even when the talk had nothing to do with it. This page lists what the mod tells a character about the moment, lets
the player turn each kind off, and says how the place is worded. The audit of what is fed to a turn is `docs/DYNAMIC_CONTEXT_AUDIT.md`.

## What the player sees

**Settings > Conversations > Dynamic info (Open)** opens a page with two sets of the same twelve switches (see "Two sets of switches" below: the first heading **In person**, the second **Phone calls and texts**). In person, all twelve switches are on by default except **Other mods' state**, which is off by default. **Phone calls and texts** has defaults of its own (see "Defaults and old files"). In both sets a missing or malformed saved value takes the set's default, in the game and in the bridge. An off kind is left out of every conversation
provider (Convai, Mistral, Local AI and Custom) and the mod stops reading it from the game. The page has the usual Back row and takes part in
Restore defaults (Native Settings UI's own button, and the Defaults footer button in Mod Configuration Menu).

| Switch (row id) | Saved key | What it covers | Dropped from the prompt | No longer read from the game |
| --- | --- | --- | --- | --- |
| Location (`dynamic:location`) | `dynamicInfo.location` | the district, V's apartment or the named place, indoors or outdoors; an ordinary NPC's "where you are now" | the place sentence of the right-now block (every form), `archetypeContext` | `currentDistrict()`, the indoors read, Johnny's arrival-at-a-place sampling. Not covered: the picture Convai gets of what V sees, and an add-on's own text |
| Time and weather (`dynamic:time`) | `dynamicInfo.time` | the hour and the weather | the Background line (and the clock in the block) | the game clock, the weather |
| Company and vehicle (`dynamic:company`) | `dynamicInfo.company` | who is with V, in a vehicle, driving, V's motion, what a companion is doing, which weapon she carries, by its display name: drawn ("You are holding Satara."), holstered ("You carry Satara (holstered).") or none ("You carry no weapon."). The hand is read each turn; when it is empty, her inventory list is read (kept 5 s per copy) and, if that holds no weapon, the primary equipment of her character record, because the game adds a copy's weapon to its inventory only when it is first equipped, so a copy that has not drawn yet can have none listed. "No weapon" is said only when the record was read and holds none; a failed or unresolved read says nothing (`Companion recovery carried-weapon {...}` in probe.log, once per change: `result`, `via` list or record, `list` items, `weapons` among them, `record` weapon, none, unresolved or failed) and whether she wears other clothes than her appearance text (docs/COMPANION_OUTFITS.md) | "Also with V", "V is in a vehicle / driving / walking" and the companion's own activity | the party read, the activity inputs, the vehicle read |
| Health, heat and fights (`dynamic:condition`) | `dynamicInfo.condition` | V's health band, the police heat, the last fight | "V is hurt", the heat sentence, the battle block of a manual turn | the health and heat reads, and the fight read of a manual turn (`battles.captureManual`: group, phone, microphone and typed text). The battle module's own capture is never gated: battle reactions carry their own fight whatever the switch says |
| V's money (`dynamic:money`) | `dynamicInfo.money` | a rough band: nearly broke ... rich | the money sentence | the money read |
| V's gear and clothes (`dynamic:gear`) | `dynamicInfo.gear` | clothes, weapons, cyberware, and whether V is visibly topless or naked ([PLAYER_GEAR_CONTEXT.md](PLAYER_GEAR_CONTEXT.md), "Nudity") | the gear block (and what a bystander can see), the nudity note of the right-now block | `playerGear:capture()` |
| V's gender and lifepath (`dynamic:about`) | `dynamicInfo.about` | V's gender and lifepath | "V is a woman ..., lifepath ..." | the gender and lifepath reads for the turn (the world facts of the story may still reflect the lifepath) |
| Quest and journal (`dynamic:quest`) | `dynamicInfo.quest` | the tracked quest and objectives, open jobs, the journal history, the job briefing a quest giver gives when V asks about their job ([QUEST_BRIEFINGS.md](QUEST_BRIEFINGS.md)) | the journal, jobs, history and job-briefing blocks (not even the "history is unavailable" line) | `questContext.capture()`, and the journal-history scan is not stepped, asked for or sent (unless Johnny's remarks need it) |
| Recent game dialogue (`dynamic:dialogue`) | `dynamicInfo.dialogue` | the last lines of scenes and V's chosen replies | the game-dialogue block | `gameDialogue:capture()` (the recorder stays: Johnny's remarks and the add-ons hear the game's lines through it, and it only works when the game shows a line) |
| Time since last talk (`dynamic:lastTalk`) | `dynamicInfo.lastTalk` | how long since V last talked to this character, in the game and in real days | the Background line "You last talked with V ..." (and nothing is stored for the character) | the game clock in seconds (one read inside the turn-context snapshot) |
| Music and TV (`dynamic:media`) | `dynamicInfo.media` | the song on the car radio while V rides in a car, or on V's pocket radio on foot; a TV that is on near V (its channel and what it just said) | the Background line's radio and TV sentences, for a companion in person and for Johnny in V's head | `mod/media-context.lua` (the radio and TV reads), `mod/media-song.lua` (the game's song-change events, hooked only while on) and the TV and radio-host line rings in `mod/game-dialogue.lua` |
| Other mods' state (`dynamic:mods`) | `dynamicInfo.mods` | V's thirst, hunger, tiredness, nerve, withdrawal, humanity and lasting injuries, from the Dark Future mod, V's stamina, daily energy, drink and cigarettes from Flesh and Chrome and V's injuries (bleeding, a limp, a broken arm, a concussion) from Injuries, when they are installed | the "V is exhausted and parched" sentences of the Background line | `mod/mod-state.lua` and `mod/vixen-state.lua` are not loaded and the classes of Dark Future, Flesh and Chrome and Injuries are not asked, and `mod/equipment-ex.lua` is not loaded and Equipment-EX is not asked (with the switch off nothing at all is read from other mods and no probe line is logged; with the switch on and the mod absent: one failed lookup a minute at most, while a turn is built) |

What is deliberately not a switch: what each character knows about the story (the world facts and the recent shared events, they are the character's own
knowledge and the bridge binds a conversation to the save with them), a fight reaction's own subject (battle reactions have their own setting), the pickups
of a loot reaction, the relationship style (Relationships page), the vision picture (every provider, only while the Companions can see setting is on, off by default since 2026-10-29,
and it follows the same place rule: indoors or outdoors only from the text, else the picture), V's voice gender and the dialogue volume for V's typed-line
voice (they are no part of the words the model reads; they keep working with every switch off).

## Two sets of switches: in person, and phone calls and texts (2026-10-31)

Added from a player request: some live info should reach a companion who is with V, but not a character V is only calling or texting. The page now has two headed
groups of the same twelve rows, in the same row style, in the same order:

- **In person** (the party and face to face talk). Row ids `dynamic:<kind>`, saved as `dynamicInfo.<kind>` (unchanged, so every older file keeps working).
- **Phone calls and texts** (holocalls, voice or video, and Phone Chat messages). Row ids `dynamicPhone:<kind>`, saved as `dynamicInfoPhone.<kind>`.

Restore defaults resets both groups. Only three new texts were added to the catalogue and the 15 locale files ("In person", "Phone calls and texts" and the
sentence under the second heading). The labels and help of the rows are the same strings as before.

**Defaults and old files (changed 2026-10-31).** A caller or texter does not see V, so the phone set starts with its own defaults, not a copy of the in-person set.
Off by default on the phone: **Location**, **Company and vehicle**, **Health, heat and fights**, **V's money**, **V's gear and clothes**, **Music and TV**, **Recent game dialogue**
and **Other mods' state**. On by default on the phone: **Time and weather**, **V's gender and lifepath**, **Quest and journal** and **Time since last talk**. (Money is off because
nobody on the other end sees a wallet. The weather stays on because a caller can say "it's pouring over there".) The defaults are `dynamicInfoDefault(kind, true)` in
`mod/manager.lua` and `OFF_BY_DEFAULT_PHONE` in `bridge/dynamic-info.mjs`, which a test keeps equal, and the page's rows use them as the value Restore defaults goes back to.

Every player gets the new defaults once, because the phone set is new in this update. The mark is `settings.dynamicInfoPhoneDefaults = 1` in `runtime/settings.json`. While it is
missing, the settings load treats a phone set that is missing, empty or an exact copy of the in-person set (what the first build of the phone set wrote on the first load: no choice
of the player's) as untouched and replaces it with the defaults. A phone set that differs from the in-person set in any kind is the player's own choice: its saved booleans stay and
only the kinds with no saved boolean take the defaults. Then the mark is saved, and from then on a saved phone set is never reset. A fresh install gets the defaults and the mark at once.
The bridge applies the same defaults when it reads a file that has no phone set or a missing kind (`offKinds(settings, true)`), so a bridge that starts before the game has saved the file
behaves the same.

**Which set a turn uses.** The phone set applies to a Phone Chat text (`input.channel === 'phone'`) and to a one-to-one holocall (`input.holocall.mode` is `audio` or
`holo`, not a group round), unless the character is standing within a few metres of V (the party row says `near`, `besideV` in `bridge/turn-context.mjs`): that character is
treated as in person even when V uses the phone, the same rule as the "right beside you" form of the right-now block. Every other turn (face to face talk, group
rounds, reactions, speak-up, Johnny in V's head, an ordinary NPC) uses the in-person set. `phoneTurn(input)` in `bridge/dynamic-info.mjs` says whether a turn is a phone
turn, `dynamicOff(input)` and `dynamicOn(kind, input)` in `bridge/quest-context.mjs` pick the set (`besideV` is read only for a phone turn). `conversationContextBlocks`,
`turnContextOptions`, `gearWantedFor` and the other per-turn callers in `bridge/convai-bridge.mjs` all go through them, so every provider follows the same set.

**Cost.** Nothing new is read or polled. The game side reads a kind when EITHER set has it on (`M.dynamicInfo(kind)` is the union, `M.dynamicInfoSet(kind, phone)` is one
set, and the `convaiDynamicInfo` global the per-frame journal collector reads is the union), because the turn context is read once for both kinds of turn; the bridge then
drops what the turn's own set turned off (`stripSnapshot` with that set). A kind off in both sets is not read at all, exactly as before. The picking itself is a set
lookup at the time a turn's context is built, never per frame. One consequence worth knowing: the time since the last talk is stored for a turn only when its own set has
that kind on, so with it off for the phone only, texts and calls do not count as a talk, and the next face to face talk says how long since the last face to face one.

The support report lists the kinds that are off in each set (`dynamicInfoOff`, `dynamicInfoPhoneOff`).

## Where it is applied

Both halves follow the same saved tables (`runtime/settings.json`, `"dynamicInfo": {"location": true, ...}` for talk in person and `"dynamicInfoPhone": {...}` for holocalls and texts;
a missing or non-boolean value takes the set's default (on in person except Other mods' state, the phone defaults above on the phone), a key that is not a kind is dropped on load. The tables are also in the support report's
settings section, with `dynamicInfoOff` and `dynamicInfoPhoneOff` lists of the kinds that are off).

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

### Named places by position (2026-10-30)

A live test put V in the Afterlife: the game's record for V's position was only `LittleChina`, so the context said "somewhere in Little China, Watson" and Judy answered "but I thought we were in Watson". A record can only name a place when the game has an interior record for it, so the context now also names a place from V's **world position**.

- `bridge/named-places-data.mjs` is the list: id, phrase ("the Afterlife, a merc bar in Little China, Watson"), root district, x, y, z, radius, floor tolerance `dz`. Sixteen places: the Afterlife, Lizzie's Bar, Misty's Esoterica, Viktor's clinic, V's apartments (H10, Corpo Plaza, Northside), Tom's Diner, El Coyote Cojo, the Sunset Motel, Clouds, Judy's apartment, the Totentanz, Wakako's office and the CEO level of Arasaka Tower.
- The position is read by `mod/turn-context.lua` (`N.position`, `player:GetWorldPosition()`) with the rest of the snapshot, when a turn is built and at most every 5 s: one native call, no hook, no timer, never per frame. It is sent as `position {x, y, z}` (rounded to 0.1 m), owned by the Location kind of Dynamic info, and is never worded or logged: only the place's name reaches the prompt.
- `bridge/named-places.mjs` `namedPlaceAt` finds the place whose radius holds V (and whose floor and root district agree); `describePlace` uses it only when the game's own record is a plain neighbourhood or none. The wording: "You are inside the Afterlife, ..." when the game says V is indoors, "You are at ..." otherwise, "near" in a vehicle.
- **Positions (30 Oct, all offline, none measured by us in the game yet, so a live check is owed).** Each entry of `named-places-data.mjs` names its source:
  - **repo:** V's apartment in H10 (the interior box of docs/HOUSEMATES.md).
  - **teleport:** the console guides of beebom.com and games.gg agree to the digit on the Afterlife (-1455.068, 1010.975, 17.824), Clouds (-625.404, 794.564, 132.252), the Arasaka Tower CEO level (-1437.788, 157.247, 565.346), the Corpo Plaza flat (-1607.948, 350.182, 50.997) and the Northside flat (-1504.078, 2228.468, 23.798). Cross-check: the repo's own survey entry points of the two flats are 12 m and 4 m from those. The point is where the player is put, so it can be at the door.
  - **sector grid:** Lizzie's Bar, El Coyote Cojo, Judy's apartment, the Totentanz and Wakako's office from the game's interior streaming sector names (`interior_X_Y_Z_level`, a 32 m cell, 64 m at level 1; wiki.redmodding.org "Reference: World Sectors"), the centre of the cells, **about 20 m off**. They are marked `approx`, have a wide height tolerance, and are never claimed while the game says V is outdoors. The centres were recomputed from the cell numbers: for Judy's apartment (-896, 1856, 48) and the Totentanz (-1712, 2224, 96) this differs from the first list by 16 m in x (and 16 m in z for the Totentanz), which was the average of the cell corners.
  - **Dropped: Embers** (`interior_-57_-17_2_0`, z 64 to 96): the guides' Time Machine teleport 59 m away is at z 7.8 on the street, so the height index does not fit that area.
  - **Still to measure with `quest capture:<id>`** (stand in the middle of the place with Developer mode on): Misty's Esoterica (`mistys-esoterica`), Viktor's clinic (`victors-clinic`), Tom's Diner (`toms-diner`), the Sunset Motel (`sunset-motel`); also Konpeki, Lele Park, the Aldecaldos camp and Kerry's mansion, which are not in the list. The probe writes `runtime/quest-place-capture.json`; the bridge reads it when it changes (`captureReader`, at most every 5 s, off the turn's path) and uses a measured position at once, for a place that has none shipped. Then copy the numbers into the data file with their source. Radii are first guesses.
  - The district gate is only set where the game's root district is certain (Watson, from the live test). No district polygon exists in the repo to check a point against, so the check was by distance to the repo's own points.
- Tests: `bridge/named-places.test.mjs`, and the Lua read in `bridge/turn-context.test.mjs`.

Limits: the game's record for the H10 hallways or a megabuilding lobby may be a plain `LittleChina` record, in which case the sentence is the indoors / somewhere-in
form above, not the apartment. Only V's own apartment records (`HOME_PLACES` in `bridge/place-names.mjs`) and the named interiors are said by name.

## Tests

`bridge/dynamic-info.test.mjs` (every kind off, for Convai, Mistral, Local AI and Custom, with every other kind still present; the Lua reads; the location
wording; the two sets: an old file without the phone set, a holocall, a text, a face to face turn and a phone turn with the character beside V), and the Dynamic info and Forget cases in `bridge/manager.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/mcm-host.test.mjs`,
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
and an add-on voice still get nothing. The next plain turn is quiet again. With nothing to tell, nothing is said unless the game side read the state and found it fine (next paragraph).

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

**When V asks and nothing is wrong** (added 2026-10-27). Live test (game 2.31, Dark Future, V fed, rested and not thirsty): V asked a companion "can you see my body state?" and she said no. `probe.log`: `df: installed=yes read=ok stage=hydration0,nutrition0,energy0,nerve0 switch=on asked=yes sent=none(no stage worth saying)`. The game side sends only the stages worth saying (`mod/mod-state.lua`: `if not any then return nil end`), so a fine V has no `mods` table at all, and the bridge had nothing to tell. Two changes: (1) the scenery memory returns `modsAsked` for every question about V, not only when there is a state signature (`bridge/scenery-memory.mjs`); (2) `modsAskedSentences(mods, form, reads)` in `bridge/mod-state.mjs` also takes the game side's compact notes (`modsRead`, `facRead`, `injRead`, which the snapshot already carries for the probe lines) and, from the stages they say were **read as a number**, words what is fine: "V looks well: fed, rested, not thirsty, steady." (hunger 0, tiredness 0 in both mods, thirst 0, nerve below the bar of 3; Flesh and Chrome adds "not winded", Injuries "free of visible injuries" only when all four kinds were read as 0). A need the note marks `?` (no answer) or `-` (system not found), a note that is not `read=ok` (`none`, `failed`, `off`, `idle`) and a mod that is not installed claim nothing; nothing is said at all when nothing was read. When something is wrong it stays the answer and what else read fine follows it: "V is a little hungry. Otherwise V is rested, not thirsty and steady." A stranger is told only "V looks well." (he sees a body, so only the body and the visible injuries count, by the stranger's bars). The sentence is in the right-now block (same spot as the state sentences), followed by the same "plain to see" instruction; a phone chat, a call and an add-on voice get nothing. Unprompted turns are unchanged: a fine V is never mentioned. The probe line reads `sent=right-now(fine)` for this case (also in the `fac:` and `inj:` lines for their own part). No new file, read or poll: the notes were already in the turn. Tests: `bridge/mod-state.test.mjs` (the live turn rebuilt, a need not read, each failed read kind, the stranger, Johnny, the phone, the switch off, the mixed case, Flesh and Chrome and Injuries) and `bridge/vixen-state.test.mjs`. **Live check:** with Dark Future on and V fed, rested and not thirsty, ask a companion "can you see my body state?" and "how do I look?": she should say V looks fine (not that she cannot see); the probe line must end `sent=right-now(fine)`; a plain next turn must not mention V's body again.

**The probe line** (`df:`). Every typed turn whose snapshot carries the game side's note gets one line in `probe.log`, next to `Conversation result`, and in the bridge log
as `[DarkFuture] df: ...` (the `fac:` and `inj:` lines of the Digital Vixen mods are tagged `[FleshAndChrome]` and `[Injuries]`, below):

```
df: installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1 switch=on asked=yes sent=right-now
```

| Field | Meaning |
| --- | --- |
| `installed=` | the game side found Dark Future (`yes`); `read=` `ok` (some system answered), `none` (installed but none of the nine state systems could be found: names changed), `failed` (no scriptable-systems container), `load-failed` (`mod-state.lua` did not load) |
| `stage=` | the raw stages the game side read: the four needs always (`?` unknown or not running, `-` system not found), an addiction (its withdrawal level) or a condition only while it is not 0 |
| `switch=` | Settings > Conversations > Dynamic info > Other mods' state, as the bridge sees it |
| `asked=` | V's words asked about themself (`asksAboutSelf`), whatever the state |
| `sent=` | `right-now` (in the block, worded as the answer), `right-now(fine)` (asked, nothing wrong, told that V looks well from what was read), `background` (the Background line), or `none(reason)`: `told earlier in this talk, V did not ask`, `no stage worth saying`, `this stage is below the bar for this form` (a stranger under stage 3, or nerve under 3), `a phone gets none` (a call, a voice), `switch off` |

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

## Other mods' state: Flesh and Chrome and Injuries (Digital Vixen)

Added 2026-10-27 after two player requests (Nexus, 26 Oct). Same switch, same rules as Dark Future above: **Other mods' state** on, the mod installed, a character is told in
plain words of body language what shows: "V is out of breath." / "V is bleeding and limping a little." / "V has been drinking." Neither mod is loaded or asked while the switch is off.
Both mods are read by one module, `mod/vixen-state.lua`, in the same pass (one scriptable-systems container, one player), inside the same cached turn snapshot: on demand, nothing per frame,
no timer, hook or file. `mod/mod-state.lua` (Dark Future) is untouched; the `vixen` and `vixenOff` options in `mod/init.lua` sit beside `mods` and `modsOff`, and
`mod/turn-context.lua` merges the result into the same `mods` table (`mods.fleshAndChrome`, `mods.injuries`) and carries a note each (`facRead`, `injRead`).

### What the mods expose (read from their redscript, extracted read-only under `deliverables/reference/`; nothing of it is run or copied)

**Flesh and Chrome 1.31.0** is a stamina and energy mod. It has NO injuries, bleeding or breathing getter of the kind the first brief guessed. What it keeps:

| What | Where | Used |
| --- | --- | --- |
| `FleshAndChrome.FACSystem` | scriptable system; `container:Get(CName.new('FleshAndChrome.FACSystem'))` (the mod's own `FACExternal.System` does the same) | the entry point |
| `IsEnabled() -> Bool` | its own switch (`modON`) | off: nothing is read |
| `GetStaminaPercent(player) -> Float` 0 to 1 | short-term exertion pool (1.0 before it exists) | breath: below 20 percent stage 1, 10 stage 2, 5 stage 3, empty (or its `FACStatusEffect.Exhausted` still on: it clears above 5 percent) stage 4. These are the mod's own penalty bars (tunnel vision 20, heavy breathing and sway 10) |
| `GetEnergyPercent(player) -> Float` 0 to 1 | the daily pool sleep, meals and drinks refill (3 percent of max an hour awake, more after 9 hours) | energy: below 35 percent stage 1, 20 stage 2, 10 stage 3, 5 stage 4 (a day awake only reaches about 60 percent) |
| `GetTotalAlcohol(player)`, `GetTotalCigarettes(player)` -> Int32 | public getters on `FACSystem`: lifetime counts (`m_facTotalAlcohol`, `m_facTotalCigarettes`) | the source of drink and cigarettes (the persistent fields behind the sober-up window never read from CET, below). They are the SAVE'S LIFETIME totals (`+= 1` at FleshAndChrome.reds 1662 and 1675, nothing ever lowers or resets them, 1769 and 1781 return them as they are), not what is in V's body: a count that went up since the last read is a drink or a cigarette just had, and the count alone says nothing about the body |
| `IsStaminaRegenning()`, `GetConfig()` | public: true while the pool refills; the config object (`alcoholSoberBaseHours` 6, `alcoholSoberHoursPerExtraDrink` 1, `smokingPenaltyDurationMinutes` 30, `regenDelayCooldownMinutes` 10) | probe line and the fallback's windows |
| meal counts, `m_exhausted` | lifetime totals, a private flag | not used (`m_exhausted` is private and mirrored by the status effect) |

**How the pool refills (why "out of breath" can last minutes):** the mod's tick (every half second, game time) refills the stamina pool only when V is not moving at a jog or faster (`FACActivity.GetDrainRate`
is 0), after a cooldown of `regenDelayCooldownMinutes` (10 game minutes) times how empty the pool was (`FleshAndChrome.reds` 500, 518, 584), and never above the daily energy pool (`staminaCeiling = energy / maxEnergy * maxStamina`,
586), at `staminaRegenRate` 2.78 a game second against a pool of 5000 or more. The game clock runs about 8 times real time (`DVClock` default ratio), so a fully emptied pool is exhausted for about 75 real seconds plus the refill. The
Exhausted status clears above 5 percent. The reader reports the pool as it is (`GetStaminaPercent`), so a stage 4 that lasts for ten real minutes is either the mod's own state or a clock that is not running; the breath probe line (below) tells which.

The mod has no visible drunkenness of its own (alcohol only adds sleep owed), but a small model took "V has had a lot to drink" for nothing worth saying (live 2026-10-27: V asked "am i drunk" at stage 3 and was told "Not drunk, just wired"). So since 2026-10-27 the heavier stages are said as how V is, in plain vivid words: stage 1 (1 to 2 drinks) "V has had a drink or two.", stage 2 (3 to 5) "V is tipsy: loose, a little loud, smelling of booze.", stage 3 (6 and more) "V is drunk: slurring, unsteady on their feet, reeking of booze." A cigarette is "V has just had a cigarette." V asking about themself ("am i drunk", "do i seem drunk", "am i sober") also gets the state as a fresh fact at both ends of the prompt, worded as the answer (stage 3: "V is drunk. If V asks whether they are drunk, the answer is yes: ..."), and the character's own earlier answers and remembered notes that say the opposite are not sent (`docs/FRESH_FACTS.md`, round 2).

**Injuries 1.7.4** keeps injuries per body region as a tier 0 to 3 (none, light, medium, severe) on `PlayerPuppetPS.m_injurySeverity` and applies a status effect per kind:

| What | Where | Used |
| --- | --- | --- |
| `Injuries.InjuriesSystem` | scriptable system (`InjuriesSystem.Get`) | the entry point |
| `IsLive() -> Bool` | session armed; false before it and after a death | not live: nothing |
| `GetAppliedTier(kind: Int32) -> Int32` 0 to 3 | kinds 0 limp (legs), 1 broken arm, 2 concussion (head), 3 bleeding (torso); what is IN EFFECT on V, after painkillers and medkits have suppressed some of it | the state: limp, arm, head, bleed, each tier 1 to 3 |
| `GetSeverity(region: Int32) -> Int32` 0 to 3 | regions 0 head, 1 torso, 2 and 3 arms, 4 and 5 legs: the injury itself | all six regions are asked (probe line); severity above 0 for a kind with nothing in effect means a healing item holds it back, "bandaged up" (`treated`) |
| status effects `Injuries.Limp_T1..3`, `BrokenArm_T1..3`, `Concussion_T1..3`, `Bleeding_T1..3` | applied by the mod for the tier in effect (`Injuries_Effects.reds` `SyncInjuryStatusEffect`, `TweakIDFor`) | a second opinion: when the system answers "none" they are asked (12 calls, at most once a minute); one in force is believed over the zeros and the disagreement is logged |

**When Injuries injures at all** (`Injuries_HitProbe.reds`, `Injuries_Config.reds`): a hit worth 80 percent of V's health at once is an injury (two tiers); otherwise the damage of the last 10 seconds must add up to 50 percent of
V's health, then a 75 percent roll (lowered by chrome in that region) decides. A fall or a few shots below those numbers honestly give all zeros; the first live test's zeros are consistent with that, and the signatures in the
source (`IsLive`, `GetAppliedTier(kind)`, `GetSeverity(region)`) match the calls made, so the zeros were probably true. The probe line says what the system held while V was hurt.
| fractures, bandage flags, a bleeding amount | none | Injuries has no fracture or bandage state beyond the above: a broken arm is the arm kind, a healed injury is no injury |

The two mods share DigitalVixen Core and the Redscript Configuration Framework (config and clock), not their state: there is no common value to read once. The module reads both in one pass and shares the
container and the player; there is no shared state class.

### What is said, and to whom (`bridge/mod-state.mjs`)

- Order of sentences, each at most three phrases, worst first: the body (breath, energy, thirst, hunger), V's injuries (bleeding, a broken arm, a limp, a concussion; "bandaged up" only when nothing else shows),
  what V has had (drink, a cigarette), then Dark Future's inner states. Flesh and Chrome's energy and Dark Future's energy are one phrase, the worse stage.
- Companion in person and Johnny in V's head: every stage from 1. Told with the Background line (mention only if it matters) when new, changed or after a long silence, never recited; in the block, worded as the answer, whenever V asks about themself.
- A stranger: breathlessness from stage 2, energy from 3 (as before), blood from stage 1, a limp or a held arm from stage 2, a dazed face from 3 ("V looks to be bleeding."), strong drink ("V looks drunk and smells of booze."). Not a cigarette, not "bandaged up".
- A phone chat, a call and an add-on voice: nothing.
- No mod name, number or stage ever reaches the model.

### The probe lines

Per turn that carried the game side's note, beside `df:` (bridge log, and in the reply fields `fac` and `inj`, which `mod/init.lua` writes to `probe.log` next to "Conversation result"):

`fac: installed=yes read=ok state=breath0,energy1,drinks0,smoke0 switch=on asked=no sent=background`
`inj: installed=yes read=ok state=limp0,arm0,head0,bleed2,treated0 switch=on asked=yes sent=right-now`

`read=` is `ok`, `off` (Flesh and Chrome switched off in its own settings), `idle` (Injuries not live), or `none` (installed, no getter answered: names changed). `?` is a getter that failed or answered out of range. `sent=` is the
disposition of that mod's own sentences (right-now, background, none(...) with the reason). The reader also writes `Mod state: flesh-and-chrome breath=.. energy=.. drinks=.. smoke=..` and `Mod state: injuries limp=.. arm=.. head=.. bleed=.. treated=..` to
`probe.log` once per distinct reading, `Mod state: Flesh and Chrome Injuries found, reader loaded` once, and with the switch OFF one line per installed mod, once a session:
`fac: installed=yes read=skipped state=- switch=off asked=? sent=none(...)`. In the bridge log the three lines carry their own mod's tag (`[DarkFuture] df:`, `[FleshAndChrome] fac:`, `[Injuries] inj:`; before 2026-10-27
all three said `[DarkFuture]`). Cost: with neither mod, two class lookups a minute while a turn is built (with the switch off, three probes in a session and no more); with them, two lookups
and about twenty getter calls per 5 second snapshot (Flesh and Chrome: stamina, energy, config, two lifetime counts, one status check only below 5 percent; Injuries: `IsLive`, six `GetSeverity`, four `GetAppliedTier`,
and once a minute twelve status checks while nothing is injured). Nothing runs between turns.

### The probe lines of the game side (`Mod state probe:` in `probe.log`; added 2026-10-27 after the first live test)

Every uncertain read says exactly what was tried and what came back, so the next live test settles it:

| Line | Written | Tells |
| --- | --- | --- |
| `Mod state probe: the counts or the game clock went back (alcohol 9 to 6, cigarettes 0 to 0): another save, the baseline is taken again` | when a count falls | another save was loaded; what was watched is dropped |
| `Mod state probe: drinks and cigarettes via=counts` (or `none`), then `counts alcohol=N cigarettes=N stages drinks=N smoke=N` | when the text changes | whether the counts answered, the lifetime counts seen, the resulting stages |
| `Mod state probe: breath stage=4 stamina=0 energy=0.62 exhaustedStatus=nil regenning=false gamePool=0 clock=8.0x` | first read, every change of stage, and every 120 real seconds while the stage is 3 or 4 | `stamina`/`energy`: the raw fractions from the mod; `exhaustedStatus`: the Exhausted status (only asked below 5 percent); `regenning`: `IsStaminaRegenning()`; `gamePool`: the game's own stamina pool in percent (the mod writes its pool there every tick); `clock`: game seconds per real second since the last read (about 8 normally, 0 when time is held, `?` for the first read) |
| `Mod state probe: injuries live=true applied=0,0,0,0 severity=0,0,0,0,0,0 effects=unchecked` (or `none`, `some`) | when the text changes | `applied` limp, arm, head, bleed; `severity` regions 0 to 5 (head, torso, arm, arm, leg, leg); whether the status-effect second opinion was asked |
| `Mod state probe: injuries system said none but the status effect Injuries.Limp_T2 is in force: believed` | once per kind | the system and the status effects disagreed |

**Drinks and cigarettes.** The mod keeps the sober-up window in persistent fields on `PlayerPuppetPS` (`m_facAlcoholDrinks`, `m_facAlcoholSoberEnd`, `m_facSmokingPenaltyEnd`). They never read from CET: on 2.31, three
sessions of 27 Oct, every field was `nil` through the direct read and reflection, and the probe of the ways to the state showed `GetPS`, `GetPlayerPuppetPS` (does not exist) and the persistency system all giving a `PlayerPuppetPS` with
`m_facInitialized` nil and 0 `m_fac` properties on the class. That path and its probe lines were removed (fix/vixen-read-3); nothing asks for the persistent state any more. What is used is the lifetime counts, watched on the game clock:
a count that rose since an earlier read is a drink (stage 1 for one or two in the window, the window being 6 hours plus an hour for each further drink, from the mod's config) or a cigarette (30 game minutes). The window starts at
the read that saw the rise, which can be a little after the drink.

**The counts are lifetime totals, not the drinks in the body (second live test, 27 Oct).** The first version of the fallback took them for that and was right by accident: 0 at the first read, 9 after drinking (stage 3). Between sessions the
count read 6 against 9, which is another save (each save keeps its own totals; nothing in the mod decreases them), and in a new game at 09:59 the first read already showed 6 after the owner had drunk, which the first read took for the baseline and said
`drinks0`. A count therefore never maps to a stage by itself: 6 lifetime drinks would read "a lot to drink" for ever. What was fixed: (a) **a baseline read when a save has loaded**: `mod/init.lua` `convaiVixenBaseline`, one ordinary read of the reader
3 seconds after the world is ready (from the existing 0.5 second sample in `updateBattles`, a nil check while nothing is due; due at start and set by `abandonSession` for every load, death or detach, not for a fast travel; only with Other mods' state on),
so a drink had before the first question is a rise over the baseline at the first question; (b) **another save is recognised**: a count that falls, or a game clock that goes back, drops everything watched and takes the baseline again
(`Mod state probe: the counts or the game clock went back (alcohol 9 to 6, ...): another save, the baseline is taken again`); `abandonSession` also resets the reader. Still unknown: a drink had while the switch was off or before the first
baseline of a CET reload, or in a save loaded with the mod's own clock in another state; and a drink that the mod did not count (an item without its `FACAlcohol` tag).

**What the first live test settled (27 Oct, game 2.31, all plugins loaded):** CET returns both systems and every getter in use answered with the right argument shape (no `failed` line); the breath stage 4 was logged
from 06:56 to 07:06Z and fell to 0 at 07:06:35Z, which fits the mod's own cooldown at a game clock much slower than 8 times, or a pool held at zero by something else; the injuries stayed zero while a
character described injuries (made up, by the thresholds above, unless the next probe lines show otherwise). Fixed: the log tags, the drink and cigarette fallback, the injuries second opinion and every probe above. Not settled
from the source alone: why the breath stage lasted ten minutes. The next live test's breath probe lines give the pool, the cooldown and the clock pace to settle it.

### Not confirmed in the game (only a live run can)

Confirmed on 27 Oct (game 2.31): CET returns the system for both class names and dispatches `IsEnabled`, `GetStaminaPercent(player)`, `GetEnergyPercent(player)`, `IsLive`, `GetAppliedTier(kind)` and `GetSeverity(region)`. Confirmed later the same day: drink before talking, then "am i drunk?" is answered (the counts and the baseline). Still open: that `GetTotalAlcohol(player)`, `GetTotalCigarettes(player)`, `GetConfig()` and `IsStaminaRegenning()` answer from CET (if not: `failed` lines once, the stage stays `?`); that `Game.GetStatusEffectSystem():HasStatusEffect(entityId, TweakDBID)` exists (if not:
exhausted shows as stage 3 until the pool is empty, and the injuries second opinion is silent); that `Game.GetStatPoolsSystem():GetStatPoolValue(entityId, Stamina, true)` takes an `EntityID` for its `StatsObjectID` (probe line only); that Injuries 1.7.4 and Flesh and Chrome 1.31.0 are the builds in the player's game.

Tests: `bridge/vixen-state-lua.test.mjs` (strict fakes of both mods' real shapes: methods that need `self` and exactly the game's argument count, the stage bars, the exhausted status, a clock that does not match, out-of-range answers, raising getters, one mod missing or broken, the log lines, the passive-module scan, the loader and the switch-off notes in `init.lua`), `bridge/vixen-state.test.mjs` (parsing, wording per form, the merged energy, signatures, the probe lines, end to end with the switch, and the nudity note).

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
  and nothing in the radio ring below reaches them either. A line heard in the last 20 s with no TV located stands for the TV ("A TV nearby is on; it just said ...").
- **The radio host (2026-10-30, not yet checked in the game):** what the DJ or presenter says between songs is told the same way: "You can hear the car radio: "<track>" on "<station>".
  The radio host just said: "<line>". If V asks what is on, answer from this." (`radio.said`, the last line or two, at most 90 s old, 200 characters; it is shortened first and dropped
  first when the 300-character budget is tight, and it does not count as a change for the scenery memory, like a TV line). `mod/game-dialogue.lua` `noteHeard` keeps lines of type `Radio` in a
  ring of its own (last three, 160 characters each, same duplicate window), under the same Music and TV switch (one boolean read per line when off, no per-frame work, no new setting), and
  `Instance:heardRadioLines(maxAge, source)` gives them to `mod/media-context.lua` for the receiver that is on. A `Radio` line is not always a broadcast: the Delamain cab's own voice and
  quest voices come as `Radio` lines too (the recorder above keeps them only during a call). So a line is kept only when **all** of this holds, and in doubt it is skipped:
  1. no phone call is on;
  2. in a car: the line's speaker is the very vehicle V is mounted in, `IsRadioReceiverActive()` is true, and the vehicle is not one of the two Delamain cab records
     (`Vehicle.v_standard2_villefort_cortes_delamain_player`, `Vehicle.v_delamain_taxi`); on foot: the pocket radio's `IsActive()` is true and the line has no speaker or V as its speaker
     (any other speaker, another car's radio included, is not the pocket radio);
  3. the speaker is not a character the mod knows (`resolve` on the speaker, then `resolveName` on the shown name; not asked when V is the speaker).
  Radio lines are never recorded game dialogue: `capture()`, the policy table, Johnny's remarks and the add-ons are unchanged, and the cab's voice during a call works as before.
  probe.log gets `Game dialogue: Radio line heard (car|pocket) speaker=<class>` or `... not kept (<reason>) speaker=<class>` for the first 12 `Radio` lines of a session (never the words),
  and the `Media:` line ends with `hostSaid=yes|no`. **Unverified:** that the game sends the host's words as `Radio` subtitle lines at all, what their speaker is (the car? V? nothing?),
  and what a quest voice looks like, so the live pass should read those log lines first.
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
